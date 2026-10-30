// The last good copy of Tizen Tap, kept on the TV for the rescue companion.
//
// Tizen Tap is the installer, so a self-update that breaks it leaves nothing
// on the TV able to put it back. The rescue package (rescue/) can, if a signed
// copy of a build known to work is waiting for it. This module keeps that copy.
//
// Every install of Tizen Tap, whether a self-update, an install from a phone,
// or `npm run bootstrap` from a computer, leaves the signed package at the one
// staging path vd_appinstall accepts. The installer keeps its own package
// aside as the candidate before installing it, and a build that starts and
// finds its own package still staged does the same; once that build has
// served /version for two minutes, the candidate becomes last-good.wgt. A
// build that never comes up healthy is never promoted, so the copy on disk is
// always one that ran.
//
// Shared with the rescue bundle, so the paths and the probe cannot drift
// between the writer and the reader.

'use strict';

const { createHash } = require('crypto');

const { identify, readFromZip } = require('../install/manifest.ts');

const SELF_PACKAGE_ID = 'GJBBYNLkgP';
const TIZEN_TAP_APP_ID = `${SELF_PACKAGE_ID}.TizenHomebrew`;
const TIZEN_TAP_PORT = 8091;

const RESCUE_PACKAGE_ID = 'kiB8Pr8Nds';
const RESCUE_APP_ID = `${RESCUE_PACKAGE_ID}.Rescue`;
const RESCUE_PORT = 8093;

const STAGED_PACKAGE = '/home/owner/share/tmp/sdk_tools/package.wgt';
const RESCUE_DIR = '/home/owner/share/tizen-tap-rescue';
const CANDIDATE = `${RESCUE_DIR}/candidate.wgt`;
const LAST_GOOD = `${RESCUE_DIR}/last-good.wgt`;
const LAST_GOOD_META = `${RESCUE_DIR}/last-good.json`;
const RESCUE_LOG = `${RESCUE_DIR}/rescue.log`;
const RESCUE_STATE = `${RESCUE_DIR}/state.json`;
const RESCUE_PIN = `${RESCUE_DIR}/pin.json`;

// Tizen Tap's own configuration: its pairing PIN, its developer mark and the
// TV's signing pair. The rescue only ever reads it.
const TIZEN_TAP_CONFIG = '/home/owner/share/homebrewConfig.json';

const HEALTHY_UPTIME_MS = 120000;
const PROBE_TIMEOUT_MS = 5000;

const BUNDLE_ENTRY = 'service/dist/index.js';

// The build stamp is injected into the bundle as a literal, so the package
// carries the exact build it would start. config.xml's version does not
// change between builds of one release.
function carriesBuild(archive, build) {
    try {
        if (identify(archive).packageId !== SELF_PACKAGE_ID) return false;

        const bundle = readFromZip(archive, BUNDLE_ENTRY);

        return !!bundle && bundle.toString('utf8').indexOf(build) !== -1;
    } catch (e) {
        return false;
    }
}

// A crash between the write and the rename leaves a stray temp file and the
// previous target untouched, never half a package under the real name.
function writeAtomically(fs, path, data) {
    const temporary = `${path}.tmp`;

    fs.writeFileSync(temporary, data);
    fs.renameSync(temporary, path);
}

function readJson(fs, path) {
    try {
        return JSON.parse(fs.readFileSync(path, 'utf8'));
    } catch (e) {
        return null;
    }
}

// The first non-internal IPv4. Tizen gives every app its own loopback, so a
// sibling's port is only reachable on the LAN address.
function lanIpv4(os = require('os')) {
    try {
        const interfaces = os.networkInterfaces();

        for (const name of Object.keys(interfaces)) {
            for (const entry of interfaces[name] || []) {
                if ((entry.family === 'IPv4' || entry.family === 4) && !entry.internal) return entry.address;
            }
        }
    } catch (e) {}

    return null;
}

// Whether Tizen Tap answers /version with a build, on a given host.
function probeVersion(host, port = TIZEN_TAP_PORT, timeoutMs = PROBE_TIMEOUT_MS) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };

        try {
            const request = require('http').get({ host, port, path: '/version', timeout: timeoutMs }, (response) => {
                let body = '';
                response.on('data', (chunk) => { body += chunk; });
                response.on('end', () => {
                    try {
                        const parsed = JSON.parse(body);
                        finish(response.statusCode === 200 && parsed && parsed.build ? String(parsed.build) : null);
                    } catch (e) {
                        finish(null);
                    }
                });
                response.on('error', () => finish(null));
            });

            request.on('timeout', () => { request.destroy(); finish(null); });
            request.on('error', () => finish(null));
        } catch (e) {
            finish(null);
        }
    });
}

// The incoming package of a self-update, kept before vd_appinstall runs: the
// installer may not leave the staged file behind for the new build to find.
// Its build is checked by the build that starts, at promotion.
function keepCandidate(fs, archive, log) {
    try {
        if (identify(archive).packageId !== SELF_PACKAGE_ID) return false;

        fs.mkdirSync(RESCUE_DIR, { recursive: true });
        writeAtomically(fs, CANDIDATE, archive);
        log(`last good: kept the incoming package (${archive.length} bytes) as the candidate`);

        return true;
    } catch (error) {
        try { log(`last good: could not keep the incoming package: ${error.message}`); } catch (e) {}
        return false;
    }
}

// `probe` answers whether this build is serving; `schedule` is setTimeout,
// injected so the two-minute wait runs on a fake clock in tests.
function createKeeper({ fs, build, probe, log, schedule = setTimeout, now = () => new Date() }) {
    const say = (message) => {
        try { log(message); } catch (e) {}
    };

    function alreadyKept() {
        const meta = readJson(fs, LAST_GOOD_META);

        return !!(meta && meta.build === build && fs.existsSync(LAST_GOOD));
    }

    function capture() {
        if (alreadyKept()) return 'kept';

        // The self-update that installed this build already kept it.
        if (fs.existsSync(CANDIDATE) && carriesBuild(fs.readFileSync(CANDIDATE), build)) return 'captured';
        if (!fs.existsSync(STAGED_PACKAGE)) return 'none-staged';

        const archive = fs.readFileSync(STAGED_PACKAGE);

        if (!carriesBuild(archive, build)) return 'not-this-build';

        fs.mkdirSync(RESCUE_DIR, { recursive: true });
        writeAtomically(fs, CANDIDATE, archive);
        say(`last good: staged package is this build (${archive.length} bytes), kept as the candidate`);

        return 'captured';
    }

    async function promote() {
        if (alreadyKept()) return 'kept';
        if (!fs.existsSync(CANDIDATE)) return 'no-candidate';

        const archive = fs.readFileSync(CANDIDATE);

        if (!carriesBuild(archive, build)) {
            say('last good: the candidate is not this build, left as it is');
            return 'not-this-build';
        }

        if (!await probe()) {
            say(`last good: /version did not answer after ${HEALTHY_UPTIME_MS / 1000}s, candidate not promoted`);
            return 'unhealthy';
        }

        // The package first, then what describes it: a crash between the two
        // leaves a valid package with stale metadata, which only costs a recopy.
        fs.renameSync(CANDIDATE, LAST_GOOD);
        writeAtomically(fs, LAST_GOOD_META, JSON.stringify({
            build,
            version: identify(archive).version,
            size: archive.length,
            sha256: createHash('sha256').update(archive).digest('hex'),
            promotedAt: now().toISOString()
        }, null, 4));

        say(`last good: ${build} served for ${HEALTHY_UPTIME_MS / 1000}s, promoted to ${LAST_GOOD}`);

        return 'promoted';
    }

    function start() {
        try {
            capture();
        } catch (error) {
            say(`last good: could not keep the staged package: ${error.message}`);
        }

        const timer = schedule(() => {
            promote().catch((error) => say(`last good: promotion failed: ${error.message}`));
        }, HEALTHY_UPTIME_MS);

        if (timer && typeof timer.unref === 'function') timer.unref();
    }

    return { capture, promote, start };
}

const LOG_TAIL_LINES = 10;

// What /dev/status says about the rescue. `installed` is null off a TV, where
// nothing can be known about it.
function describeRescue({ fs, installed }) {
    let lastGood: any = null;

    try {
        if (fs.existsSync(LAST_GOOD)) {
            const stat = fs.statSync(LAST_GOOD);
            const meta = readJson(fs, LAST_GOOD_META) || {};

            lastGood = {
                path: LAST_GOOD,
                build: meta.build || null,
                version: meta.version || null,
                size: stat.size,
                promotedAt: meta.promotedAt || new Date(stat.mtimeMs).toISOString()
            };
        }
    } catch (e) {}

    let log: string[] = [];

    try {
        if (fs.existsSync(RESCUE_LOG)) {
            log = String(fs.readFileSync(RESCUE_LOG, 'utf8')).split('\n').filter(Boolean).slice(-LOG_TAIL_LINES);
        }
    } catch (e) {}

    return {
        appId: RESCUE_APP_ID,
        installed,
        lastGood,
        candidate: (() => { try { return fs.existsSync(CANDIDATE); } catch (e) { return null; } })(),
        state: readJson(fs, RESCUE_STATE),
        log
    };
}

module.exports = {
    SELF_PACKAGE_ID, TIZEN_TAP_APP_ID, TIZEN_TAP_PORT, RESCUE_PACKAGE_ID, RESCUE_APP_ID, RESCUE_PORT,
    STAGED_PACKAGE, RESCUE_DIR, CANDIDATE, LAST_GOOD, LAST_GOOD_META, RESCUE_LOG, RESCUE_STATE, RESCUE_PIN, TIZEN_TAP_CONFIG,
    HEALTHY_UPTIME_MS, carriesBuild, keepCandidate, writeAtomically, readJson, lanIpv4, probeVersion, createKeeper, describeRescue
};

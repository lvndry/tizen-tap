// Tizen Tap Rescue: the service entry point.
//
// on-boot starts it with the TV. It runs one check (see rescue.ts), writes
// what it did to /home/owner/share/tizen-tap-rescue/rescue.log, and then
// stays up serving :8093 (see server.ts): a service that exits under
// auto-restart can be started again in a loop, and the idle server holds
// nothing but a socket. Opening the Rescue app from the drawer (or
// `app.js kiB8Pr8Nds.Rescue`) reaches onRequest and runs a manual check,
// still within the per-boot and on-disk limits.

'use strict';

const fs = require('fs');

const sdb = require('../../service/src/tv/sdb.ts');
const {
    RESCUE_DIR, RESCUE_LOG, RESCUE_STATE, RESCUE_PORT, LAST_GOOD, TIZEN_TAP_APP_ID, TIZEN_TAP_CONFIG,
    writeAtomically, readJson, lanIpv4, probeVersion, takeExpectedRestart
} = require('../../service/src/rescue/lastgood.ts');
const { createRescue, createReinstall } = require('./rescue.ts');
const { resolvePin, createGate, createInstall, createServer, createPinGate } = require('./server.ts');

const BUILD = '__RESCUE_BUILD__';
const LOG_CEILING = 256 * 1024;
const HEALTH_PROBE_MS = 2000;

function note(message) {
    try {
        fs.mkdirSync(RESCUE_DIR, { recursive: true });

        try {
            if (fs.statSync(RESCUE_LOG).size > LOG_CEILING) fs.renameSync(RESCUE_LOG, `${RESCUE_LOG}.1`);
        } catch (e) {}

        fs.appendFileSync(RESCUE_LOG, `[${new Date().toISOString()}] ${message}\n`);
    } catch (e) {
        // Logging must never be the reason a rescue fails.
    }
}

// The kernel's id for this boot; the boot time is the fallback, rounded so
// clock jitter does not split one boot in two.
function readBootId() {
    try {
        const id = String(fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
        if (id) return id;
    } catch (e) {}

    try {
        const uptime = Number(String(fs.readFileSync('/proc/uptime', 'utf8')).split(' ')[0]);
        return `boot-${Math.round((Date.now() / 1000 - uptime) / 600)}`;
    } catch (e) {
        return 'boot-unknown';
    }
}

const state = {
    read: () => readJson(fs, RESCUE_STATE),
    write: (value) => {
        try {
            fs.mkdirSync(RESCUE_DIR, { recursive: true });
            writeAtomically(fs, RESCUE_STATE, JSON.stringify({ ...value, at: new Date().toISOString() }, null, 4));
        } catch (error) {
            note(`could not write ${RESCUE_STATE}: ${error.message}`);
        }
    }
};

function appInstalled(appId) {
    try {
        return !!(globalThis as any).tizen.application.getAppInfo(appId);
    } catch (e) {
        return false;
    }
}

function launch(appId) {
    return new Promise<void>((resolve) => {
        try {
            (globalThis as any).tizen.application.launch(appId,
                () => { note(`launch of ${appId} accepted`); resolve(); },
                (error) => { note(`launch of ${appId} refused: ${(error && (error.name || error.message)) || error}`); resolve(); });
        } catch (error) {
            note(`launch of ${appId} threw: ${error.message || error}`);
            resolve();
        }
    });
}

function lastGoodKey() {
    try {
        const stat = fs.statSync(LAST_GOOD);
        return stat.size > 0 ? `${stat.size}@${Math.round(stat.mtimeMs)}` : null;
    } catch (e) {
        return null;
    }
}

const gate = createGate();
const reinstallLastGood = createReinstall({ readArchive: () => fs.readFileSync(LAST_GOOD), sdb, log: note });

const rescue = createRescue({
    probe: (host) => probeVersion(host),
    lanHost: () => lanIpv4(),
    appInstalled,
    launch,
    reinstall: async () => {
        const release = gate.enter('boot reinstall');
        if (!release) throw Object.assign(new Error('an install through :8093 is running'), { code: 'installBusy' });

        try {
            await reinstallLastGood();
        } finally {
            release();
        }
    },
    lastGoodKey,
    state,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: note,
    bootId: readBootId()
});

const readConfig = () => readJson(fs, TIZEN_TAP_CONFIG);

const handle = createServer({
    health: async () => {
        const host = lanIpv4();

        return {
            ok: true,
            rescue: BUILD,
            tizenTap: {
                installed: appInstalled(TIZEN_TAP_APP_ID),
                answering: host ? !!await probeVersion(host, undefined, HEALTH_PROBE_MS) : null
            }
        };
    },
    install: createInstall({ readConfig, sdb, launch, log: note }),
    authorise: createPinGate({ resolve: () => resolvePin({ fs, readConfig, log: note }), log: note }),
    gate,
    log: note
});

let server: any = null;

function listen() {
    if (server) return;

    server = require('http').createServer(handle);
    server.on('error', (error) => note(`cannot listen on ${RESCUE_PORT}: ${error.message}`));
    server.listen(RESCUE_PORT, '0.0.0.0', () => note(`listening on 0.0.0.0:${RESCUE_PORT}`));
}

// Tizen Tap opens the rescue just before installing over itself; the note it
// left says so, and turns this start into following that restart.
function runCheck(manual) {
    const follow = takeExpectedRestart(fs);
    rescue.run(follow ? { follow } : { manual });
}

function start() {
    note(`rescue ${BUILD} starting, pid ${process.pid}, node ${process.version}`);

    listen();
    runCheck(false);
}

module.exports.onStart = start;
module.exports.onRequest = () => {
    note('manual request');
    runCheck(true);
};
module.exports.onExit = () => note('rescue service stopping');

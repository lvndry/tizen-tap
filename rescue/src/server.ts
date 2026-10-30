// The rescue's way in: a second installer on :8093 that does not depend on
// Tizen Tap running, so a broken Tizen Tap can be replaced from a computer
// without touching Developer Mode or rebooting.
//
// Two routes and nothing else: GET /health, and POST /install behind the PIN.
// No eval, no shell, no root. The server holds no state between requests
// beyond the lockout table, so an idle rescue costs a listening socket.
//
// The PIN is the one Tizen Tap shows, read from its configuration on every
// request (Tizen Tap can mint or change it while the rescue runs):
//
//   Tizen Tap marked a developer build   000000, which is what it answers too
//   Tizen Tap stored a pairing PIN       that PIN
//   neither                              a rescue PIN, minted once, kept in
//                                        pin.json beside the log and logged
//
// Wrong PINs lock out the client address, escalating, through the same
// lockout table Tizen Tap uses.

'use strict';

const installer = require('../../service/src/install/installer.ts');
const { identify } = require('../../service/src/install/manifest.ts');
const pin = require('../../service/src/auth/pin.ts');
const { json, failure, retryLater, denied, readBody } = require('../../service/src/http/respond.ts');
const { RESCUE_PACKAGE_ID, RESCUE_PIN, RESCUE_DIR, writeAtomically, readJson } = require('../../service/src/rescue/lastgood.ts');
const { installStaged } = require('./rescue.ts');

const BUSY_RETRY_SECONDS = 15;
const PIN_SHAPE = /^\d{6}$/;

function refuse(code, message) {
    return Object.assign(new Error(message), { code });
}

function resolvePin({ fs, readConfig, generate = pin.generate, log }) {
    const config = readConfig() || {};

    if (config.developerBuild === true) return { pin: pin.DEVELOPER_PIN, source: 'developer' };
    if (typeof config.pin === 'string' && PIN_SHAPE.test(config.pin)) return { pin: config.pin, source: 'tizen-tap' };

    const kept = readJson(fs, RESCUE_PIN);
    if (kept && typeof kept.pin === 'string' && PIN_SHAPE.test(kept.pin)) return { pin: kept.pin, source: 'rescue' };

    const minted = generate();

    try {
        fs.mkdirSync(RESCUE_DIR, { recursive: true });
        writeAtomically(fs, RESCUE_PIN, JSON.stringify({ pin: minted, at: new Date().toISOString() }));
    } catch (error) {
        log(`could not keep the rescue PIN: ${error.message}`);
    }

    log(`no Tizen Tap PIN is stored; the rescue PIN is ${minted} (kept in ${RESCUE_PIN})`);

    return { pin: minted, source: 'rescue' };
}

// One install at a time across the server and the boot check: two would
// fight over sdbd's single session and the one staging path.
function createGate() {
    let holder: any = null;

    return {
        holder: () => holder,
        enter(name) {
            if (holder) return null;
            holder = { name, startedAt: Date.now() };
            return () => { holder = null; };
        }
    };
}

// Stage, install over loopback sdb, launch. Re-signed with the TV's own pair
// when Tizen Tap has one stored, exactly as Tizen Tap does; otherwise the
// package must already be signed for this TV.
function createInstall({ readConfig, resign = null as any, stage = installer.stage, sdb, launch, log }) {
    const say = (message) => {
        try { log(message); } catch (e) {}
    };

    const signer = resign || ((archive, certificates) => require('../../service/src/install/resign.ts').resign(archive, certificates));

    return async function install(upload, name) {
        const phases: string[] = [];
        const phase = (line) => { phases.push(line); say(`install: ${line}`); };

        try {
            const identity = (() => {
                try {
                    return identify(upload);
                } catch (error) {
                    throw refuse('badPackage', error.message);
                }
            })();

            phase(`identified ${identity.name || name || 'a package'} ${identity.version || ''} (${identity.packageId})`.replace(/ +/g, ' '));

            if (identity.packageId === RESCUE_PACKAGE_ID) {
                throw refuse('rescueSelf', 'The rescue cannot replace itself while it is running; install it through Tizen Tap.');
            }

            const config = readConfig() || {};
            let archive = upload;

            if (config.author && config.distributor) {
                archive = (await signer(upload, config)).archive;
                phase('re-signed with this TV\'s certificate pair');
            } else {
                phase('no certificate pair stored by Tizen Tap; installing as sent, so it must be signed for this TV');
            }

            const path = stage(archive, identity);
            phase(`staged ${archive.length} bytes to ${path}`);

            try {
                await sdb.withSession({ log: say }, (session) => installStaged(session, path, identity.packageId, phase));
            } finally {
                sdb.release();
            }

            phase('installed');

            if (identity.appId) {
                await launch(identity.appId);
                phase(`launched ${identity.appId}`);
            }

            return { ok: true, packageId: identity.packageId, appId: identity.appId, version: identity.version, phases };
        } catch (error) {
            throw Object.assign(error, { phases });
        }
    };
}

function createServer({ health, install, authorise, gate, log }) {
    const say = (message) => {
        try { log(message); } catch (e) {}
    };

    return async function handle(request, response) {
        const path = String(request.url || '').split('?')[0];

        try {
            if (request.method === 'GET' && path === '/health') {
                return json(response, await health());
            }

            if (request.method !== 'POST' || path !== '/install') {
                return failure(response, 404, 'notFound', 'The rescue answers GET /health and POST /install, nothing else.');
            }

            const address = request.socket && request.socket.remoteAddress;
            const verdict = authorise(request.headers['x-homebrew-pin'], address);

            if (!verdict.ok) {
                request.resume();
                return denied(response, verdict);
            }

            const release = gate.enter(request.headers['x-homebrew-name'] || 'upload');

            if (!release) {
                request.resume();
                const running = gate.holder();
                return retryLater(response, 409, {
                    code: 'installBusy',
                    message: `An install is already running (${running.name}). Try again in ${BUSY_RETRY_SECONDS}s.`,
                    retryAfterSeconds: BUSY_RETRY_SECONDS
                });
            }

            try {
                const upload = await readBody(request);
                say(`install requested from ${address}: ${upload.length} bytes`);

                return json(response, await install(upload, request.headers['x-homebrew-name']));
            } catch (error) {
                say(`install failed: ${error.code || 'internal'}: ${error.message}`);

                const status = error.code === 'badPackage' || error.code === 'rescueSelf' ? 400 : 500;

                return json(response, {
                    ok: false,
                    code: error.code || 'internal',
                    message: error.message,
                    remedy: error.remedy || null,
                    phases: error.phases || []
                }, status);
            } finally {
                release();
            }
        } catch (error) {
            say(`request failed: ${error.message}`);
            try { failure(response, 500, 'internal', error.message); } catch (e) {}
        }
    };
}

// A fresh authoriser per request over one lockout table: the PIN can change
// underneath, the lockouts must not.
function createPinGate({ resolve, lockouts = pin.createLockouts(), log }) {
    return (presented, address) => pin.createAuthoriser(resolve().pin, {
        lockouts,
        onLockout: (client, lockout) => log(`${client} locked out (lockout ${lockout.lockouts})`)
    })(presented, address);
}

module.exports = { resolvePin, createGate, createInstall, createServer, createPinGate, BUSY_RETRY_SECONDS };

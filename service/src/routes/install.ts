// The mutating surface: installing a package and managing the signing
// certificates. Both sit behind the PIN, because each one changes what the
// television will run.
//
// Installing is the long road — an upload, a re-sign, and a hand-off to sdbd —
// so it reports its phases and, on a self-update, exits abnormally so the
// firmware's auto-restart loads the new build in its place (see lifecycle.js).

'use strict';

const { json, failure, readBody } = require('../http/respond.ts');
const { size, took, host } = require('../obs/units.ts');
const { Facility } = require('../obs/log.ts');
const { ErrorCode } = require('../protocol.ts');

// A self-update replaces the very wgt this process runs out of. sdbd has
// already swapped the files, so the old code is stale: exit abnormally and
// let auto-restart load the new build — no manual relaunch.
const SELF_PACKAGE_ID = 'GJBBYNLkgP';

function register(ctx, router) {
    const { authorise, installer, updates, sdb, store, config, log, recorded } = ctx;

    const pkg = log.on(Facility.PKG);
    const cfg = log.on(Facility.CFG);

    function requirePin(request, response) {
        const verdict = authorise(request.headers['x-homebrew-pin']);
        return verdict.ok || failure(response, verdict.code === ErrorCode.LOCKED_OUT ? 429 : 403, verdict.code, verdict.message);
    }

    router.on.post('/install', async (request, response) => {
        if (!requirePin(request, response)) return;

        const phases: string[] = [];
        const began = Date.now();
        const archive = await readBody(request);

        pkg.info(`${host(request.socket && request.socket.remoteAddress)} uploaded ` +
            `${size(archive.length)}${request.headers['x-homebrew-name'] ? ` as ${request.headers['x-homebrew-name']}` : ''} ` +
            `in ${took(Date.now() - began)}`);

        try {
            const outcome = await installer.install(
                { source: 'upload', reference: request.headers['x-homebrew-name'], upload: archive },
                (phase, detail) => phases.push(detail ? `${phase}: ${detail}` : phase)
            );

            updates.changed();

            json(response, { ok: true, phases, ...outcome });

            if (outcome.packageId === SELF_PACKAGE_ID) {
                sdb.release();
                // Same as /restart: an uncaught throw reliably trips auto-restart, so the new
                // build loads in place without a manual relaunch.
                setTimeout(() => {
                    recorded.recordExit('self-update');
                    throw new Error('homebrew self-update');
                }, 300);
            }
        } catch (error) {
            failure(response, 500, error.code || ErrorCode.INTERNAL, error.message, error.remedy);
            pkg.err(`upload install stopped after: ${phases.join(', ') || 'nothing'}`);
        }
    });

    router.on.post('/certificates', async (request, response) => {
        if (!requirePin(request, response)) return;

        const sent = await readBody(request, 4 * 1024 * 1024);

        const pair = (() => {
            try {
                return JSON.parse(sent.toString('utf8'));
            } catch (e) {
                return null;
            }
        })();

        const devices = ((pair || {}).devices || []).filter((name) => typeof name === 'string' && name);

        const opened = (() => {
            try {
                return require('../install/resign.ts').openPair(pair);
            } catch (error) {
                return { error };
            }
        })();

        if (opened.error) {
            return failure(response, 400, ErrorCode.BAD_MESSAGE, opened.error.message);
        }

        const device = devices[0] || null;
        const state = store.select('device');
        const here = state && state.duid;

        config.update({
            author: pair.author,
            distributor: pair.distributor,
            certDuid: device,
            certDuids: devices,
            certCreatedAt: new Date().toISOString()
        });

        const mismatched = Boolean(here && devices.length && devices.indexOf(here) === -1);

        cfg[mismatched ? 'warn' : 'ok'](
            `certificates stored for ${devices.join(', ') || 'an unnamed device'}` +
            (mismatched ? `, but this television is ${here} — installs will be refused` : ''));

        json(response, { ok: true, device, devices, matchesThisTv: !mismatched, thisTv: here || null });
    });

    router.on.delete('/certificates', (request, response) => {
        if (!requirePin(request, response)) return;

        config.forgetCertificates();
        cfg.info('certificates forgotten');

        json(response, { ok: true });
    });
}

module.exports = { register };

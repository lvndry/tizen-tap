'use strict';

// Six named steps, each taking the work so far further along. Every route runs this same sequence.

const { createHash } = require('crypto');

const sources = require('./sources.ts');
const manifest = require('./manifest.ts');
const preview = require('./preview.ts');
const installer = require('./installer.ts');
const { size, took, rate } = require('../obs/units.ts');
const memory = require('../obs/memory.ts');

function refuse(code, message) {
    return Object.assign(new Error(message), { code });
}

// Installs run one at a time, and a second client waits its turn in line, so two agents driving
// the same TV both get their installs. It is only turned away when the line is too slow or the
// install ahead of it is a self-update, which restarts this service and drops everyone waiting.
// Then it is told when to come back; an install that has already run long is a slow one (a big
// download, a cold sdbd), so it is asked to wait longer.
const QUEUE_WAIT_MS = 3 * 60 * 1000;
const QUEUE_POLL_MS = 250;

// A root command holding the agent delays the release an install needs; most finish in seconds.
const ROOT_IDLE_WAIT_MS = 60 * 1000;

const BUSY_RETRY_MIN_S = 10;
const BUSY_RETRY_MAX_S = 30;

function busyRetrySeconds(startedAt, now = Date.now()) {
    const ranSeconds = startedAt ? Math.max(0, (now - startedAt) / 1000) : 0;
    return Math.min(BUSY_RETRY_MAX_S, Math.max(BUSY_RETRY_MIN_S, Math.ceil(ranSeconds / 2)));
}

function refuseBusy(running, now = Date.now()) {
    const described = running && typeof running === 'object' ? running : {};
    const startedAt = described.startedAt || null;
    const retryAfterSeconds = busyRetrySeconds(startedAt, now);
    const installing = {
        name: described.name || null,
        phase: described.phase || null,
        startedAt: startedAt ? new Date(startedAt).toISOString() : null
    };

    const what = [installing.name, installing.phase].filter(Boolean).join(', ');
    const message = `An install is already running${what ? ` (${what})` : ''}. ` +
        `Try again in ${retryAfterSeconds}s.`;

    return Object.assign(refuse('installBusy', message), { retryAfterSeconds, installing });
}

// The package this service runs out of. A self-update is the one install where
// uninstalling first would remove the very process doing the installing.
const SELF_PACKAGE_ID = 'GJBBYNLkgP';

const QUIET = ['debug', 'info', 'ok', 'warn', 'err']
    .reduce((noop, level) => ({ ...noop, [level]: () => {} }), {});

// How sdbd turns away a second client while it is serving the root agent's session. The command
// never ran, so another route is safe to try.
const HELD_BY_ANOTHER_SESSION = { sdbClosed: true, sdbReset: true };

// At the readiness probe sdbd can also just hang until the timeout (seen on a CU7105 with the agent
// connected). The probe only asked for the duid, so nothing was installed and root is still safe.
const PROBE_HELD_BY_ANOTHER_SESSION = { ...HELD_BY_ANOTHER_SESSION, sdbTimeout: true };

// sdbd takes a few seconds to notice its session's process is gone: the release kills the agent
// a second after it answers, and on a CU7105 a dial two seconds later was still reset while one
// eight seconds later went through. So the install waits until sdbd completes a handshake.
const SDBD_SETTLE_MS = 1500;
const SDBD_FREE_ATTEMPTS = 15;
const SDBD_FREE_GAP_MS = 1000;

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(done: () => boolean, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (!done() && Date.now() < deadline) await wait(QUEUE_POLL_MS);
    return done();
}

function createInstaller({ sdb, device, config, resigner, store, log, rootChannel = null as any, rearmRoot = null as any,
    keepCandidate = null as any, selfRestart = null as any, queueWaitMs = QUEUE_WAIT_MS, rootIdleWaitMs = ROOT_IDLE_WAIT_MS }) {
    const say = log ? log.on('pkg') : QUIET;
    const sdbSays = log ? log.on('sdb') : QUIET;

    const line: object[] = [];

    // First in, first served. The turn is claimed by the caller in the same tick the line lets it
    // go, so no other waiter can slip in between.
    async function waitForTurn(request) {
        const ticket = {};
        line.push(ticket);
        try {
            const first = store.select('installing');
            if (first) {
                say.info(`queued behind ${first.name || 'another install'}: ${request.reference || '(upload)'}, ` +
                    `${line.length - 1} ahead`);
            }

            const turned = await waitUntil(() => {
                const running = store.select('installing');
                return (!running && line[0] === ticket) || !!(running && running.self) || queueWaitMs <= 0;
            }, queueWaitMs);

            const running = store.select('installing');
            if (running && (running.self || !turned || queueWaitMs <= 0)) {
                const busy = refuseBusy(running);
                say.warn(`refused: an install is already running (${busy.installing.name || 'unnamed'}, ` +
                    `${busy.installing.phase || 'starting'})${running.self ? ', a self-update' : ''}, ` +
                    `asked to retry in ${busy.retryAfterSeconds}s`);
                throw busy;
            }
        } finally {
            line.splice(line.indexOf(ticket), 1);
        }
    }

    const rootHoldsSdbd = (code, held = HELD_BY_ANOTHER_SESSION) =>
        !!(held[code] && rootChannel && rootChannel.status().root);

    async function install(request: any, report = (..._args: any[]) => {}) {
        await waitForTurn(request);

        const startedAt = Date.now();

        // Truthy for the guard, and what a refused second client is told about this one.
        const track = (patch) => store.update({ installing: { ...store.select('installing'), ...patch } });
        store.update({ installing: { name: request.reference || null, phase: null, startedAt } });

        const held = memory.peak();
        const phase = (name: string, detail?: any, extra?: any) => {
            held.at(name);
            track({ phase: name });
            report(name, detail, extra);
        };

        const at = () => Date.now() - startedAt;

        say.info(`install requested: ${request.source} ${request.reference || '(upload)'}`);

        const probeReadiness = async () => {
            phase('probing');

            const state = await device.probe();

            say.info(state.onTv
                ? `television is tizen ${state.platformVersion || 'unknown'}` +
                  `${state.needsResign ? ', which requires re-signed packages' : ''}` +
                  `, sdb ${state.ready ? 'reachable' : `unreachable — ${state.sdbDetail || state.sdbError || state.reason || 'unknown'}`}`
                : 'no television here — running as a development harness');

            if (state.onTv && !state.ready && rootHoldsSdbd(state.sdbError, PROBE_HELD_BY_ANOTHER_SESSION)) {
                say.info('sdb is turning clients away while the root agent holds its session; ' +
                    'the install will release it and go over sdb');
            } else if (state.onTv && !state.ready) {
                // The remedy comes after the fault and only as the thing that would explain it.
                throw refuse(
                    state.reason === 'debugModeOff' ? 'debugModeOff' : 'sdbUnreachable',
                    `${state.sdbDetail || `sdb was unreachable (${state.sdbError || state.reason || 'unknown'})`} ` +
                    (state.reason === 'debugModeOff'
                        ? 'Developer Mode is off in Apps › 12345 › Settings.'
                        : 'If it stays this way, Host PC IP = 127.0.0.1 and a restart is what fixes a misconfigured one.')
                );
            }

            return { state };
        };

        const acquirePackage = async (carried) => {
            phase('fetching', request.reference || request.source);

            const began = Date.now();

            const { archive, name } = await sources.resolve({
                ...request,
                catalog: store.select('catalog') || [],
                log
            });

            const spent = Date.now() - began;

            say.ok(`got ${name}: ${size(archive.length)} in ${took(spent)} (${rate(archive.length, spent)})`);
            say.info(`sha256 ${createHash('sha256').update(archive).digest('hex').slice(0, 16)}…`);

            return { ...carried, archive, name };
        };

        // Read as it arrived: a file that is not a package should be refused before anything signs it.
        const readIdentity = (carried) => {
            const identity = manifest.identify(carried.archive);
            track({
                name: identity.name || identity.packageId || carried.name || null,
                self: identity.packageId === SELF_PACKAGE_ID
            });

            say.info(`identified ${identity.name || 'an unnamed package'} ${identity.version || ''} ` +
                `(${identity.packageId}${identity.appId ? `, app ${identity.appId}` : ''}, ${identity.isWgt ? 'wgt' : 'tpk'})`);

            return { ...carried, identity, described: preview.describe(carried.archive, identity) };
        };

        // Always re-signed with this TV's own pair: from Tizen 7 the set checks the certificate is its own.
        const resign = async (carried) => {
            // Sent before the certificate check, so a refusal names the application rather than the file.
            phase('resigning', carried.identity.name || carried.identity.packageId,
                { identity: carried.described });

            if (!config.hasCertificates(carried.state.duid)) {
                throw refuse('certsMissing',
                    'Packages are signed with this TV\'s own certificate pair, and none is ' +
                    'stored yet. Send one first — see `npm run certs`.');
            }

            const sign = await resigner();
            const { archive, device, files } = await sign(carried.archive);

            say.ok(`re-signed ${files} files for ${device || 'this television'}`);

            return { ...carried, archive };
        };

        const stageOnDisk = (carried) => {
            phase('staging', carried.identity.name || carried.identity.packageId);

            const stagedPath = installer.stage(carried.archive, carried.identity);

            say.ok(`staged ${size(carried.archive.length)} to ${stagedPath}`);

            // The rescue's last-good copy starts here; the new build promotes it once it runs.
            if (keepCandidate && carried.identity.packageId === SELF_PACKAGE_ID) keepCandidate(carried.archive);

            return { ...carried, stagedPath };
        };

        const logLines = (line) => sdbSays.info(line);

        const inPlaceOverSdb = (carried) => {
            const { packageId } = carried.identity;

            sdbSays.info(`shell:0 vd_appinstall ${packageId} ${carried.stagedPath} (in place)`);

            return sdb.withSession({ log: logLines },
                (session) => installer.run(session, carried.stagedPath, packageId));
        };

        // Two copies of the same package start the service twice, so a copy that
        // survived an earlier failed install has to go before the new one lands.
        const replaceOverSdb = (carried) => {
            const { packageId } = carried.identity;
            const uninstall = `shell:0 vd_appuninstall ${packageId}`;

            sdbSays.info(uninstall);

            return sdb.withSession({ log: logLines }, async (session) => {
                const cleared = await session.exec(uninstall, { timeout: 30000 });
                sdbSays.info(`old copy gone: ${String(cleared).trim() || '(clean)'}`);
                return installer.run(session, carried.stagedPath, packageId);
            });
        };

        // A self-update installs in place: sdbd overwrites the files, and the caller then exits
        // abnormally so auto-restart loads the new build. Uninstalling first removes the very
        // process doing the installing, so it is only the fallback for the installer's own
        // refusal. An sdb error (a reset, a closed handshake, a timeout) is never that: one got
        // through on the uninstall's retry and left the TV with no Tizen Tap at all, and a
        // timeout says nothing about whether the install ran.
        const installOverSdb = async (carried, isSelf) => {
            if (isSelf) {
                try {
                    return await inPlaceOverSdb(carried);
                } catch (error) {
                    if (error.isSdbError) throw error;
                    sdbSays.info(`in place refused (${error.code || 'install failed'}), uninstalling the old copy first`);
                }
            }

            return replaceOverSdb(carried);
        };

        // The connected root agent holds sdbd's single client session. Installing through root
        // instead (pkgcmd) puts a package on disk without registering it with the app manager: no
        // drawer icon, and the Control API cannot launch it (seen on a CU7105). So every install
        // goes over sdb, once the agent has given its session back. A self-update re-arms through
        // the new build's own start; anything else re-arms here, after the install.
        const releaseAndInstall = async (carried, refusal, isSelf) => {
            if (rootChannel.busy) say.info('waiting for the running root command before releasing the agent');
            if (!await waitUntil(() => !rootChannel.busy, rootIdleWaitMs)) {
                throw refuse('installBusy',
                    'sdb is turning clients away while the root agent holds its session ' +
                    `(${refusal.code}), and a root command is still running, so the agent cannot be ` +
                    'released yet. Retry once the root channel is idle.');
            }

            say.warn(`releasing the root agent so sdb can carry the install (${refusal.code})`);
            await rootChannel.release();
            await wait(SDBD_SETTLE_MS);

            if (sdb.probeHandshake) {
                const freed = await sdb.probeHandshake({ attempts: SDBD_FREE_ATTEMPTS, gap: SDBD_FREE_GAP_MS });
                sdbSays.info(freed.handshake === 'ok'
                    ? `sdbd took a client again after the release (attempt ${freed.attempts})`
                    : `sdbd still turned clients away after the release (${freed.error})`);
            }

            try {
                await installOverSdb(carried, isSelf);
            } catch (error) {
                if (!HELD_BY_ANOTHER_SESSION[error.code]) throw error;

                throw refuse('sdbUnreachable',
                    `sdb still turned the install away (${error.code}) after the root agent was ` +
                    'released, so nothing was installed. POST /dev/root/arm brings root back; retry the ' +
                    'install once sdb answers.');
            }

            say.info('installed over sdb after releasing the root agent');

            if (!isSelf && rearmRoot) {
                Promise.resolve().then(rearmRoot).then(
                    () => say.info('root re-armed after the install'),
                    (error) => say.warn(`could not re-arm root after the install: ${error.message}`)
                );
            }

            return { ...carried, route: 'sdb' };
        };

        // The platform kills this process partway through installing over it, so something outside
        // has to start the new build: the rescue is told first, and told again if nothing happened.
        const runInstaller = async (carried) => {
            const isSelf = carried.identity.packageId === SELF_PACKAGE_ID;

            phase('installing', carried.identity.name || carried.identity.packageId);

            if (!isSelf || !selfRestart) return installByRoute(carried, isSelf);

            selfRestart.expect();
            try {
                return await installByRoute(carried, isSelf);
            } catch (error) {
                selfRestart.cancel();
                throw error;
            }
        };

        const installByRoute = async (carried, isSelf) => {
            // The probe already saw sdb held, so it is not tried again before the release: a second
            // attempt would hang the same way.
            const { state } = carried;
            if (state && state.onTv && !state.ready && rootHoldsSdbd(state.sdbError, PROBE_HELD_BY_ANOTHER_SESSION)) {
                sdbSays.warn(`sdb was held by the root agent at the probe (${state.sdbError})`);
                return releaseAndInstall(carried, { code: state.sdbError }, isSelf);
            }

            try {
                await installOverSdb(carried, isSelf);
                return { ...carried, route: 'sdb' };
            } catch (error) {
                if (!rootHoldsSdbd(error.code)) throw error;

                sdbSays.warn(`sdb refused the install (${error.code}) while the root agent holds its session`);
                return releaseAndInstall(carried, error, isSelf);
            }
        };

        const recordOutcome = (carried) => {
            const { packageId, appId, name, version } = carried.identity;

            const previous = (config.read().lastInstalled || [])
                .filter((entry) => entry.packageId !== packageId);

            config.update({
                lastInstalled: [{ packageId, appId, name, version, at: new Date().toISOString() }]
                    .concat(previous)
                    .slice(0, 20)
            });

            return { packageId, appId, name, version, route: carried.route };
        };

        try {
            const readied = await probeReadiness();
            const acquired = await acquirePackage(readied);
            const identified = readIdentity(acquired);
            const signed = await resign(identified);
            const staged = stageOnDisk(signed);
            const installed = await runInstaller(staged);
            const outcome = recordOutcome(installed);

            held.at('finishing');

            say.ok(`installed ${outcome.name || outcome.packageId} ${outcome.version || ''} over ${outcome.route} in ${took(at())}`);

            return outcome;
        } catch (error) {
            say.err(`install failed after ${took(at())}: ${error.code || 'internal'} — ${error.message}`);

            if (error.remedy) error.remedy.split('\n').forEach((line) => say.warn(line));

            // Certificates the TV rejected make every later attempt fail identically, so the next one re-mints.
            if (error.code === 'certRejected') {
                say.warn('clearing the stored certificates so the next attempt re-mints them');
                config.forgetCertificates();
            }

            throw error;
        } finally {
            const high = held.highest();

            if (high.at) {
                say.info(`peak memory ${memory.describe(high)}, at ${high.at}` +
                    (high.peakRss ? `; process high-water ${size(high.peakRss)}` : ''));
            }

            store.update({ installing: false });
        }
    }

    return { install };
}

module.exports = { createInstaller, busyRetrySeconds };

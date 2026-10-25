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

// The package this service runs out of. A self-update is the one install where
// uninstalling first would remove the very process doing the installing.
const SELF_PACKAGE_ID = 'GJBBYNLkgP';

const QUIET = ['debug', 'info', 'ok', 'warn', 'err']
    .reduce((noop, level) => ({ ...noop, [level]: () => {} }), {});

function createInstaller({ sdb, device, config, resigner, store, log }) {
    const say = log ? log.on('pkg') : QUIET;
    const sdbSays = log ? log.on('sdb') : QUIET;

    async function install(request: any, report = (..._args: any[]) => {}) {
        if (store.select('installing')) {
            say.warn('refused: an install is already running');
            throw refuse('internal', 'An install is already running.');
        }

        store.update({ installing: true });

        const held = memory.peak();
        const phase = (name: string, detail?: any, extra?: any) => {
            held.at(name);
            report(name, detail, extra);
        };

        const startedAt = Date.now();
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

            if (state.onTv && !state.ready) {
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

            return { ...carried, stagedPath };
        };

        const runInstaller = async (carried) => {
            const { packageId } = carried.identity;
            const isSelf = packageId === SELF_PACKAGE_ID;

            phase('installing', carried.identity.name || carried.identity.packageId);

            const logLines = (line) => sdbSays.info(line);

            // A self-update installs in place: sdbd overwrites the files, and the
            // caller then exits abnormally so auto-restart loads the new build.
            // Uninstalling first would drop the connection — this process runs out
            // of the package being removed, and the install never lands.
            if (isSelf) {
                sdbSays.info(`shell:0 vd_appinstall ${packageId} ${carried.stagedPath} (in place)`);

                try {
                    await sdb.withSession({ log: logLines },
                        (session) => installer.run(session, carried.stagedPath, packageId));

                    return carried;
                } catch (error) {
                    sdbSays.info(`in place refused (${error.code || 'install failed'}) — uninstalling the old copy first`);
                }
            }

            // Two copies of the same package start the service twice, so a copy that
            // survived an earlier failed install has to go before the new one lands.
            const uninstall = `shell:0 vd_appuninstall ${packageId}`;

            sdbSays.info(uninstall);

            await sdb.withSession({ log: logLines }, async (session) => {
                const cleared = await session.exec(uninstall, { timeout: 30000 });
                sdbSays.info(`old copy gone: ${String(cleared).trim() || '(clean)'}`);
                return installer.run(session, carried.stagedPath, packageId);
            });
            return carried;
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

            return { packageId, appId, name, version };
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

            say.ok(`installed ${outcome.name || outcome.packageId} ${outcome.version || ''} in ${took(at())}`);

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

module.exports = { createInstaller };

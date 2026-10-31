// Service entry point: Tizen calls onStart when the service boots, onRequest
// for launches into a running one; a desktop run without a `tizen` object
// starts directly, so the same file is the development harness.
//
// Composition root. It opens the pairing/health HTTP server on :8091, the
// root channel on loopback :8092 (see root/, and AGENTS.md "The HTTP
// surface"), revives the companions it watches (stremio, bonsoir), wires
// the install pipeline (fetch from the origin baked at build time, re-sign,
// install over loopback sdb), and on a television arms the root channel
// itself, with retries, once the sdb probe settles. Routes live in routes/*,
// one file per concern; the UI catch-all registers last, after every other
// route.
//
// The pairing PIN is minted once, on first start, and persisted in the
// service's config — see config.pairingPin — so a reboot does not unpair
// every phone.
'use strict';

const { createServer } = require('http');
const { join } = require('path');
const { took, host } = require('./obs/units.ts');
const { homedir } = require('os');

const { startRecording, Facility } = require('./obs/log.ts');
const { createFlightRecorder } = require('./obs/flight.ts');
const runtime = require('./obs/runtime.ts');
const platform = require('./obs/platform.ts');
const memory = require('./obs/memory.ts');
const { CONFIG_DIR } = require('./config.ts');

// Opened before the first line is recorded, so last run's log is set aside and judged before this
// run's can overwrite it.
const recorded = startRecording({ flight: createFlightRecorder({ dir: CONFIG_DIR }) });
const log = recorded.log;

const { createStore } = require('./state.ts');
const { createRouter } = require('./http/router.ts');
const pin = require('./auth/pin.ts');
const device = require('./tv/device.ts');
const sdb = require('./tv/sdb.ts');
const packages = require('./tv/packages.ts');
const { Relay } = require('./tv/relay.ts');
const config = require('./config.ts');
const protocol = require('./protocol.ts');
const { createInstaller } = require('./install/pipeline.ts');
const { createCatalog } = require('./install/catalog.ts');
const { createUpdates } = require('./install/updates.ts');

const status = require('./routes/status.ts');
const install = require('./routes/install.ts');
const lifecycle = require('./routes/lifecycle.ts');
const dev = require('./routes/dev.ts');
const ui = require('./routes/ui.ts');
const rootRoutes = require('./routes/root.ts');
const { RootChannel } = require('./root/channel.ts');
const rootArm = require('./root/arm.ts');
const { makePortProbe, createWatchdog, stremioLanHost } = require('./revive.ts');
const { noteLaunch } = require('./launches.ts');
const { createKeeper, keepCandidate, probeVersion, lanIpv4, expectRestart, cancelExpectedRestart, RESCUE_APP_ID } = require('./rescue/lastgood.ts');

// 8080 is taken by a Samsung system service, so binding there fails with EADDRINUSE.
const PORT = Number(process.env.HOMEBREW_PORT) || 8091;

const BUILD = '__HOMEBREW_BUILD__';
const ORIGIN = '__HOMEBREW_ORIGIN__';

const DEVELOPER = globalThis.__HOMEBREW_DEV__ === true;

// Boot marker: every time this service process starts, append a timestamp.
try {
    const bootLog = '/home/owner/share/tmp/sdk_tools/bootlog.txt';
    require('fs').appendFileSync(bootLog, `start ${new Date().toISOString()} pid=${process.pid}\n`);
} catch (e) {}

// A start within a few minutes of the TV's own boot is a boot start; later
// starts are updates or manual relaunches. /proc/uptime is the TV's own
// clock, so no NTP is involved.
function isBootStart() {
    try {
        const uptime = Number(require('fs').readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
        return uptime < 180;
    } catch (e) {
        return false;
    }
}

// Companions this service keeps alive on the TV, in launch order:
//
//   stremio  — its server does not come up on its own after a cold boot, and
//              it is the thing that keeps a torrent stream alive when the
//              Mac is off, so a down server means a broken stream.
//   bonsoir  — the TV's front door. It is the default screen, so it must be
//              the first thing on the glass after the set wakes, which means
//              it comes back on every start of this service: a standby
//              resume re-runs this handler in the same process (the bootlog
//              shows repeated same-pid starts), and a cold boot fires it via
//              on-boot. The late post-launcher windows, which only matter
//              against the boot launcher stealing focus, stay gated to boot
//              starts so an update restart does not chase the screen for
//              four minutes.
//
// Every start of this service walks the list; each companion checks twice —
// immediately, then a minute later — because the services boot in parallel
// and the first look can race the other start. Stremio keeps being checked
// afterwards: its server has been seen dying hours into a session, with
// nothing to notice, so the start-time windows are backed by a periodic
// sweep (see revive.ts).
// A companion launch is only wanted on a waking set. The launch waits for the
// Control API to report 'on' at this cadence and gives up when the set is
// still not on: a missed launch is recovered by the next resume, while a
// launch fired into standby is what the viewer sees as a flash of an app on
// a black screen.
const AWAIT_ON_POLL_MS = 2000;
const AWAIT_ON_MS = 45_000;

function reviveCompanions() {
    const companion = log.on(Facility.SVC);

    // Probes over the TV's own LAN IPv4, never 127.0.0.1: Tizen network
    // namespaces are per-app, so a sibling app's loopback is not this app's
    // and the port would always read down.
    const watchdog = createWatchdog({ probe: makePortProbe(stremioLanHost), launch });

    // The set's real power state, straight from the Control API (the same
    // source /dev/status shows). Only 'on' is a state where putting an app on
    // the glass is wanted; any other state — or a read we cannot make — is
    // treated as not on.
    function setOn(): Promise<boolean> {
        return device.powerState().then((state) => state === 'on').catch(() => false);
    }

    // Waits until the set reports 'on' or the window gives out. The first
    // look is free (a start on a waking set usually lands 'on' at once), and
    // the polls are cheap Control API reads, never app launches.
    function waitUntilOn(label: string): Promise<boolean> {
        const deadline = Date.now() + AWAIT_ON_MS;


        function tick(): Promise<boolean> {
            return setOn().then((on) => {
                if (on) return true;
                if (Date.now() >= deadline) {
                    companion.info(`set not on (${label}) — skipping the launch until the next resume`);
                    return false;
                }
                return new Promise<boolean>((done) => setTimeout(() => { done(tick()); }, AWAIT_ON_POLL_MS));
            });
        }

        return tick();
    }

    // Every launch first waits for the set to be on, so a companion is never
    // pulled to the front of a black screen.
    async function launch(appId: string, name: string, label: string) {
        const on = await waitUntilOn(label);
        if (!on) return;

        // One source of truth for every relaunch this service fires: the ring
        // is what /dev/status serves, next to the diagnosis.
        noteLaunch(appId, label);

        // Launch the app, not the service: on this firmware a cross-app
        // launch of a service id is a silent no-op, while the app's page
        // starts the service for it through launchAppControl.
        try {
            (globalThis as any).tizen.application.launch(appId,
                () => companion.info(`${name} was down (${label}) — launched it`),
                (e: any) => companion.info(`${name} was down (${label}) — launch refused: ${e.code || e.message}`));
        } catch (e) {
            companion.info(`${name} was down (${label}) — ${e.message || e} (reinstall it to restore)`);
        }
    }

    function schedule(revive: (label: string) => Promise<void>, windows: ReadonlyArray<readonly [number, string]> = [[3000, 'first check'], [60_000, 'second check']]) {
        for (const [delay, label] of windows) {
            setTimeout(async () => { await revive(label); }, delay);
        }
    }

    // The default windows, through the watchdog's guarded check: a slow
    // probe cannot stack a second launch, and the 60 s sweep keeps the
    // server alive after this start is long over.
    schedule((label) => watchdog.check(label));

    // Every start puts the dashboard back on the glass — standby resume
    // included, since that is how the set is actually turned on. The late
    // windows only win the boot-launcher focus race, so they are boot-only.
    schedule((label) => Promise.resolve(launch('BonsoirTV1.Bonsoir', 'bonsoir', label)),
        isBootStart()
            ? [[3000, 'early check'], [60_000, 'second check'], [120_000, 'post-launcher relaunch'], [240_000, 'late relaunch']]
            : [[3000, 'early check'], [60_000, 'second check']]);
}


function start() {
    const startedAt = new Date().toISOString();
    const secret = DEVELOPER ? pin.DEVELOPER_PIN : config.pairingPin();

    const svc = log.on(Facility.SVC);

    svc.info(`tizen tap ${BUILD} starting`);
    svc.info(`${runtime.summary()}, pid ${process.pid}`);

    const previousRun = recorded.previousRun();
    if (previousRun) {
        (previousRun.endedCleanly === false ? svc.warn : svc.info)(`${previousRun.summary}; GET /logs/previous has its log`);
    }

    const devLog = log.on(Facility.DEV);

    platform.describe().then(
        (facts) => platform.summary(facts).forEach((line) => devLog.info(line)),
        (error) => devLog.warn(`could not read the platform: ${error.message}`)
    );

    if (DEVELOPER) {
        log.on(Facility.AUTH).warn(`DEVELOPER BUILD — pin fixed at ${secret}, and POST /dev/eval will run ` +
            'anything this network sends it. Do not leave this on a television you care about.');
    } else {
        log.on(Facility.AUTH).info(`pairing pin ${secret} — kept across restarts, so a reboot does not ` +
            'unpair every phone');
    }

    // The rescue on :8093 asks for the same PIN this build answers to.
    if (device.onTv && config.read().developerBuild !== DEVELOPER) config.update({ developerBuild: DEVELOPER });

    const adopted = config.adoptHandoff();

    if (adopted) {
        log.on(Facility.CFG).ok(`certificates adopted from bootstrap for ${adopted.join(', ') || 'an unnamed device'}`);
    } else if (config.hasLegacyCertificates()) {
        log.on(Facility.CFG).warn('the stored certificates are in the old .p12 format and cannot be used — ' +
            'run `npm run certs` again');
    }

    const store = createStore({
        installing: false,
        catalog: [],
        catalogStale: false,
        device: null
    });

    const stored = config.read().catalogUrl;
    const catalogUrl = stored || `${ORIGIN}/catalog.json`;
    const catalogCache = join(homedir(), 'share', 'homebrewCatalog.json');

    const catalog = createCatalog({ url: catalogUrl, cachePath: catalogCache, log });

    // No prime() at startup: priming getPackagesInfo wedges the service on Tizen 9.0.
    const updates = createUpdates({ packages, log, config });

    log.on(Facility.CAT).info(`origin ${catalogUrl}${stored ? ' (from the stored configuration)' : ''}`);
    log.on(Facility.CFG).info(`cache ${catalogCache}`);

    const relay = new Relay({
        enabled: config.read().relayEnabled,
        packageId: device.onTv ? tizen.application.getAppInfo().packageId : null,
        log: (message) => log.on(Facility.RELAY).info(message)
    });

    if (relay.enabled) log.on(Facility.RELAY).warn('the command relay is ON from stored configuration');

    // Loaded on first use so a television that never installs anything does not parse node-forge.
    async function resigner() {
        const { resign } = require('./install/resign.ts');

        return (archive) => resign(archive, config.read());
    }

    const channelManifest = rootArm.manifest();
    // The token file is the base64 form of the key; the C# agent does
    // Convert.FromBase64String on it, so the channel must use the decoded
    // bytes or every frame fails to authenticate.
    const channelSecret = require('fs')
        .readFileSync(require('path').join(rootArm.VENDOR, 'root-agent.token'), 'utf8')
        .trim();
    const channel = new RootChannel({
        host: channelManifest.callbackHost, port: channelManifest.callbackPort,
        // A Buffer, not a string: createHmac would re-encode a string as utf8
        // and corrupt any high bytes of the key.
        secret: Buffer.from(channelSecret, 'base64'),
        log: (line) => svc.info(line)
    });

    const armer = rootArm.createArmer({
        sdb, channel, log: (line) => svc.info(line), onOutcome: (error) => status.noteArmError(error),
        installing: () => !!store.select('installing')
    });

    // See expectRestart in rescue/lastgood.ts. Without the rescue installed the launch is refused
    // and the new build waits for the app to be opened, as before.
    const selfRestart = device.onTv ? {
        expect() {
            try {
                expectRestart(require('fs'), 'self-update');
                (globalThis as any).tizen.application.launch(RESCUE_APP_ID,
                    () => svc.info('the rescue is following the self-update, to start the new build'),
                    (error) => svc.warn(`the rescue was not launched (${error.code || error.message}); ` +
                        'open Tizen Tap on the TV after the update'));
            } catch (error) {
                svc.warn(`could not hand the self-update to the rescue: ${error.message}`);
            }
        },
        cancel: () => cancelExpectedRestart(require('fs'))
    } : null;

    const installer = createInstaller({
        sdb, device, config, resigner, store, log, rootChannel: channel,
        rearmRoot: () => armer.arm('the re-arm after an install'),
        keepCandidate: device.onTv ? (archive) => keepCandidate(require('fs'), archive, (line) => svc.info(line)) : null,
        selfRestart
    });

    function announce(state, previous) {
        if (!previous) {
            devLog.info(state.onTv
                ? `tizen ${state.platformVersion || 'unknown'}` +
                  `${state.needsResign ? ' — packages must be re-signed for this firmware' : ''}`
                : 'not running on a television — this is a development harness');

            if (state.onTv && state.developerMode === false) devLog.warn('developer mode is off');
        } else if (previous.ready === state.ready) {
            return state;
        }

        if (state.ready) {
            log.on(Facility.SDB).ok(`loopback 127.0.0.1:${sdb.SDB_PORT} answered — this TV can install its own apps`);
        } else if (state.onTv) {
            log.on(Facility.SDB).warn(state.sdbDetail
                ? `loopback 127.0.0.1:${sdb.SDB_PORT} — ${state.sdbDetail}`
                : `loopback 127.0.0.1:${sdb.SDB_PORT} is not usable (${state.sdbError || state.reason || 'unknown'})`);

            devLog.info(state.reason === 'debugModeOff'
                ? 'if it stays this way: Developer Mode in Apps › 12345 › Settings, then restart the TV'
                : 'if it stays this way: Host PC IP = 127.0.0.1 in Apps › 12345 › Settings, then restart ' +
                  'the TV — sdbd reads that value only at startup');
        }

        return state;
    }

    // Filled in once the socket server is up, at the end of this function. The sweep below is the
    // only thing that learns something without being asked, so it is the only thing that pushes.
    let sockets: any = null;

    async function refreshDevice() {
        // An install has the connection; probing across it would only add commands to what sdbd is doing.
        if (store.select('installing')) return store.select('device');

        const previous = store.select('device');
        const first = await device.probe();

        // sdbd drops the occasional connection, so a demotion is confirmed by a second probe.
        const state = previous && previous.ready && !first.ready
            ? await device.probe()
            : first;

        store.update({ device: state });

        // Compared whole: `ready` alone would hold back a changed reason for the same unreadiness.
        if (sockets && JSON.stringify(previous) !== JSON.stringify(state)) {
            sockets.broadcast(protocol.Outbound.STATE, { ...state, hasCertificates: config.hasCertificates() });
        }

        return announce(state, previous);
    }

    refreshDevice();
    if (device.onTv) setInterval(refreshDevice, 15000);

    const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

    function fromLoopback(request) {
    return LOOPBACK.indexOf((request.socket && request.socket.remoteAddress) || '') !== -1;
}

    const authorise = pin.createAuthoriser(secret, {
        onLockout: (address, lockout) => log.on(Facility.AUTH).warn(
            `${host(address)} locked out for ${Math.ceil(pin.remaining(lockout) / 1000)}s (lockout ${lockout.lockouts})`)
    });

    const ctx: any = {
        build: BUILD,
        port: PORT,
        startedAt,
        runtime,
        device,
        packages,
        store,
        config,
        log,
        secret,
        sdb,
        svc,
        net: log.on(Facility.NET),
        recorded,
        installer,
        updates,
        relay,
        catalog,
        protocol,
        fromLoopback,
        authorise
    };

    const root = { channel, armer };
    ctx.root = root;

    const router = createRouter({
        log,
        quiet: (request, path) =>
            request.method === 'GET' && fromLoopback(request) &&
            ['/logs', '/state', '/pin', '/version', '/health'].indexOf(path) !== -1
    });

    status.register(ctx, router);
    install.register(ctx, router);
    lifecycle.register(ctx, router);
    rootRoutes.register(ctx, router);

    if (DEVELOPER) {
        const { createRepl } = require('./dev/repl.ts');

        const repl = createRepl({
            require, process, log, store, config, secret,
            catalog, updates, installer, relay, device, sdb, packages, platform, runtime, memory
        });

        svc.warn(`repl: POST /dev/eval, with ${repl.names.join(' ')} in scope`);
        dev.register({ ...ctx, repl }, router);
    }

    // The catch-all must come after every other route.
    ui.register(ctx, router);

    const server = createServer(router.listener);

    // A failed bind arrives as an event, so without this nothing listens and nothing says so.
    server.on('error', (error) => {
        ctx.net.err(`cannot listen on ${PORT}: ${error.message}`);

        if (error.code === 'EADDRINUSE') {
            ctx.net.err('another app or a system service has claimed that port — nothing will answer');
        }
    });

    server.listen(PORT, '0.0.0.0', () => {
        ctx.net.ok(`listening on 0.0.0.0:${PORT}`);

        const addresses = ctx.lanAddresses();

        if (addresses.length === 0) {
            ctx.net.warn('no LAN address — this TV is not on a network, so no phone can reach it');
        }

        addresses.forEach((entry, index) => ctx.net.info(
            `${index === 0 ? 'reachable at' : 'also at'} http://${entry.address}:${PORT} (${entry.iface})`));

        svc.ok(`startup finished in ${took(recorded.uptime())}`);
    });

    channel.start().catch((error) => svc.err(`root channel: ${error.message}`));

    // Arm root once the sdb probe has settled: stage the payloads, fire the
    // injection, and let the agent dial back in. Idempotent, so a failed
    // attempt is retried a few times; /dev/root/arm remains manual after.
    //
    // The sdbd gate is the authorization: it accepts exactly one source
    // address, and a cold boot or the TV's own dialog can leave it pointing
    // somewhere other than loopback. Once root is in, heal it back to
    // 127.0.0.1 so the loopback install and arm paths keep working and the
    // dialog is never needed again.
    if (device.onTv) {
        const developer = require('./root/developer.ts');
        let gateEnsured = false;
        // sdbd persists a lockout after many rejected handshakes, and every
        // rejected dial feeds the counter — the arm loop must not keep
        // re-dialing a rejecting sdbd on a fixed cadence. Transient resets
        // (sdbd busy, mid-restart) keep the short retry; a clean handshake
        // reject backs off exponentially (30 s → 5 min) and after
        // HANDSHAKE_PAUSE_AFTER rejects in a row auto-arm pauses until a heal
        // or a manual /dev/root/arm resumes it.
        const HANDSHAKE_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000];
        const HANDSHAKE_PAUSE_AFTER = 3;
        let consecutiveHandshakeRejects = 0;
        setTimeout(() => {
            function ensureLoopbackGate() {
                if (gateEnsured) return;
                gateEnsured = true;
                developer.ensureLoopbackGate({
                    exec: (command, timeoutMs) => root.channel.exec(command, timeoutMs),
                    log: (line) => svc.info(line)
                }).catch((error) => svc.warn(`loopback gate: ${error.message}`))
                    .then(() => {
                        // A self-heal restarts sdbd, which takes the channel
                        // with it; the gate is loopback now, so re-arm once.
                        // That attempt is the one the heal existed for, so it
                        // is allowed even while the handshake pause is up.
                        consecutiveHandshakeRejects = 0;
                        setTimeout(() => tryArm(2, true), 20000);
                    });
            }
            function tryArm(attemptsLeft, forceAfterHeal = false) {
                if (root.channel.status().root) {
                    // The root agent lives under sdbd, so it survives a tizen-tap
                    // restart. A fresh process reconnects to it and would
                    // otherwise return here without ever healing the gate —
                    // which is exactly the case the self-heal exists for.
                    ensureLoopbackGate();
                    return;
                }
                if (consecutiveHandshakeRejects >= HANDSHAKE_PAUSE_AFTER && !forceAfterHeal) return;
                armer.arm('the boot arm').then(() => {
                    consecutiveHandshakeRejects = 0;
                    ensureLoopbackGate();
                }).catch((error) => {
                    svc.warn(`root arm: ${error.message}`);
                    if (error.code === 'armBudget') return;
                    const rejected = /closed the connection before the ADB handshake/.test(error.message);
                    if (rejected) {
                        consecutiveHandshakeRejects += 1;
                        if (consecutiveHandshakeRejects >= HANDSHAKE_PAUSE_AFTER) {
                            svc.warn(`root arm: sdbd rejected ${consecutiveHandshakeRejects} handshakes in a row — the gate is likely not 127.0.0.1 or a lockout is persisted; auto-arm paused, POST /dev/root/arm to resume`);
                            return;
                        }
                        const delay = HANDSHAKE_BACKOFF_MS[Math.min(consecutiveHandshakeRejects - 1, HANDSHAKE_BACKOFF_MS.length - 1)];
                        svc.info(`root arm: handshake rejected — backing off ${Math.round(delay / 1000)} s before the next attempt`);
                        setTimeout(() => tryArm(0), delay);
                        return;
                    }
                    if (attemptsLeft > 0) setTimeout(() => tryArm(attemptsLeft - 1), 30000);
                });
            }
            tryArm(2);
        }, 15000);
    }

    sockets = require('./socket.ts').attach({
        server, store, secret, authorise, installer, catalog, updates, relay, refreshDevice,
        fromLoopback, greeting: () => ({ ...ctx.pairing(), build: BUILD }), recorded, config, protocol, log
    });

    reviveCompanions();

    // The copy the rescue companion reinstalls when an update leaves this app dead.
    if (device.onTv) {
        createKeeper({
            fs: require('fs'),
            build: BUILD,
            probe: () => probeVersion(lanIpv4() || '127.0.0.1', PORT),
            log: (line) => svc.info(line)
        }).start();
    }

    return { server, port: PORT, pin: secret, build: BUILD };
}

// Tizen's service runtime calls onStart; a service exporting anything else loads and never listens.
module.exports.onStart = start;
module.exports.start = start;

// Tizen calls onRequest for launches into a running service; without it the runner throws on each one.
module.exports.onRequest = () => log.on(Facility.SVC).debug('a launch reached a service that is already running');
module.exports.BUILD = BUILD;
module.exports.PORT = PORT;

if (!device.onTv) start();

'use strict';

// The companion watchdog: keeps the Stremio streaming server alive on the TV
// for as long as this service runs, not only at start.
//
// The Stremio server is a separate app. It does not come up on its own after a
// cold boot, and it can also die hours after boot with nothing to notice — the
// old start-time-only probe missed exactly that. So this module probes its
// port on the TV's own LAN IPv4 and relaunches the app when the port is
// silent. The host matters: Tizen gives every app its own network namespace,
// so a sibling's 127.0.0.1 is a different loopback and would always read down;
// stremioLanHost (shared with /dev/status) returns the one address the client
// already uses.
//
// Two entry points, both funnelled through one in-flight guard so a slow probe
// can never stack a second relaunch: the start-time windows (which race the
// parallel boot) and a periodic sweep that keeps running afterwards. The probe
// and launch are injected so the whole thing is testable without a television.

const { stremioLanHost } = require('./routes/status.ts');

const STREMIO_PORT = 11470;
const STREMIO_APP_ID = 'S6K2WQ8MnP.StremioServer';
const STREMIO_NAME = 'stremio server';
const PROBE_TIMEOUT_MS = 5000;
const PERIODIC_CHECK_MS = 60_000;

// The sweep relaunches only after this many failed checks in a row. Relaunching
// opens the server's page, which takes the screen from whatever is playing: on a
// CU7105 a server busy streaming missed single checks, and each relaunch threw
// the viewer out of the Stremio client mid-film.
const FAILURES_BEFORE_RELAUNCH = 3;

// Whether a port is accepting connections on a given host. `host` is a value or
// a resolver (so the LAN address can be re-read on every probe). It only
// connects: a server busy streaming accepts at once but can take seconds to
// answer an HTTP request, and that slowness is not a dead server.
function makePortProbe(host) {
    const resolve = typeof host === 'function' ? host : () => host || '127.0.0.1';

    return (port) => new Promise((done) => {
        const socket = require('net').connect({ host: resolve(), port });
        const finish = (up) => { socket.destroy(); done(up); };

        socket.setTimeout(PROBE_TIMEOUT_MS);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', () => finish(false));
    });
}

// A probe-and-relaunch watchdog. `probe` reports whether the port answers,
// `launch` relaunches the companion, and `setInterval`/`clearInterval` may be
// injected (tests run the sweep on a fake clock); they default to the runtime
// timers. The sweep is unref'd so it never holds the event loop open on its
// own. The in-flight flag means a check that is still probing is never
// re-entered: a slow probe cannot queue a second launch.
//
// An explicit check (the start-time windows) relaunches on its first failure:
// right after a start the server is either up or really down, and nobody is
// watching yet. The sweep is patient and waits for FAILURES_BEFORE_RELAUNCH in
// a row; any answering check resets the count.
function createWatchdog({ probe, launch, intervalMs = PERIODIC_CHECK_MS, failuresBeforeRelaunch = FAILURES_BEFORE_RELAUNCH, setInterval = globalThis.setInterval, clearInterval = globalThis.clearInterval }) {
    let inFlight = false;
    let failuresInARow = 0;

    function check(label, { patient = false } = {}) {
        if (inFlight) return Promise.resolve();

        inFlight = true;

        return Promise.resolve()
            .then(() => probe(STREMIO_PORT))
            .then((up) => {
                if (up) {
                    failuresInARow = 0;
                    return;
                }

                failuresInARow += 1;
                if (patient && failuresInARow < failuresBeforeRelaunch) return;

                failuresInARow = 0;
                launch(STREMIO_APP_ID, STREMIO_NAME, label);
            })
            .catch(() => {})
            .then(() => { inFlight = false; });
    }

    const sweep = setInterval(() => { check('periodic check', { patient: true }); }, intervalMs);
    if (typeof sweep.unref === 'function') sweep.unref();

    return {
        check,
        stop: () => { clearInterval(sweep); }
    };
}

module.exports = {
    makePortProbe,
    createWatchdog,
    stremioLanHost,
    PERIODIC_CHECK_MS,
    FAILURES_BEFORE_RELAUNCH
};

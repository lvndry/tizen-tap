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
const PROBE_TIMEOUT_MS = 1500;
const PERIODIC_CHECK_MS = 60_000;

// Whether a port is answering on a given host. `host` is a value or a resolver
// (so the LAN address can be re-read on every probe); any HTTP reply is an up
// port, a refused connection, a timeout, or a dead socket is down.
function makePortProbe(host) {
    const resolve = typeof host === 'function' ? host : () => host || '127.0.0.1';

    return (port) => new Promise((done) => {
        const req = require('http').get({ host: resolve(), port, timeout: PROBE_TIMEOUT_MS },
            (res) => { res.resume(); res.on('end', () => done(true)); });
        req.on('timeout', () => { req.destroy(); done(false); });
        req.on('error', () => done(false));
    });
}

// A probe-and-relaunch watchdog. `probe` reports whether the port answers,
// `launch` relaunches the companion, and `setInterval`/`clearInterval` are the
// runtime's timer functions (the sweep is unref'd so it never holds the event
// loop open on its own). The in-flight flag means a check that is still
// probing is never re-entered: a slow probe cannot queue a second launch.
function createWatchdog({ probe, launch, intervalMs = PERIODIC_CHECK_MS, setInterval, clearInterval }) {
    let inFlight = false;

    function check(label) {
        if (inFlight) return Promise.resolve();

        inFlight = true;

        return Promise.resolve()
            .then(() => probe(STREMIO_PORT))
            .then((up) => {
                if (up) return;
                launch(STREMIO_APP_ID, STREMIO_NAME, label);
            })
            .catch(() => {})
            .then(() => { inFlight = false; });
    }

    const sweep = setInterval(() => { check('periodic check'); }, intervalMs);
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
    STREMIO_PORT,
    PERIODIC_CHECK_MS
};

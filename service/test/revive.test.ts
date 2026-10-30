// Unit tests for the companion watchdog: the probe + relaunch decision and
// the sweep schedule, with the probe, launch and timers injected so nothing
// here touches a television, the network, or a real clock.

'use strict';

const { test, expect } = require('bun:test');
const { makePortProbe, createWatchdog, stremioLanHost, PERIODIC_CHECK_MS, FAILURES_BEFORE_RELAUNCH } = require('../src/revive.ts');

const settle = () => new Promise((done) => setTimeout(done, 0));

// Timers with a handle the test can fire by hand: setInterval records the
// callback, clearInterval records it was cleared.
function fakeTimers() {
    const state = { tick: null, unrefs: 0, cleared: false };

    return {
        state,
        setInterval: (fn, ms) => { state.tick = () => fn(); state.ms = ms; return { unref: () => { state.unrefs += 1; } }; },
        clearInterval: () => { state.cleared = true; }
    };
}

function watchdogFor(probe, fake) {
    const calls = { launched: 0 };
    const seen = [];

    const watch = createWatchdog({
        probe,
        launch: (appId, name, label) => { calls.launched += 1; seen.push({ appId, name, label }); },
        setInterval: fake.setInterval,
        clearInterval: fake.clearInterval
    });

    return { watch, calls, seen };
}

test('createWatchdog: the sweep fires every 60 s, is unrefd, and relaunches a server down three checks in a row', async () => {
    const f = fakeTimers();
    const { watch, calls, seen } = watchdogFor(async () => false, f);

    expect(f.state.ms).toBe(PERIODIC_CHECK_MS);
    expect(f.state.ms).toBe(60_000);
    expect(f.state.unrefs).toBe(1);
    expect(FAILURES_BEFORE_RELAUNCH).toBe(3);

    // Each sweep's check is in flight and holds the guard, so settle the
    // microtask chain after every tick before asserting.
    for (let sweep = 1; sweep < FAILURES_BEFORE_RELAUNCH; sweep += 1) {
        f.state.tick();
        await settle();
        expect(calls.launched).toBe(0);
    }

    f.state.tick();
    await settle();

    expect(calls.launched).toBe(1);
    expect(seen[0]).toEqual({ appId: 'S6K2WQ8MnP.StremioServer', name: 'stremio server', label: 'periodic check' });

    // A watchdog whose server answers relaunches nothing.
    const f2 = fakeTimers();
    const { watch: w2, calls: c2 } = watchdogFor(async () => true, f2);
    f2.state.tick();
    await new Promise((done) => setTimeout(done, 0));

    expect(c2.launched).toBe(0);
    w2.stop();
    watch.stop();
});

test('createWatchdog: a check still probing is skipped, so a slow probe cannot stack launches', () => {
    const f = fakeTimers();

    let release;
    const deferred = new Promise((done) => { release = done; });

    let probes = 0;
    const { watch, calls, seen } = watchdogFor(
        async () => { probes += 1; await deferred; return false; }, f);

    const first = watch.check('periodic check'); // starts probing, holds the guard
    const second = watch.check('periodic check'); // arrives mid-probe: skipped

    return second.then(() => {
        expect(probes).toBe(1);
        expect(calls.launched).toBe(0);

        release(); // let the in-flight probe finish

        return first.then(() => {
            expect(probes).toBe(1);
            expect(calls.launched).toBe(1);
            expect(seen[0].label).toBe('periodic check');

            // The guard is released: a later check probes again.
            return watch.check('second check').then(() => {
                expect(probes).toBe(2);
                expect(calls.launched).toBe(2);
                watch.stop();
            });
        });
    });
});

test('createWatchdog: a probe that rejects relaunches nothing and frees the guard', () => {
    const f = fakeTimers();
    const boom = async () => { throw new Error('socket reset'); };

    const { watch, calls } = watchdogFor(boom, f);

    return watch.check('periodic check').then(() => {
        expect(calls.launched).toBe(0);

        // The next check runs instead of being stuck behind the failed one.
        const f2 = fakeTimers();
        const { watch: w2, calls: c2 } = watchdogFor(async () => true, f2);
        return w2.check('periodic check').then(() => {
            expect(c2.launched).toBe(0);
            watch.stop();
            w2.stop();
        });
    });
});

test('createWatchdog: an answering sweep resets the count, so scattered misses never relaunch', async () => {
    const f = fakeTimers();
    const answers = [false, false, true, false, false, true, false, false];
    const { watch, calls } = watchdogFor(async () => answers.shift(), f);

    while (answers.length) {
        f.state.tick();
        await settle();
    }

    expect(calls.launched).toBe(0);
    watch.stop();
});

test('createWatchdog: the count starts over after a relaunch', async () => {
    const f = fakeTimers();
    const { watch, calls } = watchdogFor(async () => false, f);

    for (let sweep = 0; sweep < FAILURES_BEFORE_RELAUNCH * 2 - 1; sweep += 1) {
        f.state.tick();
        await settle();
    }

    expect(calls.launched).toBe(1);

    f.state.tick();
    await settle();
    expect(calls.launched).toBe(2);
    watch.stop();
});

test('createWatchdog: a start-time check still relaunches on its first failure', async () => {
    const f = fakeTimers();
    const { watch, calls, seen } = watchdogFor(async () => false, f);

    await watch.check('first check');

    expect(calls.launched).toBe(1);
    expect(seen[0].label).toBe('first check');
    watch.stop();
});

test('makePortProbe: a port that accepts but never answers HTTP is up, as a server busy streaming is', async () => {
    const sockets = [];
    const silent = require('net').createServer((socket) => { sockets.push(socket); });
    await new Promise((done) => silent.listen(0, '127.0.0.1', () => done()));

    try {
        expect(await makePortProbe('127.0.0.1')(silent.address().port)).toBe(true);
    } finally {
        sockets.forEach((socket) => socket.destroy());
        await new Promise((done) => silent.close(() => done()));
    }
});

function listen(server) {
    return new Promise((done) => server.listen(0, '127.0.0.1', () => done()));
}

test('makePortProbe: an answering port is up, a refused one is down', async () => {
    const http = require('http');
    const up = http.createServer((_req, res) => res.end('ok'));
    await listen(up);
    const upPort = up.address().port;

    const probe = makePortProbe('127.0.0.1');
    expect(await probe(upPort)).toBe(true);

    // Grab a port nothing listens on: bind, remember it, release it.
    const holder = http.createServer();
    await listen(holder);
    const downPort = holder.address().port;
    await new Promise((done) => holder.close(done));

    expect(await probe(downPort)).toBe(false);
    await new Promise((done) => up.close(done));
});
test('makePortProbe: with a resolver it dials the TV LAN IPv4, not loopback', async () => {
    const http = require('http');
    const os = require('os');

    // The machine's real LAN IPv4, stubbed as the TV would read it: dialing it
    // is a local round trip, so no ARP timeout on a host that lacks that IP.
    const realLan = (() => {
        for (const entries of Object.values(os.networkInterfaces())) {
            for (const entry of entries || []) {
                if ((entry.family === 'IPv4' || entry.family === 4) && !entry.internal) return entry.address;
            }
        }
        return null;
    })();

    if (realLan === null) return; // no LAN interface in this environment

    const original = os.networkInterfaces;
    os.networkInterfaces = () => ({ eth0: [{ family: 'IPv4', address: realLan, internal: false }] });

    try {
        expect(stremioLanHost()).toBe(realLan);

        // A server bound to loopback alone: the same port answers on
        // 127.0.0.1 and refuses on the LAN IPv4 — the split Tizen's per-app
        // namespaces create, and the one the old loopback probe got wrong.
        const server = http.createServer((_req, res) => res.end('ok'));
        await listen(server);
        const port = server.address().port;

        expect(await makePortProbe('127.0.0.1')(port)).toBe(true);
        expect(await makePortProbe(stremioLanHost)(port)).toBe(false);

        await new Promise((done) => server.close(done));
    } finally {
        os.networkInterfaces = original;
    }

    // Stub restored: the resolver is back on the machine's own interfaces.
    expect(stremioLanHost()).toBe(realLan);
});

test('stremioLanHost: falls back to loopback when no LAN IPv4 is visible', () => {
    const os = require('os');
    const original = os.networkInterfaces;
    os.networkInterfaces = () => ({ lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }] });

    try {
        expect(stremioLanHost()).toBe('127.0.0.1');
    } finally {
        os.networkInterfaces = original;
    }
});

test('createWatchdog: stop clears the sweep', () => {
    const f = fakeTimers();
    const { watch } = watchdogFor(async () => true, f);

    watch.stop();
    expect(f.state.cleared).toBe(true);
});

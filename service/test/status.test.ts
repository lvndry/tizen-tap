// Unit tests for the /dev/status doctor: the pure diagnose rules, the
// buxton2ctl line parser, and the buildStatus composition over fake probes,
// so nothing here touches a network or /proc.

'use strict';

const { test, expect } = require('bun:test');
const { diagnose, parseBuxton2, buildStatus, noteArmError, realScanProc, realStremio } = require('../src/routes/status.ts');

function healthy() {
    return {
        developer: { mode: true, ip: '127.0.0.1', source: 'root-read' },
        sdbd: { process: true, port: 'open', handshake: 'ok', lastArmError: null },
        root: { root: true, identity: 'agent' },
        services: { homebrew: 'up', stremio: { up: true, serverVersion: '4.4.2' } },
        boot: { uptime_s: 3600, type: 'standby-resume' },
        recent_errors: []
    };
}

// Probes that produce exactly the state given.
function probesFor(state) {
    return {
        rootStatus: () => state.root,
        rootExec: async () => '[system] db/sdk/develop/ip = String: 127.0.0.1\n[system] db/sdk/develop/mode = Int32: 1',
        scanProc: async () => state.sdbd.process,
        portProbe: async () => state.sdbd.port,
        handshake: async () => state.sdbd.handshake,
        stremio: async () => state.services.stremio,
        uptimeSeconds: () => state.boot.uptime_s,
        recentErrors: () => state.recent_errors
    };
}

test('diagnose: a healthy set says so', () => {
    expect(diagnose(healthy())).toBe('Everything looks healthy.');
});

test('diagnose: sdbd refused leads with the developer-mode fix', () => {
    const state = healthy();
    state.sdbd.port = 'refused';
    state.sdbd.handshake = 'untested';

    expect(diagnose(state)).toBe(
        'sdbd is not running — toggle Developer Mode off/on in Settings → General → Developer mode, then wait ~30 s.');
});

test('diagnose: a refused port suppresses the root-not-armed cascade', () => {
    const state = healthy();
    state.sdbd.port = 'refused';
    state.sdbd.handshake = 'untested';
    state.root = { root: false, identity: null };

    // Stremio is up here so the only thing at stake is the root channel: with sdbd down it cannot be armed, so that is an expected cascade, not a reported problem.
    expect(diagnose(state)).toBe(
        'sdbd is not running — toggle Developer Mode off/on in Settings → General → Developer mode, then wait ~30 s.');

    // The same state minus the port failure: now the down root and down Stremio are independent and get appended.
    state.sdbd.port = 'open';
    state.sdbd.handshake = 'ok';
    state.services.stremio = { up: false, serverVersion: null };

    const verdict = diagnose(state);

    expect(verdict.startsWith('root channel is not armed')).toBe(true);
    expect(verdict).toContain('Stremio server is down — relaunch the Tizen Tap app or POST /restart.');
    expect(verdict.endsWith('POST /restart.')).toBe(true);
});

test('diagnose: a rejected handshake blames the developer-mode IP', () => {
    const state = healthy();
    state.sdbd.handshake = 'rejected';

    expect(diagnose(state)).toBe(
        "sdbd is up but is rejecting the loopback handshake — the Developer Mode IP is set to another " +
        "machine (often the Mac's LAN IP). Set it to 127.0.0.1 in Developer Mode, then toggle the mode off/on.");
});

test('diagnose: an un-armed root channel is rule three, and only with sdbd healthy', () => {
    const state = healthy();
    state.root = { root: false, identity: null };

    expect(diagnose(state)).toBe('root channel is not armed — POST /dev/root/arm.');

    // Without an open, handshaking sdbd the rule does not fire: the arm would fail for a reason this message does not cover.
    state.sdbd.port = 'refused';
    state.sdbd.handshake = 'untested';

    expect(diagnose(state)).toBe(
        'sdbd is not running — toggle Developer Mode off/on in Settings → General → Developer mode, then wait ~30 s.');
});

test('diagnose: a down Stremio server names the restart', () => {
    const state = healthy();
    state.services.stremio = { up: false, serverVersion: null };

    expect(diagnose(state)).toBe('Stremio server is down — relaunch the Tizen Tap app or POST /restart.');
});

test('diagnose: secondary issues are appended after the first match', () => {
    const state = healthy();
    state.sdbd.handshake = 'rejected';
    state.services.stremio = { up: false, serverVersion: null };

    const verdict = diagnose(state);

    // Root is connected in the healthy base state, so rule three does not fire; Stremio is the only independent issue.
    expect(verdict.startsWith('sdbd is up but is rejecting the loopback handshake')).toBe(true);
    expect(verdict).toContain('Stremio server is down — relaunch the Tizen Tap app or POST /restart.');
    expect(verdict.endsWith('POST /restart.')).toBe(true);
});

test('parseBuxton2: both properties, in the real output shape', () => {
    const parsed = parseBuxton2(
        '[system] db/sdk/develop/ip = String: 127.0.0.1\n' +
        '[system] db/sdk/develop/mode = Int32: 1');

    expect(parsed.ip).toBe('127.0.0.1');
    expect(parsed.mode).toBe(true);
});

test('parseBuxton2: mode zero is off', () => {
    const parsed = parseBuxton2(
        '[system] db/sdk/develop/ip = String: 192.168.1.14\n' +
        '[system] db/sdk/develop/mode = Int32: 0');

    expect(parsed.ip).toBe('192.168.1.14');
    expect(parsed.mode).toBe(false);
});

test('parseBuxton2: malformed output leaves the unknown part null rather than guessing', () => {
    const parsed = parseBuxton2('buxton2ctl: unknown property\nip = String: \nmode = Int32: banana');

    expect(parsed.ip).toBe(null);
    expect(parsed.mode).toBe(null);
});

test('buildStatus: without root the developer block is nulls and unknown', async () => {
    noteArmError(null);
    const state = healthy();
    state.root = { root: false, identity: null };
    state.recent_errors = ['root arm: sdbd refused', 'install failed for x.wgt'];

    const status = await buildStatus(probesFor(state));

    expect(status.ok).toBe(true);
    expect(status.developer).toEqual({ mode: null, ip: null, source: 'unknown' });
    expect(status.sdbd.lastArmError).toBe(null);
    expect(status.root).toEqual(state.root);
    expect(status.recent_errors).toEqual(state.recent_errors);
    expect(status.diagnosis).toBe('root channel is not armed — POST /dev/root/arm.');
});

test('buildStatus: a root read refreshes the developer block and caches it', async () => {
    const state = healthy();

    const status = await buildStatus(probesFor(state));

    expect(status.developer).toEqual({ mode: true, ip: '127.0.0.1', source: 'root-read' });
    expect(status.diagnosis).toBe('Everything looks healthy.');
});

test('buildStatus: without root the last reading is too stale to trust — unknown', async () => {
    const state = healthy();
    state.root = { root: false, identity: null };

    const status = await buildStatus(probesFor(state));

    expect(status.developer).toEqual({ mode: null, ip: null, source: 'unknown' });
});

test('buildStatus: a partial root read falls back to the cache', async () => {
    const state = healthy();

    // Seed the in-module last-known cache from a clean read first.
    await buildStatus(probesFor(state));

    const partial = probesFor(state);
    partial.rootExec = async () => '[system] db/sdk/develop/ip = String: 192.168.1.20\nmode = Int32: banana';

    const status = await buildStatus(partial);

    expect(status.developer).toEqual({ mode: true, ip: '127.0.0.1', source: 'last-known' });
});

test('buildStatus: a failing root exec falls back to the cache', async () => {
    noteArmError('injection refused');
    const state = healthy();
    state.root = { root: true, identity: 'agent' };
    state.sdbd.lastArmError = 'injection refused';

    const failing = probesFor(state);
    failing.rootExec = async () => { throw new Error('channel wedged'); };

    const status = await buildStatus(failing);

    expect(status.developer.source).toBe('last-known');
    expect(status.sdbd.lastArmError).toBe('injection refused');
    expect(status.diagnosis).toBe('Everything looks healthy.');

    noteArmError(null);
});

test('buildStatus: the handshake probe runs only when the port is open', async () => {
    const state = healthy();
    state.sdbd.port = 'refused';
    state.sdbd.handshake = 'untested';

    let handshakes = 0;
    const probes = probesFor(state);
    probes.handshake = async () => { handshakes += 1; return 'ok'; };

    const status = await buildStatus(probes);

    expect(handshakes).toBe(0);
    expect(status.sdbd.handshake).toBe('untested');
});

test('noteArmError: a null clears a recorded failure', () => {
    noteArmError('boom');
    const state = healthy();
    state.sdbd.lastArmError = 'boom';

    const status = buildStatus(probesFor(state));

    return status.then((s) => expect(s.sdbd.lastArmError).toBe('boom')).then(() => {
        noteArmError(null);
        const clear = buildStatus(probesFor(state));

        return clear.then((s) => expect(s.sdbd.lastArmError).toBe(null));
    });
});

test('buildStatus: while root is connected the handshake is ok by construction and never probed', async () => {
    const state = healthy();

    let handshakes = 0;
    const probes = probesFor(state);
    probes.handshake = async () => { handshakes += 1; return 'rejected'; };

    const status = await buildStatus(probes);

    expect(handshakes).toBe(0);
    expect(status.sdbd.handshake).toBe('ok');
});

test('buildStatus: without root the handshake probe still runs when the port is open', async () => {
    const state = healthy();
    state.root = { root: false, identity: null };

    let handshakes = 0;
    const probes = probesFor(state);
    probes.handshake = async () => { handshakes += 1; return 'rejected'; };

    const status = await buildStatus(probes);

    expect(handshakes).toBe(1);
    expect(status.sdbd.handshake).toBe('rejected');
});

test('buildStatus: the process probe gets the root exec only while root is connected', async () => {
    const state = healthy();
    const seen = [];
    const probes = probesFor(state);
    probes.scanProc = async (rootExec) => { seen.push(rootExec); return state.sdbd.process; };

    await buildStatus(probes);
    expect(typeof seen[0]).toBe('function');

    state.root = { root: false, identity: null };
    await buildStatus(probes);
    expect(seen[1]).toBe(null);
});

test('realScanProc: the root pidof answer ORs into the sandboxed scan', async () => {
    // The dev machine's /proc has no sdbd, so only the root tier can turn this true.
    expect(await realScanProc(null)).toBe(false);
    expect(await realScanProc(async () => 'yes\n')).toBe(true);
    expect(await realScanProc(async () => 'no\n')).toBe(false);

    const wedged = async () => { throw new Error('channel down'); };
    expect(await realScanProc(wedged)).toBe(false);
});

test('realStremio: probes the injected host and port, not hardcoded loopback', async () => {
    const http = require('http');
    const server = http.createServer((_req, res) => {
        res.end(JSON.stringify({ values: { serverVersion: '4.4.2' } }));
    });
    server.listen(0, '127.0.0.1');

    const result = await realStremio('127.0.0.1', server.address().port);
    server.close();

    expect(result).toEqual({ up: true, serverVersion: '4.4.2' });
});


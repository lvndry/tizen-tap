// Unit tests for the /dev/status doctor: the pure diagnose rules, the
// buxton2ctl line parser, the meminfo and OOM kill parsers, and the
// buildStatus composition over fake probes, so nothing here touches a
// network or /proc.

'use strict';

const { test, expect } = require('bun:test');
const {
    diagnose, parseBuxton2, buildStatus, noteArmError, realScanProc, realStremio,
    parseMeminfo, parseOomKills, OOM_DMESG_COMMAND, STREMIO_PKG_IDS
} = require('../src/routes/status.ts');
const { noteLaunch, recentLaunches, clearLaunches, LAUNCH_RING_CAP } = require('../src/launches.ts');

const OK_MEMINFO =
    'MemTotal:       1648512 kB\n' + // 1610 MB exactly
    'MemFree:         120576 kB\n' + // 118 MB
    'MemAvailable:    483328 kB\n' + // 472 MB
    'SwapTotal:        50176 kB\n' + // 49 MB
    'SwapFree:         49152 kB\n';  // 48 MB

const LOW_MEMINFO =
    'MemTotal:       1648512 kB\n' +
    'MemFree:         102400 kB\n' +
    'MemAvailable:    307200 kB\n' + // 300 MB of 1610 = 18.6% → low
    'SwapTotal:        50176 kB\n' +
    'SwapFree:         49152 kB\n';

const CRITICAL_MEMINFO =
    'MemTotal:       1648512 kB\n' +
    'MemFree:          61440 kB\n' + // 60 MB
    'MemAvailable:     194560 kB\n' + // 190 MB of 1610 ≈ 11.8% → critical
    'SwapTotal:        50000 kB\n' +
    'SwapFree:           12 kB\n';

function healthy() {
    return {
        developer: { mode: true, ip: '127.0.0.1', source: 'root-read' },
        sdbd: { process: true, port: 'open', handshake: 'ok', lastArmError: null },
        root: { root: true, identity: 'agent' },
        services: { homebrew: 'up', stremio: { up: true, serverVersion: '4.4.2' } },
        memory: { total_mb: 1610, free_mb: 118, available_mb: 472, swap_total_mb: 49, swap_free_mb: 48, pressure: 'ok' },
        oom: { kills: [], source: 'root-dmesg' },
        launches: [],
        boot: { uptime_s: 3600, type: 'standby-resume' },
        recent_errors: []
    };
}

// Probes that produce exactly the state given.
function probesFor(state) {
    const execs = [];

    return {
        rootStatus: () => state.root,
        rootExec: async (command) => {
            execs.push(command);
            if (command === OOM_DMESG_COMMAND) {
                // Render the state's kills back into dmesg lines the parser understands.
                if (state.oom.source !== 'root-dmesg') return null;
                return (state.oom.kills || []).map((kill) =>
                    `[${kill.kernel_ts == null ? '0.0' : kill.kernel_ts}] oom_reaper: reaping process ${kill.pid} (${kill.pkg}) skipped`).join('\n');
            }
            return '[system] db/sdk/develop/ip = String: 127.0.0.1\n[system] db/sdk/develop/mode = Int32: 1';
        },
        scanProc: async () => state.sdbd.process,
        portProbe: async () => state.sdbd.port,
        handshake: async () => state.sdbd.handshake,
        stremio: async () => state.services.stremio,
        uptimeSeconds: () => state.boot.uptime_s,
        meminfo: async () => meminfoFor(state.memory),
        launches: () => state.launches,
        recentErrors: () => state.recent_errors,
        execs
    };
}

// Invert the MB rounding for the probes: enough to round back to the same block.
function meminfoFor(memory) {
    if (!memory) return null;

    return 'MemTotal: ' + memory.total_mb * 1024 + ' kB\n' +
        'MemFree: ' + memory.free_mb * 1024 + ' kB\n' +
        'MemAvailable: ' + memory.available_mb * 1024 + ' kB\n' +
        'SwapTotal: ' + memory.swap_total_mb * 1024 + ' kB\n' +
        'SwapFree: ' + memory.swap_free_mb * 1024 + ' kB\n';
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

test('diagnose: a recent OOM kill of a Stremio package beats the plain down rule', () => {
    const state = healthy();
    state.services.stremio = { up: false, serverVersion: null };
    state.oom = {
        kills: [{ kernel_ts: 35467.891, pid: 391, pkg: 'newslO9NqF.stre' }],
        source: 'root-dmesg'
    };

    expect(diagnose(state)).toBe(
        'Stremio server is down and the kernel\'s OOM killer has reaped Stremio processes recently — ' +
        'the TV is out of memory; the service relaunches it, and freeing RAM (TV: Settings → Device care → RAM, ' +
        'or close open apps) is the real fix.');
});

test('diagnose: a kill of an unrelated package keeps the plain down rule', () => {
    const state = healthy();
    state.services.stremio = { up: false, serverVersion: null };
    state.oom = { kills: [{ kernel_ts: 100, pid: 10, pkg: 'com.other.app' }], source: 'root-dmesg' };

    expect(diagnose(state)).toBe('Stremio server is down — relaunch the Tizen Tap app or POST /restart.');
});

test('diagnose: an OOM verdict with critical memory does not repeat the memory rule', () => {
    const state = healthy();
    state.services.stremio = { up: false, serverVersion: null };
    state.oom = { kills: [{ kernel_ts: 100, pid: 391, pkg: 'S6K2WQ8MnP.Strem' }], source: 'root-dmesg' };
    state.memory = { total_mb: 1610, free_mb: 60, available_mb: 190, swap_total_mb: 49, swap_free_mb: 0, pressure: 'critical' };

    const verdict = diagnose(state);

    expect(verdict).toContain('OOM killer has reaped Stremio processes recently');
    expect(verdict).not.toContain('memory pressure is critical');
});

test('diagnose: critical memory without an OOM kill says so', () => {
    const state = healthy();
    state.memory = { total_mb: 1610, free_mb: 60, available_mb: 190, swap_total_mb: 49, swap_free_mb: 0, pressure: 'critical' };

    expect(diagnose(state)).toBe(
        'memory pressure is critical (MemAvailable 190 MB of 1610 MB) — expect services to be killed by the kernel until RAM frees up.');
});

test('diagnose: low memory pressure is not reported', () => {
    const state = healthy();
    state.memory = { total_mb: 1610, free_mb: 118, available_mb: 400, swap_total_mb: 49, swap_free_mb: 48, pressure: 'low' };

    expect(diagnose(state)).toBe('Everything looks healthy.');
});

test('diagnose: critical memory appends after the sdbd problem', () => {
    const state = healthy();
    state.sdbd.port = 'refused';
    state.sdbd.handshake = 'untested';
    state.memory = { total_mb: 1610, free_mb: 60, available_mb: 150, swap_total_mb: 49, swap_free_mb: 0, pressure: 'critical' };

    const verdict = diagnose(state);

    expect(verdict.startsWith('sdbd is not running — toggle Developer Mode')).toBe(true);
    expect(verdict).toContain('Also: memory pressure is critical (MemAvailable 150 MB of 1610 MB)');
    expect(verdict.endsWith('until RAM frees up.')).toBe(true);
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

test('parseMeminfo: a normal reading is ok, in MB', () => {
    expect(parseMeminfo(OK_MEMINFO)).toEqual({
        total_mb: 1610, free_mb: 118, available_mb: 472, swap_total_mb: 49, swap_free_mb: 48, pressure: 'ok'
    });
});

test('parseMeminfo: available under 25% is low, under 10% is critical', () => {
    expect(parseMeminfo(LOW_MEMINFO).pressure).toBe('low');

    // The live reading that caused the outages: ~190 MB available of 1.6 GB.
    expect(parseMeminfo(CRITICAL_MEMINFO)).toEqual({
        total_mb: 1610, free_mb: 60, available_mb: 190, swap_total_mb: 49, swap_free_mb: 0, pressure: 'critical'
    });
});

test('parseMeminfo: an almost-empty swap is critical even with available headroom', () => {
    const text =
        'MemTotal:       1648512 kB\n' +
        'MemFree:          98304 kB\n' +
        'MemAvailable:    520192 kB\n' + // 31%, well above the low line
        'SwapTotal:        50000 kB\n' +
        'SwapFree:           307 kB\n';  // 0.6% of total

    expect(parseMeminfo(text).pressure).toBe('critical');
});

test('parseMeminfo: no swap at all does not trigger the swap rule', () => {
    const text =
        'MemTotal:       1648512 kB\n' +
        'MemFree:          98304 kB\n' +
        'MemAvailable:    520192 kB\n' +
        'SwapTotal:           0 kB\n' +
        'SwapFree:             0 kB\n';

    expect(parseMeminfo(text).pressure).toBe('ok');
});

test('parseMeminfo: unparseable input is null, not a guess', () => {
    expect(parseMeminfo('')).toBe(null);
    expect(parseMeminfo(null)).toBe(null);
});

test('parseOomKills: the oom_reaper and Killed process formats, truncated pkg kept as-is', () => {
    const output =
        '[35467.891012] oom_reaper: reaping process 391 (newslO9NqF.stre) skipped\n' +
        '[35468.002113] Killed process 391 (newslO9NqF.stre) total-vm:524288kB, anon-rss:412672kB, file-rss:0kB\n';

    expect(parseOomKills(output)).toEqual([
        { kernel_ts: 35467.891012, pid: 391, pkg: 'newslO9NqF.stre' },
        { kernel_ts: 35468.002113, pid: 391, pkg: 'newslO9NqF.stre' }
    ]);
});

test('parseOomKills: a line without a kernel timestamp keeps the kill with a null ts', () => {
    const parsed = parseOomKills('oom_reaper: reaping process 777 (bonsoir.svc1) skipped');

    expect(parsed).toEqual([{ kernel_ts: null, pid: 777, pkg: 'bonsoir.svc1' }]);
});

test('parseOomKills: empty or unrelated output yields no kills', () => {
    expect(parseOomKills('')).toEqual([]);
    expect(parseOomKills(null)).toEqual([]);
    expect(parseOomKills('[1.0] out of memory: Killed process 5 (init) total-vm:1kB\n[2.0] something else')).toEqual(
        [{ kernel_ts: 1.0, pid: 5, pkg: 'init' }]);
    expect(parseOomKills('[1.0] no memory trouble here\n[2.0] another line')).toEqual([]);
});

test('STREMIO_PKG_IDS: both ids survive the 15-character truncation', () => {
    for (const id of STREMIO_PKG_IDS) {
        expect(id.length).toBeLessThan(15);
    }
});

test('launch ring: noteLaunch records, recentLaunches orders oldest first, capped at 20', () => {
    clearLaunches();

    for (let i = 0; i < LAUNCH_RING_CAP + 5; i += 1) noteLaunch(`app${i}`, 'periodic check');

    const all = recentLaunches(LAUNCH_RING_CAP);

    expect(all.length).toBe(LAUNCH_RING_CAP);
    expect(all[0].app).toBe('app5'); // the oldest surviving entry
    expect(all[all.length - 1].app).toBe(`app${LAUNCH_RING_CAP + 4}`);
    for (const entry of all) expect(typeof entry.ts).toBe('string');

    const ten = recentLaunches(10);
    expect(ten.length).toBe(10);
    expect(ten[ten.length - 1].app).toBe(`app${LAUNCH_RING_CAP + 4}`);

    clearLaunches();
});

test('buildStatus: without root the developer block is nulls and unknown', async () => {
    noteArmError(null);
    const state = healthy();
    state.root = { root: false, identity: null };
    state.oom = { kills: [], source: 'root-required' };
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
    partial.rootExec = async (command) => command === OOM_DMESG_COMMAND ? '' :
        '[system] db/sdk/develop/ip = String: 192.168.1.20\nmode = Int32: banana';

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

test('buildStatus: the memory and oom blocks appear in the response', async () => {
    clearLaunches();
    noteLaunch('S6K2WQ8MnP.StremioServer', 'periodic check');

    const state = healthy();
    state.oom = { kills: [{ kernel_ts: 35467.891012, pid: 391, pkg: 'newslO9NqF.stre' }], source: 'root-dmesg' };
    state.launches = recentLaunches(10);

    const status = await buildStatus(probesFor(state));

    expect(status.memory).toEqual({
        total_mb: 1610, free_mb: 118, available_mb: 472, swap_total_mb: 49, swap_free_mb: 48, pressure: 'ok'
    });
    expect(status.oom).toEqual(state.oom);
    expect(status.launches).toEqual([{ ts: state.launches[0].ts, app: 'S6K2WQ8MnP.StremioServer', reason: 'periodic check' }]);

    clearLaunches();
});

test('buildStatus: without root the oom block is root-required with empty kills', async () => {
    const state = healthy();
    state.root = { root: false, identity: null };
    state.oom = { kills: [], source: 'root-required' };

    const status = await buildStatus(probesFor(state));

    expect(status.oom).toEqual({ kills: [], source: 'root-required' });
});

test('buildStatus: a failed dmesg scan is root-error, and a dead meminfo is a null memory block', async () => {
    const state = healthy();

    const wedged = probesFor(state);
    wedged.rootExec = async (command) => {
        if (command === OOM_DMESG_COMMAND) throw new Error('root command timed out');
        return '[system] db/sdk/develop/ip = String: 127.0.0.1\n[system] db/sdk/develop/mode = Int32: 1';
    };

    const status = await buildStatus(wedged);
    expect(status.oom).toEqual({ kills: [], source: 'root-error' });

    const noMemory = probesFor(state);
    noMemory.meminfo = async () => { throw new Error('/proc unreadable'); };

    const status2 = await buildStatus(noMemory);
    expect(status2.memory).toBe(null);
});

test('buildStatus: every probe starts before the slowest one resolves', async () => {
    const state = healthy();
    const started = [];
    let releaseStremio;
    const stremioGate = new Promise((done) => { releaseStremio = done; });

    const probes = probesFor(state);
    const original = { rootExec: probes.rootExec, scanProc: probes.scanProc, portProbe: probes.portProbe };
    const gate = (name) => async (...args) => { started.push(name); return original[name](...args); };
    probes.rootExec = gate('rootExec');
    probes.scanProc = gate('scanProc');
    probes.portProbe = gate('portProbe');
    probes.stremio = async () => { started.push('stremio'); await stremioGate; return state.services.stremio; };

    const pending = buildStatus(probes);
    await new Promise((done) => setTimeout(done, 0));

    // The dmesg scan is still pending behind the slow stremio probe, yet it
    // already ran: nothing waited on anything else.
    expect(started).toContain('rootExec');
    expect(started).toContain('scanProc');
    expect(started).toContain('portProbe');
    expect(started).toContain('stremio');

    releaseStremio();
    await pending;
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

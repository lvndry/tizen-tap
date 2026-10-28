// Read-only routes: what the service is, where it is, and what it is doing.
//
// Three audiences, three gates. The television itself (loopback) may read its
// own pairing page and cached state without a PIN; a phone or script needs the
// PIN for logs and the package list; everything else answers a couple of
// questions unauthenticated so a browser tab can tell the service is alive.
//
// GET /dev/status (PIN-gated) is the doctor's view: it probes sdbd, the root
// channel, the companion services and the boot clock, then answers one
// question — what is broken, and what does the fix look like. Every probe is
// injectable into buildStatus so the composition is testable without a
// television.
//
// register(ctx, router) wires the handlers. The context carries the state the
// handlers read: the store, the platform probe, the build facts, the root
// channel, the sdb client, and the network helpers shared with the rest of
// the service.

'use strict';

const { json, failure } = require('../http/respond.ts');
const { ErrorCode } = require('../protocol.ts');

const SDBD_PORT = 26101;
const STREMIO_PORT = 11470;
const PORT_PROBE_MS = 2000;
const STREMIO_PROBE_MS = 2500;
const ROOT_EXEC_MS = 10000;
const COLD_BOOT_MAX_S = 180;
const DEVELOPER_COMMAND = 'buxton2ctl get system db/sdk/develop/ip; buxton2ctl get system db/sdk/develop/mode';

// sdbd runs in the system domain, which the app's /proc view does not cover.
const SDBD_PIDOF_COMMAND = 'pidof sdbd >/dev/null 2>&1 && echo yes || echo no';

// The last reading of the developer-mode settings, kept because a root read is
// only possible while the channel is armed, and the answer still matters after
// the channel drops.
let lastKnown: { ip: string | null, mode: boolean | null } = { ip: null, mode: null };
let lastArmError: string | null = null;

// The arm loop in main.ts records its failures here so /dev/status can say why
// the root channel is down without re-arming on a read.
function noteArmError(message) {
    lastArmError = message ? String(message) : null;
}

// buxton2ctl prints `key = Type: value`, one property per line. Only the two
// developer-mode properties matter; anything unrecognised is left null rather
// than guessed.
function parseBuxton2(output) {
    const result: { ip: string | null, mode: boolean | null } = { ip: null, mode: null };
    const lines = String(output == null ? '' : output).split('\n');

    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i].trim();
        const match = line.match(/=\s*(String|Int32):\s*(.*)$/);
        if (!match) continue;

        const key = line.slice(0, line.indexOf('=')).trim().toLowerCase();
        const value = match[2].trim();

        if (match[1] === 'String' && /(develop[\/ ])?ip$/.test(key)) result.ip = value || null;
        if (match[1] === 'Int32' && /(develop[\/ ])?mode$/.test(key)) {
            const n = Number(value);
            if (value !== '' && Number.isFinite(n)) result.mode = n !== 0;
        }
    }

    return result;
}

const MSG_SDBD_DOWN = 'sdbd is not running — toggle Developer Mode off/on in Settings → General → ' +
    'Developer mode, then wait ~30 s.';
const MSG_IP_MISMATCH = 'sdbd is up but is rejecting the loopback handshake — the Developer Mode IP is ' +
    'set to another machine (often the Mac\'s LAN IP). Set it to 127.0.0.1 in Developer Mode, then ' +
    'toggle the mode off/on.';
const MSG_ROOT_NOT_ARMED = 'root channel is not armed — POST /dev/root/arm.';
const MSG_STREMIO_DOWN = 'Stremio server is down — relaunch the Tizen Tap app or POST /restart.';

// Pure: given a /dev/status state, say what is wrong. The first matching rule
// leads; every other rule that also matches is appended as "Also: …".
function diagnose(state) {
    const rules: string[] = [];

    if (state.sdbd.port === 'refused') {
        rules.push(MSG_SDBD_DOWN);
    } else if (state.sdbd.handshake === 'rejected') {
        rules.push(MSG_IP_MISMATCH);
    }

    const rootNotArmed = !state.root.root && state.sdbd.port === 'open' && state.sdbd.handshake === 'ok';
    const stremioDown = state.services.stremio.up === false;

    if (rootNotArmed) rules.push(MSG_ROOT_NOT_ARMED);
    if (stremioDown) rules.push(MSG_STREMIO_DOWN);

    if (rules.length === 0) return 'Everything looks healthy.';

    const primary = rules.shift();

    if (rules.length === 0) return primary;
    // Each rule already ends in a period; strip them for the joined list and add one.
    const secondary = rules.map((r) => r.replace(/\.$/, '')).join('. ');
    return `${primary} Also: ${secondary}.`;
}

// Assembles the /dev/status response. Every probe is a function the caller
// supplies; the route supplies the real ones, tests supply fakes.
async function buildStatus(probes) {
    const root = probes.rootStatus();

    let developer: { mode: boolean | null, ip: string | null, source: 'root-read' | 'last-known' | 'unknown' } = { mode: null, ip: null, source: 'unknown' };

    if (root.root) {
        try {
            const parsed = parseBuxton2(await probes.rootExec(DEVELOPER_COMMAND));

            if (parsed.ip !== null && parsed.mode !== null) {
                lastKnown = { ip: parsed.ip, mode: parsed.mode };
                developer = { mode: parsed.mode, ip: parsed.ip, source: 'root-read' };
            } else if (lastKnown.ip !== null && lastKnown.mode !== null) {
                developer = { mode: lastKnown.mode, ip: lastKnown.ip, source: 'last-known' };
            }
        } catch (e) {
            if (lastKnown.ip !== null && lastKnown.mode !== null) {
                developer = { mode: lastKnown.mode, ip: lastKnown.ip, source: 'last-known' };
            }
        }
    }

    // The sandboxed /proc scan cannot see sdbd, so while root is armed the probe
    // may fall back to asking root via pidof; otherwise it scans alone.
    const sdbdProcess = await probes.scanProc(root.root ? probes.rootExec : null);
    const port = await probes.portProbe(SDBD_PORT, PORT_PROBE_MS);
    let handshake = 'untested';

    if (port === 'open') {
        // sdbd serves exactly one client session at a time, and the root agent
        // holds that slot while connected — a bare probe from here always loses
        // to it. A live root connection is itself proof the handshake works, so
        // certify ok without probing.
        handshake = root.root ? 'ok' : await probes.handshake();
    }

    const stremio = await probes.stremio();
    const uptime = probes.uptimeSeconds();

    const state = {
        developer,
        sdbd: { process: sdbdProcess, port, handshake, lastArmError },
        root,
        services: { homebrew: 'up', stremio },
        boot: {
            uptime_s: typeof uptime === 'number' ? Math.round(uptime) : null,
            // This firmware's power button is deep sleep, so a fresh /proc/uptime is the only
            // visible sign of a cold boot.
            type: typeof uptime === 'number' && uptime < COLD_BOOT_MAX_S ? 'cold-boot' : 'standby-resume'
        },
        recent_errors: probes.recentErrors()
    };

    return { ok: true, ts: new Date().toISOString(), diagnosis: diagnose(state), ...state };
}

function realPortProbe(port, timeoutMs) {
    return new Promise((resolve) => {
        const socket = require('net').connect({ host: '127.0.0.1', port }, () => {
            socket.destroy();
            resolve('open');
        });

        const timer = setTimeout(() => { socket.destroy(); resolve('timeout'); }, timeoutMs);
        socket.on('error', (error) => {
            clearTimeout(timer);
            resolve(error.code === 'ECONNREFUSED' ? 'refused' : 'timeout');
        });
        socket.on('close', () => clearTimeout(timer));
    });
}

// sdbd is the daemon that owns 26101; its comm line is the process check.
// Two tiers: the app's sandbox (uid 901) can read most /proc/<pid>/comm files
// but not sdbd's — it lives in the system domain — so when a root channel is
// connected the probe also asks root with pidof and ORs the two answers.
function realScanProc(rootExec) {
    const fs = require('fs');
    let found = false;

    try {
        for (const entry of fs.readdirSync('/proc')) {
            if (!/^\d+$/.test(entry)) continue;

            let comm;

            try { comm = fs.readFileSync(`/proc/${entry}/comm`, 'utf8'); }
            catch (e) { continue; }

            if (/sdb/i.test(comm)) found = true;
        }
    } catch (e) {}

    if (found || !rootExec) return Promise.resolve(found);

    return rootExec(SDBD_PIDOF_COMMAND)
        .then((output) => /yes/.test(output))
        .catch(() => false);
}

// One connect through the service's own sdb client, so the classification
// rides the same codes every other part of the service already understands:
// refused is a closed door, anything that dies mid-handshake is a rejection.
function realHandshake() {
    const { connect } = require('../tv/sdb.ts');

    return new Promise((resolve) => {
        connect({ host: '127.0.0.1', port: SDBD_PORT, attempts: 1, timeout: PORT_PROBE_MS })
            .then((session) => { session.close(); resolve('ok'); })
            .catch((error) => {
                const code = error && error.code;
                resolve(code === 'sdbRefused' || code === 'ECONNREFUSED' ? 'refused' : 'rejected');
            });
    });
}

// Tizen gives every app its own network sandbox: the Stremio server's
// 127.0.0.1:11470 is a different loopback than this app's, so a port that is
// LISTENing still answers refused from here. Dial the TV's own LAN address —
// the one the client already uses — and only fall back to loopback when no LAN
// address is visible (dev machine).
function stremioLanHost() {
    try {
        const interfaces: Record<string, any[]> = require('os').networkInterfaces();

        for (const entries of Object.values(interfaces)) {
            for (const entry of entries || []) {
                if ((entry.family === 'IPv4' || entry.family === 4) && !entry.internal) return entry.address;
            }
        }
    } catch (e) {}

    return '127.0.0.1';
}

function realStremio(host, port) {
    return new Promise((resolve) => {
        const req = require('http').get(
            { host: host || stremioLanHost(), port: port || STREMIO_PORT, path: '/settings', timeout: STREMIO_PROBE_MS },
            (res) => {
                let body = '';
                res.on('data', (chunk) => { body += chunk; });
                res.on('end', () => {
                    let version = null;

                    try {
                        const parsed = JSON.parse(body);
                        version = parsed && parsed.values && parsed.values.serverVersion;
                    } catch (e) {}

                    resolve({ up: true, serverVersion: typeof version === 'string' ? version : null });
                });
            });
        req.on('timeout', () => { req.destroy(); resolve({ up: false, serverVersion: null }); });
        req.on('error', () => resolve({ up: false, serverVersion: null }));
    });
}


function realUptimeSeconds() {
    try {
        return Number(require('fs').readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
    } catch (e) {
        return null;
    }
}

// The recorder keeps a bounded in-memory ring, so the whole buffer is readable
// here; the filter narrows it to service-level trouble.
function realRecentErrors(recorded) {
    try {
        return recorded.since(0)
            .filter((line) => line.facility === 'svc' && /error|warn|fail/i.test(line.text))
            .slice(-5)
            .map((line) => line.text);
    } catch (e) {
        return [];
    }
}

function register(ctx, router) {
    const { build, port, startedAt, runtime, device, packages, store, secret } = ctx;

    const { fromLoopback } = ctx;
    function lanAddresses() {
        const interfaces = require('os').networkInterfaces();
        const wiredFirst = (name) => (/^(eth|en)/.test(name) ? 0 : /^(wlan|wl)/.test(name) ? 1 : 2);

        return Object.entries(interfaces)
            .flatMap(([name, entries]: [string, any]) => (entries || [])
                .filter((entry: any) => (entry.family === 'IPv4' || entry.family === 4) && !entry.internal)
                .map((entry) => ({ address: entry.address, iface: name })))
            .sort((a, b) => wiredFirst(a.iface) - wiredFirst(b.iface));
    }

    // What a caller on the television itself is allowed to know: the code, and where to reach this
    // from a phone. The socket says the same thing in its greeting, so the two cannot drift.
    function pairing() {
        const addresses = lanAddresses();

        return {
            pin: secret,
            port,
            addresses: addresses.map((entry) => entry.address),
            url: addresses.length ? `http://${addresses[0].address}:${port}` : null
        };
    }

    const authorise = ctx.authorise;

    function authorisedRead(request, response, handle) {
        if (fromLoopback(request)) return handle();

        const verdict = authorise(request.headers['x-homebrew-pin']);
        if (!verdict.ok) return failure(response, 403, verdict.code, verdict.message);

        return handle();
    }

    function onlyLoopback(request, response, handle) {
        if (!fromLoopback(request)) {
            return failure(response, 403, ErrorCode.UNAUTHORIZED, 'Only readable from the TV itself.');
        }

        return handle();
    }

    router.on.get('/version', (_request, response) => json(response, {
        build,
        node: process.version,
        runtime: runtime.describe(),
        startedAt,
        uptimeSeconds: Math.round((Date.now() - Date.parse(startedAt)) / 1000),

        // The gap between the two is the only visible sign that Tizen reloaded the service.
        processUptimeSeconds: Math.round(process.uptime())
    }));

    router.on.get('/health', (_request, response) => json(response, {
        ok: true,
        port,
        onTv: device.onTv,
        addresses: lanAddresses().map((entry) => entry.address)
    }));

    router.on.get('/pin', (request, response) =>
        onlyLoopback(request, response, () => json(response, pairing())));

    // Served from the last sweep: probing here made the set connect to its own sdbd twelve times a minute.
    router.on.get('/state', (request, response) =>
        onlyLoopback(request, response, () => json(response, store.select('device') || {})));

    router.on.get('/logs', (request, response, { query }) =>
        authorisedRead(request, response, () =>
            json(response, {
                lines: ctx.recorded.since(query.get('since')),
                uptime: ctx.recorded.uptime()
            })));

    router.on.get('/packages', (request, response) =>
        authorisedRead(request, response, () =>
            packages.list().then(
                (list) => json(response, { ok: true, packages: list }),
                (error) => failure(response, 500, error.code || ErrorCode.INTERNAL, error.message))));

    // PIN-gated like the other /dev holes: the diagnosis is read-only, but it
    // walks /proc, connects to sdbd and execs through the root channel.
    function gate(request, response) {
        const verdict = ctx.authorise(request.headers['x-homebrew-pin']);
        if (verdict.ok) return true;

        failure(response, verdict.code === ErrorCode.LOCKED_OUT ? 429 : 403, verdict.code, verdict.message);
        return false;
    }

    router.on.get('/dev/status', async (request, response) => {
        if (!gate(request, response)) return;

        try {
            json(response, await buildStatus({
                rootStatus: () => ctx.root.channel.status(),
                rootExec: (command) => ctx.root.channel.exec(command, ROOT_EXEC_MS)
                    .then((result) => result.stdout + (result.stderr ? `\n[stderr]\n${result.stderr}` : '')),
                scanProc: realScanProc,
                portProbe: realPortProbe,
                handshake: realHandshake,
                stremio: realStremio,
                uptimeSeconds: realUptimeSeconds,
                recentErrors: () => realRecentErrors(ctx.recorded)
            }));
        } catch (error) {
            json(response, { ok: false, error: error.message });
        }
    });

    ctx.pairing = pairing;
    ctx.lanAddresses = lanAddresses;
}

module.exports = { register, buildStatus, diagnose, parseBuxton2, noteArmError, realScanProc, realStremio, stremioLanHost };

// Read-only routes: what the service is, where it is, and what it is doing.
//
// Three audiences, three gates. The television itself (loopback) may read its
// own pairing page and cached state without a PIN; a phone or script needs the
// PIN for logs and the package list; everything else answers a couple of
// questions unauthenticated so a browser tab can tell the service is alive.
//
// register(ctx, router) wires the handlers. The context carries the state the
// handlers read: the store, the platform probe, the build facts, and the
// network helpers shared with the rest of the service.

'use strict';

const { json, failure } = require('../http/respond.ts');
const { ErrorCode } = require('../protocol.ts');

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

    ctx.pairing = pairing;
    ctx.lanAddresses = lanAddresses;
}

module.exports = { register };

// Development endpoints, present only in a HOMEBREW_DEV build: /dev/eval runs
// an expression in the service's scope, /dev/sdb forwards a command to the
// television's sdbd, /dev/shell runs a line of /bin/sh, and /dev/inspect
// opens the remote inspector.
//
// Each one is a hole straight into the machine, so they are PIN-gated and
// logged with the caller and a flattened preview of the input.

'use strict';

const { json, denied, readBody } = require('../http/respond.ts');
const { host } = require('../obs/units.ts');

const MAX_SOURCE = 64 * 1024;
const SHELL_TIMEOUT_MS = 45000;
const SHELL_OUTPUT_LIMIT = 12000;
const SDB_TIMEOUT_MS = 30000;
const DEFAULT_INSPECT_PORT = 9229;

function preview(source) {
    return source.replace(/\s+/g, ' ').slice(0, 200);
}

function register(ctx, router) {
    const { svc, sdb, repl } = ctx;

    function gate(request, response) {
        const verdict = ctx.authorise(request.headers['x-homebrew-pin'], request.socket && request.socket.remoteAddress);
        if (verdict.ok) return true;

        denied(response, verdict);
        return false;
    }

    async function readSource(request) {
    return (await readBody(request, MAX_SOURCE)).toString('utf8');
}

    router.on.post('/dev/eval', async (request, response) => {
        if (!gate(request, response)) return;

        const source = await readSource(request);
        svc.warn(`eval from ${host(request.socket && request.socket.remoteAddress)}: ${preview(source)}`);

        json(response, await repl.evaluate(source));
    });

    router.on.post('/dev/sdb', async (request, response) => {
        if (!gate(request, response)) return;

        const source = await readSource(request);
        svc.warn(`sdb from ${host(request.socket && request.socket.remoteAddress)}: ${preview(source)}`);

        let output;
        try {
            output = await sdb.withSession({ log: (line) => svc.info(line) }, (session) =>
                session.exec(source, {
                    timeout: SDB_TIMEOUT_MS,
                    // sdbd streams; stop once the accumulated output ends on a token rather than mid-token.
                    until: (output) => {
                        const tail = output.trimEnd();
                        return tail.length > 0 && /[A-Za-z0-9:]/.test(tail[tail.length - 1]);
                    }
                }));
        } catch (error) {
            return json(response, { ok: false, error: error.message });
        }

        json(response, { ok: true, output: String(output || '') });
    });

    router.on.post('/dev/shell', async (request, response) => {
        if (!gate(request, response)) return;

        const cmd = (await readSource(request)).trim();
        if (!cmd) return json(response, { ok: false, error: 'empty command' });

        svc.warn(`shell from ${host(request.socket && request.socket.remoteAddress)}: ${preview(cmd)}`);

        // spawnSync: async child_process with stdio streams wedges Tizen's Node 18 event loop.
        const { spawnSync } = require('child_process');

        const result = spawnSync('/bin/sh', ['-c', cmd], { cwd: '/tmp', timeout: SHELL_TIMEOUT_MS });
        const out = (result.stdout || '').toString('utf8');
        const err = (result.stderr || '').toString('utf8');

        json(response, {
            ok: true,
            exit: result.status,
            killed: result.signal ? `SIG${result.signal}` : null,
            output: (out + (err ? '\n[stderr]\n' + err : '')).slice(0, SHELL_OUTPUT_LIMIT)
        });
    });

    router.on.post('/dev/inspect', (request, response) => {
        if (!gate(request, response)) return;

        const opened = repl.openInspector(Number(request.headers['x-homebrew-port']) || DEFAULT_INSPECT_PORT);

        svc.warn(`inspector: ${opened.ok ? `open at ${opened.url}` : opened.error}`);
        json(response, opened);
    });
}

module.exports = { register };

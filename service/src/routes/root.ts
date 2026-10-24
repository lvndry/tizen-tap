// The root endpoints: /dev/root reports the channel's state, /dev/root/arm
// fires the injection that runs the launcher under sdbd's privileges, and
// /dev/root/exec runs a line of /bin/sh as uid 0 through the connected agent.
//
// All three are PIN-gated like the other /dev holes. /dev/root/exec is the
// sharpest one: it is a remote shell as root, on the television, so it is
// logged with the caller and a preview of the command, exactly like
// /dev/shell.

'use strict';

const { json, failure, readBody } = require('../http/respond.ts');
const { host } = require('../obs/units.ts');
const { ErrorCode } = require('../protocol.ts');

const MAX_COMMAND = 8 * 1024;
const EXEC_TIMEOUT_MS = 30000;
const EXEC_TIMEOUT_MAX_MS = 300000;

const preview = (source) => source.replace(/\s+/g, ' ').slice(0, 200);

const register = (ctx, router) => {
    const { sdb, root } = ctx;

    const gate = (request, response) => {
        const verdict = ctx.authorise(request.headers['x-homebrew-pin']);
        if (verdict.ok) return true;

        failure(response, verdict.code === ErrorCode.LOCKED_OUT ? 429 : 403, verdict.code, verdict.message);
        return false;
    };

    router.on.get('/dev/root', (request, response) => {
        if (!gate(request, response)) return;
                json(response, root.channel.status());
    });

    router.on.post('/dev/root/arm', async (request, response) => {
        if (!gate(request, response)) return;

                if (root.channel.status().root) return json(response, { ok: true, already: true, identity: root.channel.status().identity });
        if (root.arming) return json(response, { ok: false, error: 'an arm is already in progress' });

        ctx.svc.warn(`root arm from ${host(request.socket && request.socket.remoteAddress)}`);
        root.arming = true;
        try {
            const identity = await ctx.rootArm(sdb, root.channel, (line) => ctx.svc.info(line));
            json(response, { ok: true, identity });
        } catch (error) {
            json(response, { ok: false, error: error.message });
        } finally {
            root.arming = false;
        }
    });

    router.on.post('/dev/root/exec', async (request, response) => {
        if (!gate(request, response)) return;

                const status = root.channel.status();
        if (!status.root) {
            return json(response, { ok: false, error: 'root channel is not connected; arm first' });
        }

        const command = (await readBody(request, MAX_COMMAND)).toString('utf8').trim();
        if (!command) return json(response, { ok: false, error: 'empty command' });

        const timeout = Math.min(
            Math.max(Number(request.headers['x-homebrew-timeout']) || EXEC_TIMEOUT_MS, 100),
            EXEC_TIMEOUT_MAX_MS
        );

        ctx.svc.warn(`root exec from ${host(request.socket && request.socket.remoteAddress)}: ${preview(command)}`);

        try {
            const result = await root.channel.exec(command, timeout);
            json(response, {
                ok: true,
                exit: result.exit,
                timedOut: result.timedOut,
                output: (result.stdout + (result.stderr ? '\n[stderr]\n' + result.stderr : '')).slice(0, 12000)
            });
        } catch (error) {
            json(response, { ok: false, error: error.message });
        }
    });
};

module.exports = { register };

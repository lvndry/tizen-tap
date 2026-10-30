// The root endpoints: /dev/root reports the channel's state, /dev/root/arm
// fires the injection that runs the launcher under sdbd's privileges,
// /dev/root/exec runs a line of /bin/sh as uid 0 through the connected agent,
// and /dev/root/release hands sdbd's single client session back.
// /dev/root/developer-ip reads or switches sdbd's Host PC IP gate, and
// /dev/processes is the whole TV's process table by memory.
//
// The feature routes never arm: every arm cycle pushes an agent through sdbd,
// and enough of them lock sdbd out, so they answer "root not connected"
// instead and leave the arm to the caller.
//
// All of them are PIN-gated like the other /dev holes. /dev/root/exec is the
// sharpest one: it is a remote shell as root, on the television, so it is
// logged with the caller and a preview of the command, exactly like
// /dev/shell.

'use strict';

const { json, denied, readBody } = require('../http/respond.ts');
const { host } = require('../obs/units.ts');
const developer = require('../root/developer.ts');
const processes = require('../root/processes.ts');

const MAX_COMMAND = 8 * 1024;
const EXEC_TIMEOUT_MS = 30000;
const EXEC_TIMEOUT_MAX_MS = 300000;
const FEATURE_EXEC_MS = 20000;
const MAX_JSON_BODY = 1024;
const ROOT_NOT_CONNECTED = 'root not connected; POST /dev/root/arm first';

function preview(source) {
    return source.replace(/\s+/g, ' ').slice(0, 200);
}

function register(ctx, router) {
    const { sdb, root } = ctx;

    function gate(request, response) {
        const verdict = ctx.authorise(request.headers['x-homebrew-pin'], request.socket && request.socket.remoteAddress);
        if (verdict.ok) return true;

        denied(response, verdict);
        return false;
    }

    function connected(response) {
        if (root.channel.status().root) return true;

        json(response, { ok: false, error: ROOT_NOT_CONNECTED });
        return false;
    }

    function exec(command, timeout = FEATURE_EXEC_MS) {
        return root.channel.exec(command, timeout);
    }

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

    // The connected agent holds sdbd's single client session. The installer
    // releases it by itself when it needs sdb; this is for anything else that
    // wants sdbd back by hand. Root stays off until POST /dev/root/arm.
    router.on.post('/dev/root/release', async (request, response) => {
        if (!gate(request, response)) return;

        ctx.svc.warn(`root release from ${host(request.socket && request.socket.remoteAddress)}`);
        try {
            await root.channel.release();
            json(response, { ok: true });
        } catch (error) {
            json(response, { ok: false, error: error.message });
        }
    });

    router.on.get('/dev/root/developer-ip', async (request, response) => {
        if (!gate(request, response)) return;
        if (!connected(response)) return;

        try {
            json(response, { ok: true, ip: await developer.readDeveloperIp(exec) });
        } catch (error) {
            json(response, { ok: false, error: error.message });
        }
    });

    router.on.post('/dev/root/developer-ip', async (request, response) => {
        if (!gate(request, response)) return;
        if (!connected(response)) return;

        let ip;
        try {
            ip = JSON.parse((await readBody(request, MAX_JSON_BODY)).toString('utf8')).ip;
        } catch (error) {
            return json(response, { ok: false, error: 'body must be JSON like {"ip":"127.0.0.1"}' }, 400);
        }

        ctx.svc.warn(`developer ip switch to ${String(ip)} from ${host(request.socket && request.socket.remoteAddress)}`);

        await developer.changeDeveloperIp({
            exec,
            ip,
            respond: (code, body) => json(response, body, code),
            log: (line) => ctx.svc.warn(line)
        });
    });

    router.on.get('/dev/processes', async (request, response, { query }) => {
        if (!gate(request, response)) return;

        const limit = processes.parseLimit(query.get('limit'));
        if (limit === null) {
            return json(response, { ok: false, error: `limit must be an integer from 1 to ${processes.MAX_LIMIT}` }, 400);
        }

        if (!connected(response)) return;

        try {
            const result = await exec(processes.PROCESSES_COMMAND);
            json(response, { ok: true, at: new Date().toISOString(), ...processes.parseProcesses(result.stdout, limit) });
        } catch (error) {
            json(response, { ok: false, error: error.message });
        }
    });
}

module.exports = { register };

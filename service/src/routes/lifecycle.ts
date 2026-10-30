// The service's own on/off switches: /restart and /shutdown.
//
// Exiting is all the service can do about its own lifetime — it has no
// privilege to stop a sibling application. What brings it back is the
// firmware: a *clean* exit(0) leaves it down, but an *abnormal* exit (non-
// zero code) trips config.xml's auto-restart="true", which a Tizen 6 Samsung
// honours (verified on CU7105). So /restart exits non-zero to come back in a
// few seconds; /shutdown exits cleanly to stay down.

'use strict';

const { json, failure } = require('../http/respond.ts');
const { took, host } = require('../obs/units.ts');
const { ErrorCode } = require('../protocol.ts');

function register(ctx, router) {
    const { build, sdb, svc, recorded } = ctx;

    function exitAfterResponse(payload, asked, why, restart) {
    return (request, response) => {
        const verdict = ctx.authorise(request.headers['x-homebrew-pin']);

        if (!verdict.ok) {
            return failure(response, verdict.code === ErrorCode.LOCKED_OUT ? 429 : 403, verdict.code, verdict.message);
        }

        json(response, { ok: true, build, ...payload });

        svc.warn(`${host(request.socket && request.socket.remoteAddress)} asked the service to ${asked}`);

        // sdbd is told the connection is going, rather than finding out from a reset when this exits.
        sdb.release();

        // The response has to clear the socket first, because the caller waits on it.
        setTimeout(() => {
            svc.info(`exiting after ${took(recorded.uptime())} ${why}`);
            recorded.recordExit(restart ? 'restart requested' : 'shutdown requested');

            if (restart) {
                // An uncaught throw is what reliably trips auto-restart on this firmware;
                // a non-zero exit code is flaky. Let the callback throw so the process dies.
                throw new Error('homebrew restart');
            }
            process.exit(0);
        }, 300);
    };
}

    router.on.post('/restart', exitAfterResponse(
        { restarting: true }, 'restart', 'so auto-restart reloads it on new code', true));

    router.on.post('/shutdown', exitAfterResponse(
        { stopping: true }, 'stop', 'because someone asked it to', false));
}

module.exports = { register };

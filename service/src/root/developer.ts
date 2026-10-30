// The Host PC IP switch: sdbd only accepts connections from the address in
// buxton2's db/sdk/develop/ip, and reads it once, when it starts. Setting the
// key as root and restarting sdbd changes the gate without a TV reboot.
//
// The restart runs last, after the caller has its answer: the root agent runs
// under sdbd's tarlauncher, so restarting sdbd usually kills the very agent
// executing the restart, and nothing after that call can be relied on.

'use strict';

const { parseBuxton2, noteDeveloperIp } = require('../routes/status.ts');

const DEVELOPER_IP_KEY = 'db/sdk/develop/ip';
const READ_COMMAND = `buxton2ctl get system ${DEVELOPER_IP_KEY}`;
const RESTART_COMMAND = 'systemctl restart sdbd';
const SELF_INSTALL_IP = '127.0.0.1';
const RESTART_TIMEOUT_MS = 15000;

const RESTART_NOTE = 'sdbd is restarting to load the new value. The root agent runs under sdbd, so the ' +
    'root channel will likely disconnect; POST /dev/root/arm to bring it back.';
const NOT_SELF_INSTALL_WARNING = `The Host PC IP is no longer ${SELF_INSTALL_IP}: this TV cannot install its own ` +
    `apps until it is set back to ${SELF_INSTALL_IP}.`;

// Strict: four decimal octets, 0-255, no leading zeros (a zero-padded octet
// is read as octal by some parsers, so it is ambiguous, not merely untidy).
function isDottedQuad(value) {
    if (typeof value !== 'string') return false;

    const octets = value.split('.');
    if (octets.length !== 4) return false;

    return octets.every((octet) => /^(0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255);
}

async function readDeveloperIp(exec) {
    const result = await exec(READ_COMMAND);
    if (result.exit !== 0) throw new Error(`buxton2ctl get failed (exit ${result.exit}): ${result.stderr.trim()}`);

    return parseBuxton2(result.stdout).ip;
}

// `exec` runs one root command and resolves to { exit, stdout, stderr };
// `respond` is called exactly once, before the restart is attempted.
async function changeDeveloperIp({ exec, ip, respond, log }) {
    if (!isDottedQuad(ip)) {
        respond(400, { ok: false, error: 'ip must be a dotted quad, each octet 0-255 (e.g. 127.0.0.1)' });
        return;
    }

    let before;
    let after;

    try {
        before = await readDeveloperIp(exec);

        const set = await exec(`buxton2ctl set-string system ${DEVELOPER_IP_KEY} ${ip}`);
        if (set.exit !== 0) throw new Error(`buxton2ctl set-string failed (exit ${set.exit}): ${set.stderr.trim()}`);

        after = await readDeveloperIp(exec);
    } catch (error) {
        log(`developer ip: ${error.message}`);
        respond(200, { ok: false, before: before === undefined ? null : before, error: error.message });
        return;
    }

    if (after !== ip) {
        log(`developer ip: wrote ${ip} but read back ${after}; sdbd left alone`);
        respond(200, { ok: false, before, after, error: `wrote ${ip} but read back ${after}; sdbd was not restarted` });
        return;
    }

    const body: any = { ok: true, before, after, restart: RESTART_NOTE };
    if (after !== SELF_INSTALL_IP) body.warning = NOT_SELF_INSTALL_WARNING;

    noteDeveloperIp(after);
    log(`developer ip: ${before} -> ${after}; restarting sdbd (the root channel will likely drop)`);
    respond(200, body);

    try {
        const restart = await exec(RESTART_COMMAND, RESTART_TIMEOUT_MS);
        log(`developer ip: systemctl restart sdbd exited ${restart.exit}${restart.stderr ? `: ${restart.stderr.trim()}` : ''}`);
    } catch (error) {
        log(`developer ip: sdbd restart took the root channel with it (${error.message}), as expected`);
    }
}

module.exports = {
    isDottedQuad, readDeveloperIp, changeDeveloperIp,
    READ_COMMAND, RESTART_COMMAND, SELF_INSTALL_IP, NOT_SELF_INSTALL_WARNING
};

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
// The self-heal runs inside a live root session: a synchronous restart would
// kill the very agent executing it before the exec can answer. Detached, the
// exec returns first, sdbd drops the channel on its way out, and the re-arm
// that follows finds a clean, freshly-started daemon.
const HEAL_RESTART_COMMAND = 'setsid sh -c "sleep 2; systemctl restart sdbd" >/dev/null 2>&1 &'
const SELF_INSTALL_IP = '127.0.0.1';
const RESTART_TIMEOUT_MS = 15000;

const RESTART_NOTE = 'sdbd is restarting to load the new value. The root agent runs under sdbd, so the ' +
    'root channel will likely disconnect; POST /dev/root/arm to bring it back.';
const NOT_SELF_INSTALL_WARNING = `The Host PC IP is no longer ${SELF_INSTALL_IP}: this TV cannot install its own ` +
    `apps until it is set back to ${SELF_INSTALL_IP}.`;

// The gate is frozen at the loopback address. sdbd has no per-connection key
// challenge: the developer IP equality check IS the authorization, and it
// accepts exactly one source address. The service's root arm dials sdbd over
// loopback, so the gate must stay at 127.0.0.1 or the service cannot install
// its own apps or re-arm root. A cold boot resets the key to 127.0.0.1 anyway,
// but the TV's dialog writes whatever address was in it before, so the value
// is not trustworthy. Self-healing it at boot makes the dialog optional.
//
// 0.0.0.0 is deliberately not used: it is sdbd's "unset" value, and on the
// firmware where it acts as a wildcard it would let every device on the LAN
// — phones, guests, IoT — through a gate that otherwise hands out uid 0.
async function ensureLoopbackGate({ exec, log }) {
    let current;

    try {
        current = await readDeveloperIp(exec);
    } catch (error) {
        log(`loopback gate: could not read the developer ip (${error.message}); left alone`);
        return { changed: false, reason: `unreadable: ${error.message}` };
    }

    if (current === SELF_INSTALL_IP) return { changed: false };

    try {
        const set = await exec(`buxton2ctl set-string system ${DEVELOPER_IP_KEY} ${SELF_INSTALL_IP}`);
        if (set.exit !== 0) throw new Error(`buxton2ctl set-string failed (exit ${set.exit}): ${set.stderr.trim()}`);

        const after = await readDeveloperIp(exec);
        if (after !== SELF_INSTALL_IP) throw new Error(`wrote ${SELF_INSTALL_IP} but read back ${after}`);

        noteDeveloperIp(after);
        log(`loopback gate: self-healed ${current} -> ${SELF_INSTALL_IP}; restarting sdbd in the background (the root channel will drop)`);

        await exec(HEAL_RESTART_COMMAND, 5000);
    } catch (error) {
        // The value may already be written even when this throws — a failed
        // dispatch just means sdbd keeps the old gate until its next restart.
        log(`loopback gate: self-heal to ${SELF_INSTALL_IP} failed (${error.message}); the gate may already be set`);
        return { changed: false, reason: error.message };
    }

    return { changed: true, before: current, after: SELF_INSTALL_IP };
}

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
        isDottedQuad, readDeveloperIp, changeDeveloperIp, ensureLoopbackGate,
        READ_COMMAND, RESTART_COMMAND, HEAL_RESTART_COMMAND, SELF_INSTALL_IP, NOT_SELF_INSTALL_WARNING
};

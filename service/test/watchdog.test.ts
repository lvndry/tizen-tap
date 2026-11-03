// ensureWatchdog ships the watchdog script (WATCHDOG_SCRIPT) and the systemd
// unit, and keeps the running service active. The script is the source of
// truth for the liveness + relaunch rules that the 2026-11-03 outage proved
// out, so pin the exact properties that fixed it:
//
//   - liveness is the port, not the Control API "running" flag (the page
//     process can stay alive after the service dies)
//   - relaunch is stop-then-launch (a launch is a no-op against an app the
//     Control API still believes is running)
//   - the Stremio server is only stopped when already down (a playing stream
//     must not be interrupted)

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { ensureWatchdog, WATCHDOG_SCRIPT, SCRIPT_PATH, TOKEN_PATH, UNIT_PATH } = require('../src/root/watchdog.ts');

// Run ensureWatchdog against a recorded exec, returning the command.
async function runEnsure(logs) {
    const calls = [];
    let out = 'active';
    const exec = async (command) => {
        calls.push(command);
        return { exit: 0, stdout: out + '\n', stderr: '' };
    };
    const log = (message) => logs.push(message);
    const state = await ensureWatchdog({ exec, log });
    return { state, calls, logs };
}

test('shipped script treats the port as the liveness source', () => {
    // app_down consults only the port; the Control API running flag is gone.
    assert.match(WATCHDOG_SCRIPT, /app_down\(\) \{\s*port_open "\$2" \|\| return 0/);
    assert.doesNotMatch(WATCHDOG_SCRIPT, /running/);
    assert.match(WATCHDOG_SCRIPT, /TAP=GJBBYNLkgP\.TizenHomebrew/);
    assert.match(WATCHDOG_SCRIPT, /STREMIO=S6K2WQ8MnP\.StremioServer/);
    assert.match(WATCHDOG_SCRIPT, /app_down "\$TAP"      8091/);
    assert.match(WATCHDOG_SCRIPT, /app_down "\$STREMIO"  11470/);
});

test('shipped script relaunches stop-then-launch, and never stops a playing Stremio', () => {
    // Stop is a DELETE, launch a POST, both against the full app id.
    assert.match(WATCHDOG_SCRIPT, /ca_stop\(\) \{ curl -s -m 10 -X DELETE/);
    assert.match(WATCHDOG_SCRIPT, /ca_launch\(\) \{ curl -s -m 15 -X POST/);
    // Scope the checks to the relaunch() body so case/glob patterns elsewhere
    // (e.g. the cooldown's *[!0-9]*) cannot shadow the anchors.
    const relaunch = WATCHDOG_SCRIPT.slice(
        WATCHDOG_SCRIPT.indexOf('relaunch() {'),
        WATCHDOG_SCRIPT.indexOf('prune_cache() {')
    );
    // The Stremio branch keeps a live server playing: launch only.
    assert.match(relaunch, /"\$STREMIO"\)[\s\S]*if port_open 11470; then[\s\S]*ca_launch "\$1"[\s\S]*else[\s\S]*ca_stop "\$1"/);
    // The default (TAP) branch always stops first, so a wedged page process is cleared.
    assert.match(relaunch, /\*\)[\s\S]*ca_stop "\$1"[\s\S]*sleep 2[\s\S]*ca_launch "\$1"/);
});
test('ensureWatchdog ships the script base64 and reuses it when unchanged', async () => {
    const logs = [];
    const { state, calls } = await runEnsure(logs);
    assert.equal(state, 'active');
    assert.equal(calls.length, 1);
    const command = calls[0];
    // Token is still a precondition; the script is always (re)written from
    // code, never just checked.
    assert.match(command, new RegExp(`\\[ ! -s ${TOKEN_PATH} \\]`));
    assert.match(command, /base64 -d > "\$tmp"/);
    assert.match(command, /cmp -s "\$tmp" /);
    // The base64 payload decodes back to exactly the shipped script.
    const b64 = command.match(/echo -n '([A-Za-z0-9+/=]+)' \| base64 -d/)[1];
    assert.equal(Buffer.from(b64, 'base64').toString('utf8'), WATCHDOG_SCRIPT);
    // Content-diff guard: an unchanged script does not restart the service.
    assert.match(command, /systemctl restart tv-watchdog/);
    assert.match(command, /systemctl is-active tv-watchdog/);
    // The unit still dot-sources (UEP cannot exec an unsigned file directly).
    assert.match(command, /WDEOF/);
});

test('ensureWatchdog is a no-op when the Control API token is missing', () => {
    const logs = [];
    let out = 'missing';
    const exec = async () => ({ exit: 0, stdout: out + '\n', stderr: '' });
    const state = ensureWatchdog({ exec, log: (m) => logs.push(m) });
    return state.then((s) => {
        assert.equal(s, null);
        assert.match(logs.join(' '), /missing/);
    });
});

// Boot persistence for the homebrew watchdog. The watchdog script and the
// Control API token live under /opt/etc/watchdog — the only writable area on
// the TV that survives a reboot — but a systemd unit must sit in
// /run/systemd/system, the only unit path on this TV that is both writable and
// scanned; /run is tmpfs and is wiped on every boot. So after each successful
// arm — the first of which happens right after a cold boot — recreate the unit
// and make sure it is running.
//
// The unit is intentionally small: it dot-sources the script (Tizen's UEP
// refuses to exec an unsigned file directly, even through /bin/sh) and leaves
// the Restart policy to the unit, so a killed watchdog comes back on its own.
//
// Fire and forget: a failure here must never block an arm. The watchdog is a
// convenience; without it the apps still run, they just stay dead longer.

'use strict';

const SCRIPT_PATH = '/opt/etc/watchdog/tv-watchdog.sh';
const TOKEN_PATH = '/opt/etc/watchdog/ca.token';
const UNIT_PATH = '/run/systemd/system/tv-watchdog.service';
const ENSURE_TIMEOUT_MS = 15000;

const UNIT_BODY = [
    '[Unit]',
    'Description=TV homebrew watchdog (Tizen Tap + Stremio server)',
    'After=network.target',
    '',
    '[Service]',
    `ExecStart=/bin/sh -c ". ${SCRIPT_PATH}"`,
    'Restart=always',
    'RestartSec=3',
    ''
].join('\n');

// `exec` runs one root command and resolves to { exit, stdout, stderr }.
// Resolves to the final `systemctl is-active` value, or null when skipped.
async function ensureWatchdog({ exec, log }) {
    const command =
        `if [ ! -s ${SCRIPT_PATH} ] || [ ! -s ${TOKEN_PATH} ]; then echo missing; exit 0; fi; ` +
        `cat > ${UNIT_PATH} <<'WDEOF'\n${UNIT_BODY}WDEOF\n` +
        'systemctl daemon-reload; ' +
        'systemctl is-active tv-watchdog >/dev/null 2>&1 || systemctl start tv-watchdog; ' +
        'echo $(systemctl is-active tv-watchdog)';

    try {
        const result = await exec(command, ENSURE_TIMEOUT_MS);
        const state = (result.stdout || '').trim();
        if (result.exit === 0 && state !== 'missing') {
            log(`watchdog: ensured (${state})`);
            return state;
        }
        log(`watchdog: ensure returned exit ${result.exit}: ${(result.stdout || result.stderr || '').trim()}`);
    } catch (error) {
        log(`watchdog: ensure failed (${error.message}); left alone`);
    }
    return null;
}

module.exports = {
    ensureWatchdog, SCRIPT_PATH, TOKEN_PATH, UNIT_PATH
};

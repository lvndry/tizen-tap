// Boot persistence for the homebrew watchdog. The watchdog script and the
// Control API token live under /opt/etc/watchdog — the only writable area on
// the TV that survives a reboot — but a systemd unit must sit in
// /run/systemd/system, the only unit path on this TV that is both writable and
// scanned; /run is tmpfs and is wiped on every boot. So after each successful
// arm — the first of which happens right after a cold boot — rewrite the
// script, recreate the unit, and make sure it is running.
//
// The script itself is the source of truth for what the watchdog does
// (WATCHDOG_SCRIPT below) and is rewritten on every ensure, so a manual edit
// on the TV never drifts from the code. It is shipped base64 to keep a ~4 KB
// shell script out of any quoting problem in the arm channel, and only
// replaced when its content actually differs, so an ensure never needlessly
// restarts a healthy watchdog.
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

// The watchdog, as a root shell script. Liveness is the port (a closed port
// means down — the Control API's "running" flag tracks the app's page process
// and can stay up after the service has died). Relaunch is stop-then-launch,
// because a launch is a no-op while the Control API still thinks the app is
// running. The Stremio server is only stopped when already down: stopping a
// playing server would interrupt the stream.
const WATCHDOG_SCRIPT = `#!/bin/sh
# Root-owned watchdog for the Tizen homebrew stack. Runs as a root systemd
# service (Restart=always) in the system namespace, so Tizen's per-app
# stability monitor — which kills apps in the owner namespace under load —
# cannot take it down the way it kills the Stremio server and Tizen Tap.
#
# Liveness is the port; relaunch is stop-then-launch. See the comments in
# service/src/root/watchdog.ts where this script is defined.

CA=http://127.0.0.1:8001/api/v2/
TOK=/opt/etc/watchdog/ca.token
TAP=GJBBYNLkgP.TizenHomebrew
STREMIO=S6K2WQ8MnP.StremioServer
CACHE=/opt/usr/home/owner/apps_rw/S6K2WQ8MnP/data/stremio-server
CAP_MB=800
LOG=/opt/var/tv-watchdog.log
LASTDIR=/opt/etc/watchdog/last
COOLDOWN=90

mkdir -p "\$LASTDIR" 2>/dev/null
TOKEN=$(cat "\$TOK" 2>/dev/null)

note() { echo "[$(date '+%m-%d %H:%M:%S')] \$*" >> "\$LOG" 2>/dev/null; }

# A listening port answers immediately; a down app is refused just as fast.
port_open() {
    (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null || return 1
    exec 3>&- 2>/dev/null
    return 0
}

# The port is the liveness source: closed means down, full stop.
app_down() {
    port_open "$2" || return 0
    return 1
}

ca_stop() { curl -s -m 10 -X DELETE -H "Authorization: Bearer $TOKEN" "$CA/applications/$1" -o /dev/null 2>/dev/null; }
ca_launch() { curl -s -m 15 -X POST -H "Authorization: Bearer $TOKEN" "$CA/applications/$1" -o /dev/null 2>/dev/null; }

relaunch() {
    # Per-app cooldown: skip if we already tried within COOLDOWN seconds, so a
    # slow start does not get relaunched on every pass.
    f="$LASTDIR/$1"
    now=$(date +%s)
    if [ -f "$f" ]; then
        last=$(cat "$f" 2>/dev/null)
        case "$last" in ''|*[!0-9]*) last=0 ;; esac
        [ $(( now - last )) -lt "$COOLDOWN" ] && return 0
    fi
    echo "$now" > "$f" 2>/dev/null
    case "$1" in
        "$STREMIO")
            # A healthy server is playing: never stop it.
            if port_open 11470; then
                note "relaunch $1 (launch, still up)"
                ca_launch "$1"
            else
                note "relaunch $1 (stop+launch)"
                ca_stop "$1"
                sleep 2
                ca_launch "$1"
            fi
            ;;
        *)
            # Stop first: it kills a wedged page process, which is what makes
            # the following launch actually start the service again.
            note "relaunch $1 (stop+launch)"
            ca_stop "$1"
            sleep 2
            ca_launch "$1"
            ;;
    esac
}

prune_cache() {
    [ -d "$CACHE" ] || return 0
    total=$(du -skm "$CACHE" 2>/dev/null | tail -1 | cut -f1)
    [ -n "$total" ] && [ "$total" -ge "$CAP_MB" ] || return 0
    n1=$(find "$CACHE" -type f 2>/dev/null | wc -l)
    sleep 6
    n2=$(find "$CACHE" -type f 2>/dev/null | wc -l)
    [ "$n1" = "$n2" ] || return 0
    before=$(du -skm "$CACHE" 2>/dev/null | tail -1 | cut -f1)
    find "$CACHE" -mindepth 1 -maxdepth 1 -type d -exec rm -rf {} + 2>/dev/null
    after=$(du -skm "$CACHE" 2>/dev/null | tail -1 | cut -f1)
    note "cache pruned \${before}MB -> \${after}MB"
}

note "watchdog started (pid \$\$)"
while :; do
    app_down "$TAP"      8091  || relaunch "$TAP"
    app_down "$STREMIO"  11470 || relaunch "$STREMIO"
    prune_cache
    sleep 20
done
`;

// `exec` runs one root command and resolves to { exit, stdout, stderr }.
// Resolves to the final `systemctl is-active` value, or null when skipped.
async function ensureWatchdog({ exec, log }) {
    const scriptB64 = Buffer.from(WATCHDOG_SCRIPT, 'utf8').toString('base64');
    const command =
        `if [ ! -s ${TOKEN_PATH} ]; then echo missing; exit 0; fi; ` +
        `tmp=$(mktemp); echo -n '${scriptB64}' | base64 -d > "$tmp"; ` +
        `if cmp -s "$tmp" ${SCRIPT_PATH}; then rm -f "$tmp"; ` +
        `else cat > ${UNIT_PATH} <<'WDEOF'\n${UNIT_BODY}WDEOF\n` +
        `mv "$tmp" ${SCRIPT_PATH}; chmod 644 ${SCRIPT_PATH}; systemctl daemon-reload; ` +
        `systemctl restart tv-watchdog >/dev/null 2>&1; fi; ` +
        `systemctl is-active tv-watchdog >/dev/null 2>&1 || systemctl start tv-watchdog; ` +
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
    ensureWatchdog, WATCHDOG_SCRIPT, SCRIPT_PATH, TOKEN_PATH, UNIT_PATH
};

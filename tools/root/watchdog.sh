#!/bin/sh
# Root watchdog: self-heals the TV's homebrew stack after any wake event.
#
# Installed to /home/owner/share/tmp/sdk_tools/watchdog.sh and spawned
# detached as uid 0 (see docs/boot-watchdog.md). The CU7105 "power button"
# is a standby resume, not a cold boot (uptime keeps counting), so the
# on-boot="true" app attribute and the service's isBootStart() gate never
# fire on normal usage. This watchdog does not care why the stack is down —
# boot, standby, crash, or OTA: it just brings it back.
#
# Chain it keeps alive:
#   sdbd            -> the root channel arm path (appinstall via 127.0.0.1:26101)
#   homebrew service -> companion-revive (stremio + bonsoir) + root auto-arm
#
# Single-instance via pidfile; dies with the TV and is re-spawned at the
# next root arm if the TV was truly cold-booted.

W=/home/owner/share/tmp/sdk_tools

if [ -f "$W/watchdog.pid" ] && kill -0 "$(cat "$W/watchdog.pid" 2>/dev/null)" 2>/dev/null; then
  exit 0
fi
echo $$ > "$W/watchdog.pid"

while :; do
  if ! pidof sdbd >/dev/null 2>&1; then
    ( systemctl restart sdbd 2>/dev/null || /usr/sbin/launch_sdbd.sh 2>/dev/null ) &
  fi
  if ! curl -s -m 3 -o /dev/null http://127.0.0.1:8091/; then
    /usr/bin/app_launcher -s GJBBYNLkgP.TizenHomebrew 2>/dev/null
  fi
  sleep 30
done

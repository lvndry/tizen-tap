# Root on the TV

The homebrew service can run commands as **uid 0** on the TV. It reaches
the TV's sdb daemon over a signed agent (see
[sdbd-and-root.md](sdbd-and-root.md) for how that works) and runs a line of
`/bin/sh` over a loopback channel, PIN-gated:

```sh
# run a command as root
curl -X POST -H "x-homebrew-pin: $PIN" --data "id" \
  http://<tv>:8091/dev/root/exec

# channel state
curl -H "x-homebrew-pin: $PIN" http://<tv>:8091/dev/root

# re-arm after a drop
curl -X POST -H "x-homebrew-pin: $PIN" http://<tv>:8091/dev/root/arm
```

Root is **volatile**: it dies on every power cycle and the service
re-arms it automatically at its next start (a few retries, with
`POST /dev/root/arm` as the manual fallback). Nothing on the TV needs to
be installed — the agent is signed and staged at build time.

This root path is **board- and firmware-specific** — cracked on a 2023
Tizen 6.5 board (KSU2E / CU7105), needs Developer Mode, and a different
board or a newer firmware may not offer the same entry points. `GET
/dev/status` reports the handshake state, so you find out before anything
else does.

## Self-healing around root

- **Root re-arms after every power cycle** via a sdb injection that runs
  the signed agent under sdbd's privileges. If the channel drops for
  another reason (a wgt self-install does), `POST /dev/root/arm`.
- **Stremio and Bonsoir revive** — the service probes their ports on
  every start and on a 60 s sweep, and relaunches whatever is silent.
- **`GET /dev/status` says when something didn't heal** instead of
  leaving you to find out.

The **root watchdog** (`tools/root/watchdog.sh`) is the safety net for the
cases those miss: on this firmware the power button is a standby resume,
not a boot, so the platform's `on-boot` flag fires for neither. It's
designed and in the repo but **not yet installable on the CU7105** — a
detached root process doesn't survive the root channel, UEP blocks
unsigned scripts, and the system dirs are read-only. Until that lands,
auto-arm + revive is the net, and `/dev/status` names the gap if it ever
bites.

## What it unlocks

The app sandbox can see almost nothing: its own processes, and little else.
Root sees the whole TV.

### 1. See who is using the RAM, and who the OOM killer will take

A mid-range TV has about 1.5 GB of RAM shared by the OS, every preinstalled
app, and anything you install. When it runs out, the kernel kills processes
in order of `oom_score_adj`, highest first. Root can see all of it:

```sh
grep -E 'MemTotal|MemAvailable|SwapFree' /proc/meminfo
dmesg | grep -iE 'oom|killed process' | tail
for p in $(ls /proc | grep -E '^[0-9]+$'); do
  echo "$(awk '/VmRSS/{print $2}' /proc/$p/status 2>/dev/null) $(cat /proc/$p/oom_score_adj 2>/dev/null) $(cat /proc/$p/comm 2>/dev/null)"
done | sort -rn | head -20
```

Measured on the CU7105 (Tizen 6.5), 2026-10-30:

| Who | RAM | `oom_score_adj` |
| --- | --- | --- |
| Samsung system apps (csfs, Home Media, menu, sidebar, quick launch) | 34 to 101 MB each | 200 to 360 |
| Cached apps (TV Plus, Netflix, Prime Video, Store, HbbTV, ...) | about 150 MB together | 750 |
| Tizen Tap and the Stremio server (UI processes) | 23 to 27 MB each | 630 to 750 |
| Tizen Tap and Stremio services | (inside `wrt-service`) | 290 |
| Protected daemons (bms-service, slive-provider, the root agent) | about 23 MB each | -900 |
| Window manager, tv-viewer, loaders | | -1000 |

So under pressure the kernel takes the cached apps first, and ours next.

**Raising our priority does not work on this firmware.** Writing `-900` to
`/proc/<pid>/oom_score_adj` of an app process returns success, but the
value does not change; the older `/proc/<pid>/oom_adj` write is refused.
Only the writing process's own score (`/proc/self`) changes. Smack's
`onlycap` is empty, so it is not Smack; the firmware's memory manager
appears to own app scores. Earlier versions of this page recommended the
write; it has no effect.

### 2. The preloaded apps are not worth killing

Samsung keeps Netflix, YouTube and Prime Video running in the background
so they open instantly. On the CU7105 they hold 12 to 26 MB each, at
`oom_score_adj` 750: they are already the first thing the kernel frees
under pressure, so closing them buys little. `node apps.js --close` (in the
toolbox) does it without root if you want to anyway; they come back on
their own after a boot or a Smart Hub reset.

The big users are Samsung's own system apps (`csfs` alone is about 100 MB).
Killing those breaks the TV's own interface, and the platform respawns
them.

Our own pages are not on that list any more: the Tizen Tap UI and the
Stremio page exit once their service is up instead of hiding (hidden, they
held 110 MB and 72 MB, the two largest processes on the TV).

### 3. Read and write the settings database

The TV's persistent settings live in the `buxton2` database, and the
developer-mode values (host IP, mode) are just keys in it:

```sh
buxton2ctl get system db/sdk/develop/ip
buxton2ctl set-string system db/sdk/develop/ip 127.0.0.1
buxton2ctl set-int32 system db/sdk/develop/mode 1
systemctl restart sdbd
```

With root, the on-screen Developer Mode dialog becomes optional — and
values set here survive reboots.

### 4. Inspect the firmware

Root can read the entire system tree — launch scripts, capability
assignments (`getcap`), package manifests — which is what this whole
project's reverse engineering was built on:

```sh
getcap /usr/bin/dotnet /usr/sbin/sdbd-tarlauncher
cat /usr/sbin/launch_sdbd.sh
```

Write access is narrower: `/usr` and `/` are read-only, `/opt/usr` is
writable.

### Batch your arm cycles

The root channel itself is cheap, but each arm cycle pushes a signed agent
through sdbd. After ~18-30 cycles sdbd can hit a persisted handshake
lockout (see [sdbd-and-root.md](sdbd-and-root.md)). Queue the work first,
then arm once and run everything in the one window.

## What root does not do

- It is not a shell session — each `exec` is one command, and the process
  group is torn down when it returns, so a spawned background process
  dies with it.
- It does not persist across power cycles until the service re-arms.
- It does not bypass UEP — unsigned scripts in user paths still won't
  execute, which is why the root agent is a signed binary, not a script.

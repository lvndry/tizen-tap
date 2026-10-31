# Troubleshooting

## The service won't come up

Everything here can be reproduced on your own TV from another machine on
the same network. You need [samsung-tv-toolbox](https://github.com/lvndry/samsung-tv-toolbox)
(paired once with `node pair.js`) and `curl`. Set `TV_IP` to your TV's
address before running any of the scripts.

Observed on a Samsung CU7105 (Tizen 6.5) on 2026-10-29.

### Symptom

- `ping <tv-ip>` works.
- Samsung's REST API on `:8001` answers (`node info.js` prints the model).
- The Tizen Tap service on `:8091` does not answer:

  ```sh
  curl -m 2 -o /dev/null -w "%{http_code}\n" http://<tv-ip>:8091/version
  # 000
  ```

- The Tizen Tap screen on the TV logs `the service went away`.

### Two apps, one name

Tizen Tap is two applications in one package:

| Id | What it is | Can the REST API see it? |
| --- | --- | --- |
| `GJBBYNLkgP.TizenHomebrew` | the UI, the page on screen | yes |
| `GJBBYNLkgP.TizenHomebrewService` | the service on `:8091` | no (404) |

The app drawer can list both. The service is named "Tizen Tap Service" and
carries its own icon, `service-icon.png` (the app's T mark in a dark circle on
yellow, where the app is a yellow T on dark).

`node app.js GJBBYNLkgP.TizenHomebrew status` can report
`running: true, visible: false` while `:8091` is dead. That answer is about
the UI, not the service. Do not trust `visible` either: on the CU7105 it
said `false` while Tizen Tap was plainly on screen.

The REST API cannot launch the service id either. Only the UI page starts
the service, through `tizen.application.launchAppControl`. So relaunching
the UI is the only remote lever you have.

### Memory pressure

Samsung keeps Netflix, YouTube and Prime Video running in the background
so they open instantly. Each one holds a full web runtime in RAM. See which
ones are running:

```sh
node apps.js
```

Close them:

```sh
node apps.js --close
```

This is safe. They start normally the next time someone opens them.

Our own pages do not stay behind. Hidden, the Tizen Tap UI held 110 MB and
the Stremio server's page 72 MB on the CU7105, more than any Samsung
process. So the Stremio page exits as soon as it has started its service,
and the Tizen Tap UI exits 4 s after the service answers unless someone
pressed a key on the remote. Both services keep running without them.

On the CU7105 an earlier `GET /dev/status` showed memory pressure as
critical: about 207 MB free of 1578 MB, with swap exhausted. That is the
state in which the kernel reaps sideloaded services like this one. Note
that every start of the service also launches Bonsoir (`BonsoirTV1.Bonsoir`)
and, if its port is silent, the Stremio server, so a start adds its own
load.

Memory was not the cause of the outage below, though: during it the TV had
513 MB available. Check it before blaming memory (see "How to tell").

### Recovery

Run these in order:

```sh
# 1. Is the TV on, and at which IP?
node info.js

# 2. Free memory by closing the preloaded apps.
node apps.js --close

# 3. Relaunch the UI, which starts the service. Waits up to 90 s for :8091.
node app.js GJBBYNLkgP.TizenHomebrew --wait 8091
```

Once `:8091` answers, read what the service says about itself:

```sh
curl -H "x-homebrew-pin: <pin>" http://<tv-ip>:8091/dev/status
curl -H "x-homebrew-pin: <pin>" "http://<tv-ip>:8091/logs?since=0"
```

`/dev/status` has a `diagnosis` field that names the likely problem.

If `:8091` still does not answer, open Tizen Tap on the TV and read the
log lines just before `the service went away`. Do not loop step 3
more than about three times.

## Tizen Tap is gone after an update

Observed on a Samsung CU7105 (Tizen 6.5) on 2026-10-30. A self-update of
Tizen Tap was followed by the TV dropping off the network, most likely a
restart in the middle of the swap. Afterwards:

- the Control API answered 404 for `GJBBYNLkgP.TizenHomebrew`;
- `:8091` never came back, through standby and cold boots;
- the Stremio server (`S6K2WQ8MnP`), another sideloaded on-boot service,
  started by itself at every boot, so on-boot services do run on this
  firmware (a cold boot earlier that day had started Tizen Tap's too).

Tizen Tap is the installer, so nothing on the TV could repair it. It took a
computer and two unplugs (Host PC IP to the computer and back).

### The rescue

`rescue/` is a second, tiny package, Tizen Tap Rescue
(`kiB8Pr8Nds.Rescue`, service `kiB8Pr8Nds.RescueService`), installed beside
Tizen Tap (README, Install, step 8). Its service starts on boot, waits 60 s
for the TV to settle, and checks Tizen Tap once:

| Tizen Tap | The rescue |
| --- | --- |
| `/version` answers on the TV's LAN address | nothing |
| installed, silent | launches `GJBBYNLkgP.TizenHomebrew`, checks again 60 s later |
| missing, or still silent | reinstalls the last good copy over loopback sdb, launches it, checks again |

It reinstalls at most once per boot, and gives up on a last-good copy that
failed to bring Tizen Tap back twice (across boots). A healthy check, or a
newer last-good copy, clears that count. With no LAN address it does
nothing, because silence would then mean nothing.

### The last good copy

Every install of Tizen Tap leaves its signed package at
`/home/owner/share/tmp/sdk_tools/package.wgt`: a self-update, an install
from a phone, and `npm run bootstrap` from a computer alike. Tizen Tap
copies its own package to `/home/owner/share/tizen-tap-rescue/candidate.wgt`
twice over: when it stages it (before `vd_appinstall` runs), and when a
build starts and finds its own package still staged, which is how the first
install from a computer gets one. Once a build whose stamp the candidate
carries has
answered `/version` for 2 minutes, the candidate is renamed to
`last-good.wgt`, with `last-good.json` beside it. A build that never comes
up healthy is never promoted, so the copy is always one that ran. Writes go
to a temp name and are renamed, so a crash never leaves half a package.

### Reading what it did

The rescue logs every step to
`/home/owner/share/tizen-tap-rescue/rescue.log` and keeps its counters in
`state.json` next to it. Once Tizen Tap answers again:

```sh
curl -H "x-homebrew-pin: <pin>" http://<tv-ip>:8091/dev/status   # .rescue, last 10 log lines
curl -X POST -H "x-homebrew-pin: <pin>" --data 'tail -n 60 /home/owner/share/tizen-tap-rescue/rescue.log' http://<tv-ip>:8091/dev/root/exec
```

While Tizen Tap is still down, opening the rescue runs a check now (5 s
settle instead of 60), within the same limits:

```sh
node app.js kiB8Pr8Nds.Rescue
```

If the log says `no last-good copy` or `giving up`, the copy cannot help:
reinstall from a computer (README, Install). That install leaves a fresh
staged package, which becomes the next last-good copy.

## Tizen Tap is broken and won't start: install through the rescue on :8093

When Tizen Tap is installed but will not start, or a build is broken in a
way a reinstall of the last-good copy will not fix, push a working build
straight through the rescue. Developer Mode and Host PC IP stay as they
are, and nothing needs a reboot.

```sh
curl http://<tv-ip>:8093/health
# {"ok":true,"rescue":"1.0.0+...","tizenTap":{"installed":true,"answering":false}}

npm run package -- --sign
npm run install-app -- <tv-ip> release/homebrew.wgt --pin <pin> --rescue
```

The rescue identifies the package from its `config.xml`, re-signs it with
the pair Tizen Tap stored (or installs it as sent, which then must be
signed for this TV), stages it, runs `vd_appinstall` over loopback sdb and
launches it. The answer lists every phase, and a refusal quotes the
installer's own line. One install runs at a time: a second one, or one that
arrives while the boot check is reinstalling, gets 409 with `Retry-After`.
The PIN rules are in the README (Install, step 8). If `:8093` does not
answer either, the rescue is not installed or not running: `node app.js
kiB8Pr8Nds.Rescue` starts it.

## The service reloads every 3 seconds (fixed in #6)

Found on the CU7105 on 2026-10-30, running build `0.2.2+edb0be3`.

### What it looks like

- `:8091` answers for about 1.5 s, then refuses, over and over.
- `GET /logs` always ends a second or two after startup, with no error.
- The UI on screen logs `the service went away` and
  `could not launch the service: unknown error`.
- Closing the preloaded apps and cold boots do not help.

### What is actually happening

The UI and the service restart each other. On this firmware, launching a
service that is already running reloads it inside the same process. The
reload drops the UI's socket, and the old UI relaunched the service on
that very first drop. That launch reloaded the service again, and so on,
every 3 s. The UI keeps running in the background even after Back, so the
loop needs nobody in front of the set. Nothing crashes: there is no
uncaught exception, no exit and no signal, just a reload.

### How to tell

These need a developer build (PIN `000000`, `POST /dev/eval`). The service
is only up for about 1.5 s at a time, so send each call in a loop until it
answers.

```sh
# Same pid on every start, and a boot log that grows every 3 s:
curl -s -X POST -H "x-homebrew-pin: 000000" http://<tv-ip>:8091/dev/eval -d \
  "require('fs').readFileSync('/home/owner/share/tmp/sdk_tools/bootlog.txt','utf8').trim().split('\\n').slice(-5).join('\\n')"

# Who sent the launch that started this run. On the CU7105 it was the UI,
# GJBBYNLkgP.TizenHomebrew, every time:
curl -s -X POST -H "x-homebrew-pin: 000000" http://<tv-ip>:8091/dev/eval -d \
  "tizen.application.getCurrentApplication().getRequestedAppControl().callerAppId"

# Memory, to rule it in or out:
curl -s -X POST -H "x-homebrew-pin: 000000" http://<tv-ip>:8091/dev/eval -d \
  "require('fs').readFileSync('/proc/meminfo','utf8').split('\\n').slice(0,3).join(' | ')"
```

The CU7105 showed the same pid (609) on over 11,000 starts, the UI as the
caller every time, and 513 MB of memory available.

### The fix

PR #6 changes the UI so a dropped socket never triggers a launch. It
launches the service only after it has stayed silent for four attempts,
and at most five times until it answers. Any build from that PR on is
immune.

### Getting the fix onto a TV that is stuck in the loop

`POST /install` cannot finish: a 3 MB upload outlasts the 1.5 s window.
Three ways out, easiest first:

1. **Close the UI first.** Press Back on Tizen Tap. If the service then
   stays up, install normally.
2. **Stage the package through `/dev/eval`.** It accepts at most 64 KB per
   request, so write the `.wgt` to disk in 40 KB pieces at fixed offsets
   (a piece cut off by a reload is simply resent), check its SHA-256, then
   call the service's own `installer.install` on the file in one window.
3. **Reinstall from a computer.** Follow the README's install steps (Host
   PC IP set to the computer, a restart, the installer, then Host PC IP
   back to `127.0.0.1` and another restart). A Smart Hub reset also breaks
   the loop, but it removes every sideloaded app, so you end up here
   anyway.

## The apps die while watching, and the setup screen keeps reappearing

Observed on the TU55CU7105 (Tizen 9, firmware `T-KSU2ECDEUC-0090-2230.0`)
on 2026-10-31.

### What is actually happening

Under a full stream the box runs at a sustained load average of about 32 on
four cores (the native Stremio app alone holds ~50% of a core, and Samsung's
own `bgrecompd` display recomposer holds a lot more). At that load Tizen's
`stability-monitor` starts killing applications in the `owner` namespace that
stop answering — sideloaded services included. The Stremio server and Tizen
Tap died together this way, with no OOM anywhere in `dmesg`. Every time the
server died, the Stremio app on the TV redrew its "connect to server" screen,
which reads as the setup wizard coming back.

Two traps while chasing this:

- **Standby is not a reboot.** On this firmware a power on/off is a deep
  sleep: `/proc/uptime` keeps counting across days. Only an actual power cut
  runs the boot path. A fix that depends on "boot" logic must be verified
  against `/proc/uptime`, not against a standby cycle.
- **The Control API's `developerIP` is a stale cache**, not the settings DB.
  The ground truth is `buxton2ctl get system db/sdk/develop/ip` through the
  root channel. And `running` in an `/applications/<id>` answer is not
  trustworthy mid-relaunch either — a port probe is the faster liveness
  check on the same box.

### The fix: a root watchdog that Tizen cannot kill

The fix is a shell loop running as a **root systemd service** in the system
namespace, where `stability-monitor` does not reach. Every 20 s it checks the
Tizen Tap service (`:8091`) and the Stremio server (`:11470`); an app counts
as down only when its port is closed *and* the Control API agrees it is not
running, and it relaunches through the Control API with a per-app 90 s
cooldown, so a slow start (~10 s to open its port) is not relaunched on every
pass — that spam is what made the setup screen flicker in the first place. It
also prunes the Stremio stream cache past 800 MB, guarded by a file-count
stability check so it never deletes a segment still landing; the cache had
reached 1.25 GB before the first prune, which is also what the "storage
almost full" warning was about.

### The three Tizen traps the install falls into

- **`/etc/systemd/system`, `/usr/lib/systemd/system` and `/etc/init.d` are
  read-only** (VDFS rootfs, `remount,rw` fails), and there is no `rc.local`.
  The only unit directory that is both writable *and* scanned is
  `/run/systemd/system`, which is tmpfs — wiped every boot. The service
  therefore recreates the unit after every successful root arm; the first arm
  of a boot is the rebuild moment (`service/src/root/watchdog.ts`).
- **UEP refuses to exec an unsigned file**, even one invoked through
  `/bin/sh`. The unit dot-sources the script instead:
  `ExecStart=/bin/sh -c ". /opt/etc/watchdog/tv-watchdog.sh"`.
- **There is no `timeout` binary.** Port probes are bare `/dev/tcp` connects
  (instant both ways on the same box) and `curl -m` bounds the rest.

Everything durable lives under `/opt` (the 3.9 GB eMMC partition that holds
all app data; `/home/owner` is a symlink into it). The rootfs beside it is a
1.3 GB VDFS image that is 100% full on this set — nothing writable can go
there. The script, the Control API token, the unit copy and the cooldown
state all sit under `/opt/etc/watchdog/`; the log is `/opt/var/tv-watchdog.log`.

### Reading it

```sh
curl -X POST -H "x-homebrew-pin: 000000" --data 'systemctl is-active tv-watchdog; tail -n 10 /opt/var/tv-watchdog.log' http://<tv-ip>:8091/dev/root/exec
```

A line like `relaunch S6K2WQ8MnP.StremioServer` is one rescue; `cache pruned
1250MB -> 1MB` is one prune. An app that the watchdog keeps having to
relaunch is a load problem, not a watchdog problem — the monitor is only
killing things that are too slow, usually because the box is too busy.

## A factory reset before, and what it takes

A factory reset on this set wipes everything the homebrew stack depends on:
all sideloaded packages, Developer Mode, the sdbd developer-host value, and
app-local data such as the Stremio addon list (the addons live in the app's
local storage, not on the Stremio server — reinstalling the server does not
restore them). It also changes the Samsung PIN (ours went to `1010`).

What it does fix, that nothing else did: the sdbd lockout, where
`127.0.0.1:26101` resets every client that is not the developer host IP. The
value sdbd acts on is read from the settings DB at its own startup, so the
cure is either a Developer Mode write (which restarts it) or a factory
reset. Hours of quiet do not clear it.


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

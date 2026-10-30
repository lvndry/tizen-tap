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
the UI, not the service. The UI hides itself 4 s after it connects to the
service, by design, so a hidden UI is normal and says nothing about the
service.

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

### Status

On 2026-10-29 closing the preloaded apps was not enough on its own to
bring the service back. The root cause is still under investigation.
This page describes how to reproduce and inspect the
problem. It does not describe a fix.

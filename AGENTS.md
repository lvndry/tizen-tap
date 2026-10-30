# AGENTS.md — driving the TV

Operational notes for an AI agent (or a human) whose machine is on the same
network as the television. Everything below is read-only or reversible, and
everything is a plain HTTP call or one of the small scripts in
[the toolbox](https://github.com/lvndry/samsung-tv-toolbox). No browser, no
GUI, no TV in reach required.

## Two control planes

**The Tap service** — `http://<tv-ip>:8091`, the app's own brain. Every
call except the health check wants the header `x-homebrew-pin: <6 digits>`
(dev builds use `000000`). This is where an agent installs software and inspects
state.

**The Control API** — `http://<tv-ip>:8001`, Samsung's. Authenticates with
`Authorization: Bearer <token>` (the token comes from one-time pairing). This
is where the TV itself is managed: launching apps, waking it, stopping it.

## The loop, in one screen

```sh
# 0) Is anything there?
ping -c1 <tv-ip> && curl -m 2 -o /dev/null -w "%{http_code}\n" \
  -H "x-homebrew-pin: 000000" http://<tv-ip>:8091/version

# 1) TV off (ping fails)? Wake it (standby only — not hard-off):
node wake.js          # TV is up in ~10s

# 2) TV on, :8091 down (cold boot / after a self-update)? One nudge:
node app.js GJBBYNLkgP.TizenHomebrew --wait 8091

# 3) Now it answers. Everything is JSON:
curl -H "x-homebrew-pin: 000000" http://<tv-ip>:8091/version
curl -H "x-homebrew-pin: 000000" http://<tv-ip>:8091/logs?since=0
curl -H "x-homebrew-pin: 000000" http://<tv-ip>:8091/packages
curl -H "x-homebrew-pin: 000000" http://<tv-ip>:8091/pin     # the current PIN

# 4) Do a thing:
curl -X POST -H "x-homebrew-pin: 000000" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @app.wgt http://<tv-ip>:8091/install
npm run install-app -- <tv-ip> app.wgt --pin 000000   # same, from this repo
node remote.js power home ok up down left right volumeUp mute

# 5) Leave it running (an agent does not shut a TV down):
#    do nothing. The service is auto-restart; the app stays as-is.
```

## What the service gives you

| Call | |
| --- | --- |
| `GET /version` | build, uptime, node version — the liveness check |
| `GET /health` | port, on-TV, LAN addresses |
| `GET /logs?since=<seq>` | the service's own log, JSON, resumable |
| `GET /logs/previous` | the previous run's log from disk, `endedCleanly` (null on a first run) and its `tail` |
| `GET /packages` | everything installed on the TV |
| `GET /pin` | the current pairing PIN (loopback only) |
| `POST /install` | install a `.wgt` (body), the universal verb |
| `POST /restart` | the service self-heals in ~5s, nothing else needed |
| `POST /dev/eval`, `/dev/sdb`, `/dev/shell` | dev builds only — raw access |
| `POST /dev/root/exec` | run a line of `/bin/sh` as uid 0 (PIN-gated) |
| `GET /dev/root`, `POST /dev/root/arm` | root channel state / re-arm it |

The root channel arms itself on boot: the service fires a sdb injection that
runs the signed agent under sdbd's privileges, and the agent dials back over
loopback — while that socket is open, `POST /dev/root/exec` is a root shell.
It re-arms after every power cycle; if it is not connected, call
`POST /dev/root/arm` (PIN-gated). See [docs/sdbd-and-root.md](docs/sdbd-and-root.md).

A 403 means the PIN is wrong; `GET /pin` (from the TV itself) or the
PIN relay is how you get the current one. It is minted once at first start
and kept across restarts, so cache it. Five wrong guesses lock pairing
for five minutes — back off, do not hammer.

### Getting one answer instead of five

`GET /dev/status` (in **every** build — unlike the other `/dev/*` routes it is
not behind `HOMEBREW_DEV`; it is PIN-gated) returns the whole stack in one
shape — developer mode + IP, sdbd process/port/handshake, root channel,
Stremio, boot type, recent errors — **plus `diagnosis`**, a plain-English
sentence naming the single most-likely problem and the one action that
fixes it (secondary issues appended as `Also: …`). Ask it *first*, before
probing anything by hand. Examples of what it says:

- `"sdbd is up but rejects the handshake. Two causes: (1) stale gate — the running sdbd
  loaded the developer IP at restart and it is not 127.0.0.1; (2) a persisted lockout from
  many arm cycles. Toggle Developer Mode off/on to restart sdbd; …"`
- `"root channel is not armed — POST /dev/root/arm."`
- `"Everything looks healthy."`

Probe caveats baked in (learned the hard way): the developer IP is only read
via root exec when the root channel is connected — otherwise it reports
`unknown`, it never guesses. sdbd serves **one client session at a time**, so
while the root agent is armed a bare handshake probe always loses; the
endpoint reports `ok` by construction in that case. Stremio is probed on the
service's own LAN IPv4, not `127.0.0.1` — Tizen per-app network namespaces
do not share loopback.


## The toolbox (sibling repo, plain Node)

Generic Samsung TV control; nothing in it knows about Tizen Tap.

```
pair.js           one-time pairing; writes token.txt (the only credential)
remote.js <keys>  send remote keys: power, home, ok, up, volumeUp, mute,
                  or any raw code (KEY_APPS, KEY_RED, ...)
                  key:hold long-presses; --text types into an open keyboard
listen.js [--ask] watch what the TV pushes, live (often silent — see below)
info.js           model, firmware, power state, developer IP, Wi-Fi MAC;
                  no token needed
wake.js <MAC>     Wake-on-LAN (the MAC comes from info.js)
app.js <appId> [status|close] [--wait <port>] [--link <data>]
                  launch, close or inspect an app; with --wait, relaunch it
                  unless the port already answers, then wait for the port
app.js --url <url>
                  open a page in the TV's browser
```

All of it honours `TV_IP` (default `127.0.0.1`, so always set it) and reads
`token.txt` next to the scripts. The whole auth model is: `pair.js` once,
then `token.txt` is the key. Installing from a checkout of this repo is
`npm run install-app -- <tv-ip> <url-or-path> --pin <pin>`.

## Honest failure modes (do not misdiagnose)

- **`:8091` = 000 and ping fails** → the TV is off. `wake.js`, wait 10s, retry.
- **`:8091` = 000 and ping works** → service down after cold boot or
  self-update. `node app.js GJBBYNLkgP.TizenHomebrew --wait 8091`. Do not
  loop it more than ~3 times.
- **`:8091` = 200 but a call hangs** → the service is wedged. `POST /restart`,
  then retry once.
- **The service keeps dying** → its in-memory log dies with it, but every
  line is also kept on disk (`homebrewLog.txt` in its config dir, rotated at
  256 KB). Once it is up for a moment, read `GET /logs/previous`:
  `endedCleanly: false` means that run left no exit record (killed, e.g. by
  the out-of-memory killer, or power loss), and `tail` is the last thing it
  said. `/dev/status` repeats the verdict as `previousRun`.
- **`listen.js` prints nothing** → this model is quiet on the
  remote channel by design. Silence is a working result, not an error. Read
  `/logs` or `/packages` instead.
- **`/install` returns HTTP 100 / drops the socket** → the self-update path;
  the connection dies mid-swap. `app.js` (as above) brings it back; the install
  almost certainly succeeded — verify with `GET /version` (new build) and
  `GET /packages`.
- **Keys do nothing** → the TV is on a screen that ignores that key, or it is
  on standby. `node remote.js power` once, wait, retry. Do not assume the
  channel broke.

## The agent's contract

- **Do not power the TV off.** Standby is a state you can wake; off is a state
  you cannot reach over the network. `remote.js power` toggles — use it to wake,
  never to sleep.
- **The TV is a shared device.** It is probably showing something a person
  cares about. Prefer `home` + navigation over blind taps; send `mute` before
  a sequence that might trigger sound; do not start a media app and leave it
  playing.
- **Everything is idempotent by preference.** `GET /packages` before `/install`
  if you can; a reinstall is cheap, a lost state is not.
- **The PIN rotates on every app open.** Cache it for the session, refresh it
  on 403, and never write it anywhere `token.txt` would not be.

## The Stremio companion (`S6K2WQ8MnP.StremioServer`)

This repo also ships the TV's Stremio streaming server ([stremio/](stremio/)).
Treat these as load-bearing, not guesses:

- **The server listens on `11470`.** It is a separate app from Tizen Tap
  and from the Stremio *client* (`newslO9NqF`). The client points at it by the
  TV's **LAN IP** (`<tv-ip>:11470`), never `127.0.0.1`.
- **`127.0.0.1` is per-app on Tizen.** Every app is in its own network sandbox,
  so the client's loopback is not the server's loopback. If someone reports
  "the server is up but Stremio can't connect," the address is almost always
  `127.0.0.1`. Confirm from the TV's side, not the Mac's.
- **It revives itself, but only when homebrew starts.** The homebrew service
  probes `11470` at 3s and 60s on every start and cross-launches the app if
  the port is silent (search its `/logs` for `stremio`). A cold boot that
  leaves homebrew down leaves the server down too — relaunching homebrew
  (`app.js`, as above) brings both back. Do not `:8091/install`-replace
  homebrew to fix a dead server; that's a sledgehammer that also drops the
  connection mid-swap.
- **It has been wiped by TV self-updates.** If `GET /packages` no longer lists
  `S6K2WQ8MnP`, reinstall from `stremio/release/stremio-server.wgt`. The
  client app surviving does not mean the server did.
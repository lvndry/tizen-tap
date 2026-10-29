# tizen-tap

**Your Samsung TV installs, updates, and repairs its own apps — no computer
in the room.**

tizen-tap runs a small service on the TV that re-signs and installs Tizen
packages over the TV's own loopback, keeps them alive, and shows what it's
doing on the screen. Everything is also exposed as a plain JSON API on your
LAN, behind a 6-digit PIN — so a person, a script, or an AI agent can drive
the same TV the same way.

<sub>Tested on a Samsung CU7105 (Tizen 6.5, 2023). Most of it applies to any
modern Samsung smart TV with Developer Mode.</sub>

<img src="icon.png" width="96" align="right">

## Features

- **Install anything** — a curated catalog, a GitHub release, a `.wgt`
  from your phone, a USB stick, or any direct URL. Re-signed for your TV in
  ~150 ms, no store, no review.
- **Keeps apps alive** — installed services are watched and relaunched, the
  root channel re-arms itself after power cycles, and `GET /dev/status`
  tells you when something didn't come back.
- **Self-updating** — tizen-tap is in its own catalog, so it updates itself
  the same way, including in-place self-updates that don't kill the service
  doing the installing.
- **Diagnosis in one call** — `GET /dev/status` aggregates the whole stack
  (Developer Mode, sdbd, root channel, services, memory, OOM history, boot
  type) and returns a computed `diagnosis` in plain English: the most
  likely problem and the one action that fixes it.
- **Root on the TV** (see [Root](#root)) — commands as uid 0 over a
  loopback channel, for the parts the app sandbox can't touch.
- **Ships a Stremio server** — [stremio/](stremio/) is Stremio's streaming
  server as a Tizen service, so the TV streams its own torrents with no
  computer on the network.

## Install

One command; it carries its own runtime, nothing to install first.

### Linux / macOS
```sh
curl -fsSL https://lvndry.github.io/tizen-tap/install.sh | sh
```

### Windows
```powershell
irm https://lvndry.github.io/tizen-tap/install.ps1 | iex
```

The installer finds the TV, mints a Samsung certificate for your own
account, installs the app, and tells you what to switch. Ten minutes, most
of it the TV restarting.

**Two steps are yours.** `sdb` runs a command allowlist, so no software can
do them. Both are on the TV: **Apps → hold Enter (or type 12345) →
Settings → Developer mode** — and both need a TV restart, since the value
is only read at startup:

| When | Set **Host PC IP** to |
| --- | --- |
| Before installing | this computer's address — the installer prints it |
| After installing | `127.0.0.1` |

The second is the whole trick: after it, the TV installs its own apps over
its own loopback, and no other machine on your network can reach its sdb
daemon anymore.

**From a checkout** (Node 20+):

```sh
git clone https://github.com/lvndry/tizen-tap.git
cd tizen-tap
npm install
npm run full-bootstrap          # or: -- <tv-ip>, if you know it
```

## Using it

| Tab | |
| --- | --- |
| **Apps** | The catalog — install, check for updates, one press |
| **Upload** | A `.wgt` from the phone |
| **GitHub** | `owner/repo` — takes the newest release |
| **URL** | A direct https link |
| **USB** | A stick plugged into the TV |
| **Shell** | sdb commands, off by default |

The PIN is minted once on first start and kept forever, so paired phones
stay paired; the TV screen always shows the current one.

**Agents** get the same TV through
[AGENTS.md](AGENTS.md) — a complete operational contract: every endpoint,
every command, and the honest failure modes (what a refused port means,
why silence is often success, when to stop). The on-screen log is the human
view of the same records `GET /logs?since=<seq>` serves as JSON.

**Companions.** [stremio/](stremio/) is the TV's own streaming server —
five minute setup in [stremio/README.md](stremio/README.md). The
[samsung-tv-toolbox](https://github.com/lvndry/samsung-tv-toolbox) is the
plain-Node side on your machine: pairing, remote keys over the network,
Wake-on-LAN, Developer Mode setup, sdb from your laptop. No install needed.

## Root

With the [companion root setup](docs/sdbd-and-root.md), the service reaches
the TV's sdb daemon and runs commands as **uid 0** over a loopback channel
— the only path to the parts of the TV the app sandbox can't touch. That
root is **board- and firmware-specific**: the exploit chain was cracked on
a 2023 Tizen 6.5 board (KSU2E / CU7105) and needs Developer Mode, so a
different board or a newer firmware may not offer the same entry points —
`GET /dev/status` shows a failing handshake before anything else does.

What self-heals on its own, zero involvement:

- **Root re-arms after every power cycle** via a sdb injection that runs
  the signed agent under sdbd's privileges. If the channel drops (a wgt
  self-install does), `POST /dev/root/arm`.
- **Stremio and Bonsoir revive** — the service probes their ports on every
  start and on a 60 s sweep, and relaunches whatever is silent.
- **`GET /dev/status` says when something didn't heal** instead of leaving
  you to find out.

The **root watchdog** (`tools/root/watchdog.sh`) is the safety net for the
cases those miss: on this firmware the power button is a standby resume,
not a boot, so the platform's `on-boot` flag fires for neither. It's
designed and in the repo but **not yet installable on the CU7105** — a
detached root process doesn't survive the root channel, UEP blocks
unsigned scripts, and the system dirs are read-only. Until that lands,
auto-arm + revive is the net, and `/dev/status` names the gap if it ever
bites.

## How it works

**Re-signing.** A Tizen package names the device it may install on, in its
distributor certificate:

```
URI:URN:tizen:deviceid=CPCLIM2YRW7DO
```

From Tizen 7 the TV enforces it, so a `.wgt` installs on its builder's set
and nowhere else. The TV gets its own certificate pair during setup and
re-signs everything it installs, in ~150 ms. That's also why "signed"
costs nothing here: the signature is a free developer certificate bound to
your own TV, not a store approval.

**Always on.** `config.xml` declares the service `on-boot` and
`auto-restart`. On this firmware the platform only relaunches a service
that died *abnormally*, so `POST /restart` restarts by throwing — a clean
exit stays down.

**Security.** The install endpoint is open to the network by design, gated
by the 6-digit PIN: minted on first run, readable only over loopback so a
person has to relay it. Five wrong guesses locks pairing for five minutes.
The sdb relay is off by default, takes a second opt-in to survive reboots,
and refuses commands that would disable it or uninstall the app.

**The log.** sdbd's allowlist excludes every log tool, so the app carries
its own. **show logs** on the TV; up/down a line, left/right a page, RED
for newest. `GET /logs?since=<seq>` returns the same records as JSON.

## Working on it

```sh
npm run dev          # both screens in a browser, no hardware needed
npm run dev:service  # the service off-TV, on :8091
npm test             # lint, typecheck, protocol, PIN gate, install pipeline
```

The installer is a separate program in [`installer/`](installer/),
compiled to one binary per platform; it calls `tools/` and `service/`
directly so the sdb client and the re-signer have one implementation each.

---

Thanks to [SushyDev/tizen-homebrew](https://github.com/SushyDev/tizen-homebrew)
for inspiring this, and to the people behind the Homebrew Channel, TizenBrew
and TizenTube — the credits screen lists the rest — who worked out what a
Samsung TV will and will not allow. Licensed GPL-3.0-only.

**Not affiliated with Samsung.** This project is not created, sponsored, or
endorsed by Samsung Electronics. Samsung, Tizen, sdb and related names are
trademarks of their respective owners, used here only to describe the
hardware and software this works with.

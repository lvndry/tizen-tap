# tizen-tap

A back door into your Samsung TV: install apps, watch it happen on screen,
and drive the whole thing from your phone, a script, or an LLM agent.

<sub>Tested on a Samsung CU7105 (Tizen 6.5, 2023). Most of it applies to any
modern Samsung smart TV with Developer Mode.</sub>

<img src="icon.png" width="96" align="right">

---

## What it can do

**Install anything.** One press, from the TV screen or the phone:

- **Catalog** — a curated app list, published as a file, updated by commit
- **GitHub** — `owner/repo`, takes the newest release's `.wgt`
- **Upload** — a package straight from your phone
- **USB** — a stick plugged into the TV
- **URL** — any direct https link

Every package is **re-signed for your TV** in about 150ms, so builds made on
someone else's set still install on yours.

**No computer needed afterwards.** Developer Mode normally points the TV at a
machine that has to stay online. This points it at `127.0.0.1` — the TV is its
own developer machine — and exposes the whole surface as plain JSON over your
LAN. Set it up once in ten minutes; the TV runs itself after that.

**A screen that tells you what's happening.** A dmesg-style log on the TV
itself: what it installed, when, how long it took, what failed and why. Plus
the current pairing PIN and a restart button.

**Drive it from a phone or a script.** The service is a small HTTP API gated
by a 6-digit PIN:

```
GET  /packages      what is installed
GET  /logs?since=N  the on-screen log, as JSON
GET  /pin           the current PIN (loopback only)
POST /install       a .wgt or GitHub ref → re-signed and installed
POST /restart       relaunches the service
POST /shutdown      the PIN-checked exit
```

**Drive it from an agent.** [AGENTS.md](AGENTS.md) is the complete operational
contract for an LLM (or any script) driving the TV: every endpoint, every
command, and the honest failure modes — what `:8091 = 000` means, why silence
is often a working result, why you must never power the TV off.

**Keep companions alive.** Services it installs can be watched and relaunched.
The repo ships [stremio/](stremio/) — Stremio's streaming server rebuilt as a
Tizen service, so the TV streams its own torrents with no computer on the
network — and tizen-tap keeps it running.

**Root.** With [the companion setup](docs/sdbd-and-root.md), the same channel
reaches the TV's sdb daemon and runs commands as root — that's how the Host PC
IP was moved to `127.0.0.1` permanently. See the doc for the map.

---

## Install

One command. It carries its own runtime, so nothing has to be installed first.

### Linux / macOS
```sh
curl -fsSL https://lvndry.github.io/tizen-tap/install.sh | sh
```

### Windows
```powershell
irm https://lvndry.github.io/tizen-tap/install.ps1 | iex
```

It finds the TV, mints a Samsung certificate against your own account,
installs the app, and tells you what to switch. Ten minutes, most of it spent
restarting the TV.

Two steps are yours — sdbd runs a command allowlist, so no software can do
them. Both are **Apps** → **12345** (or hold Enter) → **Settings**, and both
need a restart, since the value is only read at startup:

| When | Set **Host PC IP** to |
| --- | --- |
| Before installing | this computer's address — the installer prints it |
| After installing | `127.0.0.1` |

The second makes the rest work: the TV then installs its own apps, and no
other machine can reach its sdb daemon.

**From a checkout**, with Node 20+:

```sh
git clone https://github.com/lvndry/tizen-tap.git
cd tizen-tap
npm install
npm run full-bootstrap          # or: -- <tv-ip>, if you know it
```

---

## Using it

| Tab | |
| --- | --- |
| **Apps** | The catalog, installed with one press |
| **Upload** | A `.wgt` from the phone |
| **GitHub** | `owner/repo` — takes the newest release |
| **URL** | A direct https link |
| **USB** | A stick plugged into the TV |
| **Shell** | sdb commands, off by default |

The PIN changes every time the app opens, and the TV screen shows the current
one. Your phone keeps the last one that worked until the TV restarts.

**Updates.** Every **Apps** row says whether it is installed and at which
version; **check** asks GitHub whether anything newer was released. tizen-tap
is in its own catalog, so it updates itself the same way — including
in-place self-updates that don't kill the service doing the installing.

**Companions.** [stremio/](stremio/) is the TV's own streaming server — five
minute setup in [stremio/README.md](stremio/README.md).

The companion [tizen-toolbox](https://github.com/lvndry/tizen-toolbox) is the
plain-Node side, no install needed: pairing, remote keys over the network,
Wake-on-LAN, Developer Mode setup, sdb from your machine.

---

## How it works

**Re-signing.** A Tizen package names the device it may be installed on, in its
distributor certificate:

    URI:URN:tizen:deviceid=CPCLIM2YRW7DO

From Tizen 7 the TV enforces it, so a `.wgt` installs on its builder's set and
nowhere else. The TV is given its own certificate pair during setup, and a set
holding one re-signs everything it installs, in about 150ms.

**Always on.** `config.xml` declares the service `on-boot` and
`auto-restart`, so it comes up with the television. The app remains for the
log, the PIN and a restart button; closing it leaves the service running.
`POST /restart` self-heals in seconds: on this firmware the platform only
relaunches a service that died *abnormally*, so a restart dies by throwing,
and a clean exit stays down.

**Security.** The install endpoint is open to the network by design, gated by
the 6-digit PIN: minted on first run, readable only over loopback so a person
has to relay it. Five wrong guesses locks pairing for five minutes. The sdb
relay is off by default, takes a second opt-in to survive reboots, and refuses
commands that would disable it or uninstall the app.

**The log.** sdbd's allowlist excludes every log tool, so the app carries its
own. **show logs** on the TV; up/down a line, left/right a page, RED for
newest. `GET /logs?since=<seq>` returns the same records as JSON.

```
[    0.906] sdb: loopback 127.0.0.1:26101 answered — this TV can install its own apps
[   59.220] pkg: installed Tube 0.1.0 in 7.22s
```

---

## Working on it

```sh
npm run dev          # both screens in a browser, no hardware needed
npm run dev:service  # the service off-TV, on :8091
npm test             # lint, typecheck, protocol, PIN gate, install pipeline
```

`npm run dev` serves the TV at `/tv.html` and the phone at `/index.html`, both
at `/preview.html`. With no TV around, `ui/dev/service.js` answers with the
real protocol over a real WebSocket; `HOMEBREW_TV=<tv-ip> npm run dev` points
it at hardware.

The installer is a separate program in [`installer/`](installer/): Bun and
OpenTUI, compiled to one binary per platform. It calls `tools/` and
`service/` directly, so the sdb client and the re-signer have one
implementation each.

---
Started from [SushyDev/tizen-homebrew](https://github.com/SushyDev/tizen-homebrew)
and grown into something with an actual spine. Licensed GPL-3.0-only, on the
work in the credits screen — the Homebrew Channel, TizenBrew, TizenTube, and
the people who worked out what a Samsung TV will and will not allow.

**Not affiliated with Samsung.** This project is not created, sponsored, or
endorsed by Samsung Electronics. Samsung, Tizen, sdb and related names are
trademarks of their respective owners, used here only to describe the hardware
and software this works with.
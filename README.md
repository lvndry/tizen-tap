# tizen-tap

**A Samsung TV that installs, updates, and repairs its own apps.**

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

The service can run commands as **uid 0** on the TV — inspect the kernel,
protect services from the OOM killer, write the settings database, read
the firmware. [docs/root.md](docs/root.md) covers what it unlocks and how
to use it; [docs/sdbd-and-root.md](docs/sdbd-and-root.md) is the
reverse-engineering notes behind it. That root is **board-
and firmware-specific** — cracked on a 2023 Tizen 6.5 board (KSU2E /
CU7105), so verify before you assume.

It also self-heals on its own: the root channel re-arms after every power
cycle, the service revives Stremio and Bonsoir on a 60 s sweep, and
`GET /dev/status` names whatever didn't come back.

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

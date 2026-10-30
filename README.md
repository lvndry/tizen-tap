# tizen-tap

**A Samsung TV that installs, updates, and repairs its own apps.**

A Samsung TV only runs apps from Samsung's store. Installing anything else
normally means a computer with Tizen Studio, a developer certificate, and a
package signed for that one TV, repeated for every app and every update.

tizen-tap moves all of that onto the TV. After a one-time setup, you
install apps that aren't in the store, like a community YouTube client or a
Stremio server, from the TV itself or from your phone, with no computer
involved. It also keeps those apps running, updates them, and gives you
root on the TV.

Under the hood it's a small service on the TV that re-signs packages and
installs them over the TV's own loopback. The same service answers a JSON
API on your LAN behind a 6-digit PIN, so scripts and agents can drive it
too.

<sub>Tested on a Samsung CU7105 (Tizen 6.5, 2023). Most of it applies to any
modern Samsung smart TV with Developer Mode.</sub>

<img src="icon.png" width="96" align="right">

## Features

- Installs from a curated catalog, a GitHub release, a `.wgt` uploaded from
  your phone, a USB stick, or a direct URL. Each package is re-signed for
  your TV in about 150 ms.
- Watches installed services and relaunches them. The root channel re-arms
  after every power cycle, and Stremio and Bonsoir are revived on a 60 s
  sweep.
- Updates itself from its own catalog entry, in place, without killing the
  service that runs the install.
- `GET /dev/status` reports Developer Mode, sdbd, the root channel,
  services, memory, OOM history and boot type, plus a `diagnosis` field: one
  sentence naming the likely problem and the fix.
- Gives you root access on the TV, for everything the app sandbox can't
  reach. See [Root](#root).
- Ships Stremio's streaming server as a Tizen service ([stremio/](stremio/)),
  so the TV can stream torrents without a computer on the network.

## Install

The installer carries its own runtime.

### Linux / macOS
```sh
curl -fsSL https://lvndry.github.io/tizen-tap/install.sh | sh
```

### Windows
```powershell
irm https://lvndry.github.io/tizen-tap/install.ps1 | iex
```

It finds the TV, mints a Samsung certificate for your account, installs
tizen-tap on the TV, and tells you which settings to change. Expect about ten minutes, mostly TV
restarts.

Two settings have to be changed by hand, because `sdb` only accepts an
allowlist of commands. Both are under **Apps → hold Enter (or type 12345) →
Settings → Developer mode**, and each needs a TV restart to take effect:

| When | Set **Host PC IP** to |
| --- | --- |
| Before installing | this computer's address (the installer prints it) |
| After installing | `127.0.0.1` |

After the second change, the TV installs apps over its own loopback and no
other machine on the network can reach its sdb daemon.

From a checkout (Node 20+):

```sh
git clone https://github.com/lvndry/tizen-tap.git
cd tizen-tap
npm install
npm run full-bootstrap          # or: -- <tv-ip>, if you know it
```

## Using it

| Tab | |
| --- | --- |
| **Apps** | The catalog: install and check for updates |
| **Upload** | A `.wgt` from the phone |
| **GitHub** | `owner/repo`, installs the newest release |
| **URL** | A direct https link |
| **USB** | A stick plugged into the TV |
| **Shell** | sdb commands, off by default |

The PIN is created on first start and never changes, so paired phones stay
paired. The TV screen always shows it.

For scripts and agents, [AGENTS.md](AGENTS.md) lists every endpoint and
command, and what each failure looks like. The on-screen log shows the
same records that `GET /logs?since=<seq>` returns as JSON.
If `:8091` stops answering, see [docs/troubleshooting.md](docs/troubleshooting.md).

Related: [stremio/README.md](stremio/README.md) sets up the TV's streaming
server in about five minutes. [samsung-tv-toolbox](https://github.com/lvndry/samsung-tv-toolbox)
holds the Node scripts you run on your own machine: pairing, remote keys,
Wake-on-LAN, Developer Mode setup, and sdb from a laptop.

### What to install

Apps that publish `.wgt` builds on GitHub:

| App | Repo | How |
| --- | --- | --- |
| YouTube | [SushyDev/tizen-youtube](https://github.com/SushyDev/tizen-youtube) | **Apps** tab, it's in the catalog |
| TizenBrew | [reisxd/TizenBrew](https://github.com/reisxd/TizenBrew) | **GitHub** tab: `reisxd/TizenBrew`. Runs modules like [TizenTube](https://github.com/reisxd/TizenTube) (ad-free YouTube, SponsorBlock) |
| Jellyfin | [jeppevinkel/jellyfin-tizen-builds](https://github.com/jeppevinkel/jellyfin-tizen-builds) | **URL** tab: `https://github.com/jeppevinkel/jellyfin-tizen-builds/releases/latest/download/Jellyfin.wgt` |
| Moonlight | [brightcraft/moonlight-tizen](https://github.com/brightcraft/moonlight-tizen) | **URL** tab: `https://github.com/brightcraft/moonlight-tizen/releases/latest/download/Moonlight.wgt` |
| Stremio server | [stremio/](stremio/) in this repo | see [stremio/README.md](stremio/README.md) |

Jellyfin and Moonlight publish several `.wgt` variants per release, and the
**GitHub** tab installs the first one it finds, so use the direct URL to
get the standard build.

## Root

tizen-tap gets root on the TV. With it you can inspect the kernel,
protect services from the OOM killer, write the settings database, and read
the firmware. [docs/root.md](docs/root.md) explains how to use it, and
[docs/sdbd-and-root.md](docs/sdbd-and-root.md) has the reverse-engineering
notes.

The exploit is **board- and firmware-specific**. It was found on a 2023
Tizen 6.5 board (KSU2E / CU7105); check that it works on yours before
relying on it.

## How it works

**Re-signing.** A Tizen package's distributor certificate names the device
it may install on:

```
URI:URN:tizen:deviceid=CPCLIM2YRW7DO
```

From Tizen 7 the TV enforces this, so a `.wgt` only installs on the set it
was built for. During setup the TV gets its own certificate pair and
re-signs every package before installing it. The certificate is a free
Samsung developer certificate bound to your TV, not a store approval.

**Staying up.** `config.xml` declares the service `on-boot` and
`auto-restart`. This firmware only relaunches a service that exited
abnormally, so `POST /restart` throws on purpose. A clean exit would stay
down.

**Security.** The install endpoint is reachable from the network and gated
by the PIN. The PIN can only be read over loopback, so a person has to
relay it. Five wrong guesses lock pairing for five minutes. The sdb relay
is off by default, needs a second opt-in to survive reboots, and refuses
commands that would disable it or uninstall the app.

**The log.** sdbd's allowlist blocks every log tool, so the app keeps its
own. Open **show logs** on the TV: up/down moves a line, left/right a
page, RED jumps to the newest entry. `GET /logs?since=<seq>` returns the
same records as JSON.

## Working on it

```sh
npm run dev          # both screens in a browser, no hardware needed
npm run dev:service  # the service off-TV, on :8091
npm test             # lint, typecheck, protocol, PIN gate, install pipeline
```

The installer lives in [`installer/`](installer/) and compiles to one
binary per platform. It calls into `tools/` and `service/`, so the sdb
client and the re-signer each have a single implementation.

---

Thanks to [SushyDev/tizen-homebrew](https://github.com/SushyDev/tizen-homebrew)
for the inspiration, and to the people behind the Homebrew Channel,
TizenBrew and TizenTube (the credits screen lists the rest), who worked out
what a Samsung TV will and won't allow. Licensed GPL-3.0-only.

**Not affiliated with Samsung.** This project is not created, sponsored, or
endorsed by Samsung Electronics. Samsung, Tizen, sdb and related names are
trademarks of their respective owners, used here only to describe the
hardware and software this works with.

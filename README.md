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

About fifteen minutes, most of it the TV rebooting. You need a computer on
the same network as the TV, and the TV's remote.

Two facts explain every step below:

- **Host PC IP** (a Developer Mode setting) decides who may talk to the
  TV's sdb daemon. To install the first time, it must be your computer.
  Afterwards it must be `127.0.0.1`, so the TV installs its own apps.
- **The TV reads that setting only on a real boot.** "Restart" below means
  unplug the TV, wait 30 s, plug it back in. Standby from the remote does
  not count, and a change without a real boot does nothing.

The Developer Mode dialog: on the TV open **Apps**, then type `1` `2` `3`
`4` `5` on the remote (no number keys: hold Enter on the Apps screen to get
a keypad).

1. **Find your computer's IP address** on the home network, for example
   `192.168.1.7`. macOS: `ipconfig getifaddr en0`. Linux: `hostname -I`.
   Windows: `ipconfig`, the IPv4 Address line.
2. **Turn Developer Mode on and point it at your computer.** In the
   Developer Mode dialog set **Developer mode** to **On** and **Host PC IP**
   to the address from step 1, then OK.
3. **Restart the TV** (unplug 30 s).
4. **Run the installer** on your computer. It carries its own runtime:

   ```sh
   # Linux / macOS
   curl -fsSL https://lvndry.github.io/tizen-tap/install.sh | sh
   ```

   ```powershell
   # Windows
   irm https://lvndry.github.io/tizen-tap/install.ps1 | iex
   ```

   It finds the TV, mints a Samsung certificate for your account, installs
   tizen-tap, and opens it on the TV. If it says the TV "dropped the
   connection", step 3 did not happen: restart the TV and run it again.
5. **Point Developer Mode back at the TV.** In the same dialog set **Host
   PC IP** to `127.0.0.1`, then OK.
6. **Restart the TV** (unplug 30 s) once more.
7. **Check it.** Open Tizen Tap. The screen shows the 6-digit PIN, then:

   ```sh
   curl -H "x-homebrew-pin: <pin>" http://<tv-ip>:8091/dev/status
   ```

   `diagnosis` should read `Everything looks healthy.` If it says the root
   channel is not armed, arm it once:
   `curl -X POST -H "x-homebrew-pin: <pin>" http://<tv-ip>:8091/dev/root/arm`
8. **Install the rescue too.** Tizen Tap is the TV's installer, so an update
   that breaks it leaves nothing on the TV able to put it back. The rescue is
   a small separate app that checks Tizen Tap a minute after every boot and
   reinstalls the last build that worked if it is gone. From a checkout:

   ```sh
   node rescue/build.js
   npm run install-app -- <tv-ip> release/rescue.wgt --pin <pin>
   ```

   Two minutes after Tizen Tap starts, `/dev/status` lists `rescue.lastGood`;
   until then its `diagnosis` carries an `Also:` line saying there is none.

   The rescue is also a second way in. It serves an installer on port
   `8093` that works while Tizen Tap is down, so a broken Tizen Tap can be
   replaced without Developer Mode or a reboot:

   ```sh
   curl http://<tv-ip>:8093/health
   npm run install-app -- <tv-ip> release/homebrew.wgt --pin <pin> --rescue
   ```

   It answers `GET /health` and a PIN-gated `POST /install`, nothing else.
   The PIN is the one Tizen Tap uses: `000000` when Tizen Tap is a developer
   build, otherwise the pairing PIN Tizen Tap stored. If Tizen Tap never
   stored one, the rescue mints its own once, keeps it in
   `/home/owner/share/tizen-tap-rescue/pin.json` and writes it to
   `rescue.log` there. Five wrong PINs lock that address out, longer each
   time, as on `:8091`. When Tizen Tap's certificate pair is stored, the
   rescue re-signs the package for this TV the way Tizen Tap does; without
   one, send a package already signed for this TV (`npm run package --
   --sign`).

From then on the TV installs its own apps, and Host PC IP stays
`127.0.0.1`. You only repeat these steps to reinstall tizen-tap from a
computer, for example after a **Smart Hub reset**, which deletes every
sideloaded app (tizen-tap and the Stremio server included). After
reinstalling, put the Stremio server back as in
[stremio/README.md](stremio/README.md).

From a checkout (Node 20+), step 4 becomes:

```sh
git clone https://github.com/lvndry/tizen-tap.git
cd tizen-tap
npm install
npm run full-bootstrap -- <tv-ip>
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
Wake-on-LAN, app launching, and sdb from a laptop.

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
relay it. Five wrong guesses lock out the device that made them, for a
minute at first and twice as long each time after, up to an hour; other
devices with the right PIN are unaffected. The sdb relay
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

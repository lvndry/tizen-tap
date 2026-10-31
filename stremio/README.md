# Stremio Server for the TV

Stremio's desktop streaming server, running as a Tizen web service on the TV
itself. The TV streams its own torrents — no computer on the network is
needed, and the Mac can sleep.

## Why it exists

The Stremio TV app (1.5.0) has no built-in torrent engine: it expects a
streaming server on the network, which on most people's setups is a desktop
app that has to stay on. This package is that server, running on the TV:
pure-JS WebTorrent on Tizen's Node 18, zero native modules, cache capped at
512 MB.

## What is already automatic

- **Boots with the TV.** `on-boot` starts it after every standby wake.
- **Revives itself.** The Tizen Tap service probes port 11470 on every
  start (at 3 s and 60 s) and launches this app if the port is silent, so a
  dead server comes back the next time anything touches homebrew.
- **Bounded disk use.** The torrent cache lives on flash and is capped at
  512 MB (TVs have ~4 GB total). The server's own cap only trims torrents
  that have finished playing, so the shim also trims the cache to the cap
  at every start and, while it runs, removes old torrents whenever the TV
  drops below 600 MB free. The torrent playing is never touched.

## Setup (one time, ~5 minutes)

1. **Install it.** From the root of a checkout of this repo, with Tizen
   Tap already on the TV (its `:8091`) and the PIN from its screen:

   ```sh
   node stremio/build.js                # builds release/stremio-server.wgt
   npm run install-app -- <tv-ip> release/stremio-server.wgt --pin <pin>
   ```

   Same thing with curl: `curl -X POST --data-binary @release/stremio-server.wgt
   -H "x-homebrew-pin: <pin>" http://<tv-ip>:8091/install`. After a Smart Hub
   reset the server is gone; this step puts it back.

2. **Point the Stremio app at it.** In the Stremio app: *Settings →
   Streaming server* → `<tv-ip>:11470`.

   Use the TV's **LAN address**, not `127.0.0.1`. Tizen puts every app in its
   own network sandbox, so the app's loopback is not the server's loopback —
   loopback will silently fail to connect.

3. **Reserve the TV's IP on your router** (DHCP reservation by MAC, in the
   router's admin page). If the address can drift, the Stremio setting
   breaks with it. After the reservation, this is the last time anyone
   touches an IP.

## The Stremio client (the TV app)

The app with the icon you watch with is a separate package; this repo
ships only the server above.

**Use the official app from Samsung's store.** Stremio publishes it for
2019+ Samsung TVs (Tizen 5+). On the CU7105 it is package `IkWsFHtOY9`
(app `IkWsFHtOY9.Stremio`), v1.11.1 as of 2026-10-30. It is current and
Samsung keeps it updated. Install it on the TV: **Apps**, search
"Stremio", **Install**. After a Smart Hub reset the Apps tile can be
missing from the home bar until Smart Hub is set up again; the store app
is `com.samsung.tv.store` and can also be opened remotely:

```sh
curl -X POST -H "x-homebrew-pin: 000000" --data-binary \
  "new Promise((done) => tizen.application.launch('com.samsung.tv.store', () => done('ok'), (e) => done(e.message)))" \
  http://<tv-ip>:8091/dev/eval     # developer builds only
```

The store app also installs a background part, `IkWsFHtOY9.StremioService`.
It is not used for streaming here: the client talks to this repo's server.

**If the store does not list Stremio** (the rollout was regional), the
fallback is a sideloaded build from
[camwhite18/stremio-tizen-builds](https://github.com/camwhite18/stremio-tizen-builds).
Prefer `Stremio.wgt` (stable). Note that project stopped publishing in
March 2026 while Stremio's web app kept moving, so its builds lag behind.
Avoid `Stremio-WebWrapper.wgt`: it frames Stremio's old v4 shell
(`app.strem.io/shell-v4.4`), and as an HTTPS page it cannot reach this
plain-HTTP server without the server's remote HTTPS option.

```sh
curl -L -o /tmp/stremio-client.wgt \
  https://github.com/camwhite18/stremio-tizen-builds/releases/latest/download/Stremio.wgt
npm run install-app -- <tv-ip> /tmp/stremio-client.wgt --pin <pin>
```

After install:

- **Server address**: in the app, *Settings → Streaming server* →
  `http://<tv-ip>:11470` (step 2 above; the LAN address, never `127.0.0.1`,
  because every Tizen app has its own loopback). Verified with the store
  app on the CU7105: it then connects over plain HTTP.
- **Addons** — in *Settings → Add-ons*, import a Stremio export JSON
  (the app's own *Settings → Add-ons → Export* produces that format).
  The client keeps its addon list in its own `localStorage`, not on the
  server — reinstalling the server alone never restores it.
- **Library** — log in with your Stremio account in the app; the library
  syncs from the cloud.
That's the whole setup. From then on the TV streams with nothing else on.

## If it stops answering

| Symptom | Meaning | Fix |
| --- | --- | --- |
| `<tv-ip>:11470` = 000, homebrew = 000 | TV off, or cold boot with nothing started | Open Tizen Tap once, or `node app.js GJBBYNLkgP.TizenHomebrew --wait 8091` from samsung-tv-toolbox |
| 000, homebrew = 200 | Server process died | Open Tizen Tap again — the revive fires on its start. Still dead? The package may be gone (TV self-updates have been known to wipe it): re-run step 1 |
| App can't connect, `:11470` = 307 from the LAN | App pointed at `127.0.0.1`, or the TV's IP changed | Re-check the app's server address (step 2); check the reservation (step 3) |

The server writes a boot log to `boot.log` in its data path,
`/opt/usr/home/owner/apps_rw/S6K2WQ8MnP/data/stremio-server/` on the
CU7105 (readable as root); the homebrew service's own logs record every
revive attempt (search for `stremio`).

The torrent cache lives in that data path too, on flash, capped at 1 GB
(512 MB by default). It must not live in `/tmp`: on Tizen that is tmpfs, so
a cache there is RAM taken from every app, and a 2 GB cache in `/tmp` is
how a streaming session starts the out-of-memory killer. The shim puts the
cache back on flash and re-applies the cap on every boot. The cap alone does
not bound the film being watched, which grows to its full size; `space.js`
is what keeps that from filling the TV.

## Layout

| File | |
| --- | --- |
| `main.js` | Service entry: pins the port, data dir, cache cap, then loads the server bundle |
| `space.js` | Trims the cache to its cap at start and keeps 600 MB free while running |
| `src/server.js` | Stremio's official desktop server bundle (v4.21.2), unmodified |
| `index.html` | Page that starts the service via `launchAppControl` and exits |
| `config.xml` | Widget manifest; `application.launch` privilege is what lets the page start the service |
| `build.js` | Stages + signs the `.wgt` (uses the same `~/.tizen-certs` as the main app) |

## Known behavior, not bugs

- **Cold boot (power pulled, firmware update) does not auto-start it** — a
  Tizen limitation for sideloaded packages. Standby wake does. The revive
  covers the gap on the next homebrew start.
- The app's `127.0.0.1` and the server's `127.0.0.1` are different things on
  Tizen (per-app network sandbox). Always use the LAN address.

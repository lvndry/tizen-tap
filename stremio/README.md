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
- **Bounded disk use.** The torrent cache lives under
  `/home/owner/.stremio-server` and is capped at 512 MB (TVs have ~4 GB
  total). If that path is not writable it falls back to the system temp
  dir, which the TV reclaims more aggressively — the cache is still capped
  either way.

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

That's the whole setup. From then on the TV streams with nothing else on.

## If it stops answering

| Symptom | Meaning | Fix |
| --- | --- | --- |
| `<tv-ip>:11470` = 000, homebrew = 000 | TV off, or cold boot with nothing started | Open Tizen Tap once, or `node app.js GJBBYNLkgP.TizenHomebrew --wait 8091` from samsung-tv-toolbox |
| 000, homebrew = 200 | Server process died | Open Tizen Tap again — the revive fires on its start. Still dead? The package may be gone (TV self-updates have been known to wipe it): re-run step 1 |
| App can't connect, `:11470` = 307 from the LAN | App pointed at `127.0.0.1`, or the TV's IP changed | Re-check the app's server address (step 2); check the reservation (step 3) |

The server writes a boot log to `/home/owner/.stremio-server-boot.log` when
launched through the page; the homebrew service's own logs record every
revive attempt (search for `stremio`).

## Layout

| File | |
| --- | --- |
| `main.js` | Service entry: pins the port, data dir, cache cap, then loads the server bundle |
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

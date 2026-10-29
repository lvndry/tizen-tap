# sdbd, the developer IP, and root on the TV

Reverse-engineering notes for the CU7105 (Tizen 6.5, board KSU2E), compiled
October 2024. Everything here was verified on a live unit, not assumed.
The tooling used to take the firmware apart is set up in
[rea-notes.md](rea-notes.md).

## Expect board and firmware dependence

This is not a universal Tizen root. The chain — sdbd gate, the signed agent
launched under `sdbd-tarlauncher`, the `buxton2` settings DB, UEP behaviour
— was cracked on a **2023 Tizen 6.5 board (KSU2E / CU7105)**. Other boards
and newer firmwares may not offer the same entry points; Tizen 7+ in
particular enforces per-device install URNs and ships a rewritten sdbd.
Developer Mode must be enabled, and the sdbd developer-host gate must point
at the host doing the arming. Treat "it works on your TV" as something to
verify, not to assume — `GET /dev/status` shows the handshake failing
before anything else does.

## The developer IP is a settings-DB key, not a file

sdbd reads its developer host at boot from the `buxton2` settings database
(see `/usr/sbin/launch_sdbd.sh` on the TV, world-readable):

```sh
buxton2ctl get system db/sdk/develop/ip        # string, e.g. 127.0.0.1
buxton2ctl get system db/sdk/develop/mode      # int: 1 = User IP, 2 = HyperUART
buxton2ctl set-string system db/sdk/develop/ip 127.0.0.1
buxton2ctl set-int32  system db/sdk/develop/mode 1
systemctl restart sdbd
```

There is no Control-API endpoint and no file to edit. The on-screen
`Apps → 12345` dialog is just another writer to the same key.

## sdbd's developer-host gate

sdbd accepts **TCP from anyone**, then drops the ADB handshake unless the
client's source address equals the configured developer IP. This is why
loopback installs (`127.0.0.1:26101`, what `tools/push.js` triggers
server-side) only work when Host PC IP is `127.0.0.1`, and Mac-origin sdb
only works when it is the Mac's IP. One slot, one owner — pick a default
(`127.0.0.1`) and leave it.

## The sdb `shell:` verb is not a shell

It is a regex allowlist of canned verbs (`getduid`, `getdate`,
`vd_applist`, `vd_appinstall`, `vd_appuninstall`, …). Anything else —
pipes, redirects, a second token — is rejected or returns empty. `shell:`
does **not** give a command line.

## SVE-2025-50109: package-name shell injection

`sdb install <name>` makes sdbd run `appinstall tpk <name>` through a
shell, interpolating the name unquoted. A crafted name executes
arbitrary bytes as **uid 901 (sdk)**:

```
0 appinstall tpk new2.tpk`printf${IFS}%s${IFS}<base64>|base64${IFS}-d|bash`.tpk
```

Two quirks observed on this board:

- **Every injected payload executes exactly twice, concurrently.** A `>`
  truncate on a shared file lets the slower twin clobber the faster one
  (files landing 0 B). `>>` appends survive. Put all writes in one
  payload, or stage per-run files.
- No `$IFS` expansion inside the payload shell (harmless
  `-n: command not found` noise on line 1).

`/var/lib/buxton2` is root-owned, so uid-901 can *read* the developer IP
but not reliably write it.

## Root: the archive-root route

`chris-ritsen/samsung-tv-root` (v0.0.9+) escalates the uid-901 foothold
to **UID 0**: `sdbd-tarlauncher` carries `cap_setuid=eip` and
`/usr/bin/dotnet` carries `cap_setgid,cap_sys_admin=ei` on this board
(verified with `getcap`), which is the model-independent precondition the
tool's preflight checks live.

Verified end state (2024-10, `archive-root probe` on the CU7105):

```
authenticated: yes
uid: 0    euid: 0    gid: 0
cap eff: 0000003fffffffff
/usr/bin/dotnet             cap_setgid,cap_sys_admin=ei
/usr/sbin/sdbd-tarlauncher   cap_setgid,cap_setuid=eip
```

With that root shell, setting the developer IP no longer needs the dialog:

```sh
buxton2ctl set-string system db/sdk/develop/ip 127.0.0.1
buxton2ctl set-int32  system db/sdk/develop/mode 1
systemctl restart sdbd
```

The service now carries this route itself ("the root channel"):

- `tools/root-arm-build.js` (`npm run rootarm`) stages the samsung-tv-root
  payloads into `vendor/root-arm/` (repo root) — the launcher and agent DLLs,
a fresh RSA-2048 keypair (only the public key ships), the signed tar that
  `sdbd-tarlauncher` runs as uid 0, and the channel's HMAC secret. Output is
  committed, so the TV only ever copies files.
- On boot the service fires the injection over loopback sdb, and the agent
  dials back to the service's root channel on loopback `:8092`. While that
  socket is open, `POST /dev/root/exec` (PIN-gated) runs a line of `/bin/sh`
as uid 0. `GET /dev/root` reports state; `POST /dev/root/arm` re-arms.
- Root stays **volatile across power cycles** — the channel re-arms
  automatically at the next service start, with a few retries, and the
  manual endpoint as fallback. A partner-cert boot agent would make the
  service itself start at boot deterministically, which the root channel
  still depends on.

## Running the tool on an arm64 Mac

The tool shells out to a `sdb` binary and to `OpenSSL`; the stock sdb
release is x86-64 and the Mac has no Rosetta. `~/tools/sdb/sdb` is a Node
shim that speaks the subset the tool uses:

- `connect` / `devices` — raw ADB CNXN handshake (magic =
  `CNXN ^ 0xFFFFFFFF` as unsigned, arg1 `0x01000000`, arg2 4096), device
  state kept in `/tmp/.sdb-shim-state`
- `shell` / `shell:0` — routed through this repo's ADB client
  (`service/src/tv/sdb.ts`)
- `push` / `pull` — file transfer over the homebrew service's
  `/dev/eval` endpoint (single executor, base64 chunks, sha-verified).
  sdbd on this board does not answer ADB SYNC from a non-bundled client,
  and the injection path is too flaky for binaries.

Wire it up with `SDB=~/tools/sdb/sdb`. Building the payloads needs a
.NET SDK: `make common-payload` in the tool repo.

## Current state (verified 2024-10)

Host PC IP is set to `127.0.0.1` in the buxton2 DB via a root
`archive-root` run — the dialog is not needed anymore, and the value
survives reboots (it is a DB entry, not a runtime setting). Verified
after the change: `push.js` self-update succeeds TV-side (its probe
connects over loopback), and Mac-origin sdb gets `ECONNRESET` on the
handshake.



## Practical state machine for deploys

| Host PC IP | `tools/push.js` (TV-side) | Mac sdb (`bootstrap.js`, archive-root) |
|---|---|---|
| `127.0.0.1` (default) | works | handshake dropped |
| Mac IP | handshake dropped | works |

Leave it at `127.0.0.1`. Flip to the Mac only for the rare
bootstrap/root session, and flip back. sdbd is wedged by long
handshake-drop storms; a standby off/on (not just a retry) recovers it.

# REA toolkit — install & usage notes (2026-10-15)

REA ("Reverse Engineer Anything", [morluto/rea](https://github.com/morluto/rea)) is installed and
proven end-to-end on this Mac (Apple M5, macOS 27, arm64) for the TV exploit hunt.

## What's installed

| Component | Version | Path |
|---|---|---|
| rea-agents (CLI + MCP) | 6.5.0 | `npm i -g rea-agents` → `/opt/homebrew/bin/rea` |
| Ghidra | 12.1.4 | `/Users/YOURUSER/tools/rea/ghidra_12.1.4_PUBLIC` |
| Temurin JDK | 21.0.12.1 (arm64) | `/Users/YOURUSER/tools/rea/jdk-21.0.12.1+1/Contents/Home` |
| Hopper (pre-existing) | 6.6.0-demo | `/Users/YOURUSER/Applications/Hopper Disassembler.app` |
| binwalk | 3.1.0 (brew) | `/opt/homebrew/bin/binwalk` |
| unblob | — (no brew formula; pip-installable) | not installed |
| zig (ELF cross-compile) | 0.17.0 (brew) | `/opt/homebrew/bin/zig` |

Env vars persisted in `~/.zshrc` (block marked `# rea-env`):
```sh
export GHIDRA_INSTALL_DIR=/Users/YOURUSER/tools/rea/ghidra_12.1.4_PUBLIC
export JAVA_HOME=/Users/YOURUSER/tools/rea/jdk-21.0.12.1+1/Contents/Home
```
(Non-interactive shells / agents: export the two lines above first, or use `zsh -i -c '…'`.)

### Install log
1. `npm install --global rea-agents` (frida postinstall script skipped — only matters for Frida runtime observation; CLI/Ghidra paths unaffected).
2. Ghidra: `brew install --cask ghidra` does **not exist** — no cask. Downloaded official
   `ghidra_12.1.4_PUBLIC_20260921.zip` (543 MB) from the NSA GitHub release → `~/tools/rea/`.
3. JDK: Temurin 21.0.12.1 aarch64-mac tarball → `~/tools/rea/jdk-21.0.12.1+1`.
4. **Key gotcha:** Ghidra 12.1.x PUBLIC zips ship native decompiler binaries for
   `linux_x86_64` and `win_x86_64` **only** — `mac_arm_64` is missing, and `rea doctor` reports
   `ghidra-native_decompiler: config_drift`. Fix (37 s, needs Xcode CLT):
   ```sh
   cd $GHIDRA_INSTALL_DIR/support/gradle
   JAVA_HOME=$JAVA_HOME ./gradlew buildNatives
   # → Ghidra/Features/Decompiler/build/os/mac_arm_64/{decompile,sleigh}
   ```
   After that `rea doctor --provider ghidra` is fully green.
5. `brew install zig`, `brew install binwalk`.

## Proven status
- `rea doctor --provider ghidra --json` → `healthy: true` (all 9 checks ok, incl. native decompiler `mach-o arm64 matches darwin/arm64`).
- `rea setup --yes --skill=false --json` → `status: ready`; only updates the three already
  REA-aligned registrations (claude_code, codex, pi) with provider env, with its own
  `.rea.backup.*.recovery` backups. No other agent config touched.
- End-to-end native analysis: **Ghidra provider works for both Mach-O (arm64) and ELF (x86_64)**.
  REA drives Ghidra headless (ephemeral project, `-readOnly -deleteProject`, Java bridge over a
  local socket) — not the GUI, no manual `analyzeHeadless` needed.

## Working commands

### (a) Native binary (ELF, Mach-O, PE)
```sh
export GHIDRA_INSTALL_DIR=/Users/YOURUSER/tools/rea/ghidra_12.1.4_PUBLIC
export JAVA_HOME=/Users/YOURUSER/tools/rea/jdk-21.0.12.1+1/Contents/Home

rea analyze   /path/to/bin --provider ghidra --json   # overview: segments, image base
rea search    /path/to/bin . --kind procedures --mode regex --provider ghidra --json   # function list
rea search    /path/to/bin <text> --kind strings --provider ghidra --json             # string search
rea decompile /path/to/bin <name-or-address> --provider ghidra --json                  # pseudocode
rea function  /path/to/bin <name-or-address> --provider ghidra --json                  # dossier (calls, CFG, p-code)
rea instructions /path/to/bin <address> --provider ghidra --json                       # assembly
rea xrefs /path/to/bin --address=<address> --provider ghidra --json                    # cross-references
```
Notes:
- First run on a target takes ~20–60 s (JVM start + import + auto-analysis); later commands are fast.
- Procedure selector: symbol name, or hex address with/without `0x`. For names starting with `-`,
  use `--procedure='-[Foo bar]'`.
- ELF PIE gotcha: Ghidra rebases (e.g. entry `0x11b0` → procedure `0x10011b0` at image base
  `0x1000000`). Use `rea search … --kind procedures` to get observed addresses, or
  `rea decompile <bin> --file-offset=0x11b0` for source-file offsets.

### (b) JS artifact (TV web apps, Electron, extracted JS)
```sh
rea analyze-javascript-application /path/to/dir-or-app.asar --json
```
- Accepts a **directory or .asar file** (not a bare .js file). Returns the static JavaScript
  Application Graph: module nodes, function identities, string literals, export shapes.
- Complements: `rea compare-javascript-export-shapes`, `rea export-web-scripts`,
  `rea inspect-analysis-view`.
- For a single script, quick wins are plain `strings`/`node --check` plus the graph on the folder.

### (c) Firmware — LIMITATION
- REA's firmware lane (`rea inspect-firmware-regions`, `rea extract-firmware`) **requires Linux**:
  it refuses on macOS with `capability_unavailable: "This integration requires Linux and an
  absolute REA_BINWALK_COMMAND path"` even when binwalk is installed. It also needs
  `prlimit` (util-linux), which has no macOS port.
- **Fallback for the TV firmware image: run binwalk directly** (installed, v3.1.0):
  ```sh
  binwalk -e firmware.bin          # extract everything
  binwalk --display firmware.bin  # region table
  ```
  Then feed extracted ELFs to REA (a): `rea analyze extracted/usr/bin/some-tool --provider ghidra`.
  This is exactly REA's documented workflow ("select a returned ELF separately for Ghidra analysis").
  If you ever need REA's managed firmware lane, run it on a Linux box you can SSH into (any box you control).

### (d) Pointing REA at a file
- CLI: pass the absolute (or cwd-relative) path as the first positional arg; add
  `--provider ghidra` for native analysis and `--json` for machine-readable Evidence.
- MCP: `open_binary { "path": "/abs/path", "provider_id": "ghidra" }` then
  `list_procedures` / `analyze_function` / `procedure_pseudo_code` on the same session.
- `rea doctor` = read-only health check. `rea setup` = interactive/agent MCP registration
  (`--dry-run`, `--json`, `--yes --client <id>` for scripted use).

## Proven outputs (evidence)
- `rea analyze /Users/YOURUSER/github/samsung-tv-toolbox/sdb/sdb --provider ghidra --json` →
  format `mach-o`, arch `arm64`, image base `0x100000000` (18 s first run).
- `rea search ./sdb entry --kind procedures --provider ghidra --json` → entry at `0x100002368`.
- `rea decompile ./sdb 0x100002368 --provider ghidra --json` →
  ```c
  void entry(int param_1,long param_2)
  {
    _sdb_trace_init();
    _sdb_commandline(param_1 + -1,param_2 + 8);
    return;
  }
  ```
- `rea search ./sdb samsung --kind strings --provider ghidra --json` →
  `"/dev/samsung_sdb"` @ 0x10000eca8, `"Samsung Development Bridge"` @ 0x100010a2e.
- ELF sample (zig cross-compile `zig cc -target x86_64-linux -nostdlib -static`):
  `rea analyze /tmp/tv-hello-elf` → format `elf`, arch `x86_64`, image base `0x1000000`,
  `.text` at `0x10011b0`; `rea decompile /tmp/tv-hello-elf main` →
  `int main(void) { int r; return 0x2a; }` (0x2a = 42).
- JS sample dir → graph built, functions `checkAuth`/`decodePayload` and the `'sha256'`
  literal recovered statically.

## Known open items
- Ghidra `mac_arm_64` natives are built, not shipped — if you ever re-download Ghidra, re-run
  `./gradlew buildNatives` (needs JDK 21; JDK 27 fails gradle).
- `rea setup` Hopper registration not done (Hopper 6.6.0-demo is a demo build; REA wants its
  official package). Ghidra is the primary provider anyway.
- unblob not installed (Python 3.15 + `pipx install unblob==26.6.x` if deep firmware extraction
  is needed directly); REA itself can't drive it off-Linux regardless.
- frida install script was skipped by npm allow-scripts — only relevant if using REA's Frida
  runtime-observation tools later.

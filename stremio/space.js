// Keeps the torrent cache from filling the television.
//
// The server's cacheSize only trims torrents that are no longer playing: the
// one being watched grows to its full size. The user partition is 3.85GB, so
// one long film can leave the TV unable to install or update anything (seen
// on a CU7105: a single 640MB torrent under a 512MB cap, on a set already
// out of space). Two rules, on top of the server's own:
//
//   - at start nothing is playing, so the cache is trimmed to the cap,
//     oldest torrent first
//   - while running, when the partition has less than FREE_FLOOR left, the
//     oldest torrents go, sparing the one written to last (the one playing)

'use strict';

const path = require('path');

const FREE_FLOOR = 600 * 1048576;
const SWEEP_MS = 60000;

function walk(fs, dir) {
    let size = 0;
    let newest = 0;

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            const inner = walk(fs, full);
            size += inner.size;
            newest = Math.max(newest, inner.newest);
        } else {
            const stat = fs.statSync(full);
            size += stat.size;
            newest = Math.max(newest, stat.mtimeMs);
        }
    }

    return { size, newest };
}

// One entry per torrent, oldest first by its most recently written file.
function torrents(fs, cacheDir) {
    let names;

    try {
        names = fs.readdirSync(cacheDir, { withFileTypes: true });
    } catch (e) {
        return [];
    }

    return names
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({ dir: path.join(cacheDir, entry.name), ...walk(fs, path.join(cacheDir, entry.name)) }))
        .sort((a, b) => a.newest - b.newest);
}

function remove(fs, torrent, why, log) {
    fs.rmSync(torrent.dir, { recursive: true, force: true });
    log(`cache: removed ${path.basename(torrent.dir)} (${Math.round(torrent.size / 1048576)}MB), ${why}`);
}

function trimToCap({ fs, cacheDir, cap, log }) {
    const all = torrents(fs, cacheDir);
    let total = all.reduce((sum, torrent) => sum + torrent.size, 0);

    for (const torrent of all) {
        if (total <= cap) break;
        remove(fs, torrent, `the cache was over its ${Math.round(cap / 1048576)}MB cap at start`, log);
        total -= torrent.size;
    }
}

function keepFree({ fs, cacheDir, freeBytes, floor = FREE_FLOOR, log }) {
    let free = freeBytes();
    if (free >= floor) return;

    const spare = torrents(fs, cacheDir).slice(0, -1);

    for (const torrent of spare) {
        if (free >= floor) return;
        remove(fs, torrent, `the TV was down to ${Math.round(free / 1048576)}MB free`, log);
        free = freeBytes();
    }
}

module.exports = { trimToCap, keepFree, torrents, FREE_FLOOR, SWEEP_MS };

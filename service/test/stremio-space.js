'use strict';

// The Stremio cache guard: trimmed to the cap at start, kept from filling the TV while running.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { trimToCap, keepFree, torrents } = require('../../stremio/space.js');

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
};

const MB = 1048576;

// Torrents named by age: 'a' was written to first, the last one most recently.
function cacheWith(sizesMb) {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stremio-cache-'));
    let at = Date.now() / 1000 - 3600;

    for (const [name, mb] of sizesMb) {
        const dir = path.join(cacheDir, name, '0');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, 'piece');
        fs.writeFileSync(file, Buffer.alloc(0));
        fs.truncateSync(file, mb * MB);
        fs.utimesSync(file, at, at);
        at += 60;
    }

    return cacheDir;
}

const left = (cacheDir) => torrents(fs, cacheDir).map((torrent) => path.basename(torrent.dir)).join(',');

{
    const cacheDir = cacheWith([['a', 300], ['b', 200], ['c', 100]]);
    const lines = [];
    trimToCap({ fs, cacheDir, cap: 400 * MB, log: (line) => lines.push(line) });
    check('at start the oldest torrents go until the cache fits its cap', left(cacheDir) === 'b,c', left(cacheDir));
    check('and each removal is logged', lines.length === 1 && /removed a \(300MB\)/.test(lines[0]), lines.join(' | '));
}

{
    const cacheDir = cacheWith([['a', 640]]);
    trimToCap({ fs, cacheDir, cap: 512 * MB, log: () => {} });
    check('a single torrent over the cap goes at start, since nothing is playing then', left(cacheDir) === '', left(cacheDir));
}

{
    const cacheDir = cacheWith([['a', 100], ['b', 100], ['c', 100]]);
    let free = 450 * MB;
    keepFree({ fs, cacheDir, floor: 600 * MB, freeBytes: () => free, log: () => { free += 100 * MB; } });
    check('low on space, the oldest torrents go until the floor is met', left(cacheDir) === 'c', left(cacheDir));
}

{
    const cacheDir = cacheWith([['a', 100], ['playing', 100]]);
    keepFree({ fs, cacheDir, floor: 600 * MB, freeBytes: () => 10 * MB, log: () => {} });
    check('the torrent written to last, the one playing, is never removed', left(cacheDir) === 'playing', left(cacheDir));
}

{
    const cacheDir = cacheWith([['a', 100]]);
    keepFree({ fs, cacheDir, floor: 600 * MB, freeBytes: () => 2000 * MB, log: () => {} });
    check('with space to spare nothing is touched', left(cacheDir) === 'a', left(cacheDir));
}

{
    const lines = [];
    trimToCap({ fs, cacheDir: path.join(os.tmpdir(), 'no-such-stremio-cache'), cap: MB, log: (line) => lines.push(line) });
    check('a cache that does not exist yet is fine', lines.length === 0, lines.join(' | '));
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed.`);
process.exit(failed ? 1 : 0);

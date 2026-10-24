'use strict';

// Builds and signs release/stremio-server.wgt.
//
// The package is four flat files (config.xml, icon.png, index.html, main.js
// and the vendored desktop bundle staged as src/server.js) — there is nothing
// desktop bundle is already the artifact. Signing uses the same certificate
// pair as the homebrew package, which already covers this television.

const { execFileSync } = require('child_process');
const { existsSync, mkdirSync, rmSync, cpSync } = require('fs');
const { join } = require('path');

const ROOT = join(__dirname, '..');
const STAGE = join(ROOT, '.package-stremio');
const OUT = join(ROOT, 'release', 'stremio-server.wgt');

const INCLUDE = ['config.xml', 'icon.png', 'index.html', 'main.js'];

const certificates = require(join(ROOT, 'tools', 'certificates.js'));

function main() {
    const found = certificates.locate();
    const tizenjs = require(join(ROOT, 'tools', 'which.js')).which('tizenjs');

    if (!tizenjs) throw new Error('tizenjs not found — run npm install in the repo root');

    if (!existsSync(found.author) || !existsSync(found.distributor)) {
        throw new Error('missing author or distributor certificate in ' + found.directory);
    }

    rmSync(STAGE, { recursive: true, force: true });
    mkdirSync(STAGE, { recursive: true });
    mkdirSync(join(STAGE, 'src'), { recursive: true });

    INCLUDE.forEach((f) => cpSync(join(__dirname, f), join(STAGE, f)));
    cpSync(join(ROOT, 'vendor', 'stremio', 'server.js'), join(STAGE, 'src', 'server.js'));

    mkdirSync(join(ROOT, 'release'), { recursive: true });
    rmSync(OUT, { force: true });

    execFileSync(tizenjs, [
        'build', '.',
        '-t', 'wgt',
        '-o', OUT,
        '--author', found.author,
        '--authorPwd', found.password,
        '--distributor', found.distributor,
        '--distributorPwd', found.distributorPassword
    ], { cwd: STAGE, stdio: 'inherit' });

    rmSync(STAGE, { recursive: true, force: true });
    console.log('built ' + OUT);
}

main();

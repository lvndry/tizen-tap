'use strict';

// Builds and signs release/rescue.wgt.
//
// The service is bundled the way service/build.js bundles Tizen Tap's, from
// the same sdb client and installer sources, so the rescue speaks to sdbd
// exactly as the app it repairs does. Signed with the same certificate pair;
// installed through Tizen Tap, it is re-signed for the TV on the way in.

const { execFileSync } = require('child_process');
const { existsSync, mkdirSync, rmSync, cpSync, writeFileSync } = require('fs');
const { join } = require('path');

const { rolldown } = require('rolldown');

const ROOT = join(__dirname, '..');
const STAGE = join(ROOT, '.package-rescue');
const OUT = join(ROOT, 'release', 'rescue.wgt');

const TARGET = 'node12';
const INCLUDE = ['config.xml', 'icon.png', 'index.html'];

// The rescue carries an sdb client and an installer and nothing else.
const CEILING = 80 * 1024;

const certificates = require(join(ROOT, 'tools', 'certificates.js'));

async function bundle() {
    const built = await rolldown({
        input: join(__dirname, 'src', 'main.ts'),
        platform: 'node',
        transform: { target: TARGET }
    });

    const { output } = await built.generate({ format: 'cjs' });
    const entry = output.find((chunk) => chunk.type === 'chunk' && chunk.isEntry);

    if (!/onStart/.test(entry.code)) throw new Error('the rescue bundle does not export onStart');

    const bytes = Buffer.byteLength(entry.code);
    if (bytes > CEILING) throw new Error(`the rescue bundle is ${bytes} bytes, over the ${CEILING} ceiling`);

    return entry.code;
}

async function main() {
    const found = certificates.locate();
    const tizenjs = require(join(ROOT, 'tools', 'which.js')).which('tizenjs');

    if (!tizenjs) throw new Error('tizenjs not found: run npm install in the repo root');

    if (!existsSync(found.author) || !existsSync(found.distributor)) {
        throw new Error('missing author or distributor certificate in ' + found.directory);
    }

    const code = await bundle();

    rmSync(STAGE, { recursive: true, force: true });
    mkdirSync(STAGE, { recursive: true });

    INCLUDE.forEach((name) => cpSync(join(__dirname, name), join(STAGE, name)));
    writeFileSync(join(STAGE, 'main.js'), code);

    execFileSync(process.execPath, [join(ROOT, 'service', 'check-syntax.js'), join(STAGE, 'main.js')], { stdio: 'inherit' });

    mkdirSync(join(ROOT, 'release'), { recursive: true });
    rmSync(OUT, { force: true });

    try {
        execFileSync(tizenjs, [
            'build', '.',
            '-t', 'wgt',
            '-o', OUT,
            '--author', found.author,
            '--authorPwd', found.password,
            '--distributor', found.distributor,
            '--distributorPwd', found.distributorPassword
        ], { cwd: STAGE, stdio: 'inherit' });
    } finally {
        rmSync(STAGE, { recursive: true, force: true });
    }

    console.log(`built ${OUT} (service bundle ${Buffer.byteLength(code)} bytes)`);
}

main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
});

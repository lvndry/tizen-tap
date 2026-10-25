'use strict';

const { writeFileSync, mkdirSync, statSync } = require('fs');

const { interpret, settled } = require('./verdicts.ts');

const STAGING_DIR = '/home/owner/share/tmp/sdk_tools';
const INSTALL_TIMEOUT = 180000;

function problem(code, message) {
    return Object.assign(new Error(message), { code });
}

// Running on the TV makes staging an ordinary file write, with no ADB sync protocol to reimplement.
function stage(archive, { isWgt }) {
    const path = `${STAGING_DIR}/package.${isWgt ? 'wgt' : 'tpk'}`;

    mkdirSync(STAGING_DIR, { recursive: true });
    writeFileSync(path, archive);

    const written = statSync(path).size;

    if (written !== archive.length) {
        throw problem('internal', `Staged ${written} bytes but the package is ${archive.length}.`);
    }

    return path;
}

function run(session, path, packageId) {
    return session.exec(`shell:0 vd_appinstall ${packageId} ${path}`, {
        timeout: INSTALL_TIMEOUT,
        until: settled
    }).then((output) => interpret(output, { packageId }));
}

module.exports = { stage, run, STAGING_DIR };

'use strict';

const { writeFileSync, mkdirSync, statSync } = require('fs');

const { interpret, settled, failureIn } = require('./verdicts.ts');
const { ErrorCode } = require('../protocol.ts');

const STAGING_DIR = '/home/owner/share/tmp/sdk_tools';
const INSTALL_TIMEOUT = 180000;
const PKGCMD = '/usr/bin/pkgcmd';

// pkgcmd reports through its request callback, one `key[...] val[...]` line per event; the end event
// is the verdict.
const PKGCMD_SUCCEEDED = /key\[end\]\s*val\[ok\]/i;
const PKGCMD_FAILED = /key\[error\]|key\[end\]\s*val\[fail\]/i;

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

// Plain words only: the root channel turned a printf escape into a literal backslash on the TV.
function rootCommand(path) {
    return `${PKGCMD} -i -t ${/\.tpk$/.test(path) ? 'tpk' : 'wgt'} -p ${path}`;
}

function interpretPkgcmd(result, context) {
    const text = `${result.stdout || ''}${result.stderr ? `\n${result.stderr}` : ''}`;
    const tail = text.trim().slice(-400) || '(empty)';
    const known = failureIn(text, context);

    if (known) {
        throw Object.assign(new Error(known.line), { code: known.code, remedy: known.remedy });
    }

    if (result.timedOut) {
        throw problem(ErrorCode.INSTALL_FAILED, `pkgcmd did not finish in ${INSTALL_TIMEOUT / 1000}s. Output: ${tail}`);
    }

    if (PKGCMD_FAILED.test(text)) {
        throw problem(ErrorCode.INSTALL_FAILED, `pkgcmd refused the package (exit ${result.exit}). Output: ${tail}`);
    }

    if (PKGCMD_SUCCEEDED.test(text)) return { output: text };

    throw problem(ErrorCode.INSTALL_FAILED, result.exit !== 0
        ? `pkgcmd exited ${result.exit}. Output: ${tail}`
        : `pkgcmd reported neither success nor failure. Output: ${tail}`);
}

function runAsRoot(channel, path, packageId) {
    return channel.exec(rootCommand(path), INSTALL_TIMEOUT)
        .then((result) => interpretPkgcmd(result, { packageId }));
}

module.exports = { stage, run, runAsRoot, rootCommand, interpretPkgcmd, STAGING_DIR };

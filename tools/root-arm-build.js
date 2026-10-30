'use strict';

// Builds the root-arm staging payload once, on a computer with openssl and the
// samsung-tv-root payloads. The output is committed and shipped inside the wgt,
// so the television itself only ever copies files: no openssl, no key material
// and no build step run on the TV.
//
// The payload is the SamsungTvRootAgent from chris-ritsen/samsung-tv-root,
// launched the same way its archive-root route launches it: the SVE-2025-50109
// appinstall-argument injection runs the launcher under sdbd's capabilities,
// and the launcher hands a signed single-file tar to sdbd-tarlauncher, which
// executes launch.sh as uid 0. The resulting agent connects back over loopback
// to the service's root channel (service/src/root/channel.ts) and stays there,
// which is what "root" is on this set: an open, authenticated channel, not a
// persistent process we can see.
//
// Source: ~/github/samsung-tv-root (override with SAMSUNG_TV_ROOT).
//   payloads/common/out/SamsungTvArchiveRoot.dll   the launcher (uid 901)
//   payloads/common/out/SamsungTvRootAgent.dll     the agent (uid 0)
// Rebuild after updating those:  npm run rootarm   (from the repo root)
// Then re-package:                npm run package  (copies the output into the wgt)

const { execFileSync } = require('child_process');
const {
    copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync
} = require('fs');
const { join } = require('path');
const { randomBytes } = require('crypto');

// The launcher validates this exact shape: "archive-root-" + 16 lowercase hex.
// It is fixed on purpose: with a fixed staging path, the signed tar and its
// launch.sh are identical on every television, so the artifacts can be
// committed instead of regenerated per run.
const PACKAGE = 'archive-root-0000000000000001';
const STAGING_ROOT = '/home/owner/share/tmp/sdk_tools';
const STAGING = `${STAGING_ROOT}/${PACKAGE}`;

// The service listens for the agent on loopback. 8092 sits next to 8091 and is
// not claimed by any Samsung system service (8080 is).
const CALLBACK_HOST = '127.0.0.1';
const CALLBACK_PORT = 8092;

function fail(message) {
    const error = new Error(message);
    error.isFriendly = true;
    throw error;
}

function openssl(args, { binary = false } = {}) {
    return execFileSync('openssl', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: binary ? 'buffer' : 'utf8'
    });
}

function main() {
    const source = process.env.SAMSUNG_TV_ROOT || join(process.env.HOME, 'github', 'samsung-tv-root');
    const outDir = join(__dirname, '..', 'vendor', 'root-arm');

    for (const name of ['SamsungTvArchiveRoot.dll', 'SamsungTvRootAgent.dll']) {
        const from = join(source, 'payloads', 'common', 'out', name);
        if (!existsSync(from)) {
            fail(`Missing ${from}. Clone and build samsung-tv-root first (see the header),\n` +
                '  or point SAMSUNG_TV_ROOT at a checkout that has payloads/common/out/.');
        }
    }

    // The staging directory carries everything the launcher and the agent need.
    // Everything here except the token is safe to leave world-readable; the
    // token is the channel's key, so it is written 0600 on the TV at stage time.
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });

    const artifacts = {};
    for (const name of [
        'SamsungTvArchiveRoot.dll', 'SamsungTvArchiveRoot.runtimeconfig.json',
        'SamsungTvRootAgent.dll', 'SamsungTvRootAgent.runtimeconfig.json'
    ]) {
        const from = join(source, 'payloads', 'common', 'out', name);
        copyFileSync(from, join(outDir, name));
        artifacts[name] = statSync(from).size;
    }

    // The launcher bind-mounts the public key onto /usr/share/sdbd/public.pem
    // and uses it to verify the tar signature; the private key never leaves
    // this machine. A fresh keypair per build, so a leaked artifact is not a
    // leaked signature for every other television.
    const keyDir = join(outDir, '.keys');
    mkdirSync(keyDir, { recursive: true });
    execFileSync('openssl', [
        'genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048',
        '-out', join(keyDir, 'private.pem')
    ], { stdio: 'pipe' });
    execFileSync('openssl', [
        'pkey', '-in', join(keyDir, 'private.pem'), '-pubout', '-out', join(outDir, 'public.pem')
    ], { stdio: 'pipe' });

    // A single owner line, so the launcher's /etc/passwd view resolves uid 0
    // and the dotnet process can read its own identity.
    writeFileSync(join(outDir, 'passwd'), 'owner:x:0:0:owner:/home/owner:/bin/sh\n', 'ascii');

    // The channel's secret. Committed on purpose: it only authorises a
    // connection between the agent and this service over loopback on the same
    // television, and both ends ship in the same signed wgt.
    const token = Buffer.from(randomBytes(32)).toString('base64');
    writeFileSync(join(outDir, 'root-agent.token'), token, 'ascii');

    // The signed tar contains exactly launch.sh; sdbd-tarlauncher expands it
    // and hands it to /bin/sh as root (--to-command). Fixed staging means the
    // script text is stable across builds.
    const launch = [
        '#!/bin/sh',
        `exec /usr/bin/dotnet ${STAGING}/SamsungTvRootAgent.dll ` +
        `${CALLBACK_HOST} ${CALLBACK_PORT} ${STAGING}/root-agent.token ${STAGING}`
    ].join('\n') + '\n';

    // Node has no portable gzip+tar writer without a dependency, and this runs
    // on a computer: use the system tar. mtime fixed so the artifacts (and the
    // signature) are byte-identical across rebuilds of the same inputs.
    const tarDir = join(outDir, '.tar');
    mkdirSync(tarDir, { recursive: true });
    writeFileSync(join(tarDir, 'launch.sh'), launch, { mode: 0o600 });
    const tarPath = join(outDir, `${PACKAGE}.tar.gz`);
    const signaturePath = join(outDir, `${PACKAGE}.tar.gz.signature`);

    // Pin the member's mtime the portable way: touch, then plain tar. Both
    // GNU tar and bsdtar honour the file mtime; neither takes --mtime.
    execFileSync('touch', ['-t', '197001010000', join(tarDir, 'launch.sh')], { stdio: 'pipe' });
    rmSync(tarPath, { force: true });
    execFileSync('tar', ['-czf', tarPath, '-C', tarDir, 'launch.sh'], { stdio: 'pipe' });
    rmSync(tarDir, { recursive: true, force: true });

    // openssl dgst -sign writes the raw RSA signature to stdout; it is binary,
    // so it must not pass through a utf8 string on the way to the file.
    const signature = openssl(['dgst', '-sha256', '-sign', join(keyDir, 'private.pem'), tarPath], { binary: true });
    writeFileSync(signaturePath, signature);

    // Sanity: the signature must verify against the public key before it
    // ships. A mismatch here means the tar changed after signing, which it
    // cannot — but catching it beats finding out on the television.
    try {
        execFileSync('openssl', [
            'dgst', '-sha256', '-verify', join(outDir, 'public.pem'),
            '-signature', signaturePath, tarPath
        ], { stdio: 'pipe' });
    } catch (e) {
        fail('signature verification failed on the freshly built artifacts:\n' +
            (e.stderr || e.message));
    }
    rmSync(keyDir, { recursive: true, force: true });

    // The service needs to know where it is staging from, and the docs need
    // the token's shape (not the value — it is a file, never printed).
    writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({
        schemaVersion: 1,
        package: PACKAGE,
        stagingRoot: STAGING_ROOT,
        staging: STAGING,
        callbackHost: CALLBACK_HOST,
        callbackPort: CALLBACK_PORT,
        files: Object.assign({}, artifacts, {
            'public.pem': statSync(join(outDir, 'public.pem')).size,
            'passwd': 37,
            'root-agent.token': token.length,
            [`${PACKAGE}.tar.gz`]: statSync(tarPath).size,
            [`${PACKAGE}.tar.gz.signature`]: Buffer.byteLength(signature)
        })
    }, null, 4) + '\n');

    console.log(`root-arm payload built into vendor/root-arm/`);
    console.log(`  package   ${PACKAGE}`);
    console.log(`  staging   ${STAGING}`);
    console.log(`  callback  ${CALLBACK_HOST}:${CALLBACK_PORT}`);
}

main();

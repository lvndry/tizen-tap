'use strict';

const { readFileSync } = require('fs');
const { basename } = require('path');

const ui = require('./ui.js');
const { parse } = require('./args.js');

const PORT = 8091;

// The rescue's own installer, for when Tizen Tap itself is what is broken.
const RESCUE_PORT = 8093;
const DEFAULT_PIN = '000000';
const BUSY_GIVE_UP_MS = 10 * 60 * 1000;

const friendly = (message) => Object.assign(new Error(message), { isFriendly: true });

const isUrl = (source) => /^https?:\/\//.test(source);

const buildOf = async (host) => {
    try {
        const response = await fetch(`http://${host}:${PORT}/version`, { signal: AbortSignal.timeout(3000) });
        return response.ok ? (await response.json()).build || null : null;
    } catch (e) {
        return null;
    }
};

// A self-update restarts the service while it is still answering the upload, so the connection
// drops even when the install worked. Waiting for /version tells the two apart.
async function afterDrop(host, buildBefore, reason) {
    for (let waited = 0; waited < 90; waited += 3) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const build = await buildOf(host);
        if (!build) continue;

        if (build !== buildBefore) return { build, updated: true };
        return { build, updated: false };
    }

    throw friendly(`Tizen Tap stopped answering on ${host}:${PORT} (${reason}) and did not come back within 90 s.\n` +
        '  A self-update can leave the service down until something relaunches it:\n' +
        `  TV_IP=${host} node app.js GJBBYNLkgP.TizenHomebrew --wait ${PORT}   (samsung-tv-toolbox)`);
}

async function load(source) {
    if (!isUrl(source)) {
        try {
            return readFileSync(source);
        } catch (e) {
            throw friendly(`Cannot read ${source}: ${e.message}`);
        }
    }

    const response = await fetch(source).catch((e) => { throw friendly(`Download failed: ${e.message}`); });
    if (!response.ok) throw friendly(`Download failed: HTTP ${response.status} for ${source}`);

    return Buffer.from(await response.arrayBuffer());
}

const main = async () => {
    const args = parse(process.argv.slice(2), ['--pin', '--name']);
    const [host, source] = args.positionals;
    const pin = args.value('--pin') || DEFAULT_PIN;
    const rescue = args.has('--rescue');
    const port = rescue ? RESCUE_PORT : PORT;

    if (!host || !source) throw friendly('Usage:  npm run install-app -- <tv-ip> <url-or-path> [--pin 123456] [--name "My App"] [--rescue]');

    const name = args.value('--name') || basename(isUrl(source) ? new URL(source).pathname : source);

    ui.heading('install-app', rescue ? `${host} (rescue :${RESCUE_PORT})` : host);

    const started = Date.now();
    const archive = await load(source);
    const buildBefore = rescue ? null : await buildOf(host);

    const post = () => fetch(`http://${host}:${port}/install`, {
        method: 'POST',
        headers: {
            'content-type': 'application/octet-stream',
            'x-homebrew-pin': pin,
            'x-homebrew-name': name
        },
        body: archive,
        signal: AbortSignal.timeout(300000)
    }).catch((e) => e);

    // The service queues a second install itself; a 409 means the line was too slow or a
    // self-update is running, and both clear by themselves.
    let response = await post();
    while (!(response instanceof Error) && response.status === 409 && Date.now() - started < BUSY_GIVE_UP_MS) {
        const seconds = Number(response.headers.get('retry-after')) || 10;
        ui.info('busy', `another install is running on the TV; retrying in ${seconds}s`);
        await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
        response = await post();
    }

    if (response instanceof Error) {
        if (rescue) {
            throw friendly(`The rescue did not answer on ${host}:${RESCUE_PORT}: ${response.message}\n` +
                `  Is Tizen Tap Rescue installed and running? curl http://${host}:${RESCUE_PORT}/health`);
        }

        if (!buildBefore) throw friendly(`Tizen Tap did not answer on ${host}:${PORT}: ${response.message}`);

        const after = await afterDrop(host, buildBefore, response.message);
        if (after.updated) {
            ui.ok(name, `${ui.bytes(archive.length)} · self-update: the service restarted on ${after.build}`, Date.now() - started);
            ui.blank();
            return;
        }

        throw friendly(`The connection dropped mid-install and the service came back on the same build (${after.build}).\n` +
            '  The install most likely did not happen; check GET /packages, then retry.');
    }

    const refusal = async () => ((await response.clone().json().catch(() => null)) || {}).message;
    if (response.status === 403) throw friendly('The PIN was refused. The current one is on the TV screen.');
    if (response.status === 429) throw friendly((await refusal()) || 'Pairing is locked after too many wrong PINs.');
    if (response.status === 409) throw friendly((await refusal()) || 'Another install is running. Retry in a moment.');

    const result = await response.json().catch(() => null);

    if (!result || !result.ok) {
        const trace = ((result && result.phases) || []).map((phase) => `      ${phase}`).join('\n');
        throw friendly(`The install failed: ${(result && result.message) || `HTTP ${response.status}`}` +
            (trace ? `\n\n${trace}` : '') +
            (result && result.remedy ? `\n\n  ${result.remedy}` : ''));
    }

    ui.ok(name, `${ui.bytes(archive.length)} · ${result.packageId || ''} v${result.version || '?'}`, Date.now() - started);

    // The rescue launches what it installed itself.
    if (rescue) {
        ((result.phases || []).filter((line) => /^launched /.test(line))).forEach((line) => ui.ok('launch', line.slice(9)));
    } else if (result.appId) {
        const launched = await fetch(`http://${host}:8001/api/v2/applications/${result.appId}`, { method: 'POST' })
            .catch(() => null);
        if (launched && launched.ok) ui.ok('launch', result.appId);
        else ui.warn(`installed, but launching ${result.appId} failed. Open it from the TV`);
    }

    ui.blank();
};

main().catch((error) => ui.crash(error));

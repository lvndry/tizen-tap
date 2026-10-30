'use strict';

const { readFileSync } = require('fs');
const { basename } = require('path');

const ui = require('./ui.js');
const { parse } = require('./args.js');

const PORT = 8091;
const DEFAULT_PIN = '000000';

const friendly = (message) => Object.assign(new Error(message), { isFriendly: true });

const isUrl = (source) => /^https?:\/\//.test(source);

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

    if (!host || !source) throw friendly('Usage:  npm run install-app -- <tv-ip> <url-or-path> [--pin 123456] [--name "My App"]');

    const name = args.value('--name') || basename(isUrl(source) ? new URL(source).pathname : source);

    ui.heading('install-app', host);

    const started = Date.now();
    const archive = await load(source);

    const response = await fetch(`http://${host}:${PORT}/install`, {
        method: 'POST',
        headers: {
            'content-type': 'application/octet-stream',
            'x-homebrew-pin': pin,
            'x-homebrew-name': name
        },
        body: archive,
        signal: AbortSignal.timeout(300000)
    }).catch((e) => { throw friendly(`Tizen Tap did not answer on ${host}:${PORT}: ${e.message}`); });

    if (response.status === 403) throw friendly('The PIN was refused. The current one is on the TV screen.');
    const retryAfter = response.headers.get('retry-after');
    const wait = retryAfter ? `${retryAfter}s` : 'a minute';

    if (response.status === 429) {
        throw friendly(`This machine is locked out after too many wrong PINs. Wait ${wait}, then use the PIN on the TV screen.`);
    }
    if (response.status === 409) {
        const busy = await response.json().catch(() => ({}));
        const running = busy.installing && busy.installing.name ? ` (${busy.installing.name})` : '';
        throw friendly(`Another install is running on the TV${running}. Try again in ${wait}.`);
    }

    const result = await response.json().catch(() => null);

    if (!result || !result.ok) {
        const trace = ((result && result.phases) || []).map((phase) => `      ${phase}`).join('\n');
        throw friendly(`The install failed: ${(result && result.message) || `HTTP ${response.status}`}` +
            (trace ? `\n\n${trace}` : '') +
            (result && result.remedy ? `\n\n  ${result.remedy}` : ''));
    }

    ui.ok(name, `${ui.bytes(archive.length)} · ${result.packageId || ''} v${result.version || '?'}`, Date.now() - started);

    if (result.appId) {
        const launched = await fetch(`http://${host}:8001/api/v2/applications/${result.appId}`, { method: 'POST' })
            .catch(() => null);
        if (launched && launched.ok) ui.ok('launch', result.appId);
        else ui.warn(`installed, but launching ${result.appId} failed. Open it from the TV`);
    }

    ui.blank();
};

main().catch((error) => ui.crash(error));

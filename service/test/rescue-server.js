'use strict';

// The rescue's :8093 installer: routes, PIN gate and lockout, the busy gate,
// and the install itself, with sdb, staging, signing and launch injected.

const http = require('http');
const JSZip = require('jszip');

const lastgood = require('../src/rescue/lastgood.ts');
const { resolvePin, createGate, createInstall, createServer, createPinGate, BUSY_RETRY_SECONDS } = require('../../rescue/src/server.ts');
const pin = require('../src/auth/pin.ts');

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
};

const PIN = '424242';

async function packageOf(packageId, appId = `${packageId}.App`) {
    const zip = new JSZip();

    zip.file('config.xml', '<?xml version="1.0"?><widget version="1.2.3">' +
        `<tizen:application id="${appId}" package="${packageId}" required_version="3.0"/>` +
        '<name>Some App</name></widget>');
    zip.file('index.html', '<html></html>');

    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function memoryFs(initial = {}) {
    const files = new Map(Object.entries(initial));
    const ops = [];

    return {
        files,
        ops,
        existsSync: (path) => files.has(path),
        readFileSync: (path) => {
            if (!files.has(path)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
            return files.get(path);
        },
        writeFileSync: (path, data) => { ops.push(['write', path]); files.set(path, Buffer.from(String(data))); },
        renameSync: (from, to) => { ops.push(['rename', from, to]); files.set(to, files.get(from)); files.delete(from); },
        mkdirSync: () => {}
    };
}

function fakeSdb(replies) {
    const seen = { commands: [], released: 0 };

    return {
        seen,
        withSession: (_options, fn) => fn({
            exec: (command) => {
                seen.commands.push(command);
                const reply = replies.length > 1 ? replies.shift() : replies[0];
                return Promise.resolve(reply);
            }
        }),
        release: () => { seen.released++; }
    };
}

function serve(handle) {
    return new Promise((resolve) => {
        const server = http.createServer(handle);
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

function request(server, { method = 'GET', path = '/health', headers = {}, body = null } = {}) {
    return new Promise((resolve, reject) => {
        const outgoing = http.request({ host: '127.0.0.1', port: server.address().port, method, path, headers }, (response) => {
            let text = '';
            response.on('data', (chunk) => { text += chunk; });
            response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(text) }));
        });
        outgoing.on('error', reject);
        outgoing.end(body);
    });
}

async function pins() {
    {
        const fs = memoryFs();
        const chosen = resolvePin({ fs, readConfig: () => ({ developerBuild: true, pin: '111111' }), log: () => {} });
        check('pin: a Tizen Tap developer build means 000000, which is what it answers', chosen.pin === '000000' && chosen.source === 'developer',
            JSON.stringify(chosen));
    }

    {
        const fs = memoryFs();
        const chosen = resolvePin({ fs, readConfig: () => ({ developerBuild: false, pin: '123456' }), log: () => {} });
        check('pin: otherwise Tizen Tap\'s stored pairing PIN', chosen.pin === '123456' && chosen.source === 'tizen-tap' && fs.ops.length === 0,
            JSON.stringify(chosen));
    }

    {
        const fs = memoryFs();
        const lines = [];
        const first = resolvePin({ fs, readConfig: () => null, generate: () => '987654', log: (line) => lines.push(line) });
        const second = resolvePin({ fs, readConfig: () => null, generate: () => '000001', log: (line) => lines.push(line) });

        check('pin: with no Tizen Tap PIN a rescue PIN is minted once, kept through a temp name, and logged',
            first.pin === '987654' && second.pin === '987654' && first.source === 'rescue' &&
            JSON.stringify(fs.ops) === JSON.stringify([
                ['write', `${lastgood.RESCUE_PIN}.tmp`],
                ['rename', `${lastgood.RESCUE_PIN}.tmp`, lastgood.RESCUE_PIN]
            ]) && lines.length === 1 && /987654/.test(lines[0]), `${JSON.stringify(fs.ops)} ${lines.join(' | ')}`);
    }

    {
        const authorise = createPinGate({ resolve: () => ({ pin: PIN }), log: () => {} });
        const verdicts = [];
        for (let attempt = 0; attempt < pin.MAX_ATTEMPTS; attempt++) verdicts.push(authorise('000000', '192.168.1.50'));
        const locked = authorise(PIN, '192.168.1.50');
        const other = authorise(PIN, '192.168.1.51');

        check('lockout: five wrong PINs lock that address out, even with the right PIN after',
            verdicts.every((verdict) => !verdict.ok) && !locked.ok && locked.retryAfterSeconds > 0, JSON.stringify(locked));
        check('lockout: another address is not affected', other.ok, JSON.stringify(other));
    }

    {
        let current = PIN;
        const authorise = createPinGate({ resolve: () => ({ pin: current }), log: () => {} });
        const before = authorise(PIN, '10.0.0.2');
        current = '555555';
        const after = authorise('555555', '10.0.0.2');

        check('pin: a PIN Tizen Tap changes is picked up on the next request', before.ok && after.ok, JSON.stringify(after));
    }
}

async function routes() {
    const installs = [];
    let release = null;
    const handle = createServer({
        health: async () => ({ ok: true, rescue: '1.0.0+abc.20261030T1500', tizenTap: { installed: true, answering: false } }),
        install: async (upload, name) => {
            installs.push({ size: upload.length, name });
            if (name === 'slow') await new Promise((done) => { release = done; });
            return { ok: true, packageId: 'ACME000001', appId: 'ACME000001.App', version: '1.2.3', phases: ['installed'] };
        },
        authorise: createPinGate({ resolve: () => ({ pin: PIN }), log: () => {} }),
        gate: createGate(),
        log: () => {}
    });
    const server = await serve(handle);

    try {
        const health = await request(server);
        check('health: answers without a PIN, in its shape', health.status === 200 && health.body.ok === true &&
            typeof health.body.rescue === 'string' && health.body.tizenTap.installed === true && health.body.tizenTap.answering === false,
            JSON.stringify(health.body));

        const probes = await Promise.all(['/dev/eval', '/dev/shell', '/dev/root/exec', '/packages', '/install'].map((path) =>
            request(server, { method: path === '/install' ? 'GET' : 'POST', path, headers: { 'x-homebrew-pin': PIN } })));
        check('routes: nothing else answers (no eval, no shell, no root, no GET /install)',
            probes.every((reply) => reply.status === 404) && installs.length === 0, probes.map((reply) => reply.status).join(','));

        const refused = await request(server, { method: 'POST', path: '/install', headers: { 'x-homebrew-pin': '000000' }, body: 'x' });
        check('install: a wrong PIN is a 403 and installs nothing', refused.status === 403 && installs.length === 0, String(refused.status));

        const done = await request(server, { method: 'POST', path: '/install', headers: { 'x-homebrew-pin': PIN, 'x-homebrew-name': 'app.wgt' }, body: 'abc' });
        check('install: the right PIN runs the install and answers its outcome', done.status === 200 && done.body.packageId === 'ACME000001' &&
            installs.length === 1 && installs[0].size === 3 && installs[0].name === 'app.wgt', JSON.stringify(done.body));

        const slow = request(server, { method: 'POST', path: '/install', headers: { 'x-homebrew-pin': PIN, 'x-homebrew-name': 'slow' }, body: 'abc' });
        while (!release) await new Promise((done) => setTimeout(done, 5));

        const busy = await request(server, { method: 'POST', path: '/install', headers: { 'x-homebrew-pin': PIN }, body: 'abc' });
        check('busy: a second install while one runs is a 409 with Retry-After', busy.status === 409 &&
            busy.headers['retry-after'] === String(BUSY_RETRY_SECONDS) && busy.body.code === 'installBusy' && installs.length === 2,
            `${busy.status} ${JSON.stringify(busy.body)}`);

        release();
        await slow;
        const again = await request(server, { method: 'POST', path: '/install', headers: { 'x-homebrew-pin': PIN }, body: 'abc' });
        check('busy: the gate opens again once the install finishes', again.status === 200, String(again.status));

        for (let attempt = 0; attempt < pin.MAX_ATTEMPTS; attempt++) {
            await request(server, { method: 'POST', path: '/install', headers: { 'x-homebrew-pin': '999999' }, body: 'x' });
        }
        const locked = await request(server, { method: 'POST', path: '/install', headers: { 'x-homebrew-pin': PIN }, body: 'abc' });
        check('lockout: over HTTP it is a 429 with Retry-After', locked.status === 429 && Number(locked.headers['retry-after']) > 0,
            `${locked.status} ${JSON.stringify(locked.headers)}`);
    } finally {
        server.close();
    }

    {
        const gate = createGate();
        const held = gate.enter('boot reinstall');
        const second = gate.enter('upload');
        held();
        check('gate: the boot reinstall and an upload exclude each other', second === null && typeof gate.enter('upload') === 'function', 'both entered');
    }
}

async function installs() {
    const archive = await packageOf('ACME000001');

    {
        const sdb = fakeSdb(['spend time 2.0']);
        const launched = [];
        const staged = [];
        const install = createInstall({
            readConfig: () => ({ pin: PIN }),
            resign: async () => { throw new Error('must not sign'); },
            stage: (data, identity) => { staged.push(identity.packageId); return '/home/owner/share/tmp/sdk_tools/package.wgt'; },
            sdb, launch: async (appId) => { launched.push(appId); }, log: () => {}
        });

        const outcome = await install(archive, 'app.wgt');

        check('install: the package id comes out of the archive\'s config.xml', outcome.packageId === 'ACME000001' &&
            outcome.appId === 'ACME000001.App' && outcome.version === '1.2.3' && staged[0] === 'ACME000001', JSON.stringify(outcome));
        check('install: one in-place vd_appinstall over loopback sdb', sdb.seen.commands.length === 1 &&
            sdb.seen.commands[0] === 'shell:0 vd_appinstall ACME000001 /home/owner/share/tmp/sdk_tools/package.wgt', JSON.stringify(sdb.seen.commands));
        check('install: sdbd is released and the app launched', sdb.seen.released === 1 && launched.join() === 'ACME000001.App',
            `${sdb.seen.released} ${launched}`);
        check('install: without a stored pair it installs as sent, and says so', outcome.phases.some((line) => /installing as sent/.test(line)),
            outcome.phases.join(' | '));
    }

    {
        const sdb = fakeSdb(['spend time 2.0']);
        const signed = [];
        const install = createInstall({
            readConfig: () => ({ author: { key: 'a' }, distributor: { key: 'd' } }),
            resign: async (upload, certificates) => { signed.push(certificates.author.key); return { archive: upload }; },
            stage: () => '/home/owner/share/tmp/sdk_tools/package.wgt',
            sdb, launch: async () => {}, log: () => {}
        });

        const outcome = await install(archive);
        check('install: with Tizen Tap\'s stored pair it re-signs first, as Tizen Tap does', signed.join() === 'a' &&
            outcome.phases.some((line) => /re-signed/.test(line)), outcome.phases.join(' | '));
    }

    {
        const sdb = fakeSdb(['app_id[ACME000001] install failed[118, -12] Invalid certificate chain with certificate in signature']);
        const install = createInstall({
            readConfig: () => ({}), stage: () => '/home/owner/share/tmp/sdk_tools/package.wgt',
            sdb, launch: async () => { throw new Error('must not launch'); }, log: () => {}
        });

        const error = await install(archive).then(() => null, (failure) => failure);

        check('install: a refusal carries the installer\'s own words and the phases so far',
            error && /Invalid certificate chain/.test(error.message) && error.phases.length >= 3, error && `${error.message} ${error.phases}`);
        check('install: no backslash in any sdb command', sdb.seen.commands.length > 0 &&
            sdb.seen.commands.every((command) => command.indexOf('\\') === -1), JSON.stringify(sdb.seen.commands));
        check('install: sdbd is released after a failure', sdb.seen.released === 1, String(sdb.seen.released));
    }

    {
        const sdb = fakeSdb(['spend time 2.0']);
        const install = createInstall({ readConfig: () => ({}), stage: () => '/x', sdb, launch: async () => {}, log: () => {} });
        const own = await install(await packageOf(lastgood.RESCUE_PACKAGE_ID)).then(() => null, (failure) => failure);
        const junk = await install(Buffer.from('not a zip')).then(() => null, (failure) => failure);

        check('install: the rescue refuses to replace itself', own && own.code === 'rescueSelf' && sdb.seen.commands.length === 0, String(own));
        check('install: a file that is not a package is a badPackage before sdb', junk && junk.code === 'badPackage' &&
            sdb.seen.commands.length === 0, String(junk));
    }
}

async function statusProbe() {
    const { rescuePortAnswers } = require('../src/routes/status.ts');
    const server = await serve((_request, response) => { response.writeHead(200); response.end('{}'); });
    const port = server.address().port;

    const up = await rescuePortAnswers('127.0.0.1', port, 1000);
    server.close();
    await new Promise((done) => server.once('close', done));
    const down = await rescuePortAnswers('127.0.0.1', port, 1000);

    check('status: /dev/status reports whether :8093 answers /health', up === true && down === false, `${up} ${down}`);
}

async function main() {
    await pins();
    await routes();
    await installs();
    await statusProbe();

    const failed = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed.`);
    process.exit(failed ? 1 : 0);
}

main().catch((error) => {
    console.error('\nHarness error:', error.stack || error.message);
    process.exit(1);
});

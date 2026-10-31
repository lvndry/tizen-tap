'use strict';

// A POST /install behind a running self-update: 409, Retry-After, and a body naming what is running.
// Any other install waits its turn instead (test/pipeline.js).

const http = require('http');
const WebSocket = require('ws');
const { createRouter } = require('../src/http/router.ts');
const { createInstaller, busyRetrySeconds } = require('../src/install/pipeline.ts');
const { createStore } = require('../src/state.ts');
const { attach } = require('../src/socket.ts');
const protocol = require('../src/protocol.ts');
const install = require('../src/routes/install.ts');

const results = [];
function check(name, ok, detail) {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
}

const QUIET = { on: () => ({ debug() {}, info() {}, ok() {}, warn() {}, err() {} }) };

check('a retry is never sooner than 10s', busyRetrySeconds(Date.now()) === 10, String(busyRetrySeconds(Date.now())));
check('nor later than 30s', busyRetrySeconds(Date.now() - 10 * 60 * 1000) === 30,
    String(busyRetrySeconds(Date.now() - 10 * 60 * 1000)));
check('a longer-running install asks for a longer wait',
    busyRetrySeconds(Date.now() - 39000) === 20, String(busyRetrySeconds(Date.now() - 39000)));
check('an install with no start time still asks for a wait', busyRetrySeconds(null) === 10, String(busyRetrySeconds(null)));

// 39s in, so the ask is 20s with a second of slack for the test itself.
const startedAt = Date.now() - 39000;
const store = createStore({
    installing: { name: 'Tizen Tap', self: true, phase: 'installing', startedAt },
    catalog: [],
    device: null
});

const installer = createInstaller({
    sdb: {}, device: {}, config: {}, resigner: () => {}, store, log: QUIET
});

const router = createRouter();
install.register({
    authorise: () => ({ ok: true }),
    installer,
    updates: { changed() {} },
    sdb: {},
    store,
    config: {},
    log: QUIET,
    recorded: {}
}, router);

const server = http.createServer(router.listener);

attach({
    server, store, installer, protocol,
    authorise: () => ({ ok: true }),
    catalog: {}, updates: { changed() {} }, relay: { enabled: false },
    refreshDevice: () => Promise.resolve({}),
    fromLoopback: () => false,
    greeting: () => ({}),
    recorded: { since: () => [], uptime: () => 0, subscribe: () => () => {} },
    config: { hasCertificates: () => false },
    log: null
});

function upload(port) {
    return new Promise((resolve, reject) => {
        const request = http.request({
            host: '127.0.0.1', port, path: '/install', method: 'POST',
            headers: { 'content-type': 'application/octet-stream', 'x-homebrew-pin': '000000' }
        }, (response) => {
            let body = '';
            response.on('data', (chunk) => { body += chunk; });
            response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
        });
        request.on('error', reject);
        request.end(Buffer.from('not a real package'));
    });
}

function overSocket(port) {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}`);
        const timer = setTimeout(() => reject(new Error('timed out waiting for the socket refusal')), 4000);

        socket.on('message', (raw) => {
            const message = JSON.parse(raw);
            if (message.type === 'hello' && message.payload.ok) {
                socket.send(JSON.stringify({ type: 'install', payload: { source: 'url', ref: 'http://example.invalid/a.wgt' } }));
            }
            if (message.type === 'error') {
                clearTimeout(timer);
                socket.close();
                resolve(message.payload);
            }
        });
        socket.on('open', () => socket.send(JSON.stringify({ type: 'hello', payload: { pin: '000000' } })));
        socket.on('error', reject);
    });
}

server.listen(0, '127.0.0.1', async () => {
    const port = server.address().port;

    try {
        const answer = await upload(port);
        const body = JSON.parse(answer.body);

        check('a second install is answered 409', answer.status === 409, String(answer.status));
        check('with its own code', body.code === 'installBusy', body.code);
        check('and ok: false', body.ok === false, JSON.stringify(body));
        check('with a Retry-After header', answer.headers['retry-after'] === '20', String(answer.headers['retry-after']));
        check('that matches retryAfterSeconds', body.retryAfterSeconds === 20, String(body.retryAfterSeconds));
        check('naming what is running',
            body.installing && body.installing.name === 'Tizen Tap' && body.installing.phase === 'installing',
            JSON.stringify(body.installing));
        check('and since when',
            body.installing && body.installing.startedAt === new Date(startedAt).toISOString(),
            JSON.stringify(body.installing));
        check('the message says when to come back', /20s/.test(body.message), body.message);
        check('the running install is left alone',
            store.select('installing') && store.select('installing').name === 'Tizen Tap',
            JSON.stringify(store.select('installing')));

        const refused = await overSocket(port);
        check('the websocket install path refuses the same way',
            refused.code === 'installBusy' && refused.retryAfterSeconds === 20 &&
            refused.installing && refused.installing.name === 'Tizen Tap',
            JSON.stringify(refused));
    } catch (error) {
        check('the harness ran', false, error.message);
    }

    server.close();
    const failed = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed.`);
    process.exit(failed ? 1 : 0);
});

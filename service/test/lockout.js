'use strict';

const http = require('http');
const os = require('os');
const fs = require('fs');
const WebSocket = require('ws');

const PORT = Number(process.env.HOMEBREW_PORT) || 8422;
process.env.HOMEBREW_PORT = String(PORT);
process.env.HOMEBREW_CONFIG_DIR = fs.mkdtempSync(`${os.tmpdir()}/homebrew-lockout-`);

const results = [];
function check(name, ok, detail) {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
}

function get(path, headers) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: PORT, path, headers: headers || {} }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve(Object.assign(body, { status: res.statusCode, headers: res.headers })));
        }).on('error', reject);
    });
}

// Per address, on a clock the test controls: a real one would make this test take an hour.
{
    const pin = require('../src/auth/pin.ts');
    const SECRET = '424242';
    const WRONG = '111111';
    const A = '192.168.1.50';
    const B = '192.168.1.51';

    const authorise = pin.createAuthoriser(SECRET);
    let now = 1000000;

    for (let attempt = 0; attempt < pin.MAX_ATTEMPTS; attempt++) authorise(WRONG, A, now);

    const lockedA = authorise(SECRET, A, now);
    check('address A is locked out after five wrong PINs', lockedA.code === 'lockedOut', JSON.stringify(lockedA));
    check('and told how long, in seconds', lockedA.retryAfterSeconds === pin.LOCKOUT_MS / 1000,
        String(lockedA.retryAfterSeconds));
    check('address B with the right PIN still gets in', authorise(SECRET, B, now).ok === true, 'B was refused');
    check('B with a wrong PIN is told wrong, not locked',
        authorise(WRONG, B, now).code === 'unauthorized', 'B saw the lockout');
    check('an IPv4-mapped A is the same device as A',
        authorise(SECRET, `::ffff:${A}`, now).code === 'lockedOut', 'the mapped form escaped the lockout');

    now += pin.LOCKOUT_MS;
    check('A with the right PIN after the wait gets in', authorise(SECRET, A, now).ok === true, 'still refused');

    for (let attempt = 0; attempt < pin.MAX_ATTEMPTS; attempt++) authorise(WRONG, A, now);
    const afterClear = authorise(SECRET, A, now);
    check('and that success cleared the escalation',
        afterClear.retryAfterSeconds === pin.LOCKOUT_MS / 1000, String(afterClear.retryAfterSeconds));

    const C = '192.168.1.52';
    const waits = [];
    for (let lockout = 0; lockout < 4; lockout++) {
        for (let attempt = 0; attempt < pin.MAX_ATTEMPTS; attempt++) authorise(WRONG, C, now);
        const verdict = authorise(SECRET, C, now);
        waits.push(verdict.retryAfterSeconds);
        now += verdict.retryAfterSeconds * 1000;
    }
    check('each lockout an address earns doubles its wait', waits.join() === '60,120,240,480', waits.join());

    check('and no other address inherits it', authorise(SECRET, B, now).ok === true, 'B was refused');

    for (let lockout = 0; lockout < 12; lockout++) {
        for (let attempt = 0; attempt < pin.MAX_ATTEMPTS; attempt++) authorise(WRONG, C, now);
        now += authorise(SECRET, C, now).retryAfterSeconds * 1000;
    }
    for (let attempt = 0; attempt < pin.MAX_ATTEMPTS; attempt++) authorise(WRONG, C, now);
    check('the wait stops growing at an hour',
        authorise(SECRET, C, now).retryAfterSeconds === pin.LOCKOUT_CEILING_MS / 1000,
        String(authorise(SECRET, C, now).retryAfterSeconds));
}

// The table is bounded, and filling it unlocks nobody.
{
    const pin = require('../src/auth/pin.ts');
    const SECRET = '424242';
    const WRONG = '111111';
    const lockouts = pin.createLockouts({ maxAddresses: 4, forgetAfterMs: 60 * 60 * 1000 });
    const authorise = pin.createAuthoriser(SECRET, { lockouts });
    let now = 5000000;

    for (let index = 0; index < 4; index++) {
        for (let attempt = 0; attempt < pin.MAX_ATTEMPTS; attempt++) authorise(WRONG, `10.0.0.${index}`, now);
    }
    check('the table holds at most its cap', lockouts.size() === 4, String(lockouts.size()));
    check('a full table keeps every locked address locked',
        authorise(SECRET, '10.0.0.0', now).code === 'lockedOut', 'a full table freed an address');

    for (let index = 10; index < 10 + pin.MAX_ATTEMPTS; index++) authorise(WRONG, `10.0.0.${index}`, now);
    check('addresses past the cap share one stricter counter',
        lockouts.size() === 4 && lockouts.overflowed(), `size ${lockouts.size()}, overflowed ${lockouts.overflowed()}`);
    check('so five failures spread across new addresses lock the newest out',
        authorise(SECRET, '10.0.0.99', now).code === 'lockedOut', 'a new address got in past a full table');

    now += 2 * 60 * 60 * 1000;
    check('an hour with no failures forgets an address',
        authorise(SECRET, '10.0.0.99', now).ok === true && lockouts.size() === 0, `size ${lockouts.size()}`);
}

function open() {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${PORT}`);
        const inbox = [];
        socket.on('message', (raw) => inbox.push(JSON.parse(raw)));
        socket.on('open', () => resolve({ socket, inbox }));
        socket.on('error', reject);
    });
}

function next(conn, type, timeout) {
    const deadline = Date.now() + (timeout || 4000);
    return new Promise((resolve, reject) => {
        (function poll() {
            for (let i = 0; i < conn.inbox.length; i++) {
                if (conn.inbox[i].type === type) return resolve(conn.inbox.splice(i, 1)[0]);
            }
            if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${type}`));
            setTimeout(poll, 20);
        })();
    });
}

function send(conn, type, payload) {
    conn.socket.send(JSON.stringify({ type, payload: payload || {} }));
}

require('../src/main.ts');

setTimeout(() => {
    let pin;
    let conn;

    get('/pin')
        .then((body) => {
            pin = JSON.parse(String(body)).pin;
            return open();
        })
        .then((c) => {
            conn = c;
            return next(conn, 'hello');
        })
        .then(() => {
            const wrong = pin === '000000' ? '111111' : '000000';
            let chain = Promise.resolve();
            for (let i = 0; i < 5; i++) {
                chain = chain.then(() => {
                    send(conn, 'hello', { pin: wrong });
                    return next(conn, 'hello');
                });
            }
            return chain;
        })
        .then(() => {
            send(conn, 'hello', { pin });
            return next(conn, 'error');
        })
        .then((msg) => {
            check('further attempts are locked out after 5 failures',
                msg.payload.code === 'lockedOut', JSON.stringify(msg.payload));
            check('lockout message says how long to wait',
                /\d+s/.test(msg.payload.message || ''), msg.payload.message);

            send(conn, 'hello', { pin });
            return next(conn, 'error');
        })
        .then((msg) => {
            check('a correct PIN is rejected while locked out',
                msg.payload.code === 'lockedOut', JSON.stringify(msg.payload));
            check('the socket refusal carries retryAfterSeconds',
                msg.payload.retryAfterSeconds > 0, JSON.stringify(msg.payload));

            // Same address over HTTP: the websocket and the routes share one count per device.
            return get('/dev/status', { 'x-homebrew-pin': pin });
        })
        .then((res) => {
            const body = JSON.parse(String(res));
            check('an HTTP route from the same address is locked too', res.status === 429, String(res.status));
            check('with a Retry-After header', Number(res.headers['retry-after']) > 0, String(res.headers['retry-after']));
            check('matching retryAfterSeconds in the body',
                String(body.retryAfterSeconds) === res.headers['retry-after'], JSON.stringify(body));

            const failed = results.filter((r) => !r).length;
            console.log(`\n${results.length - failed}/${results.length} checks passed.`);
            process.exit(failed ? 1 : 0);
        })
        .catch((err) => {
            console.error('Harness error:', err.message);
            process.exit(1);
        });
}, 400);

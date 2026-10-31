'use strict';

// A stand-in root agent on a loopback socket, so the channel's handshake,
// frame authentication and request/reply round trips can be exercised without
// a television. The agent side is the minimal re-implementation of the C#
// SamsungTvRootAgent's protocol — if the two drift, this test fails.

const net = require('net');
const crypto = require('crypto');

const { RootChannel } = require('../src/root/channel.ts');
const { PROTOCOL_VERSION, NONCE_BYTES, MINIMUM_SECRET_BYTES, verify, encode } = require('../src/root/protocol.ts');

const results = [];
function check(name, ok, detail) {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
}

const SECRET = crypto.randomBytes(MINIMUM_SECRET_BYTES).toString('hex');
// fakeAgent resolves the moment AUTH is written, not the moment the server has
// processed it; poll the channel for the state that follows.
function eventually(poll, timeout = 2000) {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const tick = () => {
            if (poll()) return resolve();
            if (Date.now() - started > timeout) return reject(new Error('condition not met in time'));
            setTimeout(tick, 25);
        };
        tick();
    });
}

// The agent: connect, read hello, send AUTH, then answer frames.
function fakeAgent(port, { uid = 0, leavesOnShutdown = false } = {}) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1');
        socket.commands = [];
        let buffered = Buffer.alloc(0);
        let nonce = null;

        const send = (payload) => socket.write(encode(SECRET, nonce, payload));

        const answer = (parts) => {
            const verb = parts[0];
            const theirSeq = parts[1];

            if (verb === 'PING') return send(`PONG\t${theirSeq}\t${uid}\t${uid}\t0\t0`);
            if (verb === 'EXEC') {
                const command = Buffer.from(parts[3], 'base64').toString('utf8');
                socket.commands.push(command);
                if (command === 'echo ok') return send(`RESULT\t${theirSeq}\t0\t0\t${Buffer.from('ok\n').toString('base64')}\t`);
                if (command === 'exit 3') return send(`RESULT\t${theirSeq}\t3\t0\t\t${Buffer.from('boom\n').toString('base64')}`);
                return send(`RESULT\t${theirSeq}\t1\t0\t\t${Buffer.from('no such command\n').toString('base64')}`);
            }
            if (verb === 'SHUTDOWN') {
                send(`BYE\t${theirSeq}`);
                if (leavesOnShutdown) socket.end();
                return undefined;
            }
            send(`ERROR\t${theirSeq}\tunknown ${verb}`);
        };

        socket.on('data', (chunk) => {
            buffered = Buffer.concat([buffered, chunk]);
            let index;
            while ((index = buffered.indexOf(0x0a)) !== -1) {
                const line = buffered.slice(0, index).toString('utf8');
                buffered = buffered.slice(index + 1);

                if (!nonce) {
                    const parts = line.split('\t');
                    if (parts[0] !== PROTOCOL_VERSION) return reject(new Error('bad hello'));
                    nonce = Buffer.from(parts[1], 'hex');
                    send(`AUTH\t4242\t${uid}\t${uid}\t0\t0\t3fffffffff\t${Buffer.from('User').toString('base64')}`);
                    resolve(socket);
                    continue;
                }
                try { answer(verify(SECRET, nonce, line).split('\t')); }
                catch (error) { reject(error); }
            }
        });
        socket.on('error', reject);
    });
}

async function main() {
    const port = 8192;
    const channel = new RootChannel({ port, secret: SECRET });
    await channel.start();

    // Wrong secret: the channel must refuse the connection, not accept a stranger.
    {
        const foreign = new RootChannel({ port: port + 1, secret: crypto.randomBytes(NONCE_BYTES).toString('hex') });
        await foreign.start();
        const agent = net.connect(port + 1, '127.0.0.1');
        const gotHello = await new Promise((resolve) => {
            let held = '';
            agent.on('data', (chunk) => {
                held += chunk;
                if (held.includes('\n')) resolve(held.split('\t')[0]);
            });
            agent.on('error', () => resolve(null));
        });
        // A 64-hex HMAC that is the wrong value, so the length check passes and
        // the content check fails — the path that must reject, not crash.
        agent.write(`AUTH\t1\t0\t0\t0\t0\t3fffffffff\t${Buffer.from('User').toString('base64')}\t${'0'.repeat(64)}\n`);
        await new Promise((resolve) => setTimeout(resolve, 100));
        check('an agent without a shared secret is refused', gotHello === PROTOCOL_VERSION && !foreign.connected,
            `hello=${gotHello} connected=${foreign.connected}`);
        agent.destroy();
        foreign.close();
    }
    const agentSocket = await fakeAgent(port);
    await eventually(() => channel.status().root);

    check('the agent is recognised as root', channel.status().root === true, JSON.stringify(channel.status().identity));

    const pong = await channel.ping(3000);
    check('ping comes back as a pong', pong.verb === 'PONG' && pong.identity.uid === 0, JSON.stringify(pong));

    const echo = await channel.exec('echo ok', 3000);
    check('exec relays stdout', echo.verb === 'RESULT' && echo.exit === 0 && echo.stdout.trim() === 'ok', JSON.stringify(echo));

    const fail = await channel.exec('exit 3', 3000);
    check('exec relays exit code and stderr', fail.exit === 3 && fail.stderr.includes('boom'), JSON.stringify(fail));

    // A second agent dialing in takes the channel over: the first is dropped.
    {
        const firstIsAgent = agentSocket;
        const second = await fakeAgent(port, { uid: 0 });
        await new Promise((resolve) => setTimeout(resolve, 100));
        check('a second agent supersedes the first', firstIsAgent.destroyed === true, `first destroyed=${firstIsAgent.destroyed}`);
        second.destroy();
        await new Promise((resolve) => setTimeout(resolve, 50));
    }

    agentSocket.destroy();
    await eventually(() => !channel.status().connected);
    check('exec on a closed channel rejects instead of hanging',
        await channel.exec('echo ok', 300).then(
            () => false,
            (error) => /not connected/.test(error.message)
        ), '');

    // sdbd serves one session at a time and the agent holds one, so release() has to end it.
    {
        const agent = await fakeAgent(port, { leavesOnShutdown: true });
        await eventually(() => channel.status().root);
        check('an idle channel is not busy', channel.busy === false, String(channel.busy));

        await channel.release(1000);
        check('release lets an agent that honours SHUTDOWN leave', channel.status().connected === false, '');
        check('and has the agent kill its own process, which is what frees sdbd',
            agent.commands.some((command) => /sleep 1; kill -9 4242\)/.test(command)), JSON.stringify(agent.commands));
    }

    {
        const stubborn = await fakeAgent(port);
        await eventually(() => channel.status().root);

        const began = Date.now();
        await channel.release(300);
        await new Promise((resolve) => setTimeout(resolve, 50));
        check('release closes the socket of an agent that ignores SHUTDOWN',
            channel.status().connected === false && stubborn.destroyed && Date.now() - began < 1500,
            `connected=${channel.status().connected} destroyed=${stubborn.destroyed}`);
    }

    channel.close();
}

main().then(() => {
    const failed = results.filter((r) => !r).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed.`);
    process.exit(failed ? 1 : 0);
}).catch((err) => {
    console.error('Harness error:', err);
    process.exit(1);
});

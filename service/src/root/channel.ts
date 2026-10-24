// The root channel: a loopback TCP server the root agent dials at boot. Once
// the agent — which sdbd ran as uid 0 — connects and authenticates, the
// connection itself is the standing root: it stays open, and while it is open
// this object can ask the television to run a command as root, with the agent
// relaying exit code and output back over the same socket.
//
// The agent connects to us (it is the client). Sequence numbers strictly
// increase in both directions; a duplicate injection from sdbd opens a second
// socket that we drop, so the first agent always wins the channel.
//
// The agent dies when the television powers off, so "root" here is a
// re-armable session, not a daemon: arm() (see arm.ts) stages the payloads,
// fires the injection, and waits for this server to be dialed again.

'use strict';

const net = require('net');
const { randomBytes } = require('crypto');
const { PROTOCOL_VERSION, NONCE_BYTES, MINIMUM_SECRET_BYTES, ProtocolError, verify, encode, fields } = require('./protocol.ts');

const MAX_COMMAND_BYTES = 8 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;

interface RootIdentity {
    pid: number; uid: number; euid: number; gid: number; egid: number;
    capEff: string; smack: string;
}

class RootChannel {
    private host: string;
    private port: number;
    private secret: string;
    private log: (line: string) => void;
    private server: ReturnType<typeof net.createServer> | null;
    private socket: any;
    private nonce: Buffer | null;
    private nextSeq = 0;
    private identity: RootIdentity | null;
    private pending: Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: any }>;
    private connected = false;

    constructor({ host = '127.0.0.1', port, secret, log }: { host?: string; port: number; secret: string; log?: (line: string) => void } = {} as any) {
        if (!secret || secret.length < MINIMUM_SECRET_BYTES) {
            throw new ProtocolError('root secret must be at least 32 bytes');
        }
        this.host = host;
        this.port = port;
        this.secret = secret;
        this.log = log || (() => {});
        this.server = null;
        this.socket = null;
        this.nonce = null;
        this.identity = null;
        this.pending = new Map();
        this._onNewSocket = this._onNewSocket.bind(this);
    }

    get listening() { return !!(this.server && this.server.listening); }

    start() {
        if (this.server) return Promise.resolve(undefined);
        return new Promise<void>((resolve, reject) => {
            const server = net.createServer(this._onNewSocket);
            server.once('error', reject);
            server.listen(this.port, this.host, () => {
                this.server = server;
                this.log(`root channel listening on ${this.host}:${this.port}`);
                resolve();
            });
        });
    }

    close() {
        if (this.socket) { try { this.socket.end(); } catch (_) {} this.socket = null; }
        if (this.server) { this.server.close(); this.server = null; }
        this._resetSession();
    }

    // One agent at a time: if a second agent dials in (sdbd double-fires the
    // injection), the first connection is dropped and this one takes over.
    _onNewSocket(socket) {
        if (this.socket) {
            const previous = this.socket;
            this._resetSession();
            try { previous.destroy(); } catch (_) {}
            this.log('root channel: a second agent dialed in; the first connection was closed');
        }
        this._handleSocket(socket);
    }

    _resetSession() {
        for (const entry of this.pending.values()) {
            clearTimeout(entry.timer);
            entry.reject(new Error('root channel closed'));
        }
        this.pending.clear();
        this.connected = false;
        this.identity = null;
        this.nextSeq = 0;
        this.nonce = null;
    }

    _handleSocket(socket) {
        const nonce = randomBytes(NONCE_BYTES);
        this.nonce = nonce;
        this.socket = socket;
        socket.setNoDelay(true);
        socket.write(`${PROTOCOL_VERSION}\t${nonce.toString('hex')}\n`);

        let buffered = Buffer.alloc(0);
        let authed = false;

        const fail = (message) => {
            this.log(`root channel: ${message}`);
            try { socket.destroy(); } catch (_) {}
        };

        socket.on('data', (chunk) => {
            buffered = Buffer.concat([buffered, chunk]);
            if (buffered.length > MAX_RESPONSE_BYTES) return fail('root channel frame too large');

            let index;
            while ((index = buffered.indexOf(0x0a)) !== -1) {
                const line = buffered.slice(0, index).toString('utf8');
                buffered = buffered.slice(index + 1);
                try {
                    const payload = verify(this.secret, nonce, line);
                    const parts = fields(payload);

                    if (!authed) {
                        if (parts[0] !== 'AUTH' || parts.length < 8) throw new ProtocolError('expected AUTH');
                        this.identity = {
                            pid: Number(parts[1]), uid: Number(parts[2]), euid: Number(parts[3]),
                            gid: Number(parts[4]), egid: Number(parts[5]), capEff: parts[6],
                            smack: Buffer.from(parts[7] || '', 'base64').toString('utf8').trim()
                        };
                        this.connected = true;
                        authed = true;
                        this.log(`root channel: agent connected (uid ${this.identity.uid}, cap ${this.identity.capEff})`);
                        continue;
                    }
                    this._dispatch(parts);
                } catch (error) {
                    return fail(`bad root channel frame: ${error.message}`);
                }
            }
        });

        socket.on('error', () => fail('root channel socket error'));
        socket.on('close', () => {
            const was = this.socket === socket && this.connected;
            if (this.socket === socket) this.socket = null;
            this._resetSession();
            if (was) this.log('root channel: agent disconnected');
        });
    }

    _dispatch(parts) {
        const verb = parts[0];
        const seq = Number(parts[1]);
        if (!Number.isInteger(seq) || seq <= 0) return;

        const entry = this.pending.get(seq);
        if (!entry) return;
        this.pending.delete(seq);
        clearTimeout(entry.timer);

        if (verb === 'PONG') {
            entry.resolve({ verb: 'PONG', identity: { uid: Number(parts[2]), euid: Number(parts[3]), gid: Number(parts[4]), egid: Number(parts[5]) } });
        } else if (verb === 'RESULT') {
            entry.resolve({
                verb: 'RESULT', exit: Number(parts[2]), timedOut: parts[3] === '1',
                stdout: Buffer.from(parts[4] || '', 'base64').toString('utf8'),
                stderr: Buffer.from(parts[5] || '', 'base64').toString('utf8')
            });
        } else if (verb === 'BYE') {
            entry.resolve({ verb: 'BYE' });
        }
    }

    // Every command frame is the verb with a strictly increasing sequence as
    // its second field; the response carries the same sequence back.
    _roundTrip(payload, timeoutMs) {
        if (!this.connected || !this.socket || !this.socket.writable) {
            return Promise.reject(new Error('root channel is not connected'));
        }
        const seq = (this.nextSeq += 1);
        const parts = payload.split('\t');
        parts.splice(1, 0, String(seq));
        this.socket.write(encode(this.secret, this.nonce, parts.join('\t')));

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(seq);
                reject(new Error(`root command timed out after ${timeoutMs}ms`));
            }, timeoutMs + 2000);
            this.pending.set(seq, { resolve, reject, timer });
        });
    }

    ping(timeoutMs = 5000) {
        return this._roundTrip('PING', timeoutMs);
    }

    exec(command, timeoutMs = 30000) {
        if (typeof command !== 'string' || !command.length) throw new ProtocolError('exec needs a command');
        if (command.length > MAX_COMMAND_BYTES) throw new ProtocolError('command too long');
        return this._roundTrip(`EXEC\t${timeoutMs}\t${Buffer.from(command, 'utf8').toString('base64')}`, timeoutMs);
    }

    shutdown(timeoutMs = 5000) {
        return this._roundTrip('SHUTDOWN', timeoutMs);
    }

    status() {
        return {
            listening: this.listening,
            connected: this.connected,
            root: this.connected && this.identity ? this.identity.uid === 0 : false,
            identity: this.identity,
            host: this.host,
            port: this.port
        };
    }
}

module.exports = { RootChannel };

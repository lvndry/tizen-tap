// Wire format of the root agent channel, matching the C# SamsungTvRootAgent
// from chris-ritsen/samsung-tv-root (which runs on the television as uid 0)
// byte for byte. Both sides implement the same thing; if this file and the
// C# source ever disagree, the television is the one to blame.
//
// Every frame is one line: "{payload}\t{hmac}\n" where the hmac is the
// lowercase hex HMAC-SHA256 over key = the shared secret, message = the
// handshake nonce (32 bytes) + a single 0x00 byte + the payload in utf8.
// Sequence numbers must strictly increase, which is what keeps a stale
// duplicate (sdbd injects every payload twice) from corrupting the session.

'use strict';

const crypto = require('crypto');

const PROTOCOL_VERSION = 'SAMSUNG-TV-ROOT/1';
const NONCE_BYTES = 32;
const MINIMUM_SECRET_BYTES = 32;

class ProtocolError extends Error {}

function mac(secret, nonce, payload) {
    return crypto
        .createHmac('sha256', secret)
        .update(nonce)
        .update(Buffer.from([0]))
        .update(payload, 'utf8')
        .digest('hex');
}

// "PONG\t1\t0\t0\t0\t0" + authenticator → "PONG\t1\t0\t0\t0\t0".
function verify(secret, nonce, line) {
    const text = String(line).replace(/\r?\n$/, '');
    const cut = text.lastIndexOf('\t');
    if (cut <= 0) throw new ProtocolError('frame has no authenticator');

    const payload = text.slice(0, cut);
    const observed = text.slice(cut + 1);
    const expected = mac(secret, nonce, payload);
    if (observed.length !== expected.length ||
        !crypto.timingSafeEqual(Buffer.from(observed), Buffer.from(expected))) {
        throw new ProtocolError('frame authentication failed');
    }
    return payload;
}

function encode(secret, nonce, payload) {
    return `${payload}\t${mac(secret, nonce, payload)}\n`;
}

function fields(payload) {
    return payload.split('\t');
}

module.exports = { PROTOCOL_VERSION, NONCE_BYTES, MINIMUM_SECRET_BYTES, ProtocolError, verify, encode, fields };

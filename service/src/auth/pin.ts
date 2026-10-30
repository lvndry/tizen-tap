'use strict';

const { randomBytes, timingSafeEqual } = require('crypto');
const { ErrorCode } = require('../protocol.ts');
const { host } = require('../obs/units.ts');

const DIGITS = 6;
const MAX_ATTEMPTS = 5;

// Each lockout an address earns doubles the next, so a guesser settles at a few tries an hour.
const LOCKOUT_MS = 60 * 1000;
const LOCKOUT_CEILING_MS = 60 * 60 * 1000;

// An address with no failure, and no lockout running, for this long starts again from nothing.
const FORGET_AFTER_MS = 60 * 60 * 1000;

// A home television has a handful of clients. Every extra address is another five guesses per
// lockout, so the table stays small enough that brute force across many addresses is still slow.
const MAX_ADDRESSES = 32;

// Where every address goes once the table is full. Sharing one counter is stricter than any
// single address, so filling the table buys an attacker nothing and unlocks nobody.
const OVERFLOW = '(overflow)';

// Not a secret: a build pushed at a television every few minutes should not have to be read off its screen.
const DEVELOPER_PIN = '0'.repeat(DIGITS);

function generate() {
    const ceiling = 10 ** DIGITS;

    function draw() {
        // Rejection sampling: a modulus of a random 32-bit value would make the low PINs likelier.
        const limit = Math.floor(0xffffffff / ceiling) * ceiling;
        for (;;) {
            const value = randomBytes(4).readUInt32BE(0);
            if (value < limit) return value % ceiling;
        }
    }

    return String(draw()).padStart(DIGITS, '0');
}

function matches(attempt, pin) {
    const given = Buffer.from(String(attempt ?? ''));
    const expected = Buffer.from(pin);

    // timingSafeEqual needs equal lengths, so length is compared first.
    if (given.length !== expected.length) return false;

    return timingSafeEqual(given, expected);
}

function fresh() {
    return ({ failures: 0, lockedUntil: 0, lockouts: 0, lastFailure: 0 });
}

function lockoutLength(lockouts) {
    return Math.min(LOCKOUT_CEILING_MS, LOCKOUT_MS * 2 ** Math.max(0, lockouts - 1));
}

function remaining(lockout, now = Date.now()) {
    return Math.max(0, lockout.lockedUntil - now);
}

function isLocked(lockout, now = Date.now()) {
    return remaining(lockout, now) > 0;
}

function recordFailure(lockout, now = Date.now()) {
    const failures = (lockout.failures || 0) + 1;
    const lockouts = lockout.lockouts || 0;

    // Reaching the limit starts the timer and resets the count, so each lockout has to be earned again.
    return failures >= MAX_ATTEMPTS
        ? { failures: 0, lockedUntil: now + lockoutLength(lockouts + 1), lockouts: lockouts + 1, lastFailure: now }
        : { failures, lockedUntil: lockout.lockedUntil, lockouts, lastFailure: now };
}

// Failures counted per client address, so one client's stale PIN does not lock out the rest.
// Only addresses that have failed are kept, and only for as long as they matter.
function createLockouts({ maxAddresses = MAX_ADDRESSES, forgetAfterMs = FORGET_AFTER_MS } = {}) {
    const table = new Map();

    // Counted from the end of a lockout too, or an address at the ceiling would wait it out and start over.
    function forgotten(lockout, now) {
        return now - Math.max(lockout.lastFailure, lockout.lockedUntil) >= forgetAfterMs;
    }

    function prune(now) {
        table.forEach((lockout, address) => {
            if (forgotten(lockout, now)) table.delete(address);
        });
    }

    function occupied() {
        return table.size - (table.has(OVERFLOW) ? 1 : 0);
    }

    function full(now) {
        prune(now);
        return occupied() >= maxAddresses;
    }

    function peek(address, now = Date.now()) {
        const key = address || 'unknown';
        const own = table.get(key);

        if (own && !forgotten(own, now)) return own;
        if (own) table.delete(key);

        return full(now) ? (table.get(OVERFLOW) || fresh()) : fresh();
    }

    function failed(address, now = Date.now()) {
        const own = address || 'unknown';
        prune(now);
        const key = table.has(own) || occupied() < maxAddresses ? own : OVERFLOW;
        const lockout = recordFailure(table.get(key) || fresh(), now);
        table.set(key, lockout);
        return lockout;
    }

    function succeeded(address) {
        table.delete(address || 'unknown');
    }

    return { peek, failed, succeeded, size: occupied, overflowed: () => table.has(OVERFLOW) };
}

// Counted per client address: a stale PIN on one phone must not lock out the rest of the house.
function createAuthoriser(secret, { lockouts = createLockouts(), onLockout = (..._args: any[]) => {} } = {}) {
    return function authorise(presented, address, now = Date.now()) {
        // One client, however its address arrives: an IPv4-mapped address and the bare one are the same device.
        const client = host(address);
        const lockout = lockouts.peek(client, now);

        if (isLocked(lockout, now)) {
            const retryAfterSeconds = Math.ceil(remaining(lockout, now) / 1000);
            return {
                ok: false, code: ErrorCode.LOCKED_OUT, retryAfterSeconds,
                message: `Too many incorrect PINs from this device. Try again in ${retryAfterSeconds}s.`
            };
        }

        if (!matches(presented, secret)) {
            const after = lockouts.failed(client, now);
            if (isLocked(after, now)) onLockout(client, after);
            return { ok: false, code: ErrorCode.UNAUTHORIZED, message: 'Wrong or missing PIN.' };
        }

        lockouts.succeeded(client);
        return { ok: true };
    };
}

module.exports = {
    generate, matches, remaining, isLocked, createLockouts, createAuthoriser,
    DIGITS, DEVELOPER_PIN, MAX_ATTEMPTS, LOCKOUT_MS, LOCKOUT_CEILING_MS
};

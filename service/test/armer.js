'use strict';

// Every caller shares one arm in flight, and injections are capped per hour.

const { createArmer } = require('../src/root/arm.ts');

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
};

const IDENTITY = { uid: 0, capEff: '0000003fffffffff' };

function fakeChannel() {
    const channel = { root: false };
    return { channel, status: () => ({ root: channel.root, identity: channel.root ? IDENTITY : null }) };
}

function setup({ succeed = true, budget = 3 } = {}) {
    const { channel, status } = fakeChannel();
    const calls = { injections: 0, outcomes: [] };
    let clock = 0;
    let finish;

    const armer = createArmer({
        sdb: {}, channel: { status }, log: () => {}, budget, windowMs: 1000, now: () => clock,
        onOutcome: (error) => calls.outcomes.push(error),
        armOnce: () => {
            calls.injections += 1;
            return new Promise((resolve, reject) => {
                finish = () => {
                    if (succeed) { channel.root = true; resolve(IDENTITY); } else reject(new Error('the agent never dialed back in'));
                };
            });
        }
    });

    return { armer, calls, channel, finish: () => finish(), tick: (ms) => { clock += ms; } };
}

const run = async () => {
    {
        const { armer, calls, finish } = setup();
        const first = armer.arm('one agent');
        const second = armer.arm('another agent');
        check('a second caller during an arm joins it instead of injecting again', calls.injections === 1, String(calls.injections));
        check('and the status says an arm is in flight', armer.status().arming === true, JSON.stringify(armer.status()));
        finish();
        const [a, b] = await Promise.all([first, second]);
        check('both callers get the same identity', a === IDENTITY && b === IDENTITY, JSON.stringify([a, b]));
        check('the outcome is recorded once, as a success', calls.outcomes.length === 1 && calls.outcomes[0] === null,
            JSON.stringify(calls.outcomes));
        const third = await armer.arm('a late caller');
        check('once root is up, a call answers without injecting', third === IDENTITY && calls.injections === 1,
            String(calls.injections));
    }

    {
        const { armer, calls, finish, tick } = setup({ succeed: false, budget: 2 });
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const pending = armer.arm('a retry loop').catch((e) => e);
            finish();
            await pending;
        }
        const capped = await armer.arm('a retry loop').catch((e) => e);
        check('past the hourly budget, an arm is refused without injecting',
            capped.code === 'armBudget' && calls.injections === 2, `${capped.code} after ${calls.injections}`);
        check('and says when the next one is allowed', capped.retryAfterSeconds === 1, String(capped.retryAfterSeconds));
        check('the status reports the cap', armer.status().armsThisHour === 2 && armer.status().nextArmInSeconds === 1,
            JSON.stringify(armer.status()));
        check('failed arms are recorded as errors', calls.outcomes.every((error) => /never dialed back/.test(error)),
            JSON.stringify(calls.outcomes));

        tick(1000);
        const after = armer.arm('after the window').catch((e) => e);
        check('once the window passes, arming is allowed again', calls.injections === 3, String(calls.injections));
        finish();
        await after;
    }

    {
        let installing = true;
        const order = [];
        const { channel, status } = fakeChannel();
        const armer = createArmer({
            sdb: {}, channel: { status }, log: () => {}, installing: () => installing,
            wait: async () => { order.push('waited'); installing = false; },
            armOnce: async () => { order.push('injected'); channel.root = true; return IDENTITY; }
        });
        await armer.arm('another agent, mid-install');
        check('an arm during an install waits for it to finish before injecting',
            order.join(',') === 'waited,injected', order.join(','));
    }

    const failed = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed.`);
    process.exit(failed ? 1 : 0);
};

run().catch((error) => {
    console.error(error);
    process.exit(1);
});

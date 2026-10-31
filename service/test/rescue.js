'use strict';

// The rescue companion and the last-good copy it reinstalls from, with the
// probe, launch, sdb, clock and filesystem injected: nothing here touches a TV.

const JSZip = require('jszip');

const lastgood = require('../src/rescue/lastgood.ts');
const { createRescue, createReinstall, MAX_FAILED_REINSTALLS } = require('../../rescue/src/rescue.ts');
const { diagnose, MSG_RESCUE_MISSING, MSG_NO_LAST_GOOD } = require('../src/routes/status.ts');

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
};

const BUILD = '0.2.2+abc1234.20261030T1200';

const TIMINGS = { settleMs: 0, manualSettleMs: 0, retryMs: 0, afterLaunchMs: 0, lanPollMs: 0, lanPolls: 2 };

async function packageOf({ packageId = 'GJBBYNLkgP', build = BUILD } = {}) {
    const zip = new JSZip();

    zip.file('config.xml', '<?xml version="1.0"?><widget version="0.2.2">' +
        `<tizen:application id="${packageId}.TizenHomebrew" package="${packageId}" required_version="3.0"/>` +
        '<name>Tizen Tap</name></widget>');
    zip.file('service/dist/index.js', `const BUILD="${build}";module.exports.onStart=()=>{};`);

    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// An in-memory filesystem that records every write and rename in order.
function memoryFs(initial = {}) {
    const files = new Map(Object.entries(initial));
    const ops = [];
    const missing = (path) => Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' });

    return {
        files,
        ops,
        existsSync: (path) => files.has(path),
        readFileSync: (path, encoding) => {
            if (!files.has(path)) throw missing(path);
            const data = files.get(path);
            return encoding ? data.toString(encoding) : data;
        },
        writeFileSync: (path, data) => {
            ops.push(['write', path]);
            files.set(path, Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
        },
        renameSync: (from, to) => {
            if (!files.has(from)) throw missing(from);
            ops.push(['rename', from, to]);
            files.set(to, files.get(from));
            files.delete(from);
        },
        mkdirSync: () => {},
        unlinkSync: (path) => {
            if (!files.has(path)) throw missing(path);
            ops.push(['unlink', path]);
            files.delete(path);
        },
        statSync: (path) => {
            if (!files.has(path)) throw missing(path);
            return { size: files.get(path).length, mtimeMs: 1761825600000 };
        }
    };
}

// Persistent state shared across "boots", the way state.json is on the TV.
function memoryState() {
    let stored = null;
    return { read: () => stored, write: (value) => { stored = JSON.parse(JSON.stringify(value)); }, peek: () => stored };
}

// `answers` is the sequence of probe results; the last one repeats.
function rescueFor({ answers, installed = true, reinstallFails = false, key = 'copy-1', host = '192.168.1.119', state = memoryState(), bootId = 'boot-1', timings = TIMINGS }) {
    const calls = { probes: 0, launches: [], reinstalls: 0, lines: [] };
    let queue = answers.slice();
    let clock = 0;

    const rescue = createRescue({
        probe: async () => {
            calls.probes++;
            return queue.length > 1 ? queue.shift() : queue[0];
        },
        lanHost: () => host,
        appInstalled: () => installed,
        launch: async (appId) => { calls.launches.push(appId); },
        reinstall: async () => {
            calls.reinstalls++;
            if (reinstallFails) throw Object.assign(new Error('install failed[118, -12]'), { code: 'installFailed' });
        },
        lastGoodKey: () => key,
        state,
        wait: async (ms) => { clock += ms || 1; },
        now: () => clock,
        log: (line) => calls.lines.push(line),
        bootId,
        timings
    });

    return { rescue, calls, state, setAnswers: (next) => { queue = next.slice(); } };
}

async function rescueDecisions() {
    {
        const { rescue, calls, state } = rescueFor({ answers: [BUILD] });
        const outcome = await rescue.run();

        check('healthy: does nothing', outcome === 'healthy' && calls.launches.length === 0 && calls.reinstalls === 0,
            JSON.stringify({ outcome, calls }));
        check('healthy: one probe, no retry', calls.probes === 1, String(calls.probes));
        check('healthy: clears the failure counter', state.peek().failedReinstalls === 0, JSON.stringify(state.peek()));
    }

    {
        const { rescue, calls } = rescueFor({ answers: [null, null, BUILD] });
        const outcome = await rescue.run();

        check('installed but silent: one launch of the UI', outcome === 'relaunched' &&
            calls.launches.length === 1 && calls.launches[0] === 'GJBBYNLkgP.TizenHomebrew', JSON.stringify({ outcome, calls }));
        check('installed but silent: no reinstall when the launch brings it back', calls.reinstalls === 0, String(calls.reinstalls));
    }

    {
        const { rescue, calls } = rescueFor({ answers: [null, null, null, BUILD] });
        const outcome = await rescue.run();

        check('installed, still silent after the launch: one reinstall, then a launch',
            outcome === 'reinstalled' && calls.reinstalls === 1 && calls.launches.length === 2, JSON.stringify({ outcome, calls }));
    }

    {
        const { rescue, calls, state } = rescueFor({ answers: [null, null, BUILD], installed: false });
        const outcome = await rescue.run();

        check('missing: one reinstall, then one launch', outcome === 'reinstalled' &&
            calls.reinstalls === 1 && calls.launches.length === 1, JSON.stringify({ outcome, calls }));
        check('missing: a reinstall that worked clears the counter', state.peek().failedReinstalls === 0, JSON.stringify(state.peek()));
    }

    {
        const { rescue, calls } = rescueFor({ answers: [null], host: null });
        const outcome = await rescue.run();

        check('no LAN address: nothing is probed, launched or reinstalled', outcome === 'no-network' &&
            calls.probes === 0 && calls.launches.length === 0 && calls.reinstalls === 0, JSON.stringify({ outcome, calls }));
    }

    {
        const { rescue, calls } = rescueFor({ answers: [null], installed: false, key: null });
        const outcome = await rescue.run();

        check('missing with no last-good copy: says so, reinstalls nothing', outcome === 'no-last-good' &&
            calls.reinstalls === 0, JSON.stringify({ outcome, calls }));
    }

    {
        const state = memoryState();
        let reinstalls = 0;
        const outcomes = [];

        for (const bootId of ['boot-1', 'boot-1', 'boot-2', 'boot-3', 'boot-4']) {
            const { rescue, calls } = rescueFor({ answers: [null], installed: false, reinstallFails: true, state, bootId });
            outcomes.push(await rescue.run({ manual: true }));
            reinstalls += calls.reinstalls;
        }

        check('a failing reinstall: once per boot, then given up across boots',
            reinstalls === MAX_FAILED_REINSTALLS &&
            outcomes.join(',') === 'reinstall-failed,already-reinstalled,reinstall-failed,gave-up,gave-up',
            `${reinstalls} reinstalls, ${outcomes.join(',')}`);

        const { rescue, calls } = rescueFor({ answers: [null], installed: false, reinstallFails: true, state, bootId: 'boot-5', key: 'copy-2' });
        await rescue.run();

        check('a different last-good copy gets its own attempts', calls.reinstalls === 1, String(calls.reinstalls));

        const healthy = rescueFor({ answers: [BUILD], state, bootId: 'boot-6', key: 'copy-2' });
        await healthy.rescue.run();
        check('a healthy Tizen Tap clears the counter', state.peek().failedReinstalls === 0 && state.peek().failedCopy === null,
            JSON.stringify(state.peek()));
    }

    {
        const state = memoryState();
        let reinstalls = 0;

        for (const bootId of ['boot-1', 'boot-2', 'boot-3', 'boot-4']) {
            const { rescue, calls } = rescueFor({ answers: [null], installed: true, state, bootId });
            await rescue.run();
            reinstalls += calls.reinstalls;
        }

        check('a reinstall that installs but never answers also counts toward giving up',
            reinstalls === MAX_FAILED_REINSTALLS && state.peek().outcome === 'gave-up', `${reinstalls}, ${JSON.stringify(state.peek())}`);
    }

    {
        let release;
        const gate = new Promise((done) => { release = done; });
        const { rescue } = rescueFor({ answers: [BUILD] });
        const slow = createRescue({
            probe: async () => { await gate; return BUILD; },
            lanHost: () => '192.168.1.119', appInstalled: () => true, launch: async () => {}, reinstall: async () => {},
            lastGoodKey: () => 'copy-1', state: memoryState(), wait: async () => {}, log: () => {}, bootId: 'boot-1', timings: TIMINGS
        });

        const first = slow.run();
        const second = await slow.run({ manual: true });
        release();

        check('a second check while one runs is dropped', second === 'busy' && await first === 'healthy', second);
        check('an unrelated rescue is unaffected', await rescue.run() === 'healthy', 'not healthy');
    }

    {
        const { rescue, calls } = rescueFor({ answers: [null], installed: false });
        const failing = createRescue({
            probe: async () => null, lanHost: () => '192.168.1.119', appInstalled: () => false, launch: async () => {},
            reinstall: async () => {}, lastGoodKey: () => 'copy-1', state: memoryState(), wait: async () => {},
            log: () => { throw new Error('disk full'); }, bootId: 'boot-1', timings: TIMINGS
        });

        check('a log that throws does not stop the rescue', await failing.run() === 'reinstalled-still-silent', 'stopped');
        await rescue.run();
        check('reinstall happens exactly once for a missing app in one run', calls.reinstalls === 1, String(calls.reinstalls));
    }
}

function fakeSession(replies) {
    const commands = [];

    return {
        commands,
        exec: (command) => {
            commands.push(command);
            const reply = replies.shift();
            return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
        }
    };
}

function fakeSdb(session) {
    const seen = { released: 0 };

    return {
        seen,
        withSession: (_options, fn) => fn(session),
        release: () => { seen.released++; }
    };
}

async function reinstallCommands() {
    const archive = await packageOf();
    const staged = [];
    const stage = (data) => { staged.push(data.length); return lastgood.STAGED_PACKAGE; };

    {
        const session = fakeSession(['spend time 3.2']);
        const sdb = fakeSdb(session);
        await createReinstall({ readArchive: () => archive, stage, sdb, log: () => {} })();

        check('reinstall: in place over sdb, one command', session.commands.length === 1 &&
            session.commands[0] === `shell:0 vd_appinstall GJBBYNLkgP ${lastgood.STAGED_PACKAGE}`, JSON.stringify(session.commands));
        check('reinstall: stages the last-good copy first', staged[0] === archive.length, JSON.stringify(staged));
        check('reinstall: gives sdbd back afterwards', sdb.seen.released === 1, String(sdb.seen.released));
    }

    {
        const session = fakeSession(['app_id[GJBBYNLkgP] install failed[118, -12] Invalid', 'spend time 1.0', 'spend time 3.0']);
        const sdb = fakeSdb(session);
        await createReinstall({ readArchive: () => archive, stage, sdb, log: () => {} })();

        check('reinstall: an installer refusal gets one uninstall, then a fresh install',
            session.commands.join(' | ') === `shell:0 vd_appinstall GJBBYNLkgP ${lastgood.STAGED_PACKAGE} | ` +
            'shell:0 vd_appuninstall GJBBYNLkgP | ' +
            `shell:0 vd_appinstall GJBBYNLkgP ${lastgood.STAGED_PACKAGE}`, JSON.stringify(session.commands));
        check('reinstall: no backslash in any sdb command', session.commands.every((command) => command.indexOf('\\') === -1),
            JSON.stringify(session.commands));
    }

    {
        const dropped = Object.assign(new Error('reset'), { code: 'sdbReset', isSdbError: true });
        const session = fakeSession([dropped]);
        const sdb = fakeSdb(session);
        const error = await createReinstall({ readArchive: () => archive, stage, sdb, log: () => {} })().then(() => null, (e) => e);

        check('reinstall: sdbd dropping the connection is not answered with an uninstall',
            error && error.code === 'sdbReset' && session.commands.length === 1, JSON.stringify(session.commands));
        check('reinstall: sdbd is released after a failure too', sdb.seen.released === 1, String(sdb.seen.released));
    }

    {
        const other = await packageOf({ packageId: 'S6K2WQ8MnP' });
        const session = fakeSession([]);
        const error = await createReinstall({ readArchive: () => other, stage, sdb: fakeSdb(session), log: () => {} })()
            .then(() => null, (e) => e);

        check('reinstall: a last-good file that is not Tizen Tap is refused before sdb', error && error.code === 'badPackage' &&
            session.commands.length === 0, String(error));
    }

    const paths = [lastgood.STAGED_PACKAGE, lastgood.RESCUE_DIR, lastgood.CANDIDATE, lastgood.LAST_GOOD,
        lastgood.LAST_GOOD_META, lastgood.RESCUE_LOG, lastgood.RESCUE_STATE];

    check('no backslash in any rescue path', paths.every((path) => path.indexOf('\\') === -1 && path[0] === '/'), paths.join(' '));
}

async function keeperPromotion() {
    const archive = await packageOf();

    {
        const fs = memoryFs({ [lastgood.STAGED_PACKAGE]: archive });
        const scheduled = [];
        let healthy = false;
        const keeper = lastgood.createKeeper({
            fs, build: BUILD, probe: async () => healthy, log: () => {},
            schedule: (fn, ms) => { scheduled.push({ fn, ms }); return {}; }
        });

        keeper.start();

        check('keeper: the staged package of this build is kept as the candidate, through a temp name',
            JSON.stringify(fs.ops) === JSON.stringify([
                ['write', `${lastgood.CANDIDATE}.tmp`],
                ['rename', `${lastgood.CANDIDATE}.tmp`, lastgood.CANDIDATE]
            ]), JSON.stringify(fs.ops));
        check('keeper: nothing is promoted at start', !fs.existsSync(lastgood.LAST_GOOD), 'last-good exists');
        check('keeper: promotion waits two minutes of uptime', scheduled.length === 1 && scheduled[0].ms === 120000,
            JSON.stringify(scheduled.map((entry) => entry.ms)));

        const unhealthy = await keeper.promote();
        check('keeper: a build whose /version does not answer is not promoted', unhealthy === 'unhealthy' &&
            !fs.existsSync(lastgood.LAST_GOOD) && fs.existsSync(lastgood.CANDIDATE), unhealthy);

        healthy = true;
        fs.ops.length = 0;
        const promoted = await keeper.promote();

        check('keeper: a healthy build is promoted by rename, its metadata through a temp name',
            promoted === 'promoted' && JSON.stringify(fs.ops) === JSON.stringify([
                ['rename', lastgood.CANDIDATE, lastgood.LAST_GOOD],
                ['write', `${lastgood.LAST_GOOD_META}.tmp`],
                ['rename', `${lastgood.LAST_GOOD_META}.tmp`, lastgood.LAST_GOOD_META]
            ]), `${promoted} ${JSON.stringify(fs.ops)}`);

        const meta = JSON.parse(fs.readFileSync(lastgood.LAST_GOOD_META, 'utf8'));
        check('keeper: the metadata names the build and size', meta.build === BUILD && meta.size === archive.length &&
            meta.version === '0.2.2', JSON.stringify(meta));
        check('keeper: the last-good bytes are the staged package', fs.readFileSync(lastgood.LAST_GOOD).equals(archive), 'differ');

        fs.ops.length = 0;
        check('keeper: a build already kept is not copied again', keeper.capture() === 'kept' && fs.ops.length === 0,
            JSON.stringify(fs.ops));
    }

    {
        const fs = memoryFs({ [lastgood.STAGED_PACKAGE]: await packageOf({ build: '0.2.1+old0000.20261001T0000' }) });
        const keeper = lastgood.createKeeper({ fs, build: BUILD, probe: async () => true, log: () => {}, schedule: () => ({}) });

        check('keeper: a staged package of another build is not kept', keeper.capture() === 'not-this-build' &&
            fs.ops.length === 0, JSON.stringify(fs.ops));
    }

    {
        const fs = memoryFs({ [lastgood.STAGED_PACKAGE]: await packageOf({ packageId: 'S6K2WQ8MnP' }) });
        const keeper = lastgood.createKeeper({ fs, build: BUILD, probe: async () => true, log: () => {}, schedule: () => ({}) });

        check('keeper: a staged package of another app is not kept', keeper.capture() === 'not-this-build', 'kept');
    }

    {
        const fs = memoryFs({ [lastgood.CANDIDATE]: await packageOf({ build: '0.2.1+old0000.20261001T0000' }) });
        const keeper = lastgood.createKeeper({ fs, build: BUILD, probe: async () => true, log: () => {}, schedule: () => ({}) });

        check('keeper: a candidate from a build that never started is not promoted by this one',
            await keeper.promote() === 'not-this-build' && !fs.existsSync(lastgood.LAST_GOOD), 'promoted');
    }

    {
        const fs = memoryFs();
        const keeper = lastgood.createKeeper({ fs, build: BUILD, probe: async () => true, log: () => {}, schedule: () => ({}) });

        check('keeper: nothing staged, nothing kept', keeper.capture() === 'none-staged' && await keeper.promote() === 'no-candidate',
            'kept something');
    }

    {
        const fs = memoryFs();
        const kept = lastgood.keepCandidate(fs, archive, () => {});
        const other = lastgood.keepCandidate(fs, await packageOf({ packageId: 'S6K2WQ8MnP' }), () => {});

        check('keepCandidate: an incoming Tizen Tap package becomes the candidate through a temp name, another app does not',
            kept && !other && JSON.stringify(fs.ops) === JSON.stringify([
                ['write', `${lastgood.CANDIDATE}.tmp`],
                ['rename', `${lastgood.CANDIDATE}.tmp`, lastgood.CANDIDATE]
            ]), JSON.stringify(fs.ops));

        fs.writeFileSync(lastgood.STAGED_PACKAGE, archive);
        fs.ops.length = 0;
        const keeper = lastgood.createKeeper({ fs, build: BUILD, probe: async () => true, log: () => {}, schedule: () => ({}) });

        check('keeper: a candidate the self-update already kept is not copied again at start',
            keeper.capture() === 'captured' && fs.ops.length === 0, JSON.stringify(fs.ops));
    }

    {
        const broken = memoryFs({ [lastgood.STAGED_PACKAGE]: archive });
        broken.writeFileSync = () => { throw new Error('EROFS'); };
        const lines = [];
        const keeper = lastgood.createKeeper({ fs: broken, build: BUILD, probe: async () => true, log: (line) => lines.push(line), schedule: () => ({}) });

        let threw = false;
        try { keeper.start(); } catch (e) { threw = true; }

        check('keeper: a failed copy is logged, never thrown into the service start', !threw && /could not keep/.test(lines.join('\n')),
            lines.join(' | '));
    }
}

async function statusReport() {
    const healthy = {
        sdbd: { port: 'open', handshake: 'ok' },
        root: { root: true },
        services: { stremio: { up: true } },
        memory: null,
        previousRun: null
    };

    const archive = await packageOf();
    const fs = memoryFs({
        [lastgood.LAST_GOOD]: archive,
        [lastgood.LAST_GOOD_META]: Buffer.from(JSON.stringify({ build: BUILD, version: '0.2.2', promotedAt: '2026-10-30T12:00:00.000Z' })),
        [lastgood.RESCUE_LOG]: Buffer.from(Array.from({ length: 14 }, (_, index) => `line ${index}`).join('\n') + '\n')
    });

    const described = lastgood.describeRescue({ fs, installed: true });

    check('status: the last-good copy is reported with its build, size and date', described.lastGood &&
        described.lastGood.build === BUILD && described.lastGood.size === archive.length &&
        described.lastGood.promotedAt === '2026-10-30T12:00:00.000Z', JSON.stringify(described.lastGood));
    check('status: the rescue log tail is the last 10 lines', described.log.length === 10 && described.log[9] === 'line 13',
        JSON.stringify(described.log));

    check('status: an installed rescue with a last-good copy stays healthy',
        diagnose({ ...healthy, rescue: described }) === 'Everything looks healthy.', diagnose({ ...healthy, rescue: described }));

    const missing = diagnose({ ...healthy, rescue: lastgood.describeRescue({ fs: memoryFs(), installed: false }) });

    check('status: a missing rescue and no last-good copy are Also lines, never the lead',
        missing.indexOf('Everything looks healthy. Also: ') === 0 &&
        missing.indexOf(MSG_RESCUE_MISSING.replace(/\.$/, '')) !== -1 &&
        missing.indexOf(MSG_NO_LAST_GOOD.replace(/\.$/, '')) !== -1, missing);

    check('status: off a television nothing is said about the rescue',
        diagnose({ ...healthy, rescue: lastgood.describeRescue({ fs: memoryFs(), installed: null }) }) === 'Everything looks healthy.',
        'said something');
}

const FOLLOW = { reason: 'self-update', until: new Date(5 * 60 * 1000).toISOString() };
const FOLLOW_TIMINGS = { ...TIMINGS, followPollMs: 2000, followQuietMs: 6000, followAfterLaunchMs: 15000 };

async function followingRestarts() {
    {
        // Killed mid-install: answers, goes quiet, stays quiet until launched.
        const { rescue, calls } = rescueFor({ answers: [BUILD, BUILD, null, null, null, null, null, 'new-build'], timings: FOLLOW_TIMINGS });
        const outcome = await rescue.run({ follow: FOLLOW });
        check('follow: a self-update killed mid-install is launched, again every 15 s, until it answers',
            outcome === 'relaunched' && calls.launches.length >= 1 && calls.reinstalls === 0, JSON.stringify({ outcome, calls }));
    }

    {
        const { rescue, calls } = rescueFor({ answers: [BUILD, null, 'new-build'], timings: FOLLOW_TIMINGS });
        const outcome = await rescue.run({ follow: FOLLOW });
        check('follow: a build that comes back by itself is left alone',
            outcome === 'restarted' && calls.launches.length === 0, JSON.stringify({ outcome, calls }));
    }

    {
        const { rescue, calls } = rescueFor({ answers: [BUILD], timings: FOLLOW_TIMINGS });
        const outcome = await rescue.run({ follow: FOLLOW });
        check('follow: an update that never happened ends at the deadline without launching anything',
            outcome === 'no-restart' && calls.launches.length === 0, JSON.stringify({ outcome, launches: calls.launches }));
    }

    {
        // Uninstalled and never back: the usual check reinstalls the last-good copy.
        const { rescue, calls } = rescueFor({ answers: [BUILD, null], installed: false, timings: FOLLOW_TIMINGS });
        const outcome = await rescue.run({ follow: FOLLOW });
        check('follow: a package that never comes back falls through to the reinstall',
            outcome === 'reinstalled-still-silent' && calls.reinstalls === 1, JSON.stringify({ outcome, reinstalls: calls.reinstalls }));
    }

    {
        const fs = memoryFs();
        lastgood.expectRestart(fs, 'self-update', 0);
        const taken = lastgood.takeExpectedRestart(fs, 1000);
        check('note: a fresh note is taken once', taken && taken.reason === 'self-update' &&
            lastgood.takeExpectedRestart(fs, 1000) === null, JSON.stringify(taken));

        lastgood.expectRestart(fs, 'self-update', 0);
        check('note: an expired note is ignored', lastgood.takeExpectedRestart(fs, 10 * 60 * 1000) === null, 'taken');

        lastgood.expectRestart(fs, 'self-update', 0);
        lastgood.cancelExpectedRestart(fs);
        check('note: a cancelled note is gone', !fs.existsSync(lastgood.EXPECT_RESTART), 'still there');
    }
}

async function main() {
    await rescueDecisions();
    await followingRestarts();
    await reinstallCommands();
    await keeperPromotion();
    await statusReport();

    const failed = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed.`);
    process.exit(failed ? 1 : 0);
}

main().catch((error) => {
    console.error('\nHarness error:', error.stack || error.message);
    process.exit(1);
});

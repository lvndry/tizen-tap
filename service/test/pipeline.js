'use strict';

const { createInstaller } = require('../src/install/pipeline.ts');
const { createStore } = require('../src/state.ts');
const fixture = require('./fixture.js');
const { readFileSync } = require('fs');
const { join } = require('path');

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
};

const realPackage = fixture.wgt();

const otherUploadFor = (packageId) => fixture.zipAll([
    { name: 'config.xml', contents: Buffer.from(readFileSync(join(__dirname, '..', '..', 'config.xml')).toString('utf8').replace(/GJBBYNLkgP/g, packageId)), deflate: true },
    { name: 'icon.png', contents: fixture.PIXEL }
]);

{
    const entry = require('../src/main.ts');
    check('the service exports onStart, which Tizen calls',
        typeof entry.onStart === 'function', `exports: ${Object.keys(entry).join(', ')}`);

    check('and onRequest, which it calls on every launch after the first',
        typeof entry.onRequest === 'function', `exports: ${Object.keys(entry).join(', ')}`);
}

const fakeConfig = (initial = {}) => {
    let stored = { lastInstalled: [], ...initial };
    return {
        read: () => stored,
        update: (patch) => { stored = { ...stored, ...patch }; return stored; },
        hasCertificates: () => !!stored.author,
        forgetCertificates: () => { stored = { ...stored, author: null }; return stored; }
    };
};

const fakeSdb = (output = 'coreinstall spend time = 1234 ms') => ({
    withSession: (_options, run) => run({
        exec: () => Promise.resolve(output),
        close: () => {}
    })
});

const fakeResigner = () => Promise.resolve(async (archive) => ({
    archive, device: 'TESTSET', files: 1
}));

const fakeDevice = (state = {}) => ({
    probe: () => Promise.resolve({
        onTv: true, ready: true, needsResign: false, reason: null, ...state
    })
});

const installer = require('../src/install/installer.ts');
const realStage = installer.stage;
installer.stage = () => '/home/owner/share/tmp/sdk_tools/package.wgt';

const run = async () => {
    {
        const phases = [];
        const announced = [];
        const store = createStore({ installing: false, catalog: [] });

        const { install } = createInstaller({
            sdb: fakeSdb(), device: fakeDevice(), config: fakeConfig({ author: 'present' }),
            resigner: fakeResigner, store
        });

        const outcome = await install(
            { source: 'upload', reference: 'homebrew.wgt', upload: fixture.wgtWithIcon() },
            (phase, _detail, extra) => {
                phases.push(phase);
                if (extra && extra.identity) announced.push([phase, extra.identity]);
            }
        );

        check('an upload installs end to end',
            outcome.packageId === 'GJBBYNLkgP', JSON.stringify(outcome));
        check('the steps run in order',
            phases.join(' → ') === 'probing → fetching → resigning → staging → installing', phases.join(' → '));
        check('the store is released afterwards', store.select('installing') === false, 'still marked installing');

        check('the package announces what it is, once, as it is signed',
            announced.length === 1 &&
            announced[0][0] === 'resigning' &&
            announced[0][1].packageId === 'GJBBYNLkgP' &&
            announced[0][1].name === 'Tizen Tap',
            JSON.stringify(announced));

        check('with the icon out of the archive on it',
            String(announced[0][1].icon || '').startsWith('data:image/png;base64,'),
            String(announced[0][1].icon).slice(0, 40));
    }

    {
        const kept = [];
        const store = createStore({ installing: false, catalog: [] });
        const upload = fixture.wgtWithIcon();
        const otherConfig = Buffer.from(readFileSync(join(__dirname, '..', '..', 'config.xml')).toString('utf8').replace(/GJBBYNLkgP/g, 'ACME000001'));

        const { install } = createInstaller({
            sdb: fakeSdb(), device: fakeDevice(), config: fakeConfig({ author: 'present' }),
            resigner: fakeResigner, store, keepCandidate: (archive) => kept.push(archive)
        });

        await install({ source: 'upload', reference: 'homebrew.wgt', upload });
        await install({ source: 'upload', reference: 'other.wgt', upload: fixture.zip('config.xml', otherConfig) });

        check('a self-install hands its signed package to the rescue keeper, another app does not',
            kept.length === 1 && kept[0].equals(upload), `${kept.length} kept`);
    }


    {
        // A copy of another package that survived an earlier failed install has to
        // go before the new one lands: two copies start the service twice.
        const commands = [];
        const store = createStore({ installing: false, catalog: [] });

        const { install } = createInstaller({
            sdb: { withSession: (_options, run) => run({
                exec: (c) => {
                    commands.push(c);
                    return Promise.resolve(c.includes('vd_appinstall') ? 'coreinstall spend time = 1234 ms' : 'ok');
                },
                close: () => {}
            }) },
            device: fakeDevice(), config: fakeConfig({ author: 'present' }),
            resigner: fakeResigner, store
        });

        // Identity comes from the manifest inside the archive, so the other
        // package is a real variant of the repo's config with a different id.
        const outcome = await install({ source: 'upload', reference: 'other.wgt', upload: otherUploadFor('ACME000001') });

        const uninstallIndex = commands.findIndex((c) => c.includes('vd_appuninstall ACME000001'));
        const installIndex = commands.findIndex((c) => c.includes('vd_appinstall ACME000001'));

        check('another package\'s old copy is uninstalled before the new one is installed',
            outcome.packageId === 'ACME000001' &&
            uninstallIndex !== -1 && installIndex !== -1 && uninstallIndex < installIndex,
            JSON.stringify(commands));
    }

    {
        // A self-update installs in place: uninstalling the running package first
        // would kill the process doing the installing, so no vd_appuninstall at all.
        const commands = [];
        const store = createStore({ installing: false, catalog: [] });

        const { install } = createInstaller({
            sdb: { withSession: (_options, run) => run({
                exec: (c) => {
                    commands.push(c);
                    return Promise.resolve('coreinstall spend time = 1234 ms');
                },
                close: () => {}
            }) },
            device: fakeDevice(), config: fakeConfig({ author: 'present' }),
            resigner: fakeResigner, store
        });

        await install({ source: 'upload', reference: 'homebrew.wgt', upload: fixture.wgtWithIcon() });

        check('a self-update does not uninstall its own package',
            !commands.some((c) => c.includes('vd_appuninstall')) &&
            commands.some((c) => c.includes('vd_appinstall GJBBYNLkgP')),
            JSON.stringify(commands));
    }

    {
        const store = createStore({ installing: { name: 'Stuck', startedAt: Date.now() }, catalog: [] });
        const { install } = createInstaller({
            sdb: fakeSdb(), device: fakeDevice(), config: fakeConfig(),
            resigner: () => {}, store, queueWaitMs: 300
        });

        const refused = await install({ source: 'upload', upload: realPackage }).catch((e) => e);
        check('a second install that waits longer than the line allows is refused as busy',
            refused.code === 'installBusy', String(refused.code));
        check('and told when to come back', refused.retryAfterSeconds >= 10 && refused.retryAfterSeconds <= 30,
            String(refused.retryAfterSeconds));
        check('the first install still holds the guard', store.select('installing').name === 'Stuck',
            JSON.stringify(store.select('installing')));
    }

    {
        const store = createStore({ installing: { name: 'Tizen Tap', self: true, startedAt: Date.now() }, catalog: [] });
        const { install } = createInstaller({
            sdb: fakeSdb(), device: fakeDevice(), config: fakeConfig(),
            resigner: () => {}, store
        });

        const began = Date.now();
        const refused = await install({ source: 'upload', upload: realPackage }).catch((e) => e);
        check('an install behind a self-update is refused at once, since the restart would drop it',
            refused.code === 'installBusy' && Date.now() - began < 1000, `${refused.code} after ${Date.now() - began}ms`);
    }

    {
        // Two agents installing at once: the second waits its turn, and both land, in order.
        const order = [];
        const slowSdb = {
            withSession: (_options, run) => run({
                exec: (command) => new Promise((resolve) => setTimeout(() => {
                    if (command.includes('vd_appinstall')) order.push(command.split(' ')[2]);
                    resolve('coreinstall spend time = 1234 ms');
                }, 200)),
                close: () => {}
            })
        };
        const store = createStore({ installing: false, catalog: [] });
        const { install } = createInstaller({
            sdb: slowSdb, device: fakeDevice(), config: fakeConfig({ author: 'present' }),
            resigner: fakeResigner, store
        });

        const [first, second] = await Promise.all([
            install({ source: 'upload', reference: 'first', upload: otherUploadFor('ACME000001') }).catch((e) => e),
            install({ source: 'upload', reference: 'second', upload: otherUploadFor('ACME000002') }).catch((e) => e)
        ]);
        check('two concurrent installs both succeed', first.packageId === 'ACME000001' && second.packageId === 'ACME000002',
            JSON.stringify({ first: first.code || first.packageId, second: second.code || second.packageId }));
        check('one after the other, first come first served', order.join(',') === 'ACME000001,ACME000002', order.join(','));
        check('and the guard is free afterwards', store.select('installing') === false, JSON.stringify(store.select('installing')));
    }

    {
        const seen = [];
        const store = createStore({ installing: false, catalog: [] });
        const { install } = createInstaller({
            sdb: fakeSdb(), device: fakeDevice(), config: fakeConfig({ author: 'present' }),
            resigner: fakeResigner, store
        });

        await install({ source: 'upload', reference: 'homebrew.wgt', upload: fixture.wgtWithIcon() },
            () => seen.push(store.select('installing')));

        const last = seen[seen.length - 1];
        check('a running install describes itself in the store',
            last && last.phase === 'installing' && typeof last.startedAt === 'number' && last.name,
            JSON.stringify(last));
        check('and the description is gone afterwards', store.select('installing') === false,
            JSON.stringify(store.select('installing')));
    }

    {
        const phases = [];
        const store = createStore({ installing: false, catalog: [] });
        const { install } = createInstaller({
            sdb: fakeSdb(), device: fakeDevice({ ready: false, reason: 'debugModeOff' }),
            config: fakeConfig(), resigner: () => {}, store
        });

        const refused = await install({ source: 'upload', upload: realPackage }, (p) => phases.push(p)).catch((e) => e);
        check('an unready TV refuses before fetching',
            refused.code === 'debugModeOff' && phases.join() === 'probing', `${refused.code} / ${phases}`);
        check('the store is released after a refusal', store.select('installing') === false, 'still marked installing');
    }

    {
        const announced = [];
        const store = createStore({ installing: false, catalog: [] });
        const { install } = createInstaller({
            sdb: fakeSdb(), device: fakeDevice({ needsResign: true }), config: fakeConfig(),
            resigner: () => Promise.reject(new Error('unreachable')), store
        });

        const refused = await install(
            { source: 'upload', upload: realPackage },
            (phase, _detail, extra) => { if (extra && extra.identity) announced.push([phase, extra.identity]); }
        ).catch((e) => e);

        check('a Tizen 7 set without certificates is refused', refused.code === 'certsMissing', String(refused.code));

        check('and the package still said what it was first',
            announced.length === 1 && announced[0][0] === 'resigning' &&
            announced[0][1].name === 'Tizen Tap',
            JSON.stringify(announced));
    }

    {
        const store = createStore({ installing: false, catalog: [] });
        const config = fakeConfig({ author: 'present' });
        const { install } = createInstaller({
            sdb: fakeSdb('Check certificate error : :Check config.xml'),
            device: fakeDevice(), config, resigner: fakeResigner, store
        });

        const refused = await install({ source: 'upload', upload: realPackage }).catch((e) => e);
        check('a rejected certificate is dropped, not kept',
            refused.code === 'certRejected' && config.hasCertificates() === false,
            `${refused.code} / certs still held: ${config.hasCertificates()}`);
    }

    {
        const phases = [];
        const store = createStore({ installing: false, catalog: [] });
        const signed = [];

        const { install } = createInstaller({
            sdb: fakeSdb(),
            device: fakeDevice({ needsResign: false, duid: 'TESTSET' }),
            config: fakeConfig({ author: 'present' }),
            resigner: () => Promise.resolve(async (archive) => {
                signed.push(archive.length);
                return { archive, device: 'TESTSET', files: 3 };
            }),
            store
        });

        await install({ source: 'upload', upload: realPackage }, (phase) => phases.push(phase));

        check('a package is re-signed even where the TV would not insist',
            signed.length === 1 && phases.indexOf('resigning') !== -1, phases.join(' → '));
    }

    {
        const phases = [];
        const store = createStore({ installing: false, catalog: [] });

        const { install } = createInstaller({
            sdb: fakeSdb(), device: fakeDevice({ needsResign: false }), config: fakeConfig(),
            resigner: () => Promise.reject(new Error('should not be needed')), store
        });

        const refused = await install({ source: 'upload', upload: realPackage },
            (phase) => phases.push(phase)).catch((e) => e);

        check('no certificates is refused on any firmware, not just Tizen 7',
            refused.code === 'certsMissing', String(refused.code));

        check('and nothing unsigned by us reaches the installer',
            phases.indexOf('installing') === -1, phases.join(' → '));
    }

    // sdbd serves one session at a time and the root agent holds one, so with the channel
    // connected sdb turns every other client away mid-handshake.
    const heldSdb = (succeedAfter = Infinity) => {
        const calls = { count: 0, commands: [] };
        return {
            calls,
            withSession: (_options, run) => {
                calls.count += 1;
                if (calls.count <= succeedAfter) {
                    return Promise.reject(Object.assign(new Error('127.0.0.1:26101 closed the connection before the ADB handshake completed.'), { code: 'sdbClosed' }));
                }
                return run({
                    exec: (command) => {
                        calls.commands.push(command);
                        return Promise.resolve('coreinstall spend time = 1234 ms');
                    },
                    close: () => {}
                });
            }
        };
    };

    const fakeChannel = ({ root = true, busy = false } = {}) => {
        const seen = { commands: [], released: 0 };
        return {
            seen,
            busy,
            status: () => ({ root }),
            exec: (command) => { seen.commands.push(command); return Promise.resolve({ exit: 0, timedOut: false, stdout: '', stderr: '' }); },
            release: () => { seen.released += 1; return Promise.resolve(); }
        };
    };

    const counter = () => {
        const count = { value: 0 };
        return { count, rearm: () => { count.value += 1; return Promise.resolve(); } };
    };

    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    const otherUpload = () => otherUploadFor('ACME000001');

    {
        const store = createStore({ installing: false, catalog: [] });
        const { install } = createInstaller({
            sdb: fakeSdb(), device: fakeDevice(), config: fakeConfig({ author: 'present' }),
            resigner: fakeResigner, store, rootChannel: fakeChannel()
        });

        const outcome = await install({ source: 'upload', upload: otherUpload() });
        check('an install sdb carries reports the sdb route', outcome.route === 'sdb', JSON.stringify(outcome));
    }

    const releasedInstall = async ({ sdbError = null, sdb = heldSdb(0), upload = otherUpload(), channel = fakeChannel(), rootIdleWaitMs = 0 }) => {
        const store = createStore({ installing: false, catalog: [] });
        const rearms = counter();
        const { install } = createInstaller({
            sdb, config: fakeConfig({ author: 'present' }), resigner: fakeResigner, store,
            device: sdbError ? fakeDevice({ ready: false, reason: 'sdbUnreachable', sdbError }) : fakeDevice(),
            rootChannel: channel, rearmRoot: rearms.rearm, rootIdleWaitMs
        });
        const outcome = await install({ source: 'upload', upload }).catch((e) => e);
        await settle();
        return { outcome, channel, sdb, rearms: rearms.count.value };
    };

    for (const sdbError of ['sdbClosed', 'sdbTimeout']) {
        const { outcome, channel, sdb, rearms } = await releasedInstall({ sdbError });
        check(`with the probe held by the root agent (${sdbError}), the agent is released and sdb carries the install`,
            outcome.route === 'sdb' && outcome.packageId === 'ACME000001' && channel.seen.released === 1 &&
            sdb.calls.commands.some((c) => c.includes('vd_appinstall ACME000001')),
            JSON.stringify({ outcome, channel: channel.seen, sdb: sdb.calls }));
        check(`and nothing goes through root, which would not register the app (${sdbError})`,
            channel.seen.commands.length === 0, JSON.stringify(channel.seen.commands));
        check(`and root is re-armed once afterwards (${sdbError})`, rearms === 1, String(rearms));
    }

    {
        const { outcome, channel, rearms } = await releasedInstall({ sdb: heldSdb(1) });
        check('sdb refusing at install time also releases the agent and installs over sdb',
            outcome.route === 'sdb' && channel.seen.released === 1 && channel.seen.commands.length === 0 && rearms === 1,
            JSON.stringify({ outcome, channel: channel.seen, rearms }));
    }

    {
        const store = createStore({ installing: false, catalog: [] });
        const { install } = createInstaller({
            sdb: heldSdb(), device: fakeDevice(), config: fakeConfig({ author: 'present' }),
            resigner: fakeResigner, store, rootChannel: fakeChannel({ root: false })
        });

        const refused = await install({ source: 'upload', upload: otherUpload() }).catch((e) => e);
        check('without a root channel a handshake rejection is the error, and nothing is released',
            refused.code === 'sdbClosed', String(refused.code));
    }

    {
        const { outcome, channel } = await releasedInstall({ sdb: heldSdb() });
        check('if sdb still refuses after the release, nothing is installed and the error says so',
            outcome.code === 'sdbUnreachable' && /after the root agent was released/.test(outcome.message) &&
            channel.seen.released === 1, `${outcome.code}: ${outcome.message}`);
    }

    {
        const { outcome, channel, sdb, rearms } = await releasedInstall({ sdb: heldSdb(1), upload: fixture.wgtWithIcon() });
        check('a self-update is released and carried in place by sdb, never uninstalled first',
            outcome.route === 'sdb' && channel.seen.released === 1 && channel.seen.commands.length === 0 &&
            sdb.calls.commands.length === 1 && sdb.calls.commands[0].includes('vd_appinstall GJBBYNLkgP') &&
            !sdb.calls.commands.some((c) => c.includes('vd_appuninstall')),
            JSON.stringify({ outcome, channel: channel.seen, sdb: sdb.calls }));
        check('and is not re-armed here: the new build re-arms on its own start', rearms === 0, String(rearms));
    }

    {
        const told = [];
        const selfRestart = { expect: () => told.push('expect'), cancel: () => told.push('cancel') };
        const store = createStore({ installing: false, catalog: [] });
        const { install } = createInstaller({
            sdb: fakeSdb(), device: fakeDevice(), config: fakeConfig({ author: 'present' }),
            resigner: fakeResigner, store, selfRestart
        });

        await install({ source: 'upload', upload: fixture.wgtWithIcon() });
        check('a self-update tells the rescue before installing, since nothing else starts the new build',
            told.join(',') === 'expect', told.join(','));

        told.length = 0;
        await install({ source: 'upload', upload: otherUploadFor('ACME000001') });
        check('another package does not', told.length === 0, told.join(','));

        told.length = 0;
        const failing = createInstaller({
            sdb: fakeSdb('install failed[118, -12]'), device: fakeDevice(), config: fakeConfig({ author: 'present' }),
            resigner: fakeResigner, store, selfRestart
        });
        await failing.install({ source: 'upload', upload: fixture.wgtWithIcon() }).catch(() => {});
        check('a self-update that fails withdraws the request', told.join(',') === 'expect,cancel', told.join(','));
    }

    {
        const { outcome, sdb } = await releasedInstall({ sdb: heldSdb(), upload: fixture.wgtWithIcon() });
        check('a self-update that sdb keeps turning away after the release never uninstalls the running copy',
            outcome.code === 'sdbUnreachable' && !sdb.calls.commands.some((c) => c.includes('vd_appuninstall')),
            JSON.stringify({ code: outcome.code, commands: sdb.calls.commands }));
    }

    for (const [label, upload] of [['a self-update', fixture.wgtWithIcon()], ['another package', otherUpload()]]) {
        const { outcome, channel } = await releasedInstall({ sdb: heldSdb(), upload, channel: fakeChannel({ busy: true }) });
        check(`${label} while a root command outlasts the wait is refused as busy, root left alone`,
            outcome.code === 'installBusy' && /Retry once the root channel is idle/.test(outcome.message) &&
            channel.seen.released === 0 && channel.seen.commands.length === 0,
            `${outcome.code}: ${outcome.message}`);
    }

    {
        // sdbd keeps turning clients away for a few seconds after the agent dies.
        const order = [];
        const sdb = heldSdb(0);
        sdb.probeHandshake = async (options) => { order.push(`probe x${options.attempts}`); return { handshake: 'ok', attempts: 4, error: null }; };
        const wrapped = { ...sdb, withSession: (options, run) => { order.push('session'); return sdb.withSession(options, run); } };
        const { outcome } = await releasedInstall({ sdbError: 'sdbClosed', sdb: wrapped });
        check('after the release the install waits for sdbd to take a client before installing',
            outcome.route === 'sdb' && order[0] === 'probe x15' && order.indexOf('session') > 0, order.join(','));
    }

    {
        const channel = fakeChannel({ busy: true });
        setTimeout(() => { channel.busy = false; }, 300);
        const { outcome } = await releasedInstall({ sdb: heldSdb(1), channel, rootIdleWaitMs: 5000 });
        check('an install waits for a short root command, then releases the agent and installs',
            outcome.route === 'sdb' && channel.seen.released === 1, JSON.stringify({ outcome, channel: channel.seen }));
    }

    installer.stage = realStage;

    const failed = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed.`);
    process.exit(failed ? 1 : 0);
};

run().catch((error) => { console.error('Harness error:', error); process.exit(1); });

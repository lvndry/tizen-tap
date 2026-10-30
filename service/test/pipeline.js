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
        const otherConfig = Buffer.from(readFileSync(join(__dirname, '..', '..', 'config.xml')).toString('utf8').replace(/GJBBYNLkgP/g, 'ACME000001'));
        const otherUpload = fixture.zipAll([
            { name: 'config.xml', contents: otherConfig, deflate: true },
            { name: 'icon.png', contents: fixture.PIXEL }
        ]);

        const outcome = await install({ source: 'upload', reference: 'other.wgt', upload: otherUpload });

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
        const store = createStore({ installing: true, catalog: [] });
        const { install } = createInstaller({
            sdb: fakeSdb(), device: fakeDevice(), config: fakeConfig(),
            resigner: () => {}, store
        });

        const refused = await install({ source: 'upload', upload: realPackage }).catch((e) => e);
        check('a second concurrent install is refused', refused.code === 'internal', String(refused.code));
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

    const PKGCMD_OK = '__return_cb req_id[1] pkg_type[wgt] pkgid[ACME000001] key[start] val[install]\n' +
        '__return_cb req_id[1] pkg_type[wgt] pkgid[ACME000001] key[end] val[ok]\n' +
        'spend time for pkgcmd is [2210]ms\n';

    const fakeChannel = ({ root = true, busy = false, result = { exit: 0, timedOut: false, stdout: PKGCMD_OK, stderr: '' } } = {}) => {
        const seen = { commands: [], released: 0 };
        return {
            seen,
            busy,
            status: () => ({ root }),
            exec: (command) => { seen.commands.push(command); return Promise.resolve(result); },
            release: () => { seen.released += 1; return Promise.resolve(); }
        };
    };

    const otherConfig = Buffer.from(readFileSync(join(__dirname, '..', '..', 'config.xml')).toString('utf8').replace(/GJBBYNLkgP/g, 'ACME000001'));
    const otherUpload = () => fixture.zipAll([
        { name: 'config.xml', contents: otherConfig, deflate: true },
        { name: 'icon.png', contents: fixture.PIXEL }
    ]);

    {
        const store = createStore({ installing: false, catalog: [] });
        const { install } = createInstaller({
            sdb: fakeSdb(), device: fakeDevice(), config: fakeConfig({ author: 'present' }),
            resigner: fakeResigner, store, rootChannel: fakeChannel()
        });

        const outcome = await install({ source: 'upload', upload: otherUpload() });
        check('an install sdb carries reports the sdb route', outcome.route === 'sdb', JSON.stringify(outcome));
    }

    {
        const store = createStore({ installing: false, catalog: [] });
        const channel = fakeChannel();
        const { install } = createInstaller({
            sdb: heldSdb(), config: fakeConfig({ author: 'present' }), resigner: fakeResigner, store,
            device: fakeDevice({ ready: false, reason: 'sdbUnreachable', sdbError: 'sdbClosed' }),
            rootChannel: channel
        });

        const outcome = await install({ source: 'upload', upload: otherUpload() }).catch((e) => e);
        check('with the root agent holding sdbd, the probe does not refuse and the install goes through root',
            outcome.route === 'root' && outcome.packageId === 'ACME000001', JSON.stringify(outcome));
        check('through pkgcmd, on the staged file',
            channel.seen.commands.length === 1 &&
            channel.seen.commands[0] === '/usr/bin/pkgcmd -i -t wgt -p /home/owner/share/tmp/sdk_tools/package.wgt',
            JSON.stringify(channel.seen.commands));
    }

    {
        const store = createStore({ installing: false, catalog: [] });
        const channel = fakeChannel();
        let sdbTried = false;
        const sdb = heldSdb();
        const untouched = new Proxy(sdb, {
            get(target, name) {
                const value = target[name];
                if (typeof value !== 'function') return value;
                return (...args) => { sdbTried = true; return value.apply(target, args); };
            }
        });
        const { install } = createInstaller({
            sdb: untouched, config: fakeConfig({ author: 'present' }), resigner: fakeResigner, store,
            device: fakeDevice({ ready: false, reason: 'sdbUnreachable', sdbError: 'sdbTimeout' }),
            rootChannel: channel
        });

        const outcome = await install({ source: 'upload', upload: otherUpload() }).catch((e) => e);
        check('a probe that timed out while the root agent holds sdbd installs through root',
            outcome.route === 'root' && outcome.packageId === 'ACME000001', JSON.stringify(outcome));
        check('and never tries sdb for the install, so nothing can race the root install',
            !sdbTried && channel.seen.commands.length === 1, JSON.stringify({ sdbTried, commands: channel.seen.commands }));
    }

    {
        const store = createStore({ installing: false, catalog: [] });
        const { install } = createInstaller({
            sdb: heldSdb(), device: fakeDevice(), config: fakeConfig({ author: 'present' }),
            resigner: fakeResigner, store, rootChannel: fakeChannel({ root: false })
        });

        const refused = await install({ source: 'upload', upload: otherUpload() }).catch((e) => e);
        check('without a root channel a handshake rejection is the error, not a root install',
            refused.code === 'sdbClosed', String(refused.code));
    }

    {
        const store = createStore({ installing: false, catalog: [] });
        const failing = '__return_cb req_id[1] pkg_type[wgt] pkgid[ACME000001] key[error] val[-12:signature invalid]\n' +
            '__return_cb req_id[1] pkg_type[wgt] pkgid[ACME000001] key[end] val[fail]\n';
        const { install } = createInstaller({
            sdb: heldSdb(), device: fakeDevice(), config: fakeConfig({ author: 'present' }), resigner: fakeResigner, store,
            rootChannel: fakeChannel({ result: { exit: 1, timedOut: false, stdout: failing, stderr: '' } })
        });

        const refused = await install({ source: 'upload', upload: otherUpload() }).catch((e) => e);
        check('a pkgcmd refusal is a failed install carrying pkgcmd\'s own words',
            refused.code === 'installFailed' && /val\[-12:signature invalid\]/.test(refused.message), `${refused.code}: ${refused.message}`);
    }

    {
        const store = createStore({ installing: false, catalog: [] });
        const sdb = heldSdb(1);
        const channel = fakeChannel();
        const { install } = createInstaller({
            sdb, device: fakeDevice(), config: fakeConfig({ author: 'present' }), resigner: fakeResigner, store,
            rootChannel: channel
        });

        const outcome = await install({ source: 'upload', upload: fixture.wgtWithIcon() }).catch((e) => e);
        check('a self-update never goes through root: the agent is released and sdb carries it in place',
            outcome.route === 'sdb' && channel.seen.released === 1 && channel.seen.commands.length === 0 &&
            sdb.calls.commands.length === 1 && sdb.calls.commands[0].includes('vd_appinstall GJBBYNLkgP') &&
            !sdb.calls.commands.some((c) => c.includes('vd_appuninstall')),
            JSON.stringify({ outcome, channel: channel.seen, sdb: sdb.calls }));
    }

    {
        const store = createStore({ installing: false, catalog: [] });
        const channel = fakeChannel({ busy: true });
        const { install } = createInstaller({
            sdb: heldSdb(), device: fakeDevice(), config: fakeConfig({ author: 'present' }), resigner: fakeResigner, store,
            rootChannel: channel
        });

        const refused = await install({ source: 'upload', upload: fixture.wgtWithIcon() }).catch((e) => e);
        check('a self-update while a root command runs is refused with a retry hint, root left alone',
            refused.code === 'sdbUnreachable' && /Retry once the root channel is idle/.test(refused.message) &&
            channel.seen.released === 0 && channel.seen.commands.length === 0,
            `${refused.code}: ${refused.message}`);
    }

    {
        const command = installer.rootCommand('/home/owner/share/tmp/sdk_tools/package.wgt');
        check('the root install command carries no backslash', command.indexOf('\\') === -1, command);
        check('and names the package type from the staged file',
            installer.rootCommand('/home/owner/share/tmp/sdk_tools/package.tpk').includes('-t tpk'), command);

        const silent = (() => {
            try { installer.interpretPkgcmd({ exit: 0, timedOut: false, stdout: 'spend time for pkgcmd is [9]ms\n', stderr: '' }, {}); return null; }
            catch (error) { return error; }
        })();
        check('pkgcmd output without an end event is not taken as success',
            silent && silent.code === 'installFailed' && /neither success nor failure/.test(silent.message), String(silent && silent.message));

        const author = (() => {
            try {
                installer.interpretPkgcmd({
                    exit: 1, timedOut: false, stderr: '',
                    stdout: 'key[error] val[-11:Author certificate not match]\nkey[end] val[fail]\n'
                }, { packageId: 'ACME000001' });
                return null;
            } catch (error) { return error; }
        })();
        check('a pkgcmd failure the sdb installer also knows keeps its specific code',
            author && author.code === 'authorMismatch', String(author && author.code));
    }

    installer.stage = realStage;

    const failed = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed.`);
    process.exit(failed ? 1 : 0);
};

run().catch((error) => { console.error('Harness error:', error); process.exit(1); });

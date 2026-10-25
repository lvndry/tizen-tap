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

    installer.stage = realStage;

    const failed = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed.`);
    process.exit(failed ? 1 : 0);
};

run().catch((error) => { console.error('Harness error:', error); process.exit(1); });

'use strict';

// powerState(): the set's live power state straight from the Control API.
// The only contract a caller needs is: 'on' means the glass is up, anything
// else (another state, an unreadable one, no TV at all) means "not on". The
// companion launches key off that, so a wrong 'on' is a flash of an app on a
// black screen.

function check(name, ok, detail) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
    return ok;
}

async function main() {
    const results = [];
    const fetch = require('../src/remote/fetch.ts');
    const realGetJson = fetch.getJson;

    function stubGetJson(value, error) {
        // device.ts destructures getJson at require time, so the stub must be
        // in place before each freshDevice() require picks the module up.
        fetch.getJson = async (url) => {
            if (error) throw error;
            return { device: value };
        };
    }

    // Off-TV: no tizen global, so powerState is null without a single read.
    global.tizen = undefined;
    delete require.cache[require.resolve('../src/tv/device.ts')];
    results.push(check('not on a TV -> null', (await require('../src/tv/device.ts').powerState()) === null, 'expected null off-TV'));

    // On-TV: a systeminfo that reports a platform version.
    global.tizen = { application: {}, systeminfo: { getCapability: () => '6.0' } };

    stubGetJson({ PowerState: 'on' });
    delete require.cache[require.resolve('../src/tv/device.ts')];
    results.push(check('reports "on" as on', (await require('../src/tv/device.ts').powerState()) === 'on', 'expected on'));

    stubGetJson({ PowerState: 'standby' });
    delete require.cache[require.resolve('../src/tv/device.ts')];
    results.push(check('reports "standby" as standby', (await require('../src/tv/device.ts').powerState()) === 'standby', 'expected standby'));

    stubGetJson({ developerMode: '1' });
    delete require.cache[require.resolve('../src/tv/device.ts')];
    results.push(check('missing PowerState -> null', (await require('../src/tv/device.ts').powerState()) === null, 'expected null for missing field'));

    stubGetJson({ PowerState: 5 });
    delete require.cache[require.resolve('../src/tv/device.ts')];
    results.push(check('non-string PowerState -> null', (await require('../src/tv/device.ts').powerState()) === null, 'expected null for a number'));

    stubGetJson(null, Object.assign(new Error('ECONNREFUSED'), { url: 'http://127.0.0.1:8001/api/v2/' }));
    delete require.cache[require.resolve('../src/tv/device.ts')];
    results.push(check('Control API down -> null', (await require('../src/tv/device.ts').powerState()) === null, 'expected null when the read fails'));

    fetch.getJson = realGetJson;

    const failed = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed.`);
    process.exit(failed ? 1 : 0);
}

main().catch((error) => {
    console.error('\nHarness error:', error.message);
    process.exit(1);
});

'use strict';

const { mkdtempSync, readFileSync, existsSync, statSync } = require('fs');
const { tmpdir } = require('os');
const http = require('http');

process.env.HOMEBREW_CONFIG_DIR = mkdtempSync(`${tmpdir()}/homebrew-flight-test-`);

const { startRecording, Facility } = require('../src/obs/log.ts');
const { createFlightRecorder, ABRUPT, RUN_RECORD, EXIT_RECORD } = require('../src/obs/flight.ts');
const { createRouter } = require('../src/http/router.ts');
const status = require('../src/routes/status.ts');

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
};

const freshDir = () => mkdtempSync(`${tmpdir()}/homebrew-flight-`);

const quietly = (flight) => startRecording({ capture: false, print: () => {}, flight });

const fileLines = (path) => (existsSync(path)
    ? readFileSync(path, 'utf8').split('\n').filter((line) => line.length > 0)
    : []);

{
    const dir = freshDir();
    const flight = createFlightRecorder({ dir, pid: 101 });
    const recorder = quietly(flight);

    check('a first run has no previous run to judge', flight.previousRun().endedCleanly === null,
        JSON.stringify(flight.previousRun()));

    recorder.log.info(Facility.SVC, 'first');
    recorder.log.warn(Facility.PKG, 'second\nthird');

    const onDisk = fileLines(flight.paths.current);
    const inMemory = recorder.since(0).map((line) => recorder.format(line));

    check('every record reaches the file, one line each, in the same shape as the ring',
        onDisk.length === inMemory.length && onDisk.every((line, index) => line === inMemory[index]),
        JSON.stringify({ onDisk, inMemory }));

    check('and the run opens with its pid', onDisk[0].indexOf(`${RUN_RECORD} 101`) !== -1, onDisk[0]);

    const reopened = createFlightRecorder({ dir, pid: 102 });

    check('a run with no exit record, from another pid, ended abruptly',
        reopened.previousRun().endedCleanly === false && reopened.previousRun().summary === ABRUPT,
        JSON.stringify(reopened.previousRun()));

    check('its lines are set aside as the previous run', fileLines(reopened.paths.previous).length === onDisk.length,
        `kept ${fileLines(reopened.paths.previous).length} of ${onDisk.length}`);

    check('and this run starts with an empty file', !existsSync(reopened.paths.current), 'the old log was left in place');
}

{
    const dir = freshDir();
    const recorder = quietly(createFlightRecorder({ dir, pid: 201 }));

    recorder.log.info(Facility.SVC, 'about to restart');
    recorder.recordExit('restart requested');
    recorder.recordExit('process exit, code 0');

    const next = createFlightRecorder({ dir, pid: 202 });
    const judged = next.previousRun();

    check('a recorded exit reads as a clean end, with its reason',
        judged.endedCleanly === true && judged.reason === 'restart requested', JSON.stringify(judged));

    const exits = fileLines(next.paths.previous).filter((line) => line.indexOf(EXIT_RECORD) !== -1);
    check('only the first exit reason is recorded', exits.length === 1, JSON.stringify(exits));
}

{
    const dir = freshDir();
    quietly(createFlightRecorder({ dir, pid: 301 })).log.info(Facility.SVC, 'still running');

    const judged = createFlightRecorder({ dir, pid: 301 }).previousRun();

    check('the same pid starting again is a reload in place, not a death',
        judged.endedCleanly === true && /reloaded/.test(judged.reason), JSON.stringify(judged));
}

{
    const dir = freshDir();
    const cap = 2048;
    const flight = createFlightRecorder({ dir, cap, pid: 401 });
    const recorder = quietly(flight);

    for (let index = 0; index < 200; index++) recorder.log.info(Facility.SVC, `line ${index} ${'x'.repeat(40)}`);

    check('the file rotates at the cap', existsSync(flight.paths.rotated), 'no rotated file');
    check('and neither file grows past it',
        statSync(flight.paths.current).size <= cap && statSync(flight.paths.rotated).size <= cap,
        `${statSync(flight.paths.current).size} / ${statSync(flight.paths.rotated).size}`);

    const current = fileLines(flight.paths.current);
    check('the newest line is in the current file', /line 199 /.test(current[current.length - 1]), current[current.length - 1]);
    check('and every file still names the run\'s pid', current[0].indexOf(`${RUN_RECORD} 401`) !== -1, current[0]);

    const next = createFlightRecorder({ dir, pid: 401 });
    const previous = next.previous();

    check('a rotated run is read back oldest first, both files together',
        previous.lines.length > current.length && /line 199 /.test(previous.lines[previous.lines.length - 1]),
        `${previous.lines.length} lines, last ${previous.lines[previous.lines.length - 1]}`);

    check('the tail is the end of it', previous.tail[previous.tail.length - 1] === previous.lines[previous.lines.length - 1],
        JSON.stringify(previous.tail.slice(-1)));
}

{
    const flight = createFlightRecorder({ dir: '/definitely/not/a/writable/place', pid: 501 });
    const recorder = quietly(flight);
    let survived = true;

    try {
        recorder.log.info(Facility.SVC, 'nowhere to go');
    } catch (e) {
        survived = false;
    }

    check('an unwritable directory does not stop the log', survived && recorder.since(0).length === 2,
        `survived ${survived}, kept ${recorder.since(0).length}`);
    check('and the failure is reported, not hidden', typeof flight.recording().error === 'string',
        JSON.stringify(flight.recording()));
}

{
    const healthy = {
        sdbd: { port: 'open', handshake: 'ok' },
        root: { root: true },
        services: { stremio: { up: true } },
        memory: { pressure: 'ok' },
        oom: { kills: [] }
    };

    check('a clean previous run changes nothing',
        status.diagnose({ ...healthy, previousRun: { endedCleanly: true } }) === 'Everything looks healthy.',
        status.diagnose({ ...healthy, previousRun: { endedCleanly: true } }));

    const abrupt = status.diagnose({ ...healthy, previousRun: { endedCleanly: false } });
    check('an abrupt one is named second, after the present',
        /^Everything looks healthy\. Also: the previous run ended without an exit record .*\/logs\/previous/.test(abrupt), abrupt);

    const alongside = status.diagnose({ ...healthy, root: { root: false }, previousRun: { endedCleanly: false } });
    check('and never outranks what is broken now',
        /^root channel is not armed.* Also: the previous run ended without an exit record/.test(alongside), alongside);
}

function get(port, path, headers) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path, headers: headers || {} }, (response) => {
            let body = '';
            response.on('data', (chunk) => { body += chunk; });
            response.on('end', () => resolve({ status: response.statusCode, body }));
        }).on('error', reject);
    });
}

async function route() {
    const dir = freshDir();
    quietly(createFlightRecorder({ dir, pid: 601 })).log.err(Facility.SVC, 'the last thing it said');

    const recorded = quietly(createFlightRecorder({ dir, pid: 602 }));

    const router = createRouter({});
    status.register({
        recorded,
        fromLoopback: () => false,
        authorise: (presented) => (presented === '123456'
            ? { ok: true }
            : { ok: false, code: 'unauthorized', message: 'Wrong or missing PIN.' })
    }, router);

    const server = http.createServer(router.listener);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    try {
        const refused = await get(port, '/logs/previous');
        check('GET /logs/previous wants the PIN', refused.status === 403, `status ${refused.status}`);

        const served = await get(port, '/logs/previous', { 'x-homebrew-pin': '123456' });
        const body = JSON.parse(served.body);

        check('and with it, serves the previous run and its verdict',
            served.status === 200 && body.endedCleanly === false && body.summary === ABRUPT, served.body.slice(0, 200));

        check('its lines end where that run did',
            Array.isArray(body.lines) && /the last thing it said$/.test(body.lines[body.lines.length - 1]) &&
            body.tail[body.tail.length - 1] === body.lines[body.lines.length - 1],
            JSON.stringify(body.lines));

        check('and it says where this run is being kept', body.recording && /homebrewLog\.txt$/.test(body.recording.path),
            JSON.stringify(body.recording));
    } finally {
        server.close();
    }
}

route()
    .catch((error) => check('the route harness ran', false, error.stack))
    .then(() => {
        const failed = results.filter((ok) => !ok).length;
        console.log(`\n${results.length - failed}/${results.length} checks passed.`);
        process.exit(failed ? 1 : 0);
    });

'use strict';

// The Host PC IP switch with the root exec stubbed: strict validation, the
// read-set-read sequence, and the order that matters most, the response going
// out before sdbd is restarted (the restart usually kills the agent running it).

const {
    isDottedQuad, changeDeveloperIp, READ_COMMAND, RESTART_COMMAND, NOT_SELF_INSTALL_WARNING
} = require('../src/root/developer.ts');

const results = [];
function check(name, ok, detail) {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
}

function buxtonLine(ip) {
    return { exit: 0, stdout: `[system] db/sdk/develop/ip = String: ${ip}\n`, stderr: '' };
}

// A stand-in buxton2 database behind a root exec, recording every command and
// every response in one timeline so the order can be asserted.
function fakeTv({ ip = '127.0.0.1', setExit = 0, readBack = null, restart = 'drops' } = {}) {
    const timeline = [];
    let stored = ip;

    const exec = async (command) => {
        timeline.push(`exec ${command}`);

        if (command === READ_COMMAND) return buxtonLine(readBack !== null && timeline.length > 2 ? readBack : stored);
        if (command.indexOf('buxton2ctl set-string system db/sdk/develop/ip ') === 0) {
            if (setExit !== 0) return { exit: setExit, stdout: '', stderr: 'permission denied\n' };
            stored = command.split(' ').pop();
            return { exit: 0, stdout: '', stderr: '' };
        }
        if (command === RESTART_COMMAND) {
            if (restart === 'drops') throw new Error('root channel closed');
            return { exit: 0, stdout: '', stderr: '' };
        }
        throw new Error(`unexpected command ${command}`);
    };

    const responses = [];
    const respond = (code, body) => { timeline.push('respond'); responses.push({ code, body }); };
    const logs = [];

    return { exec, respond, log: (line) => logs.push(line), timeline, responses, logs, stored: () => stored };
}

async function main() {
    const valid = ['127.0.0.1', '0.0.0.0', '192.168.1.42', '255.255.255.255', '10.0.0.1'];
    const invalid = ['', '127.0.0', '127.0.0.1.5', '256.1.1.1', '1.2.3.-4', '01.2.3.4', '1.2.3.4 ',
        ' 1.2.3.4', '1.2.3.4; reboot', '1.2.3.4\nreboot', 'a.b.c.d', '1..2.3', '1.2.3.1000', null, 127001, undefined];

    check('every valid dotted quad is accepted', valid.every(isDottedQuad), valid.filter((ip) => !isDottedQuad(ip)).join(','));
    check('malformed, out-of-range, zero-padded and injected values are refused',
        invalid.every((value) => !isDottedQuad(value)),
        JSON.stringify(invalid.filter(isDottedQuad)));

    {
        const tv = fakeTv();
        await changeDeveloperIp({ ...tv, ip: '1.2.3.4; reboot' });
        check('an invalid ip is a 400 and touches nothing',
            tv.responses.length === 1 && tv.responses[0].code === 400 && tv.timeline.length === 1,
            JSON.stringify(tv.timeline));
    }

    {
        const tv = fakeTv({ ip: '127.0.0.1' });
        await changeDeveloperIp({ ...tv, ip: '192.168.1.50' });

        const expected = [
            `exec ${READ_COMMAND}`,
            'exec buxton2ctl set-string system db/sdk/develop/ip 192.168.1.50',
            `exec ${READ_COMMAND}`,
            'respond',
            `exec ${RESTART_COMMAND}`
        ];
        check('read, set, read back, respond, and only then restart sdbd',
            JSON.stringify(tv.timeline) === JSON.stringify(expected), JSON.stringify(tv.timeline));

        const body = tv.responses[0].body;
        check('the response carries before and after',
            body.ok === true && body.before === '127.0.0.1' && body.after === '192.168.1.50', JSON.stringify(body));
        check('a value other than 127.0.0.1 warns that self-install stops working',
            body.warning === NOT_SELF_INSTALL_WARNING, JSON.stringify(body));
        check('the response says the root channel will likely drop', /POST \/dev\/root\/arm/.test(body.restart), body.restart);
        check('a restart that takes the channel with it is logged as expected, not thrown',
            tv.logs.some((line) => /as expected/.test(line)), JSON.stringify(tv.logs));
    }

    {
        const tv = fakeTv({ ip: '192.168.1.50', restart: 'returns' });
        await changeDeveloperIp({ ...tv, ip: '127.0.0.1' });
        const body = tv.responses[0].body;
        check('setting 127.0.0.1 back carries no warning', body.ok === true && body.warning === undefined, JSON.stringify(body));
    }

    {
        const tv = fakeTv({ setExit: 1 });
        await changeDeveloperIp({ ...tv, ip: '10.0.0.2' });
        const body = tv.responses[0].body;
        check('a failed set is reported and sdbd is not restarted',
            body.ok === false && body.before === '127.0.0.1' && /set-string failed/.test(body.error) &&
            tv.timeline.indexOf(`exec ${RESTART_COMMAND}`) === -1, JSON.stringify(tv.timeline));
    }

    {
        const tv = fakeTv({ readBack: '127.0.0.1' });
        await changeDeveloperIp({ ...tv, ip: '10.0.0.3' });
        const body = tv.responses[0].body;
        check('a read-back that disagrees is an error and sdbd is not restarted',
            body.ok === false && body.after === '127.0.0.1' &&
            tv.timeline.indexOf(`exec ${RESTART_COMMAND}`) === -1, JSON.stringify(body));
    }

    {
        const tv = fakeTv();
        const failing = async () => { throw new Error('root channel is not connected'); };
        await changeDeveloperIp({ ...tv, exec: failing, ip: '10.0.0.4' });
        check('an exec that fails outright answers once, with the error',
            tv.responses.length === 1 && tv.responses[0].body.ok === false && /not connected/.test(tv.responses[0].body.error),
            JSON.stringify(tv.responses));
    }
}

main().then(() => {
    const failed = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed.`);
    process.exit(failed ? 1 : 0);
}).catch((error) => {
    console.error('Harness error:', error);
    process.exit(1);
});

'use strict';

// The process view's parser over output shaped like the TV's: the /proc rows,
// ps command lines with base64 AUL blobs after the executable, /proc/meminfo
// and the dmesg kill lines, all from the one root exec.

const { PROCESSES_COMMAND, parseProcesses, parseLimit, DEFAULT_LIMIT } = require('../src/root/processes.ts');
const { OOM_DMESG_COMMAND } = require('../src/routes/status.ts');

const results = [];
function check(name, ok, detail) {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
}

const AUL = 'NQAAAAEAAAAuAAAAAAAAAF9fQVVMX1NUQVJUVElNRV9fAAAAAAAAAAoAAAAxNzMwMjA5NjAw';

const OUTPUT = [
    'P 1 4120 -1000 systemd',
    'P 612 9876 -1000 enlightenment',
    'P 1408 88320 690 GJBBYNLkgP.Tize',
    'P 1460 41200 290 GJBBYNLkgP.Tize',
    'P 2210 152000 750 netflix',
    'P 2302 63500 660 S6K2WQ8MnP.Stre',
    'P 2350 30400 290 S6K2WQ8MnP.Stre',
    'P 2611 12000 -900 SamsungTvRootAg',
    'P 3001 5120 - vanished early',
    '@ARGS',
    '  PID COMMAND',
    '    1 /sbin/init',
    '  612 /usr/bin/enlightenment -profile samsung',
    ` 1408 /opt/usr/apps/GJBBYNLkgP/bin/GJBBYNLkgP.TizenHomebrew __AUL_STARTTIME__ ${AUL} __AUL_CALLER_PID__ ${AUL}`,
    ` 1460 /opt/usr/apps/GJBBYNLkgP/bin/GJBBYNLkgP.TizenHomebrewService ${AUL} ${AUL}`,
    ` 2210 /usr/apps/org.tizen.netflix/bin/netflix ${AUL}`,
    ` 2302 /opt/usr/apps/S6K2WQ8MnP/bin/S6K2WQ8MnP.StremioServer ${AUL}`,
    ` 2350 /opt/usr/apps/S6K2WQ8MnP/bin/S6K2WQ8MnP.StremioServerService ${AUL}`,
    // A foreign process whose AUL payload mentions our id must not count as ours.
    ` 2611 /home/owner/share/tmp/sdk_tools/SamsungTvRootAgent caller=GJBBYNLkgP`,
    '@MEMINFO',
    'MemTotal:       1648512 kB',
    'MemFree:         120576 kB',
    'MemAvailable:    483328 kB',
    'SwapTotal:        50176 kB',
    'SwapFree:         49152 kB',
    '@OOM',
    '[ 8123.456789] Out of memory: Killed process 1999 (newslO9NqF.stre) total-vm:812345kB',
    '[ 8123.470001] oom_reaper: reaping process 1999 (newslO9NqF.stre), now anon-rss:0kB',
    ''
].join('\n');

async function main() {
    const view = parseProcesses(OUTPUT, 5);

    check('rows are sorted by RSS and cut to the limit',
        view.processes.length === 5 && view.processes.map((row) => row.pid).join(',') === '2210,1408,2302,1460,2350',
        JSON.stringify(view.processes.map((row) => row.pid)));
    check('count is every process seen, not just the ones returned', view.count === 9, String(view.count));

    const ui = view.processes.find((row) => row.pid === 1408);
    check('exe is the basename of the first cmdline field, AUL blobs stripped',
        ui.exe === 'GJBBYNLkgP.TizenHomebrew', ui.exe);
    check('name is the comm, as truncated by the kernel', ui.name === 'GJBBYNLkgP.Tize', ui.name);
    check('rss is reported in MB to one decimal', ui.rss_mb === 86.3, String(ui.rss_mb));
    check('oom_score_adj is a number', ui.oom_score_adj === 690, String(ui.oom_score_adj));

    check('ours is true for both our packages and false for netflix',
        view.processes.filter((row) => row.ours).map((row) => row.pid).join(',') === '1408,2302,1460,2350' &&
        view.processes.find((row) => row.pid === 2210).ours === false,
        JSON.stringify(view.processes.map((row) => [row.pid, row.ours])));

    const all = parseProcesses(OUTPUT, 100);
    const agent = all.processes.find((row) => row.pid === 2611);
    check('an id inside the arguments, not the path, is not ours', agent.ours === false && agent.exe === 'SamsungTvRootAgent',
        JSON.stringify(agent));
    const vanished = all.processes.find((row) => row.pid === 3001);
    check('a process with no readable score or ps line reports nulls, not guesses',
        vanished.oom_score_adj === null && vanished.exe === null && vanished.ours === false && vanished.name === 'vanished early',
        JSON.stringify(vanished));
    check('a negative score parses', all.processes.find((row) => row.pid === 1).oom_score_adj === -1000, '');

    check('memory summary comes from the meminfo section',
        view.memory && view.memory.total_mb === 1610 && view.memory.available_mb === 472 && view.memory.swap_free_mb === 48,
        JSON.stringify(view.memory));
    check('the dmesg lines are kept raw and parsed into kills',
        view.oom.lines.length === 2 && view.oom.kills.length === 2 && view.oom.kills[0].pid === 1999 &&
        view.oom.kills[0].pkg === 'newslO9NqF.stre', JSON.stringify(view.oom));

    const empty = parseProcesses('', DEFAULT_LIMIT);
    check('empty output is an empty view, not a crash',
        empty.processes.length === 0 && empty.memory === null && empty.oom.kills.length === 0, JSON.stringify(empty));

    check('limit defaults to 25', parseLimit(null) === 25 && parseLimit('') === 25, '');
    check('limit accepts 1..500 and refuses the rest',
        parseLimit('1') === 1 && parseLimit('500') === 500 &&
        [ '0', '501', '-3', '2.5', 'ten', '10; reboot' ].every((raw) => parseLimit(raw) === null), '');

    check('the whole view is one shell line ending in the kill-log scan',
        PROCESSES_COMMAND.indexOf('\n') === -1 && PROCESSES_COMMAND.endsWith(OOM_DMESG_COMMAND) &&
        PROCESSES_COMMAND.length < 8 * 1024, PROCESSES_COMMAND);

    check('the command carries no backslash, which the root channel does not pass through unchanged',
        PROCESSES_COMMAND.indexOf('\\') === -1, PROCESSES_COMMAND);
}

main().then(() => {
    const failed = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed.`);
    process.exit(failed ? 1 : 0);
}).catch((error) => {
    console.error('Harness error:', error);
    process.exit(1);
});

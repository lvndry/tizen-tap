// The process view: who is holding the TV's RAM, how readily the kernel would
// reap each of them, and what it has reaped lately.
//
// Everything comes from ONE root exec, a single shell line printing four
// sections, because each exec is a round trip through the agent and the app
// sandbox cannot see other apps' /proc at all. The per-process loop uses shell
// builtins only (read, case), so walking ~200 processes forks nothing; ps is
// run once for the command lines.

'use strict';

const { parseMeminfo, parseOomKills, OOM_DMESG_COMMAND } = require('../routes/status.ts');

const OUR_PACKAGE_IDS = ['GJBBYNLkgP', 'S6K2WQ8MnP'];
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 500;

const ARGS_MARK = '@ARGS';
const MEMINFO_MARK = '@MEMINFO';
const OOM_MARK = '@OOM';

// Kernel threads have no VmRSS line, so they print nothing. The loop stops at
// VmRSS because Name comes first in /proc/<pid>/status and nothing later is needed.
// No backslashes: the root channel does not hand them to the shell unchanged, and
// on the CU7105 printf's newline escape arrived as a literal backslash-n.
const PROCESSES_COMMAND = [
    'for d in /proc/[0-9]*; do',
    'pid=${d#/proc/}; name=; rss=; adj=;',
    'while read key value; do case $key in Name:) name=$value;; VmRSS:) rss=${value%% *}; break;; esac; done 2>/dev/null < $d/status;',
    'read adj 2>/dev/null < $d/oom_score_adj;',
    '[ -n "$rss" ] && echo "P $pid $rss ${adj:--} $name";',
    'done;',
    `echo ${ARGS_MARK}; ps -eo pid,args;`,
    `echo ${MEMINFO_MARK}; cat /proc/meminfo;`,
    `echo ${OOM_MARK}; ${OOM_DMESG_COMMAND}`
].join(' ');

function parseLimit(raw) {
    if (raw === null || raw === undefined || raw === '') return DEFAULT_LIMIT;
    if (!/^\d+$/.test(String(raw))) return null;

    const limit = Number(raw);
    return limit >= 1 && limit <= MAX_LIMIT ? limit : null;
}

function basename(path) {
    return path.slice(path.lastIndexOf('/') + 1);
}

// A command line is NUL-separated and ps prints it space-joined: the
// executable path, then base64 AUL blobs. Only the first field is the program.
function firstField(args) {
    const match = String(args).match(/^\S+/);
    return match ? match[0] : '';
}

function parseProcesses(output, limit = DEFAULT_LIMIT) {
    const rows: { pid: number, rss_kb: number, oom_score_adj: number | null, name: string }[] = [];
    const paths: Record<number, string> = {};
    const meminfo: string[] = [];
    const oomLines: string[] = [];

    let section = 'proc';

    for (const line of String(output == null ? '' : output).split('\n')) {
        const trimmed = line.trim();

        if (trimmed === ARGS_MARK) { section = 'args'; continue; }
        if (trimmed === MEMINFO_MARK) { section = 'meminfo'; continue; }
        if (trimmed === OOM_MARK) { section = 'oom'; continue; }

        if (section === 'proc') {
            const row = line.match(/^P (\d+) (\d+) (-?\d+|-) ?(.*)$/);
            if (!row) continue;

            rows.push({
                pid: Number(row[1]),
                rss_kb: Number(row[2]),
                oom_score_adj: row[3] === '-' ? null : Number(row[3]),
                name: row[4]
            });
        } else if (section === 'args') {
            const entry = line.match(/^\s*(\d+)\s+(.*)$/);
            if (entry) paths[Number(entry[1])] = firstField(entry[2]);
        } else if (section === 'meminfo') {
            meminfo.push(line);
        } else if (trimmed) {
            oomLines.push(trimmed);
        }
    }

    rows.sort((left, right) => right.rss_kb - left.rss_kb);

    const processes = rows.slice(0, limit).map((row) => {
        const path = paths[row.pid] || '';

        return {
            pid: row.pid,
            name: row.name,
            exe: path ? basename(path) : null,
            rss_mb: Math.round(row.rss_kb / 102.4) / 10,
            oom_score_adj: row.oom_score_adj,
            ours: OUR_PACKAGE_IDS.some((id) => path.indexOf(id) !== -1)
        };
    });

    return {
        processes,
        count: rows.length,
        memory: parseMeminfo(meminfo.join('\n')),
        oom: { lines: oomLines, kills: parseOomKills(oomLines.join('\n')) }
    };
}

module.exports = { PROCESSES_COMMAND, OUR_PACKAGE_IDS, DEFAULT_LIMIT, MAX_LIMIT, parseLimit, parseProcesses };

'use strict';

// The log's copy on disk. The ring in log.ts dies with the process, and on the television the process
// dies to the out-of-memory killer's SIGKILL, which no handler sees: whatever already reached this file
// is the only account of a death that survives it.

const { appendFileSync, readFileSync, renameSync, existsSync, mkdirSync, unlinkSync } = require('fs');
const { join } = require('path');

const CAP_BYTES = 256 * 1024;
const TAIL_LINES = 40;

const CURRENT = 'homebrewLog.txt';
const ROTATED = 'homebrewLog.1.txt';
const PREVIOUS = 'homebrewLog.previous.txt';
const PREVIOUS_ROTATED = 'homebrewLog.previous.1.txt';

// Both are ordinary log lines, so the file stays in one shape and the markers read in /logs too.
const RUN_RECORD = 'flight: run started, pid';
const EXIT_RECORD = 'flight: exit recorded:';

const ABRUPT = 'previous run ended without an exit record (killed, e.g. by the out-of-memory killer, or power loss)';

function escapeForPattern(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const RUN_PATTERN = new RegExp(`${escapeForPattern(RUN_RECORD)} (\\d+)`);
const EXIT_PATTERN = new RegExp(`${escapeForPattern(EXIT_RECORD)} (.*)$`);

function readLines(path) {
    try {
        return readFileSync(path, 'utf8').split('\n').filter((line) => line.length > 0);
    } catch (e) {
        return [];
    }
}

function removeQuietly(path) {
    try {
        if (existsSync(path)) unlinkSync(path);
    } catch (e) {}
}

function moveQuietly(from, to) {
    try {
        if (existsSync(from)) renameSync(from, to);
        else removeQuietly(to);
    } catch (e) {}
}

// A run that recorded an exit ended on purpose. One that did not, but was started by this same pid,
// was reloaded in place by Tizen rather than killed.
function judge(lines, pid) {
    if (lines.length === 0) return { endedCleanly: null, reason: null, pid: null, summary: 'no previous run on record' };

    let runPid: number | null = null;
    let exitReason: string | null = null;

    for (const line of lines) {
        const run = line.match(RUN_PATTERN);
        if (run) runPid = Number(run[1]);

        const exit = line.match(EXIT_PATTERN);
        if (exit) exitReason = exit[1];
    }

    if (exitReason !== null) {
        return { endedCleanly: true, reason: exitReason, pid: runPid, summary: `previous run ended cleanly (${exitReason})` };
    }

    if (runPid !== null && runPid === pid) {
        return { endedCleanly: true, reason: 'reloaded in the same process', pid: runPid,
            summary: 'previous run was reloaded in the same process' };
    }

    return { endedCleanly: false, reason: null, pid: runPid, summary: ABRUPT };
}

function createFlightRecorder(options) {
    const settings = options || {};
    const dir = settings.dir;
    const cap = settings.cap || CAP_BYTES;
    const pid = settings.pid || process.pid;

    const paths = {
        current: join(dir, CURRENT),
        rotated: join(dir, ROTATED),
        previous: join(dir, PREVIOUS),
        previousRotated: join(dir, PREVIOUS_ROTATED)
    };

    let lastError: string | null = null;

    try {
        if (!existsSync(dir)) mkdirSync(dir);
    } catch (e) {
        lastError = e.message;
    }

    // Before anything new is written: last run's files become "previous", and this run starts empty.
    moveQuietly(paths.rotated, paths.previousRotated);
    moveQuietly(paths.current, paths.previous);

    function previousLines() {
        return readLines(paths.previousRotated).concat(readLines(paths.previous));
    }

    const previousRun = (() => {
        const lines = previousLines();
        return { ...judge(lines, pid), lines: lines.length };
    })();

    let written = 0;
    let firstEntry: string | null = null;

    function append(text) {
        try {
            const entry = `${text}\n`;
            const length = Buffer.byteLength(entry);

            if (firstEntry === null) firstEntry = entry;

            if (written > 0 && written + length > cap) {
                renameSync(paths.current, paths.rotated);

                // The run's first line names its pid; every file carries it, so a long run that was
                // reloaded in place is still told apart from one that was killed.
                appendFileSync(paths.current, firstEntry);
                written = Buffer.byteLength(firstEntry);
            }

            appendFileSync(paths.current, entry);
            written += length;
            lastError = null;
        } catch (e) {
            // Logging must never be the reason the service fails; the error is reported, not thrown.
            lastError = e.message;
        }
    }

    function previous() {
        const lines = previousLines();
        return { ...previousRun, lines, tail: lines.slice(-TAIL_LINES) };
    }

    return {
        pid,
        paths,
        append,
        previous,
        previousRun: () => previousRun,
        recording: () => ({ path: paths.current, cap, error: lastError })
    };
}

module.exports = { createFlightRecorder, judge, RUN_RECORD, EXIT_RECORD, ABRUPT, CAP_BYTES, TAIL_LINES };

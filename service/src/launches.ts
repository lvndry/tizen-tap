// The companion-relaunch ring: a bounded in-memory record of every launch this
// service fired on a companion's behalf. main.ts's single launch() path calls
// noteLaunch next to its "was down (label) — launched it" log line, and
// /dev/status serves the tail of the ring as `launches`, so a service's death
// and revival are readable in the same call that diagnoses it.
//
// In-memory only, like every other part of /dev/status: a service restart
// loses the history. The ring is the oldest-out kind — cap 20 entries,
// newest at the end — so recentLaunches(n) is always a chronological tail.

'use strict';

const LAUNCH_RING_CAP = 20;

let ring: { ts: string, app: string, reason: string }[] = [];

function noteLaunch(app, reason) {
    ring.push({ ts: new Date().toISOString(), app: String(app), reason: String(reason) });
    if (ring.length > LAUNCH_RING_CAP) ring.splice(0, ring.length - LAUNCH_RING_CAP);
}

// The last `count` entries (default 10), oldest first.
function recentLaunches(count = 10) {
    return ring.slice(-count);
}

// The ring is module state shared between the writer and the reader; tests
// reset it instead of leaking entries across cases.
function clearLaunches() {
    ring = [];
}

module.exports = { noteLaunch, recentLaunches, clearLaunches, LAUNCH_RING_CAP };

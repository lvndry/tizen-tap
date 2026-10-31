// The rescue's one decision: is Tizen Tap alive, and if not, what is the
// smallest thing that brings it back.
//
//   healthy                    nothing
//   installed, service silent  launch the UI (its page starts the service)
//   missing, or still silent   reinstall the last good copy, then launch
//
// Tizen Tap installing over itself is the other case: the platform kills it
// mid-install and nothing starts the new build, so it asks the rescue to
// follow the restart (see expectRestart in lastgood.ts). The rescue waits for
// it to go quiet, launches it once its package is registered again, and falls
// back to the check above if it never comes back.
//
// Bounded on purpose. One reinstall per boot, and a counter on disk of
// reinstalls of the same copy that did not bring Tizen Tap back: a broken
// last-good copy is tried MAX_FAILED_REINSTALLS times across boots and then
// left alone. A healthy Tizen Tap, or a different last-good copy, clears it.
// The counter is written before vd_appinstall runs, so a crash during the
// install still counts.
//
// Everything that touches the TV is injected; main.ts supplies the real ones.

'use strict';

const installer = require('../../service/src/install/installer.ts');
const { identify } = require('../../service/src/install/manifest.ts');
const { SELF_PACKAGE_ID, TIZEN_TAP_APP_ID } = require('../../service/src/rescue/lastgood.ts');

const MAX_FAILED_REINSTALLS = 2;

const TIMINGS = {
    settleMs: 60000,
    manualSettleMs: 5000,
    retryMs: 30000,
    afterLaunchMs: 60000,
    lanPollMs: 15000,
    lanPolls: 20,
    followPollMs: 2000,
    followQuietMs: 6000,
    followAfterLaunchMs: 15000
};

function createRescue({ probe, lanHost, appInstalled, launch, reinstall, lastGoodKey, state, wait, log, bootId,
    timings = TIMINGS, now = () => Date.now() }) {
    const say = (message) => {
        try { log(message); } catch (e) {}
    };

    let running = false;

    async function waitForLan() {
        for (let poll = 0; poll <= timings.lanPolls; poll++) {
            const host = lanHost();
            if (host) return host;
            if (poll < timings.lanPolls) await wait(timings.lanPollMs);
        }

        return null;
    }

    async function answers(host) {
        const build = await probe(host);
        if (build) say(`tizen tap answers on ${host}:8091, build ${build}`);
        return !!build;
    }

    function healthy(current) {
        state.write({ ...current, failedReinstalls: 0, failedCopy: null, outcome: 'healthy' });
        return 'healthy';
    }

    async function check({ manual }) {
        const settle = manual ? timings.manualSettleMs : timings.settleMs;
        say(`${manual ? 'manual' : 'start'} check, boot ${bootId}; settling ${settle / 1000}s`);
        await wait(settle);

        const host = await waitForLan();

        // Without a LAN address the probe cannot reach Tizen Tap at all, and
        // silence would read as broken: reinstalling over a healthy app.
        if (!host) {
            say('no LAN IPv4 address, so Tizen Tap cannot be probed; doing nothing');
            return 'no-network';
        }

        const stored = state.read() || {};
        const current = stored.bootId === bootId ? stored : { ...stored, bootId, reinstalledThisBoot: false };

        if (await answers(host)) return healthy(current);

        say(`tizen tap silent; asking once more in ${timings.retryMs / 1000}s`);
        await wait(timings.retryMs);

        if (await answers(host)) return healthy(current);

        const installed = appInstalled(TIZEN_TAP_APP_ID);
        say(`${TIZEN_TAP_APP_ID} is ${installed ? 'installed' : 'not installed'}`);

        if (installed) {
            await launch(TIZEN_TAP_APP_ID);
            say(`launched ${TIZEN_TAP_APP_ID}; checking again in ${timings.afterLaunchMs / 1000}s`);
            await wait(timings.afterLaunchMs);

            if (await answers(host)) {
                healthy(current);
                return 'relaunched';
            }

            say('still silent after the launch');
        }

        const key = lastGoodKey();

        if (!key) {
            state.write({ ...current, outcome: 'no-last-good' });
            say('no last-good copy to reinstall; Tizen Tap needs a computer (npm run bootstrap)');
            return 'no-last-good';
        }

        if (current.reinstalledThisBoot) {
            state.write({ ...current, outcome: 'already-reinstalled' });
            say('already reinstalled once this boot; not again until the next one');
            return 'already-reinstalled';
        }

        const failed = current.failedCopy === key ? (current.failedReinstalls || 0) : 0;

        if (failed >= MAX_FAILED_REINSTALLS) {
            state.write({ ...current, outcome: 'gave-up' });
            say(`the last-good copy (${key}) failed to bring Tizen Tap back ${failed} times; giving up on it`);
            return 'gave-up';
        }

        const attempt = { ...current, reinstalledThisBoot: true, failedCopy: key, failedReinstalls: failed + 1, outcome: 'reinstalling' };
        state.write(attempt);
        say(`reinstalling the last-good copy (${key}), attempt ${failed + 1} of ${MAX_FAILED_REINSTALLS}`);

        try {
            await reinstall();
            say('reinstall finished');
        } catch (error) {
            state.write({ ...attempt, outcome: 'reinstall-failed' });
            say(`reinstall failed: ${error.code || 'error'}: ${error.message}`);
            return 'reinstall-failed';
        }

        await launch(TIZEN_TAP_APP_ID);
        say(`launched ${TIZEN_TAP_APP_ID}; checking again in ${timings.afterLaunchMs / 1000}s`);
        await wait(timings.afterLaunchMs);

        if (await answers(host)) {
            healthy(attempt);
            return 'reinstalled';
        }

        state.write({ ...attempt, outcome: 'reinstalled-still-silent' });
        say('reinstalled, but Tizen Tap is still silent');
        return 'reinstalled-still-silent';
    }

    // The old build answers until the install kills it; a launch while the package is still being
    // replaced is refused or killed again, so the rescue waits for a few quiet seconds and repeats
    // the launch until the new build answers.
    async function followRestart({ reason, until }) {
        const deadline = Date.parse(until);
        const host = await waitForLan();

        if (!host) {
            say(`no LAN IPv4 address, so the ${reason} cannot be followed`);
            return 'no-network';
        }

        say(`following tizen tap's ${reason}`);
        let quietSince: number | null = null;
        let launched = false;

        while (now() < deadline) {
            if (await probe(host)) {
                if (quietSince !== null) {
                    say(`tizen tap is back after its ${reason}`);
                    healthy({ ...(state.read() || {}), bootId });
                    return launched ? 'relaunched' : 'restarted';
                }
            } else {
                if (quietSince === null) quietSince = now();

                if (now() - quietSince >= timings.followQuietMs && appInstalled(TIZEN_TAP_APP_ID)) {
                    await launch(TIZEN_TAP_APP_ID);
                    launched = true;
                    await wait(timings.followAfterLaunchMs);
                    continue;
                }
            }

            await wait(timings.followPollMs);
        }

        if (quietSince === null) {
            say(`tizen tap never went quiet; its ${reason} did not happen`);
            return 'no-restart';
        }

        say(`tizen tap did not come back from its ${reason}; checking it the usual way`);
        return check({ manual: true });
    }

    // A second request while a check runs is dropped: two checks would launch twice.
    async function run(options: { manual?: boolean, follow?: { reason: string, until: string } } = { manual: false }) {
        if (running) {
            say('a check is already running');
            return 'busy';
        }

        running = true;

        try {
            const outcome = options.follow ? await followRestart(options.follow) : await check({ manual: !!options.manual });
            say(`outcome: ${outcome}`);
            return outcome;
        } catch (error) {
            say(`check stopped: ${error.message}`);
            return 'error';
        } finally {
            running = false;
        }
    }

    return { run };
}

const UNINSTALLED = (output) => output.indexOf('spend time') !== -1 || /uninstall failed/i.test(output);

// In place first. A refusal that is the installer's verdict (not sdbd
// dropping the connection) gets one uninstall and a fresh install, which is
// what clears a half-registered package.
async function installStaged(session, path, packageId, say) {
    say(`shell:0 vd_appinstall ${packageId} ${path} (in place)`);

    try {
        return await installer.run(session, path, packageId);
    } catch (error) {
        if (error.isSdbError) throw error;
        say(`in place refused (${error.code}: ${error.message}); uninstalling first`);
    }

    const uninstall = `shell:0 vd_appuninstall ${packageId}`;
    say(uninstall);
    await session.exec(uninstall, { timeout: 120000, until: UNINSTALLED });

    say(`shell:0 vd_appinstall ${packageId} ${path}`);
    return installer.run(session, path, packageId);
}

// The last-good copy goes to the one staging path vd_appinstall accepts, then
// installs over loopback sdb. Tizen Tap's configuration lives in
// /home/owner/share and survives an uninstall.
function createReinstall({ readArchive, stage = installer.stage, sdb, log }) {
    const say = (message) => {
        try { log(message); } catch (e) {}
    };

    return async function reinstall() {
        const archive = readArchive();
        const identity = identify(archive);

        if (identity.packageId !== SELF_PACKAGE_ID) {
            throw Object.assign(new Error(`the last-good copy is ${identity.packageId}, not ${SELF_PACKAGE_ID}`), { code: 'badPackage' });
        }

        const path = stage(archive, { isWgt: true });
        say(`staged ${archive.length} bytes to ${path}`);

        try {
            await sdb.withSession({ log: say }, (session) => installStaged(session, path, SELF_PACKAGE_ID, say));
        } finally {
            // sdbd serves one session; Tizen Tap's own start needs it to arm root.
            sdb.release();
        }
    };
}

module.exports = { createRescue, createReinstall, installStaged, MAX_FAILED_REINSTALLS, TIMINGS };

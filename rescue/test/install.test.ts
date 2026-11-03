// The rescue install route takes the .wgt as the request body. A POST with no
// body used to fall straight into identify(), which read a 0-byte "archive"
// and reported "No config.xml or tizen-manifest.xml" — a message that pointed
// at a broken package when the real problem was an empty upload. That is the
// difference between "your wgt is corrupt" and "you forgot the body"; the two
// need different fixes, so the empty case gets its own message.

'use strict';

const { test, expect } = require('bun:test');
const { createInstall } = require('../src/server.ts');

// createInstall only uses its dependencies past the empty-body check, so a
// minimal set of no-ops is enough to reach the guard and assert on it.
function install() {
    return createInstall({
        readConfig: () => ({}),
        resign: (archive) => archive,
        stage: async () => ({ path: '/tmp/stage', bytes: 1 }),
        sdb: { exec: async () => ({}) },
        launch: async () => {},
        log: () => {}
    });
}

test('an empty upload body is a clear error, not a badPackage mystery', async () => {
    const run = install();
    await expect(run(Buffer.alloc(0), 'manual')).rejects.toMatchObject({
        code: 'badPackage',
        message: expect.stringContaining('No package body received')
    });
});

test('a missing upload body is the same clear error', async () => {
    const run = install();
    await expect(run(undefined, 'manual')).rejects.toMatchObject({
        code: 'badPackage',
        message: expect.stringContaining('No package body received')
    });
});

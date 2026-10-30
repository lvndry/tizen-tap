// The catch-all that serves the phone and TV pages from the bundled UI build.
//
// The widget ships the UI alongside the service, so a browser pointed at the
// television gets the pages with no other host involved. The one danger is
// that the path comes from a stranger, so it is normalised and confined to
// the UI directory before it touches the filesystem.

'use strict';

const { readFileSync, existsSync } = require('fs');
const { join, extname, normalize } = require('path');
const { failure, bytes } = require('../http/respond.ts');
const { ErrorCode } = require('../protocol.ts');

const TYPES = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.png': 'image/png'
};

function TEXTUAL(type) {
    return type.startsWith('text/') || type.endsWith('javascript');
}

// The bundle puts the UI in a couple of places depending on how it was
// flattened, so the first directory that exists wins.
function findUiRoot() {
    return [
    // Bundled widget: __dirname is service/dist, UI is at <root>/ui/dist.
    join(__dirname, '..', '..', 'ui', 'dist'),
    // Development harness: __dirname is service/src, UI is at <root>/ui.
    join(__dirname, '..', '..', 'ui')
].find(existsSync) || null;
}

function register(ctx, router) {
    const { svc } = ctx;
    const uiRoot = findUiRoot();

    if (uiRoot) {
        svc.info(`serving the phone UI from ${uiRoot}`);
    } else {
        svc.err('no UI assets in this build — the phone will get a 500 and nothing else');
    }

    router.on.get('/*', (request, response, { path }) => {
        if (!uiRoot) return failure(response, 500, ErrorCode.INTERNAL, 'UI assets are missing from this build.');

        const requested = path === '/' ? '/index.html' : path;
        const file = join(uiRoot, normalize(requested));

        // Confirms the collapsed path is still inside the UI directory — this would serve any file on the TV.
        if (!file.startsWith(uiRoot) || !existsSync(file)) {
            return failure(response, 404, ErrorCode.NOT_FOUND, `No such file: ${requested}`);
        }

        const type = TYPES[extname(file)] || 'application/octet-stream';

        bytes(response, readFileSync(file), TEXTUAL(type) ? `${type}; charset=utf-8` : type);
    });
}

module.exports = { register };

// The service entry point for the Stremio server on Tizen.
//
// The bundled server.js is a single self-contained webpack bundle with zero
// native dependencies, but it reads its data directory from APP_PATH, crashes
// if that directory does not exist yet, and binds its first free port from
// 11470 upward. This shim sets up the Tizen environment before requiring the
// bundle so the server behaves the same on the TV as on a desktop:
//
//   - APP_PATH is forced to /home/owner/.stremio-server (created up front)
//   - a lean server-settings.json is written if none exists: a 512MB torrent
//     cache (the television's user partition is 3.85GB total) and software
//     transcoding (the desktop default, videotoolbox, is Apple-only)
//   - listen() is patched so the primary port is always 11470, the port a
//     Stremio client on the LAN expects, instead of first-free-from-11470
//   - every boot stage appends a line to /home/owner/.stremio-server-boot.log,
//     so a silent crash is diagnosable from the homebrew service, which can
//     read /home/owner
//
// Everything else — the HTTP API, the addon proxy, the WebTorrent engine — is
// the unmodified desktop bundle.

'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');

const PORT = 11470;

const crashLog = '/home/owner/.stremio-server-boot.log';

const note = (msg) => {
    try {
        fs.appendFileSync(crashLog, '[' + new Date().toISOString() + '] ' + msg + '\n');
    } catch (e) {
        // the log must never kill the boot
    }
};

note('start pid=' + process.pid);

let dataPath = '/home/owner/.stremio-server';

try {
    fs.mkdirSync(dataPath, { recursive: true });
} catch (e) {
    // fall back to the app's own writable sandbox if /home/owner refuses
    note('home/owner not writable: ' + (e && e.message));
    dataPath = path.join(os.tmpdir(), 'stremio-server');
    fs.mkdirSync(dataPath, { recursive: true });
}

process.env.APP_PATH = dataPath;

note('data path ready: ' + dataPath);

// A fresh server-settings.json tuned for a 3.85GB television. The keys match
// what the desktop server writes; on a missing file it logs "Cannot update
// settings ENOENT" but still starts with built-in defaults, which is why we
// create it here with the cache limited before the bundle runs.
const settingsFile = path.join(dataPath, 'server-settings.json');

if (!fs.existsSync(settingsFile)) {
    const settings = {
        serverVersion: '4.22.4',
        appPath: dataPath,
        cacheRoot: dataPath,
        cacheRootVersion: 0,
        cacheRootsToClean: [],
        cacheSize: 536870912,
        btMaxConnections: 55,
        btHandshakeTimeout: 20000,
        btRequestTimeout: 4000,
        btDownloadSpeedSoftLimit: 2621440,
        btDownloadSpeedHardLimit: 3670016,
        btMinPeersForStable: 5,
        remoteHttps: '',
        localAddonEnabled: false,
        transcodeHorsepower: 0.75,
        transcodeMaxBitRate: 0,
        transcodeConcurrency: 1,
        transcodeTrackConcurrency: 1,
        transcodeHardwareAccel: false,
        transcodeProfile: null,
        allTranscodeProfiles: [],
        transcodeMaxWidth: 1920,
        proxyStreamsEnabled: false
    };

    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 4));
    note('settings written');
}

// The bundle listens on 11470 and retries 11471, 11472... until one is free.
// On the television 11470 is the port clients expect, so force it back if the
// bundle drifts to a higher port on a previous (partial) start.
const originalListen = net.Server.prototype.listen;

net.Server.prototype.listen = function (arg0, arg1, arg2, arg3) {
    if (typeof arg0 === 'number' && arg0 !== PORT) {
        return originalListen.call(this, PORT, arg1, arg2, arg3);
    }

    return originalListen.call(this, arg0, arg1, arg2, arg3);
};

note('requiring the bundle');

try {
    require('./src/server.js');
} catch (e) {
    note('bundle threw: ' + (e && e.stack ? e.stack : e));
    throw e;
}

note('bundle loaded');

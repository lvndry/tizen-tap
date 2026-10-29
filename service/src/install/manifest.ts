'use strict';

const { inflateRawSync } = require('zlib');

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_DIRECTORY = 0x06054b50;

function inflated(compression, data) {
    // 0 is stored, 8 is deflate; a .wgt uses no other method.
    return compression === 0 ? data : inflateRawSync(data);
}

// The end record sits in the last 22 bytes plus an optional comment of up to 64KB.
function endOfDirectory(archive) {
    const earliest = Math.max(0, archive.length - 22 - 0xffff);

    for (let at = archive.length - 22; at >= earliest; at--) {
        if (archive.readUInt32LE(at) === END_OF_DIRECTORY) return at;
    }

    return -1;
}

// Zips written with data descriptors leave the local header's sizes at zero, so only the central
// directory knows where an entry ends.
function readFromDirectory(archive, wanted) {
    const end = endOfDirectory(archive);
    if (end === -1) return undefined;

    const entries = archive.readUInt16LE(end + 10);
    let cursor = archive.readUInt32LE(end + 16);

    for (let entry = 0; entry < entries; entry++) {
        if (cursor + 46 > archive.length || archive.readUInt32LE(cursor) !== CENTRAL_HEADER) return undefined;

        const compression = archive.readUInt16LE(cursor + 10);
        const compressedSize = archive.readUInt32LE(cursor + 20);
        const nameLength = archive.readUInt16LE(cursor + 28);
        const extraLength = archive.readUInt16LE(cursor + 30);
        const commentLength = archive.readUInt16LE(cursor + 32);
        const localAt = archive.readUInt32LE(cursor + 42);
        const name = archive.slice(cursor + 46, cursor + 46 + nameLength).toString('utf8');

        if (name === wanted) {
            if (localAt + 30 > archive.length || archive.readUInt32LE(localAt) !== LOCAL_HEADER) return undefined;

            // The local extra field can differ in length from the central one.
            const dataAt = localAt + 30 + archive.readUInt16LE(localAt + 26) + archive.readUInt16LE(localAt + 28);

            return inflated(compression, archive.slice(dataAt, dataAt + compressedSize));
        }

        cursor += 46 + nameLength + extraLength + commentLength;
    }

    return null;
}

// Read without unzipping and without an XML parser: xml2js cost 99KB to extract two attributes.
// A whole archive is read through its central directory; the head of one (a preview reads only
// the first megabytes) falls back to walking the local headers from the front.
function readFromZip(archive, wanted) {
    const found = readFromDirectory(archive, wanted);
    if (found !== undefined) return found;

    let cursor = 0;

    while (cursor + 30 <= archive.length) {
        if (archive.readUInt32LE(cursor) !== LOCAL_HEADER) break;

        const compression = archive.readUInt16LE(cursor + 8);
        const compressedSize = archive.readUInt32LE(cursor + 18);
        const nameLength = archive.readUInt16LE(cursor + 26);
        const extraLength = archive.readUInt16LE(cursor + 28);

        const nameAt = cursor + 30;
        const name = archive.slice(nameAt, nameAt + nameLength).toString('utf8');
        const dataAt = nameAt + nameLength + extraLength;

        if (name === wanted) return inflated(compression, archive.slice(dataAt, dataAt + compressedSize));

        cursor = dataAt + compressedSize;
    }

    return null;
}

function identify(archive) {
    function attribute(xml, tag, key) {
        const element = new RegExp(`<${tag}\\b[^>]*>`).exec(xml);
        if (!element) return null;
        const found = new RegExp(`\\b${key}="([^"]*)"`).exec(element[0]);
        return found ? found[1] : null;
    }

    const widget = readFromZip(archive, 'config.xml');

    if (widget) {
        const xml = widget.toString('utf8');
        const packageId = attribute(xml, 'tizen:application', 'package');

        if (!packageId) throw badPackage('config.xml declares no package id.');

        const named = /<name\b[^>]*>([^<]*)<\/name>/.exec(xml);

        return {
            packageId,
            appId: attribute(xml, 'tizen:application', 'id'),
            name: named ? named[1].trim() : null,
            version: attribute(xml, 'widget', 'version'),
            iconPath: attribute(xml, 'icon', 'src'),
            isWgt: true
        };
    }

    const native = readFromZip(archive, 'tizen-manifest.xml');

    if (native) {
        const xml = native.toString('utf8');
        const packageId = attribute(xml, 'manifest', 'package');

        if (!packageId) throw badPackage('tizen-manifest.xml declares no package id.');

        const icon = /<icon\b[^>]*>([^<]*)<\/icon>/.exec(xml);

        return {
            packageId,
            appId: attribute(xml, 'ui-application', 'appid'),
            name: null,
            version: attribute(xml, 'manifest', 'version'),
            iconPath: icon ? icon[1].trim() : null,
            isWgt: false
        };
    }

    throw badPackage('No config.xml or tizen-manifest.xml — this is not a Tizen package.');
}

function badPackage(message) {
    return Object.assign(new Error(message), { code: 'badPackage' });
}

module.exports = { identify, readFromZip };

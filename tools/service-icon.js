'use strict';

// Renders service-icon.png from icon.png: the same mark in a muted slate palette with a gear
// badge, so the background service is told apart from the app in the TV's app grid.
// Run: npm run service-icon

const { readFileSync, writeFileSync } = require('fs');
const { join } = require('path');
const zlib = require('zlib');

const ui = require('./ui.js');
const { ROOT } = require('./config.js');

const SOURCE = join(ROOT, 'icon.png');
const OUTPUT = join(ROOT, 'service-icon.png');

const SOURCE_PALETTE = {
    background: [14, 18, 32],
    letter: [239, 231, 214],
    accent: [242, 222, 107]
};

const SERVICE_PALETTE = {
    background: [46, 54, 70],
    letter: [148, 155, 170],
    accent: [242, 222, 107]
};

const BADGE = {
    centerX: 400,
    centerY: 400,
    ringRadius: 96,
    toothRadius: 80,
    rootRadius: 62,
    holeRadius: 26,
    teeth: 8,
    toothShare: 0.5,
    ringColor: SOURCE_PALETTE.background,
    gearColor: SERVICE_PALETTE.accent
};

const SUPERSAMPLE = 4;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readChunks(buffer) {
    if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('icon.png is not a PNG');
    const chunks = [];
    let offset = 8;
    while (offset < buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString('latin1', offset + 4, offset + 8);
        chunks.push({ type, data: buffer.subarray(offset + 8, offset + 8 + length) });
        offset += 12 + length;
    }
    return chunks;
}

function paeth(left, above, upperLeft) {
    const estimate = left + above - upperLeft;
    const toLeft = Math.abs(estimate - left);
    const toAbove = Math.abs(estimate - above);
    const toUpperLeft = Math.abs(estimate - upperLeft);
    if (toLeft <= toAbove && toLeft <= toUpperLeft) return left;
    if (toAbove <= toUpperLeft) return above;
    return upperLeft;
}

function decode(buffer) {
    const chunks = readChunks(buffer);
    const header = chunks.find((chunk) => chunk.type === 'IHDR').data;
    const width = header.readUInt32BE(0);
    const height = header.readUInt32BE(4);
    const bitDepth = header[8];
    const colorType = header[9];
    const interlace = header[12];
    const channelsByType = { 2: 3, 6: 4 };
    const channels = channelsByType[colorType];
    if (bitDepth !== 8 || !channels || interlace !== 0) {
        throw new Error('icon.png must be 8-bit RGB or RGBA, not interlaced');
    }

    const compressed = Buffer.concat(chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data));
    const filtered = zlib.inflateSync(compressed);
    const stride = width * channels;
    const raw = Buffer.alloc(stride * height);

    for (let row = 0; row < height; row++) {
        const filter = filtered[row * (stride + 1)];
        const input = row * (stride + 1) + 1;
        const output = row * stride;
        for (let column = 0; column < stride; column++) {
            const value = filtered[input + column];
            const left = column >= channels ? raw[output + column - channels] : 0;
            const above = row > 0 ? raw[output - stride + column] : 0;
            const upperLeft = row > 0 && column >= channels ? raw[output - stride + column - channels] : 0;
            let predicted = 0;
            if (filter === 1) predicted = left;
            else if (filter === 2) predicted = above;
            else if (filter === 3) predicted = (left + above) >> 1;
            else if (filter === 4) predicted = paeth(left, above, upperLeft);
            raw[output + column] = (value + predicted) & 0xff;
        }
    }

    const rgb = Buffer.alloc(width * height * 3);
    for (let pixel = 0; pixel < width * height; pixel++) {
        raw.copy(rgb, pixel * 3, pixel * channels, pixel * channels + 3);
    }
    return { width, height, rgb };
}

const CRC_TABLE = Array.from({ length: 256 }, (unused, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
});

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
}

function encode({ width, height, rgb }) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 2;
    const stride = width * 3;
    const filtered = Buffer.alloc((stride + 1) * height);
    for (let row = 0; row < height; row++) {
        rgb.copy(filtered, row * (stride + 1) + 1, row * stride, (row + 1) * stride);
    }
    return Buffer.concat([
        PNG_SIGNATURE,
        chunk('IHDR', header),
        chunk('IDAT', zlib.deflateSync(filtered, { level: 9 })),
        chunk('IEND', Buffer.alloc(0))
    ]);
}

function mix(from, to, amount) {
    return from.map((channel, index) => channel + (to[index] - channel) * amount);
}

// Every source pixel is a blend of two palette colours (anti-aliased edges included), so it is
// projected onto each pair, and the closest pair's blend is replayed in the service palette.
function recolor(pixel) {
    const pairs = [['background', 'letter'], ['background', 'accent'], ['letter', 'accent']];
    let best = null;
    pairs.forEach(([fromName, toName]) => {
        const from = SOURCE_PALETTE[fromName];
        const to = SOURCE_PALETTE[toName];
        const direction = to.map((channel, index) => channel - from[index]);
        const offset = pixel.map((channel, index) => channel - from[index]);
        const lengthSquared = direction.reduce((sum, channel) => sum + channel * channel, 0);
        const projection = offset.reduce((sum, channel, index) => sum + channel * direction[index], 0);
        const amount = Math.min(1, Math.max(0, projection / lengthSquared));
        const residual = offset.reduce((sum, channel, index) => sum + (channel - direction[index] * amount) ** 2, 0);
        if (!best || residual < best.residual) best = { fromName, toName, amount, residual };
    });
    return mix(SERVICE_PALETTE[best.fromName], SERVICE_PALETTE[best.toName], best.amount);
}

function badgeLayer(pointX, pointY) {
    const distance = Math.hypot(pointX - BADGE.centerX, pointY - BADGE.centerY);
    if (distance > BADGE.ringRadius) return null;
    if (distance < BADGE.holeRadius) return BADGE.ringColor;
    if (distance < BADGE.rootRadius) return BADGE.gearColor;
    if (distance < BADGE.toothRadius) {
        const angle = Math.atan2(pointY - BADGE.centerY, pointX - BADGE.centerX);
        const turn = ((angle / (2 * Math.PI)) * BADGE.teeth % 1 + 1) % 1;
        if (turn < BADGE.toothShare) return BADGE.gearColor;
    }
    return BADGE.ringColor;
}

function drawBadge(image) {
    const reach = BADGE.ringRadius + 1;
    for (let row = Math.floor(BADGE.centerY - reach); row <= BADGE.centerY + reach; row++) {
        for (let column = Math.floor(BADGE.centerX - reach); column <= BADGE.centerX + reach; column++) {
            if (row < 0 || column < 0 || row >= image.height || column >= image.width) continue;
            const offset = (row * image.width + column) * 3;
            const base = [image.rgb[offset], image.rgb[offset + 1], image.rgb[offset + 2]];
            const total = [0, 0, 0];
            for (let sampleRow = 0; sampleRow < SUPERSAMPLE; sampleRow++) {
                for (let sampleColumn = 0; sampleColumn < SUPERSAMPLE; sampleColumn++) {
                    const color = badgeLayer(
                        column + (sampleColumn + 0.5) / SUPERSAMPLE,
                        row + (sampleRow + 0.5) / SUPERSAMPLE
                    ) || base;
                    color.forEach((channel, index) => { total[index] += channel; });
                }
            }
            total.forEach((channel, index) => {
                image.rgb[offset + index] = Math.round(channel / (SUPERSAMPLE * SUPERSAMPLE));
            });
        }
    }
}

function render() {
    const image = decode(readFileSync(SOURCE));
    for (let pixel = 0; pixel < image.width * image.height; pixel++) {
        const offset = pixel * 3;
        const color = recolor([image.rgb[offset], image.rgb[offset + 1], image.rgb[offset + 2]]);
        color.forEach((channel, index) => { image.rgb[offset + index] = Math.round(channel); });
    }
    drawBadge(image);
    writeFileSync(OUTPUT, encode(image));
    return image;
}

ui.heading('service icon');
const started = Date.now();
const image = render();
ui.ok('service-icon.png', `${image.width}x${image.height} from icon.png`, Date.now() - started);

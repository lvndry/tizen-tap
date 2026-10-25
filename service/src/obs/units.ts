const KILO = 1000;
const UNITS = ['B', 'kB', 'MB', 'GB'];

// Sizes are decimal, like a Content-Length. Durations change unit at one second, so two compare by eye.
function size(count: number | string) {
    const value = Number(count) || 0;

    if (value < KILO) return `${Math.round(value)} B`;

    let scaled = value;
    let unit = 0;

    while (scaled >= KILO && unit < UNITS.length - 1) {
        scaled /= KILO;
        unit += 1;
    }

    return `${scaled.toFixed(scaled < 10 ? 2 : 1)} ${UNITS[unit]}`;
}

function took(milliseconds: number) {
    const value = Math.max(0, Number(milliseconds) || 0);

    return value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(2)}s`;
}

function rate(bytes: number, milliseconds: number) {
    return (milliseconds > 0
    ? `${size((Number(bytes) || 0) / (milliseconds / 1000))}/s`
    : 'instantly');
}

function host(address: string | null | undefined) {
    const text = String(address || '');

    if (text.indexOf('::ffff:') === 0) return text.slice(7);
    if (text === '::1') return '127.0.0.1';

    return text || 'unknown';
}

module.exports = { size, took, rate, host };

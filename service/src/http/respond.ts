'use strict';

const MAX_BODY = 200 * 1024 * 1024;

// CORS is open because the phone UI is a separate origin.
function json(response, value, status = 200, headers = {}) {
    const payload = JSON.stringify(value);

    response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
        'access-control-allow-origin': '*',
        'access-control-expose-headers': 'Retry-After',
        ...headers
    });
    response.end(payload);
}

function failure(response, status, code, message, remedy?) {
    return json(response, remedy
        ? { ok: false, code, message, remedy }
        : { ok: false, code, message }, status);
}

// A refusal the caller can wait out: the header for HTTP clients, the field for anyone reading the body.
function retryLater(response, status, value) {
    return json(response, { ok: false, ...value }, status, { 'retry-after': String(value.retryAfterSeconds) });
}

// What a failed authorise() verdict becomes on the wire: 429 when the address is locked out, else 403.
function denied(response, verdict) {
    if (verdict.retryAfterSeconds) {
        return retryLater(response, 429, { code: verdict.code, message: verdict.message, retryAfterSeconds: verdict.retryAfterSeconds });
    }
    return failure(response, 403, verdict.code, verdict.message);
}

function bytes(response, buffer, contentType) {
    response.writeHead(200, {
        'content-type': contentType,
        'content-length': buffer.length,
        'access-control-allow-origin': '*'
    });
    response.end(buffer);
}

// The cap matters: this accepts uploaded packages, and without one a request could exhaust the TV.
function readBody(request, limit = MAX_BODY) {
    return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;

    function stop(message) {
        request.destroy();
        reject(new Error(message));
    }

    request.on('data', (chunk) => {
        received += chunk.length;
        if (received > limit) return stop(`Body exceeded ${limit} bytes`);
        chunks.push(chunk);
    });

    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', (error) => reject(error));
});
}

module.exports = { json, failure, retryLater, denied, bytes, readBody };

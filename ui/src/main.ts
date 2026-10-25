import './_stage/phone.css';

import { createStore } from './core/store.ts';
import { readPackage } from './core/package.ts';
import { connect, upload } from './core/socket.ts';
import { remembered, remember, forget, DIGITS } from './core/pairing.ts';
import { mount, delegate } from './core/view.ts';
import { theme } from './scene/theme.ts';
import { masthead, pairing, status, tabs, panel, outcome } from './views/screens.ts';

const Send = {
    hello: 'hello',
    state: 'getState',
    catalog: 'getCatalog',
    checkUpdates: 'checkUpdates',
    install: 'install',
    listDir: 'listDir',
    setRelay: 'setRelay',
    relayExec: 'relayExec'
};

// Titles only: what to do about a failure arrives with it as `remedy`. A code with no entry here renders as a
// bare "Failed."
const EXPLANATIONS = {
    unauthorized: 'Enter the PIN shown on the TV first.',
    lockedOut: 'Too many incorrect PINs.',
    debugModeOff: 'Developer Mode is off on this TV.',
    sdbUnreachable: 'This TV cannot reach its own sdb daemon.',
    sdbRefused: 'This TV refused the connection to its own sdb daemon.',
    sdbTimeout: 'The TV stopped answering partway through.',
    debugIpWrong: 'The TV’s developer host IP is not 127.0.0.1.',
    notFound: 'Not found.',
    downloadFailed: 'The download failed.',
    badPackage: 'That file is not a valid Tizen package.',
    certsMissing: 'This TV needs a Samsung certificate first.',
    resignFailed: 'Re-signing failed.',
    badMessage: 'That request was refused.',
    relayDisabled: 'The command relay is off.',
    internal: 'Something went wrong.',

    installFailed: 'The TV rejected the install.',
    certRejected: 'The TV rejected the certificate; it has been cleared.',
    authorMismatch: 'A different build of this app is already installed.',
    certChainInvalid: 'That package is signed for a device this is not.',
    securityError: 'The TV refused the package before reading it.',
    privilegeTooHigh: 'That app asks for more than this TV will grant.'
};

const known = remembered();

const store = createStore({
    connection: 'connecting…',
    paired: false,
    pin: known,
    pinError: null,

    // `pending` tells a refusal apart from the greeting, which arrive as the same frame; `restoring` decides
    // how the refusal is worded.
    pending: '',
    restoring: known !== null && known.length === DIGITS,

    device: null,
    catalog: [],
    catalogStale: false,

    checking: null,

    tab: 'catalog',
    github: '',
    url: '',
    usb: [] as any[],
    usbPath: '/media',

    file: null,
    reading: false,
    uploading: null,

    identity: null,

    relayEnabled: false,
    relayBusy: false,
    relayOutput: '',

    phase: null,
    phaseDetail: null,
    done: null,
    error: null,

    themeOn: false
});
const channel = theme({
    defaultOn: false,
    onState: ({ playing }) => store.update({ themeOn: playing })
});

const { send } = connect({
    url: null,
    // A connection that is not up cannot be pairing, or a phone that cannot reach its TV sits on "offering the
    // code" with no field to type into.
    onStatus: (connection) => store.update(
        connection === 'connected' ? { connection } : { connection, pending: '', restoring: false }
    ),

    onMessage: (type, payload) => {
        const reactions = {
            hello: () => {
                const { pin, pending, restoring } = store.get();

                if (payload.ok) {
                    remember(pin);
                    return { paired: true, pending: '', restoring: false, pinError: null };
                }

                // Nothing pending means this is the greeting rather than a refusal, and the greeting is the
                // moment to offer a code this phone already has. A reconnection lands here too.
                if (!pending) {
                    if (!pin || pin.length !== DIGITS) return null;

                    send(Send.hello, { pin });
                    return { pending: pin, restoring: pin === remembered() };
                }

                // Wrong, or merely old. Dropped rather than retried: the socket reconnects every second and a
                // half and would spend all five attempts.
                forget();

                // Emptied here as well as in the store: a second identical refusal renders identical markup,
                // so the repaint that would otherwise clear the field never runs.
                const field = document.getElementById('pin');
                if (field) (field as HTMLInputElement).value = '';

                return {
                    paired: false,
                    pending: '',
                    pin: '',
                    restoring: false,
                    pinError: restoring
                        ? 'The TV has restarted, so its PIN has changed.'
                        : 'That PIN did not match.'
                };
            },

            state: () => ({ device: payload }),

            catalog: () => ({ catalog: payload.entries || [], catalogStale: !!payload.stale, checking: null }),

            dir: () => ({ usb: payload }),

            relayState: () => ({ relayEnabled: !!payload.enabled }),

            relayData: () => ({ relayOutput: store.get().relayOutput + payload.chunk }),

            relayEnd: () => ({
                relayBusy: false,
                relayOutput: `${store.get().relayOutput}${payload.truncated ? '\n[output truncated]' : ''}\n`
            }),

            progress: () => ({
                phase: payload.phase,
                phaseDetail: payload.detail,
                // Sent once, with the re-signing phase; every other progress message leaves what was found in
                // place.
                identity: payload.identity || store.get().identity,
                error: null,
                done: null
            }),

            done: () => ({ phase: null, phaseDetail: null, done: payload, error: null }),

            error: () => {
                // Before pairing the PIN field is all there is, so a lockout — reported as an error rather
                // than a refused hello — is said there or nowhere.
                if (!store.get().paired) {
                    return {
                        pending: '',
                        restoring: false,
                        pinError: payload.message || EXPLANATIONS[payload.code] || 'Refused.'
                    };
                }

                return {
                    phase: null,
                    relayBusy: false,
                    uploading: null,
                    checking: null,
                    error: {
                        title: EXPLANATIONS[payload.code] || 'Failed.',
                        detail: payload.message || '',
                        remedy: payload.remedy || null
                    }
                };
            }
        };

        const reaction = reactions[type];
        const changes = reaction && reaction();

        if (changes) store.update(changes);

        if (type === 'hello' && payload.ok) {
            send(Send.catalog, {});
            send(Send.state, {});
        }
    }
});

function value(id) {
    const element = document.getElementById(id);
    return element ? (element as HTMLInputElement).value.trim() : '';
}

function beginInstall(source, reference) {
    // The identity goes with it, or one app's icon sits above another app's progress bar.
    store.update({ error: null, done: null, phase: 'probing', identity: null });
    send(Send.install, { source, ref: reference });
}

// Read now rather than after the upload, because the value of it is seeing what this is before spending a
// minute of wifi on it.
async function chooseFile(file) {
    store.update({ file, identity: null, reading: Boolean(file), error: null, done: null });

    if (!file) return;

    const app = await readPackage(file);

    // Somebody may have chosen a different file while this one was being read.
    if (store.get().file !== file) return;

    store.update({ identity: app, reading: false });
}

delegate({
    pin: (element) => {
        const digits = element.value.replace(/\D/g, '').slice(0, DIGITS);
        element.value = digits;
        const complete = digits.length === DIGITS;

        // A refusal is left on screen until the next one answers it: clearing it here would change the
        // markup around this field, and the repaint takes the field, the keystroke and the focus with it.
        store.update({ pin: digits, restoring: false, pending: complete ? digits : '' });

        if (complete) send(Send.hello, { pin: digits });
    },

    'catalog:refresh': () => send(Send.catalog, { refresh: true }),

    checkAll: () => {
        if (store.get().checking) return;
        store.update({ checking: 'all' });
        send(Send.checkUpdates, {});
    },

    check: (_element, id) => {
        if (store.get().checking) return;
        store.update({ checking: id });
        send(Send.checkUpdates, { id });
    },

    'install:github': () => value('gh') && beginInstall('github', value('gh')),
    'install:url': () => value('url') && beginInstall('url', value('url')),

    file: (element) => chooseFile(element.files[0] || null),

    upload: async () => {
        const { file, pin } = store.get();
        if (!file) return;

        store.update({ uploading: 0, error: null, done: null });

        try {
            const result = await upload({
                file,
                pin,
                onProgress: (percent) => store.update({ uploading: percent })
            });

            store.update({ uploading: null, done: result, file: null });
        } catch (failure) {
            store.update({
                uploading: null,
                error: {
                    title: EXPLANATIONS[failure.code] || 'Install failed.',
                    detail: failure.message,
                    remedy: failure.remedy || null
                }
            });
        }
    },

    'relay:toggle': (element) => send(Send.setRelay, { enabled: element.checked }),

    tab: (_element, name) => {
        store.update({ tab: name });
        if (name === 'usb') send(Send.listDir, { path: store.get().usbPath });
    },

    // `install:github:owner/repo` — the source and its reference, in the name.
    install: (_element, argument) => {
        const separator = argument.indexOf(':');
        beginInstall(argument.slice(0, separator), argument.slice(separator + 1));
    },

    usb: (_element, path) => {
        const entry = store.get().usb.find((candidate) => candidate.path === path);
        if (!entry) return;

        if (!entry.isDirectory) return beginInstall('file', entry.path);

        store.update({ usbPath: entry.path });
        send(Send.listDir, { path: entry.path });
    },

    'relay:run': () => {
        const command = value('cmd');
        if (!command) return;

        store.update({ relayBusy: true, relayOutput: `${store.get().relayOutput}$ ${command}\n` });
        send(Send.relayExec, { id: String(Date.now()), command });

        (document.getElementById('cmd') as HTMLInputElement).value = '';
    },

    theme: () => channel.toggle()
});

['dragover', 'drop'].forEach((name) => document.addEventListener(name, (event) => {
    event.preventDefault();
    if (name === 'drop') {
        const transfer = (event as DragEvent).dataTransfer;
        if (!transfer || !transfer.files.length) return;
        store.update({ tab: 'upload' });
        chooseFile(transfer.files[0]);
    }
}));

mount(store, {
    masthead,
    status: (state) => (state.paired ? status(state) : pairing(state)),
    tabs: (state) => (state.paired ? tabs(state) : { __markup: '' }),
    panel: (state) => (state.paired ? panel(state) : { __markup: '' }),
    outcome: (state) => (state.paired ? outcome(state) : { __markup: '' })
});

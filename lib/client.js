import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
import chalk from 'chalk';
import qrcode from 'qrcode-terminal';
import { getAuthDir } from './utils.js';

const logger = pino({ level: 'silent' }); // Silent to keep CLI clean
let shuttingDown = false;

export function markShuttingDown() {
    shuttingDown = true;
}

// Suppress libsignal session logs
const originalConsoleInfo = console.info;
console.info = function (...args) {
    const message = args.join(' ');
    if (message.includes('Closing session') ||
        message.includes('Opening session') ||
        message.includes('Migrating session') ||
        message.includes('Removing old closed session')) {
        return;
    }
    originalConsoleInfo.apply(console, args);
};

const originalConsoleWarn = console.warn;
console.warn = function (...args) {
    const message = args.join(' ');
    if (message.includes('Decrypted message with closed session') ||
        message.includes('Closing open session in favor of incoming prekey bundle') ||
        message.includes('Session already closed') ||
        message.includes('Session already open')) {
        return;
    }
    originalConsoleWarn.apply(console, args);
};

const originalConsoleError = console.error;
console.error = function (...args) {
    const message = args.map(a => (a && a.stack) ? a.stack : String(a)).join(' ');
    if (message.includes('Failed to decrypt message with any known session') ||
        message.includes('Session error:') ||
        message.includes('Bad MAC')) {
        return;
    }
    originalConsoleError.apply(console, args);
};

export async function connectToWhatsApp(onUpdate, options = {}) {
    const authDir = getAuthDir(options.account);
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger,
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: true,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        if (shuttingDown) return;
        const { connection, lastDisconnect, qr } = update;

        if (onUpdate) {
            onUpdate(update, sock);
        }

        if (qr && !options.suppressQr) {
            console.log(chalk.cyan('Scan this QR code to login:'));
            qrcode.generate(qr, { small: true });
        }
        
        if (connection === 'close' && !shuttingDown) {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                connectToWhatsApp(onUpdate, options);
            } else {
                console.log(chalk.red('Connection closed. You are logged out.'));
            }
        }
    });

    return sock;
}

export async function createConnectedSocket(options = {}) {
    let activeSock = null;
    await new Promise((resolve, reject) => {
        connectToWhatsApp((update, sock) => {
            activeSock = sock;
            if (update.connection === 'open') {
                resolve(sock);
            }
        }, options).then(sock => {
            if (!activeSock) activeSock = sock;
            if (sock.ws?.isOpen) resolve(sock);
        }).catch(reject);
    });
    return activeSock;
}

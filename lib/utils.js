import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import chalk from 'chalk';
import { jidNormalizedUser } from '@whiskeysockets/baileys';

export const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let currentAccount = 'default';

export function setAccountName(name) {
    if (name && typeof name === 'string') {
        currentAccount = name.trim();
    }
}

export function getAccountName() {
    return currentAccount;
}

export function getBaseDir() {
    return path.join(os.homedir(), '.wasonar');
}

export function getSessionsDir() {
    return path.join(getBaseDir(), 'sessions');
}

export function getAuthDir(account = currentAccount) {
    const sessionDir = path.join(getSessionsDir(), account);
    // Backward compatibility: if default session doesn't exist yet but local auth_info_baileys exists, migrate it
    const legacyDir = path.resolve('auth_info_baileys');
    if (account === 'default' && !fs.existsSync(sessionDir) && fs.existsSync(legacyDir)) {
        try {
            fs.mkdirSync(path.dirname(sessionDir), { recursive: true });
            fs.cpSync(legacyDir, sessionDir, { recursive: true });
        } catch {
            return legacyDir;
        }
    }
    return sessionDir;
}

export function listAccounts() {
    const dir = getSessionsDir();
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(name => {
        const full = path.join(dir, name);
        return fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, 'creds.json'));
    });
}

export function checkAuth(account = currentAccount) {
    const authPath = getAuthDir(account);
    if (!fs.existsSync(authPath) || !fs.existsSync(path.join(authPath, 'creds.json'))) {
        console.error(chalk.red(`Error: NOT AUTHENTICATED (account: "${account}").`));
        console.error(chalk.yellow(`Please run \`wasonar-cli login${account !== 'default' ? ` --account ${account}` : ''}\` first.`));
        process.exit(1);
    }
}

export function cleanPhoneNumber(input) {
    return String(input).replace(/[^\d]/g, '');
}

export async function resolveTargetJid(sock, rawNumber) {
    const cleaned = cleanPhoneNumber(rawNumber);
    const rawJid = jidNormalizedUser(`${cleaned}@s.whatsapp.net`);
    try {
        const [exists] = await sock.onWhatsApp(rawJid);
        if (exists && exists.exists) {
            return {
                exists: true,
                number: cleaned,
                jid: exists.jid,
                lid: exists.lid || null
            };
        }
        return {
            exists: false,
            number: cleaned,
            jid: rawJid,
            lid: null
        };
    } catch {
        return {
            exists: true,
            number: cleaned,
            jid: rawJid,
            lid: null
        };
    }
}

export function sendDesktopNotification(title, body) {
    if (process.platform === 'linux') {
        execFile('notify-send', ['-a', 'WaSonar', title, body], () => {});
    }
}

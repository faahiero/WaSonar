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
    return path.join(getSessionsDir(), account);
}

export function removeAccountSession(account = currentAccount) {
    const sessionDir = getAuthDir(account);
    if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
    if (account === 'default') {
        const legacyDir = path.resolve('auth_info_baileys');
        if (fs.existsSync(legacyDir)) {
            try {
                fs.rmSync(legacyDir, { recursive: true, force: true });
            } catch {}
        }
    }
}

export function hasAuth(account = currentAccount) {
    const authPath = getAuthDir(account);
    return fs.existsSync(authPath) && fs.existsSync(path.join(authPath, 'creds.json'));
}

export function listAccounts() {
    const dir = getSessionsDir();
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(name => {
        const full = path.join(dir, name);
        return fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, 'creds.json'));
    });
}

export function getAccountsSummary() {
    const saved = listAccounts();
    const active = getAccountName();
    return saved.map(acc => {
        const credsPath = path.join(getAuthDir(acc), 'creds.json');
        let meId = null;
        let meName = null;
        try {
            const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
            meId = creds?.me?.id || null;
            meName = creds?.me?.name || null;
        } catch {}
        return {
            name: acc,
            active: acc === active,
            meId,
            meName
        };
    });
}

export function checkAuth(account = currentAccount) {
    if (!hasAuth(account)) {
        console.error(chalk.red(`Error: NOT AUTHENTICATED (account: "${account}").`));
        console.error(chalk.yellow(`Please run \`wasonar-cli login${account !== 'default' ? ` --account ${account}` : ''}\` first.`));
        process.exit(1);
    }
}

export function cleanPhoneNumber(input) {
    const digits = String(input).replace(/[^\d]/g, '');
    // If user typed a 10 or 11 digit Brazilian number without country code (e.g. 88998044968), prepend 55
    if (digits.length === 10 || digits.length === 11) {
        return `55${digits}`;
    }
    return digits;
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

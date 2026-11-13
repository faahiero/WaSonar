import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import ora from 'ora';
import { connectToWhatsApp } from '../lib/client.js';
import { getAccountName, getAuthDir, listAccounts, cleanPhoneNumber } from '../lib/utils.js';

export async function login(options = {}) {
    const account = getAccountName();
    const authDir = getAuthDir(account);
    console.log(chalk.blue(`Initialize WhatsApp Session (account: ${chalk.bold(account)})`));
    console.log(chalk.dim(`Session path: ${authDir}`));

    const phone = options.phone ? cleanPhoneNumber(options.phone) : null;

    try {
        const spinner = ora('Connecting to WhatsApp...').start();
        let pairingCodeRequested = false;

        await new Promise((resolve, reject) => {
            connectToWhatsApp(async (update, sock) => {
                const { connection, qr } = update;

                if (qr) {
                    spinner.stop();
                    if (phone && !pairingCodeRequested) {
                        pairingCodeRequested = true;
                        try {
                            const code = await sock.requestPairingCode(phone);
                            const formatted = code?.match(/.{1,4}/g)?.join('-') || code;
                            console.log(chalk.cyan('\nEnter this Pairing Code on your phone (Linked Devices -> Link with phone number):'));
                            console.log(chalk.bgCyan.black.bold(`  ${formatted}  \n`));
                        } catch (err) {
                            console.error(chalk.red('Failed to request pairing code:'), err.message);
                        }
                    }
                }

                if (connection === 'open') {
                    spinner.succeed(`Connected to WhatsApp (account: ${account})`);
                    console.log(chalk.green('Session saved. You can now use other commands from any directory.'));
                    resolve();
                }

                if (connection === 'close') {
                    if (!spinner.isSpinning) spinner.start('Reconnecting...');
                }
            }, {
                account,
                suppressQr: Boolean(phone)
            }).catch(reject);
        });

        process.exit(0);
    } catch (error) {
        console.error(chalk.red('Login failed:'), error);
        process.exit(1);
    }
}

export async function logout() {
    const account = getAccountName();
    const authDir = getAuthDir(account);
    if (!fs.existsSync(authDir)) {
        console.log(chalk.yellow(`No saved session found for account "${account}".`));
        process.exit(0);
    }
    fs.rmSync(authDir, { recursive: true, force: true });
    console.log(chalk.green(`✔ Session removed for account "${account}" (${authDir}).`));
    process.exit(0);
}

export async function accounts() {
    const saved = listAccounts();
    const active = getAccountName();
    console.log(chalk.white.bold('\nSaved WhatsApp Sessions (~/.wasonar/sessions)'));
    console.log(chalk.dim('─'.repeat(50)));
    if (saved.length === 0) {
        console.log(chalk.yellow('  No authenticated accounts found. Run `wasonar-cli login`.'));
    } else {
        for (const acc of saved) {
            const credsPath = path.join(getAuthDir(acc), 'creds.json');
            let meId = 'Unknown';
            let meName = '';
            try {
                const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
                meId = creds?.me?.id || 'Unknown';
                meName = creds?.me?.name ? ` (${creds.me.name})` : '';
            } catch {}
            const marker = acc === active ? chalk.green('●') : chalk.gray('○');
            console.log(`  ${marker} ${chalk.cyan.bold(acc.padEnd(14))} ${chalk.white(meId)}${chalk.dim(meName)}`);
        }
    }
    console.log('');
    process.exit(0);
}

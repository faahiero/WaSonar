import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import ora from 'ora';
import { createConnectedSocket } from '../lib/client.js';
import { checkAuth, resolveTargetJid } from '../lib/utils.js';
import { discoverDevices, sendProbe, formatStateBadge } from '../lib/probe.js';

export async function devices(number, options) {
    checkAuth();
    console.log(chalk.blue(`Getting devices for: ${number}`));

    try {
        const connectSpinner = ora('Connecting to WhatsApp...').start();
        const sock = await createConnectedSocket();
        connectSpinner.succeed('Connected to WhatsApp');

        const deviceSpinner = ora('Querying device list...').start();
        const resolved = await resolveTargetJid(sock, number);
        if (!resolved.exists) {
            deviceSpinner.fail(`Number ${number} is not registered on WhatsApp.`);
            process.exit(1);
        }

        const deviceList = await discoverDevices(sock, resolved.jid);
        deviceSpinner.succeed(`Found ${deviceList.length} linked device(s) for ${resolved.jid}`);

        if (options.online && deviceList.length > 0) {
            const onlineSpinner = ora('Checking online status & activity state...').start();
            const probeResults = await Promise.all(
                deviceList.map(d => sendProbe(sock, d.probeJid))
            );

            deviceList.forEach((d, i) => {
                d.online = probeResults[i].clientRtt !== null;
                d.rtt = probeResults[i].clientRtt;
                d.serverRtt = probeResults[i].serverRtt;
                d.state = probeResults[i].state;
            });

            onlineSpinner.succeed('Online check complete');
        }

        console.log('');
        deviceList.forEach((d, i) => {
            const type = d.isMain ? 'Main Device (Phone)' : 'Companion Device (Web/Desktop)';
            let statusStr = '';
            if (options.online) {
                const rttText = d.online ? chalk.cyan(` ${d.rtt}ms`) : '';
                statusStr = ` ${formatStateBadge(d.state)}${rttText}`;
            }
            console.log(`Device ${i + 1} [${type}]${statusStr}`);
            console.log(chalk.dim(`   JID:       ${d.jid}`));
            console.log(chalk.dim(`   Probe JID: ${d.probeJid}`));
            console.log(chalk.dim(`   ID:        ${d.deviceId}\n`));
        });

        if (options.output) {
            if (!fs.existsSync(options.output)) fs.mkdirSync(options.output, { recursive: true });
            const filePath = path.join(options.output, `devices-${number}.json`);
            fs.writeFileSync(filePath, JSON.stringify(deviceList, null, 2));
            console.log(chalk.cyan(`Results saved to: ${filePath}`));
        }

        sock.end();
        process.exit(0);
    } catch (error) {
        console.error(chalk.red('Error fetching devices:'), error);
        process.exit(1);
    }
}

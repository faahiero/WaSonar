import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import ora from 'ora';
import { createConnectedSocket } from '../lib/client.js';
import { checkAuth, sleep, resolveTargetJid, sendDesktopNotification } from '../lib/utils.js';
import { discoverDevices, sendProbe, formatStateBadge, renderRttBar } from '../lib/probe.js';

export async function watch(numbers, options) {
    checkAuth();
    if (!Array.isArray(numbers) || numbers.length < 2) {
        console.error(chalk.red('Please provide at least 2 phone numbers to watch and correlate.'));
        console.error(chalk.yellow('Example: wasonar-cli watch 5588998044968 558591913737'));
        process.exit(1);
    }

    const maxProbes = parseInt(options.probes, 10) || 0;
    const intervalMs = parseInt(options.interval, 10) || 1500;
    const infinite = maxProbes === 0;

    console.log(chalk.blue.bold(`\nMulti-Target Activity Watch & Correlation (${numbers.length} targets)`));
    console.log(chalk.dim('─'.repeat(78)));

    try {
        const connectSpinner = ora('Connecting to WhatsApp...').start();
        const sock = await createConnectedSocket();
        connectSpinner.succeed('Connected to WhatsApp');

        const targets = [];
        for (const num of numbers) {
            const sp = ora(`Resolving ${num}...`).start();
            const resolved = await resolveTargetJid(sock, num);
            if (!resolved.exists) {
                sp.fail(`Target ${num} is not registered on WhatsApp`);
                continue;
            }
            const devices = await discoverDevices(sock, resolved.jid);
            sp.succeed(`Target ${num} (${resolved.jid}) -> ${devices.length} device(s)`);
            targets.push({
                inputNumber: num,
                jid: resolved.jid,
                devices,
                activeHistory: [], // boolean per cycle (true if any device is ACTIVE)
                onlineHistory: []  // boolean per cycle (true if any device is ONLINE)
            });
        }

        if (targets.length < 2) {
            console.error(chalk.red('Need at least 2 valid WhatsApp numbers to run correlation watch.'));
            sock.end();
            process.exit(1);
        }

        console.log(chalk.dim('─'.repeat(78)));
        let probeCount = 0;
        let running = true;
        const historyLog = [];

        process.on('SIGINT', () => {
            running = false;
            console.log(chalk.yellow('\nStopping multi-target watch...'));
        });

        while (running && (infinite || probeCount < maxProbes)) {
            probeCount++;
            const nowStr = new Date().toLocaleTimeString('pt-BR', { hour12: false });
            console.log(chalk.cyan.bold(`\n[Cycle #${probeCount} @ ${nowStr}]`));

            const spinner = ora({ text: 'Probing all targets in parallel...', spinner: 'dots' }).start();

            const cycleResults = await Promise.all(
                targets.map(async (target) => {
                    const devResults = await Promise.all(
                        target.devices.map(d =>
                            sendProbe(sock, d.probeJid).then(res => ({
                                ...res,
                                label: d.label,
                                deviceId: d.deviceId
                            }))
                        )
                    );
                    const anyActive = devResults.some(r => r.state === 'ACTIVE');
                    const anyOnline = devResults.some(r => r.state !== 'OFFLINE' && r.state !== 'ERROR');
                    target.activeHistory.push(anyActive);
                    target.onlineHistory.push(anyOnline);
                    return {
                        target: target.inputNumber,
                        jid: target.jid,
                        anyActive,
                        anyOnline,
                        devices: devResults
                    };
                })
            );

            spinner.stop();

            // Display each target's devices
            for (const tRes of cycleResults) {
                const devSummaries = tRes.devices.map(d => {
                    const rttStr = d.clientRtt !== null ? `${d.clientRtt}ms` : '-';
                    return `${chalk.white(d.label)}: ${formatStateBadge(d.state)} ${chalk.cyan(rttStr.padEnd(6))} ${renderRttBar(d.clientRtt, 6)}`;
                }).join('  |  ');
                console.log(`  ${chalk.yellow.bold(tRes.target.padEnd(15))} -> ${devSummaries}`);
            }

            // Compute pairwise activity correlation between targets[0] and targets[1]
            const tA = targets[0];
            const tB = targets[1];
            let bothActiveCount = 0;
            let eitherActiveCount = 0;
            for (let i = 0; i < probeCount; i++) {
                const a = tA.activeHistory[i];
                const b = tB.activeHistory[i];
                if (a && b) bothActiveCount++;
                if (a || b) eitherActiveCount++;
            }

            const jaccardActivePct = eitherActiveCount > 0
                ? Math.round((bothActiveCount / eitherActiveCount) * 100)
                : 0;
            const bothActiveNow = cycleResults[0].anyActive && cycleResults[1].anyActive;

            if (bothActiveNow) {
                console.log(
                    chalk.bgMagenta.white.bold(' ⚡ SIMULTANEOUS ACTIVE ') +
                    ` Both ${tA.inputNumber} & ${tB.inputNumber} have active screens/radios right now! ` +
                    chalk.dim(`(Co-activity score: ${jaccardActivePct}%)`)
                );
                if (options.notify) {
                    sendDesktopNotification(
                        'WaSonar Co-Activity Detected',
                        `${tA.inputNumber} and ${tB.inputNumber} are simultaneously ACTIVE!`
                    );
                }
            } else {
                console.log(
                    chalk.dim(`  Co-activity correlation (${tA.inputNumber} ↔ ${tB.inputNumber}): `) +
                    chalk.magenta(`${jaccardActivePct}%`) +
                    chalk.dim(` (${bothActiveCount}/${eitherActiveCount} active windows overlap)`)
                );
            }

            historyLog.push({
                cycle: probeCount,
                timestamp: Date.now(),
                bothActiveNow,
                coActivityScorePct: jaccardActivePct,
                targets: cycleResults
            });

            if (options.output) {
                if (!fs.existsSync(options.output)) fs.mkdirSync(options.output, { recursive: true });
                const outFile = path.join(options.output, `watch-correlation.json`);
                fs.writeFileSync(outFile, JSON.stringify(historyLog, null, 2));
            }

            if (running && (infinite || probeCount < maxProbes)) {
                await sleep(intervalMs);
            }
        }

        sock.end();
        process.exit(0);
    } catch (error) {
        console.error(chalk.red('Error in watch command:'), error);
        process.exit(1);
    }
}

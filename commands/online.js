import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import ora from 'ora';
import { createConnectedSocket } from '../lib/client.js';
import { checkAuth, sleep, resolveTargetJid, sendDesktopNotification } from '../lib/utils.js';
import { discoverDevices, sendProbe, formatStateBadge, renderRttBar, computeRttStats } from '../lib/probe.js';

export async function online(number, options) {
    checkAuth();
    console.log(chalk.blue(`Checking online status & activity telemetry for: ${number}`));

    const maxProbes = parseInt(options.probes, 10) || 0;
    const intervalMs = parseInt(options.interval, 10) || 1000;
    const infinite = maxProbes === 0;

    console.log(
        chalk.yellow(`Mode: ${infinite ? 'Infinite Probes (Ctrl+C to stop)' : `${maxProbes} Probe(s)`}`) +
        chalk.dim(` | Interval: ${intervalMs}ms | Desktop Alerts: ${options.notify ? 'ON' : 'OFF'}`)
    );

    try {
        const connectSpinner = ora('Connecting to WhatsApp...').start();
        const sock = await createConnectedSocket();
        connectSpinner.succeed('Connected to WhatsApp');

        const deviceSpinner = ora('Fetching linked devices...').start();
        const resolved = await resolveTargetJid(sock, number);
        if (!resolved.exists) {
            deviceSpinner.fail(`Number ${number} is not registered on WhatsApp.`);
            process.exit(1);
        }

        const devices = await discoverDevices(sock, resolved.jid);
        if (devices.length === 0) {
            deviceSpinner.fail('No devices found for this number.');
            process.exit(1);
        }

        deviceSpinner.succeed(`Found ${devices.length} device(s) for ${resolved.jid}`);
        console.log(chalk.dim('─'.repeat(78)));

        let probeCount = 0;
        let running = true;
        const allResults = [];
        const rttHistoryByDevice = new Map();
        const lastStateByDevice = new Map();

        devices.forEach(d => {
            rttHistoryByDevice.set(d.label, []);
            lastStateByDevice.set(d.label, null);
        });

        process.on('SIGINT', () => {
            running = false;
            console.log(chalk.yellow('\nStopping monitor...'));
        });

        while (running && (infinite || probeCount < maxProbes)) {
            probeCount++;
            const nowStr = new Date().toLocaleTimeString('pt-BR', { hour12: false });
            console.log(chalk.cyan(`\n[Probe #${probeCount} @ ${nowStr}]`));

            const spinner = ora({ text: 'Probing all devices...', spinner: 'dots' }).start();

            const probePromises = devices.map(device =>
                sendProbe(sock, device.probeJid).then(result => ({
                    ...result,
                    target: number,
                    jid: device.jid,
                    device: device.label,
                    deviceId: device.deviceId
                }))
            );

            const results = await Promise.all(probePromises);
            spinner.stop();

            for (const result of results) {
                const history = rttHistoryByDevice.get(result.device) || [];
                history.push(result.clientRtt);
                rttHistoryByDevice.set(result.device, history);

                const stats = computeRttStats(history, probeCount);
                const prevState = lastStateByDevice.get(result.device);

                // Desktop notification on state transition
                if (options.notify && prevState !== null && prevState !== result.state) {
                    if (prevState === 'OFFLINE' && result.state !== 'OFFLINE') {
                        sendDesktopNotification(
                            `WaSonar: ${number} Online`,
                            `${result.device} entrou ${result.state} (${result.clientRtt}ms)`
                        );
                    } else if (prevState !== 'OFFLINE' && result.state === 'OFFLINE') {
                        sendDesktopNotification(
                            `WaSonar: ${number} Offline`,
                            `${result.device} ficou OFFLINE`
                        );
                    }
                }
                lastStateByDevice.set(result.device, result.state);

                const labelCol = `  ${result.device.padEnd(14)}: `;
                if (result.error) {
                    console.log(`${labelCol}${formatStateBadge('ERROR')} ${chalk.red(result.error)}`);
                } else {
                    const badge = formatStateBadge(result.state);
                    const rttText = result.clientRtt !== null
                        ? chalk.white.bold(`${String(result.clientRtt).padStart(4)}ms`)
                        : chalk.gray('   -  ');
                    const bar = renderRttBar(result.clientRtt, 10);
                    const statsText = stats.avg !== null
                        ? chalk.dim(`avg:${stats.avg}ms min:${stats.min}ms max:${stats.max}ms jit:±${stats.jitter}ms up:${stats.uptimePct}%`)
                        : chalk.dim(`up:0%`);

                    console.log(`${labelCol}${badge} ${rttText} ${bar}  ${statsText}`);
                }

                allResults.push(result);
            }

            if (options.output) {
                saveResults(number, allResults, options.output);
            }

            if (running && (infinite || probeCount < maxProbes)) {
                await sleep(intervalMs);
            }
        }

        // Print final session summary
        console.log(chalk.dim('\n' + '═'.repeat(78)));
        console.log(chalk.white.bold(`Session Summary for ${number} (${probeCount} probes)`));
        console.log(chalk.dim('═'.repeat(78)));
        for (const device of devices) {
            const history = rttHistoryByDevice.get(device.label) || [];
            const s = computeRttStats(history, probeCount);
            if (s.avg !== null) {
                console.log(
                    `  ${chalk.cyan(device.label.padEnd(14))} -> ` +
                    `Uptime: ${chalk.green(`${s.uptimePct}%`)} (${s.onlineCount}/${s.totalProbes}) | ` +
                    `Avg: ${chalk.yellow(`${s.avg}ms`)} | Min: ${s.min}ms | Max: ${s.max}ms | Jitter: ±${s.jitter}ms`
                );
            } else {
                console.log(`  ${chalk.cyan(device.label.padEnd(14))} -> Uptime: ${chalk.gray('0% (Offline all probes)')}`);
            }
        }

        sock.end();
        process.exit(0);
    } catch (error) {
        console.error(chalk.red('Error in online check:'), error);
        process.exit(1);
    }
}

function saveResults(number, results, dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // Save JSON
    const jsonPath = path.join(dir, `online-rtt-${number}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));

    // Save CSV
    const csvPath = path.join(dir, `online-rtt-${number}.csv`);
    const header = 'iso_time,timestamp,target,device,device_id,state,client_rtt_ms,server_rtt_ms\n';
    const rows = results.map(r => [
        new Date(r.timestamp).toISOString(),
        r.timestamp,
        r.target,
        `"${r.device}"`,
        r.deviceId,
        r.state,
        r.clientRtt ?? '',
        r.serverRtt ?? ''
    ].join(',')).join('\n');
    fs.writeFileSync(csvPath, header + rows + '\n');
}

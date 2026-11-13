import http from 'http';
import https from 'https';
import fs from 'fs';
import { URL } from 'url';
import { createRequire } from 'module';
import chalk from 'chalk';
import ora from 'ora';
import { DisconnectReason } from '@whiskeysockets/baileys';
import { connectToWhatsApp, markShuttingDown, closeActiveConnection } from '../lib/client.js';
import {
    hasAuth,
    getAccountName,
    setAccountName,
    getAuthDir,
    removeAccountSession,
    getAccountsSummary,
    cleanPhoneNumber,
    resolveTargetJid,
    sendDesktopNotification
} from '../lib/utils.js';
import { discoverDevices, sendProbe, computeRttStats } from '../lib/probe.js';

const require = createRequire(import.meta.url);
const QRCode = require('qrcode-terminal/vendor/QRCode');
const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');

function generateQrSvg(qrText) {
    const qr = new QRCode(-1, QRErrorCorrectLevel.L);
    qr.addData(qrText);
    qr.make();
    const count = qr.getModuleCount();
    const margin = 2;
    const total = count + margin * 2;
    let paths = '';
    for (let r = 0; r < count; r++) {
        for (let c = 0; c < count; c++) {
            if (qr.isDark(r, c)) {
                paths += `M${c + margin},${r + margin}h1v1h-1z`;
            }
        }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="240" height="240" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#ffffff"/><path d="${paths}" fill="#000000"/></svg>`;
}

export async function web(options) {
    const port = parseInt(options.port, 10) || 3000;

    let server = null;
    let sock = null;
    const sseClients = new Set();
    let monitorTimer = null;
    let watchTimer = null;

    let authStatus = {
        account: getAccountName(),
        state: 'disconnected', // 'connected' | 'connecting' | 'qr' | 'pairing' | 'unauthenticated'
        qrSvg: null,
        pairingCode: null,
        me: null
    };

    let monitorState = {
        running: false,
        number: null,
        jid: null,
        intervalMs: 1500,
        notify: false,
        onlyDevice: null,
        probeCount: 0,
        devices: [],
        historyByDevice: {},
        lastStateByDevice: {},
        samples: []
    };

    let watchState = {
        running: false,
        numbers: [],
        intervalMs: 1500,
        notify: false,
        probeCount: 0,
        targets: [],
        samples: []
    };

    function broadcast(event, data) {
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        for (const res of sseClients) {
            try {
                res.write(payload);
            } catch {
                sseClients.delete(res);
            }
        }
    }

    function stopMonitoring() {
        if (monitorTimer) {
            clearTimeout(monitorTimer);
            monitorTimer = null;
        }
        monitorState.running = false;
        broadcast('status', { running: false, number: monitorState.number });
    }

    function stopWatch() {
        if (watchTimer) {
            clearTimeout(watchTimer);
            watchTimer = null;
        }
        watchState.running = false;
        broadcast('watch_status', { running: false });
    }

    const shutdown = () => {
        markShuttingDown();
        console.log(chalk.yellow('\n\n✔ Encerrando servidor WaSonar Web...'));
        stopMonitoring();
        stopWatch();
        for (const res of sseClients) {
            try { res.end(); } catch {}
        }
        if (server) {
            try { server.closeAllConnections?.(); server.close(); } catch {}
        }
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    async function initAccountSession(accountName, loginOpts = {}) {
        stopMonitoring();
        stopWatch();
        closeActiveConnection(sock);
        sock = null;
        setAccountName(accountName);
        authStatus = {
            account: accountName,
            state: 'connecting',
            qrSvg: null,
            pairingCode: null,
            me: null
        };
        broadcast('auth', { ...authStatus, accounts: getAccountsSummary() });

        const phone = loginOpts.phone ? cleanPhoneNumber(loginOpts.phone) : null;
        let pairingRequested = false;

        try {
            await connectToWhatsApp(async (update, activeSock) => {
                sock = activeSock;
                const { connection, lastDisconnect, qr } = update;

                if (qr) {
                    if (phone && !pairingRequested) {
                        pairingRequested = true;
                        try {
                            const code = await activeSock.requestPairingCode(phone);
                            const formatted = code?.match(/.{1,4}/g)?.join('-') || code;
                            authStatus.state = 'pairing';
                            authStatus.pairingCode = formatted;
                            authStatus.qrSvg = null;
                            broadcast('auth', { ...authStatus, accounts: getAccountsSummary() });
                        } catch (e) {
                            authStatus.state = 'unauthenticated';
                            broadcast('auth', { ...authStatus, error: e.message, accounts: getAccountsSummary() });
                        }
                    } else if (!phone) {
                        authStatus.state = 'qr';
                        authStatus.qrSvg = generateQrSvg(qr);
                        authStatus.pairingCode = null;
                        broadcast('auth', { ...authStatus, accounts: getAccountsSummary() });
                    }
                }

                if (connection === 'open') {
                    authStatus.state = 'connected';
                    authStatus.qrSvg = null;
                    authStatus.pairingCode = null;
                    authStatus.me = activeSock.user || null;
                    broadcast('auth', { ...authStatus, accounts: getAccountsSummary() });
                }

                if (connection === 'close') {
                    const statusCode = (lastDisconnect?.error)?.output?.statusCode;
                    if (statusCode === DisconnectReason.loggedOut) {
                        removeAccountSession(accountName);
                        authStatus.state = 'unauthenticated';
                        authStatus.qrSvg = null;
                        authStatus.pairingCode = null;
                        authStatus.me = null;
                        broadcast('auth', { ...authStatus, accounts: getAccountsSummary() });
                    } else {
                        authStatus.state = 'connecting';
                        authStatus.qrSvg = null;
                        authStatus.pairingCode = null;
                        broadcast('auth', { ...authStatus, accounts: getAccountsSummary() });
                    }
                }
            }, {
                account: accountName,
                suppressQr: true,
                quiet: true
            });
        } catch (err) {
            authStatus.state = 'unauthenticated';
            broadcast('auth', { ...authStatus, error: err.message, accounts: getAccountsSummary() });
        }
    }

    console.log(chalk.blue.bold('\nStarting WaSonar Web Intelligence Suite'));

    if (hasAuth(getAccountName())) {
        const connectSpinner = ora({ text: `Connecting to WhatsApp (account: ${getAccountName()})...`, discardStdin: false }).start();
        await initAccountSession(getAccountName());
        connectSpinner.succeed(`Session initialized (${getAccountName()})`);
    } else {
        authStatus.state = 'unauthenticated';
        console.log(chalk.yellow(`No saved session for "${getAccountName()}". Open the Web UI -> Accounts tab to login.`));
    }

    async function runProbeCycle() {
        if (!monitorState.running || !monitorState.devices.length || authStatus.state !== 'connected') return;
        monitorState.probeCount++;
        const cycleNum = monitorState.probeCount;

        const targetDevices = monitorState.onlyDevice && monitorState.onlyDevice !== 'ALL'
            ? monitorState.devices.filter(d => d.label === monitorState.onlyDevice)
            : monitorState.devices;

        const results = await Promise.all(
            targetDevices.map(async (d) => {
                const res = await sendProbe(sock, d.probeJid);
                const hist = monitorState.historyByDevice[d.label] || [];
                hist.push(res.clientRtt);
                monitorState.historyByDevice[d.label] = hist;
                const stats = computeRttStats(hist, hist.length);

                const prev = monitorState.lastStateByDevice[d.label];
                if (monitorState.notify && prev && prev !== res.state) {
                    if (prev === 'OFFLINE' && res.state !== 'OFFLINE') {
                        sendDesktopNotification(`WaSonar: ${monitorState.number} Online`, `${d.label} -> ${res.state} (${res.clientRtt}ms)`);
                    } else if (prev !== 'OFFLINE' && res.state === 'OFFLINE') {
                        sendDesktopNotification(`WaSonar: ${monitorState.number} Offline`, `${d.label} -> OFFLINE`);
                    }
                }
                monitorState.lastStateByDevice[d.label] = res.state;

                return {
                    ...res,
                    label: d.label,
                    deviceId: d.deviceId,
                    jid: d.jid,
                    stats
                };
            })
        );

        if (!monitorState.running) return;

        const entry = {
            cycle: cycleNum,
            timestamp: Date.now(),
            target: monitorState.number,
            devices: results
        };
        monitorState.samples.push(entry);
        if (monitorState.samples.length > 200) {
            monitorState.samples.shift();
        }
        broadcast('probe', entry);

        if (monitorState.running) {
            monitorTimer = setTimeout(runProbeCycle, monitorState.intervalMs);
        }
    }

    async function runWatchCycle() {
        if (!watchState.running || watchState.targets.length < 2 || authStatus.state !== 'connected') return;
        watchState.probeCount++;
        const cycleNum = watchState.probeCount;

        const cycleResults = await Promise.all(
            watchState.targets.map(async (target) => {
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
                const bestRtt = devResults
                    .map(r => r.clientRtt)
                    .filter(v => typeof v === 'number')
                    .sort((a, b) => a - b)[0] ?? null;

                target.activeHistory.push(anyActive);
                target.onlineHistory.push(anyOnline);
                return {
                    target: target.inputNumber,
                    jid: target.jid,
                    anyActive,
                    anyOnline,
                    bestRtt,
                    devices: devResults
                };
            })
        );

        if (!watchState.running) return;

        const tA = watchState.targets[0];
        const tB = watchState.targets[1];
        let bothActiveCount = 0;
        let eitherActiveCount = 0;
        for (let i = 0; i < cycleNum; i++) {
            const a = tA.activeHistory[i];
            const b = tB.activeHistory[i];
            if (a && b) bothActiveCount++;
            if (a || b) eitherActiveCount++;
        }
        const coActivityScorePct = eitherActiveCount > 0
            ? Math.round((bothActiveCount / eitherActiveCount) * 100)
            : 0;
        const bothActiveNow = cycleResults[0].anyActive && cycleResults[1].anyActive;

        if (bothActiveNow && watchState.notify) {
            sendDesktopNotification(
                'WaSonar Co-Activity Detected',
                `${tA.inputNumber} & ${tB.inputNumber} simultaneously ACTIVE (${coActivityScorePct}%)`
            );
        }

        const entry = {
            cycle: cycleNum,
            timestamp: Date.now(),
            bothActiveNow,
            coActivityScorePct,
            bothActiveCount,
            eitherActiveCount,
            targets: cycleResults
        };
        watchState.samples.push(entry);
        if (watchState.samples.length > 150) {
            watchState.samples.shift();
        }
        broadcast('watch_probe', entry);

        if (watchState.running) {
            watchTimer = setTimeout(runWatchCycle, watchState.intervalMs);
        }
    }

    server = http.createServer(async (req, res) => {
        const parsedUrl = new URL(req.url, `http://localhost:${port}`);
        const pathname = parsedUrl.pathname;

        // SSE stream
        if (pathname === '/api/events') {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
            });
            res.write(`event: init\ndata: ${JSON.stringify({
                monitor: monitorState,
                watch: watchState,
                auth: { ...authStatus, accounts: getAccountsSummary() }
            })}\n\n`);
            sseClients.add(res);
            req.on('close', () => sseClients.delete(res));
            return;
        }

        // Accounts API
        if (pathname === '/api/accounts' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                ...authStatus,
                accounts: getAccountsSummary()
            }));
            return;
        }

        if (pathname === '/api/accounts/switch' && req.method === 'POST') {
            const name = parsedUrl.searchParams.get('name') || 'default';
            await initAccountSession(name);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, account: name }));
            return;
        }

        if (pathname === '/api/accounts/login' && req.method === 'POST') {
            const name = parsedUrl.searchParams.get('name') || getAccountName() || 'default';
            const phone = parsedUrl.searchParams.get('phone') || '';
            await initAccountSession(name, { phone });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, account: name }));
            return;
        }

        if (pathname === '/api/accounts/logout' && req.method === 'POST') {
            const name = parsedUrl.searchParams.get('name') || getAccountName();
            if (name === getAccountName()) {
                stopMonitoring();
                stopWatch();
                closeActiveConnection(sock);
                sock = null;
                authStatus.state = 'unauthenticated';
                authStatus.me = null;
                authStatus.qrSvg = null;
                authStatus.pairingCode = null;
            }
            removeAccountSession(name);
            broadcast('auth', { ...authStatus, accounts: getAccountsSummary() });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, accounts: getAccountsSummary() }));
            return;
        }

        // OSINT Profile + Devices API
        if (pathname === '/api/profile') {
            if (authStatus.state !== 'connected' || !sock) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'WhatsApp session not connected. Go to Accounts tab.' }));
                return;
            }
            const number = parsedUrl.searchParams.get('number') || '';
            const checkOnline = parsedUrl.searchParams.get('online') === '1';
            try {
                const resolved = await resolveTargetJid(sock, number);
                if (!resolved.exists) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Number not registered on WhatsApp' }));
                    return;
                }
                const canonicalJid = resolved.jid;
                let status = null;
                let statusSetAt = null;
                try {
                    const st = await sock.fetchStatus(canonicalJid);
                    const entry = Array.isArray(st) ? st[0] : st;
                    status = entry?.status?.status ?? entry?.status ?? null;
                    const rawSetAt = entry?.status?.setAt ?? entry?.setAt ?? null;
                    if (rawSetAt instanceof Date && rawSetAt.getTime() > 0) {
                        statusSetAt = rawSetAt.toISOString();
                    } else if (typeof rawSetAt === 'number' && rawSetAt > 0) {
                        statusSetAt = new Date(rawSetAt * 1000).toISOString();
                    }
                } catch {}

                let profilePicUrl = null;
                let photoMeta = null;
                try {
                    profilePicUrl = await sock.profilePictureUrl(canonicalJid, 'image');
                    if (profilePicUrl) {
                        photoMeta = await getPhotoMetadata(profilePicUrl);
                    }
                } catch {}

                let businessProfile = null;
                try {
                    const biz = await sock.getBusinessProfile(canonicalJid);
                    if (biz && (biz.description || biz.category || biz.email || biz.website?.length || biz.address)) {
                        businessProfile = {
                            wid: biz.wid,
                            description: biz.description || null,
                            category: biz.category || null,
                            email: biz.email || null,
                            website: biz.website || [],
                            address: biz.address || null,
                            timezone: biz.business_hours?.timezone || null
                        };
                    }
                } catch {}

                const devices = await discoverDevices(sock, canonicalJid);

                if (checkOnline && devices.length > 0) {
                    const probeRes = await Promise.all(devices.map(d => sendProbe(sock, d.probeJid)));
                    devices.forEach((d, idx) => {
                        d.state = probeRes[idx].state;
                        d.rtt = probeRes[idx].clientRtt;
                    });
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    number: resolved.number,
                    jid: canonicalJid,
                    lid: resolved.lid,
                    status,
                    statusSetAt,
                    profilePicUrl,
                    photoLastModified: photoMeta?.lastModified || null,
                    photoSizeKB: photoMeta?.sizeKB || null,
                    businessProfile,
                    devices,
                    fetchedAt: new Date().toISOString()
                }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
            return;
        }

        // Single-target Live Probe start/stop/filter
        if (pathname === '/api/start' && req.method === 'POST') {
            if (authStatus.state !== 'connected' || !sock) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'WhatsApp session not connected' }));
                return;
            }
            const number = parsedUrl.searchParams.get('number') || '';
            const intervalMs = Math.max(500, parseInt(parsedUrl.searchParams.get('interval') || '1500', 10));
            const notify = parsedUrl.searchParams.get('notify') === '1';
            const onlyDevice = parsedUrl.searchParams.get('onlyDevice') || null;
            stopMonitoring();
            try {
                const resolved = await resolveTargetJid(sock, number);
                if (!resolved.exists) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Number not found on WhatsApp' }));
                    return;
                }
                const devices = await discoverDevices(sock, resolved.jid);
                monitorState = {
                    running: true,
                    number: resolved.number,
                    jid: resolved.jid,
                    intervalMs,
                    notify,
                    onlyDevice,
                    probeCount: 0,
                    devices,
                    historyByDevice: {},
                    lastStateByDevice: {},
                    samples: []
                };
                devices.forEach(d => {
                    monitorState.historyByDevice[d.label] = [];
                    monitorState.lastStateByDevice[d.label] = null;
                });
                broadcast('status', { running: true, number: resolved.number, jid: resolved.jid, devices });
                runProbeCycle();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, jid: resolved.jid, devices }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
            return;
        }

        if (pathname === '/api/filter' && req.method === 'POST') {
            monitorState.onlyDevice = parsedUrl.searchParams.get('onlyDevice') || null;
            monitorState.notify = parsedUrl.searchParams.get('notify') === '1';
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, onlyDevice: monitorState.onlyDevice, notify: monitorState.notify }));
            return;
        }

        if (pathname === '/api/stop' && req.method === 'POST') {
            stopMonitoring();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
        }

        // Multi-Target Watch start/stop
        if (pathname === '/api/watch/start' && req.method === 'POST') {
            if (authStatus.state !== 'connected' || !sock) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'WhatsApp session not connected' }));
                return;
            }
            const rawNums = (parsedUrl.searchParams.get('numbers') || '')
                .split(/[\s,;]+/)
                .map(s => s.trim())
                .filter(Boolean);
            const intervalMs = Math.max(800, parseInt(parsedUrl.searchParams.get('interval') || '1500', 10));
            const notify = parsedUrl.searchParams.get('notify') === '1';

            if (rawNums.length < 2) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Provide at least 2 phone numbers separated by comma or space' }));
                return;
            }

            stopWatch();
            try {
                const targets = [];
                for (const num of rawNums) {
                    const resolved = await resolveTargetJid(sock, num);
                    if (!resolved.exists) continue;
                    const devices = await discoverDevices(sock, resolved.jid);
                    targets.push({
                        inputNumber: resolved.number,
                        jid: resolved.jid,
                        devices,
                        activeHistory: [],
                        onlineHistory: []
                    });
                }
                if (targets.length < 2) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Need at least 2 valid WhatsApp numbers' }));
                    return;
                }
                watchState = {
                    running: true,
                    numbers: targets.map(t => t.inputNumber),
                    intervalMs,
                    notify,
                    probeCount: 0,
                    targets,
                    samples: []
                };
                broadcast('watch_status', { running: true, numbers: watchState.numbers });
                runWatchCycle();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, targets: watchState.numbers }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
            return;
        }

        if (pathname === '/api/watch/stop' && req.method === 'POST') {
            stopWatch();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
        }

        // Serve Dashboard HTML
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(DASHBOARD_HTML);
    });

    server.listen(port, () => {
        console.log(chalk.green.bold(`\n✔ Dashboard running at: http://localhost:${port}`));
        console.log(chalk.dim('Press Ctrl+C to stop the server immediately.\n'));
    });
}

function getPhotoMetadata(url) {
    return new Promise((resolve) => {
        https.get(url, (res) => {
            const lm = res.headers['last-modified'];
            const cl = res.headers['content-length'];
            res.destroy();
            resolve({
                lastModified: lm ? new Date(lm).toISOString() : null,
                sizeKB: cl ? Math.round((parseInt(cl, 10) / 1024) * 10) / 10 : null
            });
        }).on('error', () => resolve(null));
    });
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>WaSonar // Full Web Intelligence Suite</title>
<style>
  :root {
    --bg: #0b0f17;
    --panel: #131b2e;
    --border: #1f2b46;
    --text: #e2e8f0;
    --muted: #8b9bb4;
    --accent: #00f0ff;
    --green: #10b981;
    --yellow: #f59e0b;
    --red: #ef4444;
    --purple: #a855f7;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'Inter', system-ui, -apple-system, sans-serif;
    padding: 20px 26px;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--border);
    padding-bottom: 14px;
    margin-bottom: 20px;
    flex-wrap: wrap;
    gap: 14px;
  }
  .brand-wrap {
    display: flex;
    align-items: center;
    gap: 16px;
  }
  .brand {
    font-size: 20px;
    font-weight: 800;
    letter-spacing: 1px;
    color: var(--accent);
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .conn-pill {
    font-size: 12px;
    padding: 5px 12px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: rgba(255,255,255,0.03);
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
  }
  .status-dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--muted);
    display: inline-block;
  }
  .status-dot.connected { background: var(--green); box-shadow: 0 0 8px var(--green); }
  .status-dot.connecting { background: var(--yellow); }
  .status-dot.unauthenticated { background: var(--red); }
  .tabs {
    display: flex;
    gap: 8px;
  }
  .tab-btn {
    background: transparent;
    color: var(--muted);
    border: 1px solid var(--border);
    padding: 8px 16px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  .tab-btn.active {
    background: rgba(0, 240, 255, 0.14);
    color: var(--accent);
    border-color: var(--accent);
  }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }
  .toolbar {
    display: flex;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
    background: var(--panel);
    border: 1px solid var(--border);
    padding: 12px 16px;
    border-radius: 12px;
    margin-bottom: 18px;
  }
  input, select, button {
    background: #0d1424;
    color: var(--text);
    border: 1px solid var(--border);
    padding: 9px 13px;
    border-radius: 8px;
    font-size: 13px;
  }
  input { width: 220px; }
  button {
    cursor: pointer;
    font-weight: 600;
    transition: 0.15s;
  }
  button:hover { filter: brightness(1.12); }
  button.primary { background: var(--accent); color: #050811; border-color: var(--accent); }
  button.danger { background: var(--red); color: #fff; border-color: var(--red); }
  button.secondary { background: rgba(255,255,255,0.05); color: var(--text); }
  label.chk {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--muted);
    cursor: pointer;
    user-select: none;
  }
  label.chk input { width: auto; }
  .grid {
    display: grid;
    grid-template-columns: 350px 1fr;
    gap: 18px;
  }
  @media (max-width: 980px) {
    .grid { grid-template-columns: 1fr; }
  }
  .card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 18px;
  }
  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 14px;
    flex-wrap: wrap;
    gap: 10px;
  }
  .card h3 {
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--muted);
  }
  .filter-bar {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .filter-pill {
    padding: 5px 11px;
    border-radius: 20px;
    font-size: 12px;
    font-weight: 600;
    background: rgba(255,255,255,0.03);
    border: 1px solid var(--border);
    color: var(--muted);
    cursor: pointer;
  }
  .filter-pill.active {
    background: rgba(0, 240, 255, 0.15);
    border-color: var(--accent);
    color: var(--accent);
  }
  .avatar {
    width: 92px;
    height: 92px;
    border-radius: 50%;
    object-fit: cover;
    border: 2px solid var(--accent);
    margin-bottom: 12px;
    display: none;
  }
  .kv { margin-bottom: 7px; font-size: 13px; word-break: break-all; }
  .kv span { color: var(--muted); display: inline-block; width: 120px; }
  .section-sep {
    border-top: 1px solid var(--border);
    margin: 12px 0;
    padding-top: 10px;
  }
  .badge {
    display: inline-block;
    padding: 3px 8px;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 700;
  }
  .badge.ACTIVE { background: rgba(16, 185, 129, 0.2); color: var(--green); border: 1px solid var(--green); }
  .badge.STANDBY { background: rgba(245, 158, 11, 0.2); color: var(--yellow); border: 1px solid var(--yellow); }
  .badge.OFFLINE { background: rgba(139, 155, 180, 0.15); color: var(--muted); border: 1px solid var(--border); }
  .dev-cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 12px;
    margin-bottom: 16px;
  }
  .dev-card {
    background: rgba(255,255,255,0.02);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px;
    cursor: pointer;
    transition: 0.15s;
  }
  .dev-card.selected {
    border-color: var(--accent);
    background: rgba(0, 240, 255, 0.06);
    box-shadow: 0 0 0 1px var(--accent);
  }
  canvas {
    width: 100%;
    height: 250px;
    background: #090d14;
    border-radius: 8px;
    border: 1px solid var(--border);
  }
  table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 14px;
    font-size: 13px;
  }
  th, td {
    text-align: left;
    padding: 8px 10px;
    border-bottom: 1px solid var(--border);
  }
  th { color: var(--muted); font-weight: 600; }
  .co-banner {
    padding: 12px 16px;
    border-radius: 8px;
    margin-bottom: 14px;
    background: rgba(168, 85, 247, 0.15);
    border: 1px solid var(--purple);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .acc-list {
    display: grid;
    gap: 10px;
  }
  .acc-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 14px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: rgba(255,255,255,0.02);
  }
  .acc-item.active {
    border-color: var(--green);
    background: rgba(16, 185, 129, 0.06);
  }
  .pairing-box {
    font-size: 26px;
    font-weight: 800;
    letter-spacing: 3px;
    color: var(--accent);
    padding: 16px 24px;
    border: 1px dashed var(--accent);
    border-radius: 10px;
    display: inline-block;
    margin-top: 12px;
  }
</style>
</head>
<body>
  <header>
    <div class="brand-wrap">
      <div class="brand">WASONAR // WEB SUITE</div>
      <div class="conn-pill" onclick="switchTab('accounts')" title="Click to manage WhatsApp accounts">
        <span id="connDot" class="status-dot"></span>
        <span id="connLabel">Checking session...</span>
      </div>
    </div>
    <div class="tabs">
      <button id="tabBtn-probe" class="tab-btn active" onclick="switchTab('probe')">1. Live Probe & OSINT</button>
      <button id="tabBtn-watch" class="tab-btn" onclick="switchTab('watch')">2. Multi-Target Watch</button>
      <button id="tabBtn-accounts" class="tab-btn" onclick="switchTab('accounts')">3. Accounts & Login</button>
    </div>
  </header>

  <!-- TAB 1: LIVE PROBE & OSINT PROFILE -->
  <div id="tab-probe" class="tab-panel active">
    <div class="toolbar">
      <input id="numInput" type="text" placeholder="Target (e.g. 5588998044968)" />
      <select id="intervalInput">
        <option value="1000">1.0s interval</option>
        <option value="1500" selected>1.5s interval</option>
        <option value="3000">3.0s interval</option>
      </select>
      <button class="secondary" onclick="loadProfile(false)">Fetch OSINT Profile</button>
      <button class="secondary" onclick="loadProfile(true)">Check Devices Once</button>
      <button id="probeToggleBtn" class="primary" onclick="toggleSonar()">Start Live Probe</button>
      <label class="chk">
        <input id="notifyChk" type="checkbox" onchange="syncFilterOptions()" />
        Alerts (--notify)
      </label>
      <label class="chk" title="When checked, sends network probes ONLY to the currently selected device pill">
        <input id="probeOnlySelectedChk" type="checkbox" onchange="syncFilterOptions()" />
        Probe only filtered device
      </label>
      <div style="margin-left:auto;display:flex;gap:8px;">
        <button class="secondary" onclick="exportProbeData('json')">Export JSON</button>
        <button class="secondary" onclick="exportProbeData('csv')">Export CSV</button>
      </div>
    </div>

    <div class="grid">
      <div class="card">
        <div class="card-header">
          <h3>Target OSINT Profile</h3>
          <button id="saveProfileBtn" class="secondary" style="display:none;padding:4px 10px;font-size:11px;" onclick="downloadProfileJson()">Save JSON</button>
        </div>
        <img id="avatar" class="avatar" />
        <div id="profileDetails" style="color: var(--muted); font-size: 13px;">
          Enter a phone number above to inspect profile, photo metadata, business details & linked devices.
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <h3>Real-Time Device Status & RTT (ms)</h3>
          <div class="filter-bar" id="filterBar">
            <span style="font-size:12px;color:var(--muted);">View Device:</span>
            <button class="filter-pill active" onclick="setDeviceFilter('ALL')">Compare All</button>
          </div>
        </div>

        <div id="devCards" class="dev-cards"></div>
        <canvas id="rttChart" width="900" height="250"></canvas>

        <table>
          <thead id="logHead">
            <tr><th>Cycle</th><th>Time</th><th>Device</th><th>State</th><th>RTT</th><th>Avg / Min / Max / Jitter / Uptime</th></tr>
          </thead>
          <tbody id="logBody"></tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- TAB 2: MULTI-TARGET WATCH & CORRELATION -->
  <div id="tab-watch" class="tab-panel">
    <div class="toolbar">
      <input id="watchNumsInput" type="text" style="width:360px;" placeholder="2+ Numbers (e.g. 5588998044968, 558591913737)" />
      <select id="watchIntervalInput">
        <option value="1500" selected>1.5s interval</option>
        <option value="2500">2.5s interval</option>
        <option value="4000">4.0s interval</option>
      </select>
      <button id="watchToggleBtn" class="primary" onclick="toggleWatch()">Start Multi-Watch</button>
      <label class="chk">
        <input id="watchNotifyChk" type="checkbox" />
        Co-Activity Alerts
      </label>
      <button class="secondary" style="margin-left:auto;" onclick="exportWatchJson()">Export Watch JSON</button>
    </div>

    <div class="card">
      <div class="co-banner">
        <div>
          <strong style="color:var(--purple);">CO-ACTIVITY CORRELATION ENGINE</strong>
          <div id="watchBannerSub" style="font-size:12px;color:var(--muted);margin-top:3px;">
            Monitors multiple targets in parallel to detect simultaneous ACTIVE screen/radio states.
          </div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:11px;color:var(--muted);">OVERLAP SCORE</div>
          <div id="watchScoreVal" style="font-size:26px;font-weight:800;color:var(--accent);">0%</div>
        </div>
      </div>

      <div id="watchCards" class="dev-cards"></div>
      <canvas id="watchChart" width="1100" height="240"></canvas>

      <table>
        <thead id="watchHead">
          <tr><th>Cycle</th><th>Time</th><th>Co-Activity</th><th>Targets Status</th></tr>
        </thead>
        <tbody id="watchBody"></tbody>
      </table>
    </div>
  </div>

  <!-- TAB 3: ACCOUNTS & AUTHENTICATION -->
  <div id="tab-accounts" class="tab-panel">
    <div class="grid">
      <div class="card">
        <div class="card-header">
          <h3>Authenticate / Add Session</h3>
        </div>
        <div style="display:grid;gap:12px;">
          <div>
            <div style="font-size:12px;color:var(--muted);margin-bottom:5px;">Account Profile Name</div>
            <input id="accNameInput" type="text" style="width:100%;" value="default" placeholder="e.g. default, burner2" />
          </div>
          <div>
            <div style="font-size:12px;color:var(--muted);margin-bottom:5px;">Phone Number (Optional — for 8-digit Pairing Code instead of QR)</div>
            <input id="accPhoneInput" type="text" style="width:100%;" placeholder="Leave empty for QR Code, or enter 5588..." />
          </div>
          <button class="primary" onclick="startAccountLogin()">Connect / Generate QR or Pairing Code</button>
        </div>

        <div id="authInteractiveBox" style="margin-top:18px;text-align:center;"></div>
      </div>

      <div class="card">
        <div class="card-header">
          <h3>Saved Sessions (~/.wasonar/sessions)</h3>
          <button class="secondary" onclick="refreshAccounts()">Refresh</button>
        </div>
        <div id="accountsList" class="acc-list"></div>
      </div>
    </div>
  </div>

<script>
  const samples = [];
  const watchSamples = [];
  let lastProfileData = null;
  let knownDevices = [];
  let selectedDevice = null;
  let isProbeRunning = false;
  let isWatchRunning = false;
  const colors = ['#00f0ff', '#10b981', '#f59e0b', '#a855f7', '#ec4899'];

  function switchTab(tab) {
    for (const id of ['probe', 'watch', 'accounts']) {
      document.getElementById('tab-' + id).classList.toggle('active', id === tab);
      document.getElementById('tabBtn-' + id).classList.toggle('active', id === tab);
    }
  }

  function updateAuthUI(auth) {
    const dot = document.getElementById('connDot');
    const lbl = document.getElementById('connLabel');
    dot.className = 'status-dot ' + (auth.state || 'unauthenticated');
    if (auth.state === 'connected') {
      const meNum = auth.me?.id ? auth.me.id.split('@')[0] : '';
      lbl.textContent = auth.account + (meNum ? ' (' + meNum + ')' : ' (Connected)');
    } else if (auth.state === 'qr' || auth.state === 'pairing') {
      lbl.textContent = auth.account + ' (Awaiting Auth)';
    } else if (auth.state === 'connecting') {
      lbl.textContent = auth.account + ' (Connecting...)';
    } else {
      lbl.textContent = auth.account + ' (Not Authenticated)';
    }

    const box = document.getElementById('authInteractiveBox');
    if (auth.state === 'qr' && auth.qrSvg) {
      box.innerHTML = '<div style="font-size:13px;color:var(--accent);margin-bottom:10px;">Scan this QR Code in WhatsApp -> Linked Devices:</div>' +
        '<div style="background:#fff;padding:12px;border-radius:12px;display:inline-block;">' + auth.qrSvg + '</div>';
    } else if (auth.state === 'pairing' && auth.pairingCode) {
      box.innerHTML = '<div style="font-size:13px;color:var(--muted);">Enter this 8-digit code on your phone:</div>' +
        '<div class="pairing-box">' + auth.pairingCode + '</div>';
    } else if (auth.state === 'connected') {
      box.innerHTML = '<div style="color:var(--green);font-weight:600;padding:12px;">✔ Authenticated and connected (' + auth.account + ')</div>';
    } else if (auth.error) {
      box.innerHTML = '<div style="color:var(--red);padding:12px;">' + auth.error + '</div>';
    } else {
      box.innerHTML = '';
    }

    if (Array.isArray(auth.accounts)) {
      renderAccountsList(auth.accounts);
    }
  }

  function renderAccountsList(accounts) {
    const list = document.getElementById('accountsList');
    if (!accounts.length) {
      list.innerHTML = '<div style="color:var(--muted);font-size:13px;">No saved sessions found. Use the form on the left to authenticate.</div>';
      return;
    }
    list.innerHTML = accounts.map(acc => {
      const activeBadge = acc.active
        ? '<span class="badge ACTIVE">ACTIVE</span>'
        : '<button class="secondary" onclick="switchAccount(\\'' + acc.name + '\\')">Use Account</button>';
      return '<div class="acc-item ' + (acc.active ? 'active' : '') + '">' +
        '<div>' +
          '<div style="font-weight:700;font-size:14px;">' + acc.name + '</div>' +
          '<div style="font-size:12px;color:var(--muted);">' + (acc.meId || 'Unknown JID') + (acc.meName ? ' • ' + acc.meName : '') + '</div>' +
        '</div>' +
        '<div style="display:flex;gap:8px;align-items:center;">' +
          activeBadge +
          '<button class="danger" style="padding:6px 10px;font-size:12px;" onclick="logoutAccount(\\'' + acc.name + '\\')">Logout</button>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  async function refreshAccounts() {
    const res = await fetch('/api/accounts');
    const data = await res.json();
    updateAuthUI(data);
  }

  async function switchAccount(name) {
    document.getElementById('accNameInput').value = name;
    await fetch('/api/accounts/switch?name=' + encodeURIComponent(name), { method: 'POST' });
    refreshAccounts();
  }

  async function startAccountLogin() {
    const name = document.getElementById('accNameInput').value.trim() || 'default';
    const phone = document.getElementById('accPhoneInput').value.trim();
    document.getElementById('authInteractiveBox').innerHTML = '<div style="color:var(--muted);">Initializing WhatsApp handshake...</div>';
    await fetch('/api/accounts/login?name=' + encodeURIComponent(name) + '&phone=' + encodeURIComponent(phone), { method: 'POST' });
  }

  async function logoutAccount(name) {
    await fetch('/api/accounts/logout?name=' + encodeURIComponent(name), { method: 'POST' });
  }

  function updateToggleButton(running) {
    isProbeRunning = running;
    const btn = document.getElementById('probeToggleBtn');
    if (running) {
      btn.textContent = 'Stop';
      btn.className = 'danger';
    } else {
      btn.textContent = 'Start Live Probe';
      btn.className = 'primary';
    }
  }

  function updateWatchToggleButton(running) {
    isWatchRunning = running;
    const btn = document.getElementById('watchToggleBtn');
    if (running) {
      btn.textContent = 'Stop';
      btn.className = 'danger';
    } else {
      btn.textContent = 'Start Multi-Watch';
      btn.className = 'primary';
    }
  }

  function updateFilterPills() {
    const bar = document.getElementById('filterBar');
    if (!knownDevices.length) return;
    let html = '<span style="font-size:12px;color:var(--muted);margin-right:4px;">View Device:</span>';
    for (const d of knownDevices) {
      const isAct = selectedDevice === d.label ? 'active' : '';
      html += '<button class="filter-pill ' + isAct + '" onclick="setDeviceFilter(\\'' + d.label + '\\')">' + d.label + '</button>';
    }
    const isAll = selectedDevice === 'ALL' ? 'active' : '';
    html += '<button class="filter-pill ' + isAll + '" onclick="setDeviceFilter(\\'ALL\\')">Compare All</button>';
    bar.innerHTML = html;
  }

  async function syncFilterOptions() {
    const notify = document.getElementById('notifyChk').checked ? '1' : '0';
    if (notify === '1' && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
    const probeOnly = document.getElementById('probeOnlySelectedChk').checked;
    const onlyDevice = probeOnly && selectedDevice && selectedDevice !== 'ALL' ? selectedDevice : 'ALL';
    if (isProbeRunning) {
      await fetch('/api/filter?onlyDevice=' + encodeURIComponent(onlyDevice) + '&notify=' + notify, { method: 'POST' });
    }
  }

  function setDeviceFilter(filter) {
    selectedDevice = filter;
    updateFilterPills();
    syncFilterOptions();
    if (samples.length > 0) {
      renderDeviceCards(samples[samples.length - 1]);
      rebuildTable();
      drawChart();
    }
  }

  async function loadProfile(checkOnline = false) {
    const num = document.getElementById('numInput').value.trim();
    if (!num) return;
    const box = document.getElementById('profileDetails');
    box.innerHTML = checkOnline ? 'Querying servers & probing devices...' : 'Querying WhatsApp servers...';
    const res = await fetch('/api/profile?number=' + encodeURIComponent(num) + (checkOnline ? '&online=1' : ''));
    const data = await res.json();
    if (!res.ok) {
      box.innerHTML = '<span style="color:#ef4444">' + (data.error || 'Failed') + '</span>';
      return;
    }
    lastProfileData = data;
    document.getElementById('saveProfileBtn').style.display = 'inline-block';

    const av = document.getElementById('avatar');
    if (data.profilePicUrl) {
      av.src = data.profilePicUrl;
      av.style.display = 'block';
    } else {
      av.style.display = 'none';
    }

    const biz = data.businessProfile;
    const bizHtml = biz ? [
      '<div class="section-sep"><strong style="color:var(--purple);font-size:12px;">WHATSAPP BUSINESS PROFILE</strong></div>',
      biz.category ? '<div class="kv"><span>Category:</span> ' + biz.category + '</div>' : '',
      biz.description ? '<div class="kv"><span>Description:</span> ' + biz.description + '</div>' : '',
      biz.email ? '<div class="kv"><span>Email:</span> ' + biz.email + '</div>' : '',
      biz.website?.length ? '<div class="kv"><span>Website:</span> ' + biz.website.join(', ') + '</div>' : '',
      biz.address ? '<div class="kv"><span>Address:</span> ' + biz.address + '</div>' : ''
    ].join('') : '';

    const devsHtml = [
      '<div class="section-sep"><strong style="color:var(--accent);font-size:12px;">LINKED DEVICES (' + data.devices.length + ')</strong></div>',
      data.devices.map(d => {
        const badge = d.state ? (' <span class="badge ' + d.state + '">' + d.state + (d.rtt ? ' ' + d.rtt + 'ms' : '') + '</span>') : '';
        return '<div class="kv"><span>• ' + d.label + ':</span> ' + d.jid + badge + '</div>';
      }).join('')
    ].join('');

    box.innerHTML = [
      '<div class="kv"><span>Canonical JID:</span> ' + data.jid + '</div>',
      data.lid ? '<div class="kv"><span>Linked ID:</span> ' + data.lid + '</div>' : '',
      '<div class="kv"><span>Account Type:</span> ' + (biz ? '<strong style="color:var(--purple)">Business</strong>' : 'Personal') + '</div>',
      '<div class="kv"><span>Status/About:</span> ' + (data.status || '(private/none)') + '</div>',
      data.statusSetAt ? '<div class="kv"><span>Status Date:</span> ' + data.statusSetAt + '</div>' : '',
      data.photoLastModified ? '<div class="kv"><span>Photo Date:</span> ' + data.photoLastModified + (data.photoSizeKB ? ' (' + data.photoSizeKB + ' KB)' : '') + '</div>' : '',
       data.profilePicUrl ? '<div style="margin:8px 0;"><a href="' + data.profilePicUrl + '" target="_blank" style="color:var(--accent);font-size:12px;">Open High-Res Photo ↗</a></div>' : '',
      devsHtml,
      bizHtml
    ].join('');
  }

  function downloadProfileJson() {
    if (!lastProfileData) return;
    downloadBlob(JSON.stringify(lastProfileData, null, 2), 'profile-' + lastProfileData.number + '.json', 'application/json');
  }

  async function toggleSonar() {
    if (isProbeRunning) {
      updateToggleButton(false);
      await fetch('/api/stop', { method: 'POST' });
    } else {
      const num = document.getElementById('numInput').value.trim();
      const interval = document.getElementById('intervalInput').value;
      const notify = document.getElementById('notifyChk').checked ? '1' : '0';
      if (!num) return;
      samples.length = 0;
      selectedDevice = null;
      document.getElementById('logBody').innerHTML = '';
      updateToggleButton(true);
      loadProfile(false);
      const res = await fetch('/api/start?number=' + encodeURIComponent(num) + '&interval=' + interval + '&notify=' + notify, { method: 'POST' });
      if (!res.ok) updateToggleButton(false);
    }
  }

  function renderDeviceCards(cycleData) {
    const container = document.getElementById('devCards');
    container.innerHTML = cycleData.devices.map(d => {
      const s = d.stats || {};
      const isSelected = selectedDevice === d.label ? 'selected' : '';
      return '<div class="dev-card ' + isSelected + '" onclick="setDeviceFilter(\\'' + d.label + '\\')" title="Click to filter by ' + d.label + '">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
          '<strong>' + d.label + '</strong>' +
          '<span class="badge ' + d.state + '">' + d.state + '</span>' +
        '</div>' +
        '<div style="font-size:22px;font-weight:700;color:#00f0ff;margin-bottom:6px;">' +
          (d.clientRtt !== null ? d.clientRtt + ' ms' : 'OFFLINE') +
        '</div>' +
        '<div style="font-size:11px;color:#8b9bb4;">' +
          (s.avg !== null ? ('Avg: ' + s.avg + 'ms | Min: ' + s.min + 'ms | Jit: ±' + s.jitter + 'ms | Up: ' + s.uptimePct + '%') : 'Uptime: 0%') +
        '</div>' +
      '</div>';
    }).join('');
  }

  function rebuildTable() {
    const thead = document.getElementById('logHead');
    const tbody = document.getElementById('logBody');
    tbody.innerHTML = '';

    if (selectedDevice && selectedDevice !== 'ALL') {
      thead.innerHTML = '<tr><th>Cycle</th><th>Time</th><th>Device</th><th>State</th><th>RTT</th><th>Avg / Min / Max / Jitter / Uptime</th></tr>';
      const recent = samples.slice(-30).reverse();
      for (const cycleData of recent) {
        const d = cycleData.devices.find(x => x.label === selectedDevice);
        if (!d) continue;
        const s = d.stats || {};
        const timeStr = new Date(cycleData.timestamp).toLocaleTimeString();
        const tr = document.createElement('tr');
        tr.innerHTML = '<td>#' + cycleData.cycle + '</td>' +
          '<td>' + timeStr + '</td>' +
          '<td><strong>' + d.label + '</strong></td>' +
          '<td><span class="badge ' + d.state + '">' + d.state + '</span></td>' +
          '<td style="color:#00f0ff;font-weight:600;">' + (d.clientRtt !== null ? d.clientRtt + ' ms' : '-') + '</td>' +
          '<td>' + (s.avg !== null ? ('avg ' + s.avg + 'ms | min ' + s.min + 'ms | max ' + s.max + 'ms | ±' + s.jitter + 'ms | ' + s.uptimePct + '%') : '0%') + '</td>';
        tbody.appendChild(tr);
      }
    } else {
      const cols = knownDevices.map(d => '<th>' + d.label + '</th>').join('');
      thead.innerHTML = '<tr><th>Cycle</th><th>Time</th>' + cols + '</tr>';
      const recent = samples.slice(-30).reverse();
      for (const cycleData of recent) {
        const timeStr = new Date(cycleData.timestamp).toLocaleTimeString();
        const tr = document.createElement('tr');
        const cells = knownDevices.map(k => {
          const d = cycleData.devices.find(x => x.label === k.label);
          if (!d) return '<td>-</td>';
          const rttStr = d.clientRtt !== null ? ('<strong>' + d.clientRtt + ' ms</strong>') : '';
          return '<td><span class="badge ' + d.state + '">' + d.state + '</span> ' + rttStr + '</td>';
        }).join('');
        tr.innerHTML = '<td>#' + cycleData.cycle + '</td><td>' + timeStr + '</td>' + cells;
        tbody.appendChild(tr);
      }
    }
  }

  function drawChart() {
    const canvas = document.getElementById('rttChart');
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    if (!samples.length) return;

    const activeDevices = (selectedDevice && selectedDevice !== 'ALL')
      ? knownDevices.filter(d => d.label === selectedDevice)
      : knownDevices;

    let highestObserved = 1500;
    for (const s of samples) {
      for (const d of s.devices) {
        if (selectedDevice && selectedDevice !== 'ALL' && d.label !== selectedDevice) continue;
        if (typeof d.clientRtt === 'number' && d.clientRtt > highestObserved) {
          highestObserved = d.clientRtt;
        }
      }
    }
    const maxRtt = Math.min(5500, Math.max(2000, Math.ceil(highestObserved / 500) * 500 + 500));

    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.fillStyle = '#64748b';
    ctx.font = '11px sans-serif';
    for (const step of [500, 1500, 2500, 3500, 4500]) {
      if (step >= maxRtt) continue;
      const y = h - (step / maxRtt) * (h - 36) - 18;
      ctx.beginPath(); ctx.moveTo(45, y); ctx.lineTo(w - 10, y); ctx.stroke();
      ctx.fillText(step + 'ms', 6, y + 4);
    }

    const y850 = h - (850 / maxRtt) * (h - 36) - 18;
    ctx.strokeStyle = 'rgba(245, 158, 11, 0.4)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(45, y850); ctx.lineTo(w - 10, y850); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#f59e0b';
    ctx.fillText('850ms (Active/Standby threshold)', 52, y850 - 5);

    activeDevices.forEach((devObj) => {
      const label = devObj.label;
      const colorIdx = knownDevices.findIndex(k => k.label === label);
      const color = colors[Math.max(0, colorIdx) % colors.length];
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      let started = false;
      const pts = [];

      samples.forEach((s, i) => {
        const dev = s.devices.find(d => d.label === label);
        if (!dev || dev.clientRtt === null) return;
        const x = (i / Math.max(1, samples.length - 1)) * (w - 70) + 50;
        const clamped = Math.min(maxRtt, dev.clientRtt);
        const y = h - (clamped / maxRtt) * (h - 36) - 18;
        pts.push({ x, y });
        if (!started) { ctx.moveTo(x, y); started = true; }
        else { ctx.lineTo(x, y); }
      });
      ctx.stroke();

      for (const p of pts) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }

  function exportProbeData(format) {
    if (!samples.length) return;
    const target = samples[0].target || 'target';
    if (format === 'json') {
      downloadBlob(JSON.stringify(samples, null, 2), 'online-rtt-' + target + '.json', 'application/json');
    } else {
      const rows = ['iso_time,cycle,target,device,state,client_rtt_ms,server_rtt_ms'];
      for (const s of samples) {
        const iso = new Date(s.timestamp).toISOString();
        for (const d of s.devices) {
          rows.push([iso, s.cycle, s.target || '', '"' + d.label + '"', d.state, d.clientRtt ?? '', d.serverRtt ?? ''].join(','));
        }
      }
      downloadBlob(rows.join('\\n'), 'online-rtt-' + target + '.csv', 'text/csv');
    }
  }

  // MULTI-WATCH FUNCTIONS
  async function toggleWatch() {
    if (isWatchRunning) {
      updateWatchToggleButton(false);
      await fetch('/api/watch/stop', { method: 'POST' });
    } else {
      const nums = document.getElementById('watchNumsInput').value.trim();
      const interval = document.getElementById('watchIntervalInput').value;
      const notify = document.getElementById('watchNotifyChk').checked ? '1' : '0';
      if (!nums) return;
      watchSamples.length = 0;
      document.getElementById('watchBody').innerHTML = '';
      updateWatchToggleButton(true);
      const res = await fetch('/api/watch/start?numbers=' + encodeURIComponent(nums) + '&interval=' + interval + '&notify=' + notify, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || 'Failed to start Multi-Watch');
        updateWatchToggleButton(false);
      }
    }
  }

  function renderWatchCycle(data) {
    document.getElementById('watchScoreVal').textContent = data.coActivityScorePct + '%';
    document.getElementById('watchBannerSub').innerHTML = data.bothActiveNow
      ? '<strong style="color:var(--green);">⚡ SIMULTANEOUS ACTIVE DETECTED RIGHT NOW!</strong> (' + data.bothActiveCount + '/' + data.eitherActiveCount + ' active cycles overlap)'
      : 'Overlap cycles: ' + data.bothActiveCount + ' / ' + data.eitherActiveCount;

    const cards = document.getElementById('watchCards');
    cards.innerHTML = data.targets.map((t, idx) => {
      const st = t.anyActive ? 'ACTIVE' : (t.anyOnline ? 'STANDBY' : 'OFFLINE');
      return '<div class="dev-card" style="border-left: 3px solid ' + colors[idx % colors.length] + ';">' +
        '<div style="display:flex;justify-content:space-between;margin-bottom:6px;">' +
          '<strong>' + t.target + '</strong>' +
          '<span class="badge ' + st + '">' + st + '</span>' +
        '</div>' +
        '<div style="font-size:20px;font-weight:700;color:' + colors[idx % colors.length] + ';">' +
          (t.bestRtt !== null ? t.bestRtt + ' ms' : 'OFFLINE') +
        '</div>' +
      '</div>';
    }).join('');

    const tbody = document.getElementById('watchBody');
    const tr = document.createElement('tr');
    const timeStr = new Date(data.timestamp).toLocaleTimeString();
    const coBadge = data.bothActiveNow
      ? '<span class="badge ACTIVE">⚡ SIMULTANEOUS</span>'
      : '<span class="badge OFFLINE">' + data.coActivityScorePct + '%</span>';
    const targetCells = data.targets.map(t => {
      const st = t.anyActive ? 'ACTIVE' : (t.anyOnline ? 'STANDBY' : 'OFFLINE');
      return '<strong>' + t.target + ':</strong> <span class="badge ' + st + '">' + st + '</span> ' + (t.bestRtt !== null ? t.bestRtt + 'ms' : '-');
    }).join(' &nbsp;|&nbsp; ');
    tr.innerHTML = '<td>#' + data.cycle + '</td><td>' + timeStr + '</td><td>' + coBadge + '</td><td>' + targetCells + '</td>';
    tbody.prepend(tr);
    while (tbody.children.length > 30) tbody.removeChild(tbody.lastChild);

    drawWatchChart();
  }

  function drawWatchChart() {
    const canvas = document.getElementById('watchChart');
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (!watchSamples.length) return;

    const maxRtt = 4500;
    const y850 = h - (850 / maxRtt) * (h - 36) - 18;
    ctx.strokeStyle = 'rgba(245, 158, 11, 0.35)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(40, y850); ctx.lineTo(w - 10, y850); ctx.stroke();
    ctx.setLineDash([]);

    const targetList = watchSamples[watchSamples.length - 1].targets.map(t => t.target);
    targetList.forEach((tNum, idx) => {
      const color = colors[idx % colors.length];
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      let started = false;
      watchSamples.forEach((s, i) => {
        const t = s.targets.find(x => x.target === tNum);
        if (!t || t.bestRtt === null) return;
        const x = (i / Math.max(1, watchSamples.length - 1)) * (w - 60) + 45;
        const y = h - (Math.min(maxRtt, t.bestRtt) / maxRtt) * (h - 36) - 18;
        if (!started) { ctx.moveTo(x, y); started = true; }
        else { ctx.lineTo(x, y); }
      });
      ctx.stroke();
    });
  }

  function exportWatchJson() {
    if (!watchSamples.length) return;
    downloadBlob(JSON.stringify(watchSamples, null, 2), 'watch-correlation.json', 'application/json');
  }

  function downloadBlob(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
  }

  const evtSource = new EventSource('/api/events');
  evtSource.addEventListener('init', (e) => {
    const init = JSON.parse(e.data);
    if (init.auth) {
      updateAuthUI(init.auth);
      if (init.auth.state === 'unauthenticated') {
        switchTab('accounts');
      }
    }
    if (init.monitor) updateToggleButton(Boolean(init.monitor.running));
    if (init.watch) updateWatchToggleButton(Boolean(init.watch.running));
  });

  evtSource.addEventListener('auth', (e) => {
    updateAuthUI(JSON.parse(e.data));
  });

  evtSource.addEventListener('status', (e) => {
    const st = JSON.parse(e.data);
    updateToggleButton(Boolean(st.running));
  });

  evtSource.addEventListener('watch_status', (e) => {
    const st = JSON.parse(e.data);
    updateWatchToggleButton(Boolean(st.running));
  });

  evtSource.addEventListener('probe', (e) => {
    const data = JSON.parse(e.data);
    if (!knownDevices.length || knownDevices.length < data.devices.length) {
      knownDevices = data.devices.map(d => ({ label: d.label, deviceId: d.deviceId }));
      if (!selectedDevice) {
        selectedDevice = knownDevices[0]?.label || 'ALL';
      }
      updateFilterPills();
    }
    samples.push(data);
    if (samples.length > 100) samples.shift();
    renderDeviceCards(data);
    rebuildTable();
    drawChart();
  });

  evtSource.addEventListener('watch_probe', (e) => {
    const data = JSON.parse(e.data);
    watchSamples.push(data);
    if (watchSamples.length > 100) watchSamples.shift();
    renderWatchCycle(data);
  });
</script>
</body>
</html>`;

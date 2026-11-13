import chalk from 'chalk';

/**
 * Discover all linked devices for a canonical JID and return normalized device descriptors
 */
export async function discoverDevices(sock, canonicalJid) {
    const devicesList = await sock.getUSyncDevices([canonicalJid], false, false);
    if (!Array.isArray(devicesList)) return [];

    return devicesList.map(d => {
        const probeJid = d.device === 0 && !d.jid.includes(':')
            ? d.jid.replace('@', ':0@')
            : d.jid;
        return {
            jid: d.jid,
            probeJid,
            deviceId: d.device,
            isMain: d.device === 0,
            label: d.device === 0 ? 'Phone' : `Companion ${d.device}`
        };
    }).sort((a, b) => (a.isMain ? -1 : a.deviceId - b.deviceId));
}

/**
 * Send a silent delete probe to a specific device JID and measure server & client RTT
 */
export async function sendProbe(sock, targetJid, timeoutMs = 5000, retries = 1) {
    const startTime = Date.now();
    const fakeId = `PROBE_${startTime}_${Math.random().toString(36).substring(7)}`;
    const fakeKey = {
        remoteJid: targetJid,
        fromMe: true,
        id: fakeId
    };

    let serverAckTime = null;
    let clientAckTime = null;
    let deleteMessageId = null;
    let timer = null;
    let finishProbe = null;

    const getStatus = (s) => {
        if (typeof s === 'number') return s;
        if (s === 'SERVER_ACK') return 2;
        if (s === 'DELIVERY_ACK') return 3;
        if (s === 'READ') return 4;
        return 0;
    };

    const donePromise = new Promise(resolve => {
        finishProbe = resolve;
    });

    const updateHandler = (updates) => {
        for (const u of updates) {
            if (deleteMessageId && u.key.id === deleteMessageId) {
                const status = getStatus(u.update.status);
                if (status === 2 && !serverAckTime) {
                    serverAckTime = Date.now();
                }
                if (status >= 3 && !clientAckTime) {
                    clientAckTime = Date.now();
                    finishProbe();
                }
            }
        }
    };

    const upsertHandler = (event) => {
        const msg = event.messages?.[0];
        if (!msg) return;

        const isRevoke = msg.message?.protocolMessage?.type === 'REVOKE' ||
                         msg.message?.protocolMessage?.type === 0;
        const targetId = msg.message?.protocolMessage?.key?.id;

        if (msg.key.fromMe && isRevoke && targetId === fakeId) {
            if (!deleteMessageId) {
                deleteMessageId = msg.key.id;
            }
            const status = getStatus(msg.status);
            if (status === 2 && !serverAckTime) {
                serverAckTime = Date.now();
            }
            if (status >= 3 && !clientAckTime) {
                clientAckTime = Date.now();
                finishProbe();
            }
        }
    };

    sock.ev.on('messages.update', updateHandler);
    sock.ev.on('messages.upsert', upsertHandler);

    try {
        timer = setTimeout(() => finishProbe(), timeoutMs);
        const sent = await sock.sendMessage(targetJid, { delete: fakeKey });
        if (sent?.key?.id) {
            deleteMessageId = sent.key.id;
        }
        if (!serverAckTime) {
            serverAckTime = Date.now();
        }
        await donePromise;
    } catch (e) {
        clearTimeout(timer);
        sock.ev.off('messages.update', updateHandler);
        sock.ev.off('messages.upsert', upsertHandler);
        if (retries > 0) {
            await new Promise(r => setTimeout(r, 450));
            return sendProbe(sock, targetJid, timeoutMs, retries - 1);
        }
        return {
            timestamp: startTime,
            serverRtt: null,
            clientRtt: null,
            state: 'ERROR',
            error: e.message
        };
    }

    clearTimeout(timer);
    sock.ev.off('messages.update', updateHandler);
    sock.ev.off('messages.upsert', upsertHandler);

    const clientRtt = clientAckTime ? (clientAckTime - startTime) : null;
    const serverRtt = serverAckTime ? (serverAckTime - startTime) : null;

    return {
        timestamp: startTime,
        serverRtt,
        clientRtt,
        state: classifyRttState(clientRtt)
    };
}

/**
 * Classify device state based on Careless Whisper RTT thresholds
 * - ACTIVE (Screen On / App in foreground or active radio): < 850ms
 * - STANDBY (Idle / Screen Off / Doze mode wake-up): >= 850ms
 * - OFFLINE: null (timeout)
 */
export function classifyRttState(rtt) {
    if (rtt === null || rtt === undefined) return 'OFFLINE';
    if (rtt < 850) return 'ACTIVE';
    return 'STANDBY';
}

export function formatStateBadge(state) {
    if (state === 'ACTIVE') return chalk.bgGreen.black.bold(' ACTIVE ');
    if (state === 'STANDBY') return chalk.bgYellow.black.bold(' STANDBY ');
    if (state === 'ERROR') return chalk.bgRed.white.bold(' ERROR ');
    return chalk.bgGray.white(' OFFLINE ');
}

export function renderRttBar(rtt, width = 12) {
    if (rtt === null || rtt === undefined) {
        return chalk.dim('░'.repeat(width));
    }
    // Scale 0ms..2500ms -> 1..width blocks
    const ratio = Math.min(1, Math.max(0.08, rtt / 2500));
    const filled = Math.max(1, Math.round(ratio * width));
    const empty = Math.max(0, width - filled);
    const color = rtt < 850 ? chalk.green : rtt < 1600 ? chalk.yellow : chalk.red;
    return color('█'.repeat(filled)) + chalk.dim('░'.repeat(empty));
}

export function computeRttStats(rttSamples, totalProbes) {
    const valid = rttSamples.filter(v => typeof v === 'number');
    if (valid.length === 0) {
        return {
            min: null,
            max: null,
            avg: null,
            jitter: null,
            onlineCount: 0,
            totalProbes,
            uptimePct: 0
        };
    }
    const min = Math.min(...valid);
    const max = Math.max(...valid);
    const avg = Math.round(valid.reduce((a, b) => a + b, 0) / valid.length);
    const variance = valid.reduce((acc, v) => acc + Math.pow(v - avg, 2), 0) / valid.length;
    const jitter = Math.round(Math.sqrt(variance));
    const uptimePct = totalProbes > 0 ? Math.round((valid.length / totalProbes) * 100) : 100;

    return {
        min,
        max,
        avg,
        jitter,
        onlineCount: valid.length,
        totalProbes,
        uptimePct
    };
}

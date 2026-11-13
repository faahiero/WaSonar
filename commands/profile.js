import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs';
import path from 'path';
import https from 'https';
import { createConnectedSocket } from '../lib/client.js';
import { checkAuth, resolveTargetJid } from '../lib/utils.js';
import { discoverDevices } from '../lib/probe.js';

export async function profile(number, options) {
    checkAuth();
    console.log(chalk.blue(`Fetching deep OSINT profile for: ${number}`));

    try {
        const connectSpinner = ora('Connecting to WhatsApp...').start();
        const sock = await createConnectedSocket();
        connectSpinner.succeed('Connected to WhatsApp');

        const profileSpinner = ora('Resolving identity and querying servers...').start();
        const resolved = await resolveTargetJid(sock, number);

        if (!resolved.exists) {
            profileSpinner.fail('Number not found on WhatsApp');
            process.exit(1);
        }

        const canonicalJid = resolved.jid;

        // 1. Fetch Status / About + Timestamp (setAt)
        let status = null;
        let statusSetAt = null;
        try {
            const statusResult = await sock.fetchStatus(canonicalJid);
            const entry = Array.isArray(statusResult) ? statusResult[0] : statusResult;
            status = entry?.status?.status ?? entry?.status ?? null;
            statusSetAt = entry?.status?.setAt ?? entry?.setAt ?? null;
            if (statusSetAt instanceof Date) {
                statusSetAt = statusSetAt.getTime() > 0 ? statusSetAt.toISOString() : null;
            } else if (typeof statusSetAt === 'number' && statusSetAt > 0) {
                statusSetAt = new Date(statusSetAt * 1000).toISOString();
            } else {
                statusSetAt = null;
            }
        } catch {
            // Status might be private
        }

        // 2. Fetch Profile Picture URL + HTTP Metadata (Last-Modified, Content-Length)
        let profilePicUrl = null;
        let profilePicMeta = null;
        try {
            profilePicUrl = await sock.profilePictureUrl(canonicalJid, 'image');
            if (profilePicUrl) {
                profilePicMeta = await fetchUrlHeadMetadata(profilePicUrl);
            }
        } catch {
            // Profile pic might be private
        }

        // 3. Fetch Business Profile (if WhatsApp Business account)
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
                    businessHoursTimezone: biz.business_hours?.timezone || null
                };
            }
        } catch {
            // Not a business account or unavailable
        }

        // 4. Discover Linked Devices (USync)
        let devices = [];
        try {
            devices = await discoverDevices(sock, canonicalJid);
        } catch {}

        let resolvedLid = resolved.lid;
        if (!resolvedLid) {
            try {
                resolvedLid = await sock.signalRepository?.lidMapping?.getLIDForPN?.(canonicalJid) || null;
            } catch {}
        }

        profileSpinner.succeed('OSINT Profile fetched');
        console.log('');

        // Display Profile Summary
        console.log(chalk.white.bold('Profile Intelligence'));
        console.log(chalk.dim('─'.repeat(56)));
        console.log(`${chalk.cyan('Input Number:')}   ${number}`);
        console.log(`${chalk.cyan('Canonical JID:')}  ${canonicalJid}`);
        if (resolvedLid) {
            console.log(`${chalk.cyan('Linked ID (LID):')} ${resolvedLid}`);
        }
        console.log(`${chalk.cyan('Account Type:')}   ${businessProfile ? chalk.magenta.bold('WhatsApp Business') : 'Standard Personal Account'}`);
        console.log(`${chalk.cyan('Status/About:')}   ${status || chalk.gray('(private/not set)')}`);
        if (statusSetAt) {
            console.log(`${chalk.cyan('Status Updated:')} ${statusSetAt}`);
        }
        console.log(`${chalk.cyan('Profile Photo:')}  ${profilePicUrl ? chalk.green('Available') : chalk.gray('(private/not set)')}`);
        if (profilePicMeta?.lastModified) {
            console.log(`${chalk.cyan('Photo Uploaded:')} ${profilePicMeta.lastModified}${profilePicMeta.sizeKB ? ` (${profilePicMeta.sizeKB} KB)` : ''}`);
        }
        if (profilePicUrl) {
            console.log(chalk.dim(`                ${profilePicUrl}`));
        }

        // Display Linked Devices
        console.log('');
        console.log(chalk.white.bold(`Linked Devices (${devices.length})`));
        console.log(chalk.dim('─'.repeat(56)));
        if (devices.length === 0) {
            console.log(chalk.gray('  No devices reported via USync'));
        } else {
            devices.forEach((d, idx) => {
                const role = d.isMain ? 'Main Phone' : 'Companion (Web/Desktop)';
                console.log(`  ${idx + 1}. ${chalk.cyan(d.label.padEnd(14))} [${role}] -> ${chalk.dim(d.jid)}`);
            });
        }

        // Display Business Profile if present
        if (businessProfile) {
            console.log('');
            console.log(chalk.magenta.bold('Business Profile Details'));
            console.log(chalk.dim('─'.repeat(56)));
            if (businessProfile.category) console.log(`${chalk.cyan('Category:')}       ${businessProfile.category}`);
            if (businessProfile.description) console.log(`${chalk.cyan('Description:')}    ${businessProfile.description}`);
            if (businessProfile.email) console.log(`${chalk.cyan('Email:')}          ${businessProfile.email}`);
            if (businessProfile.website?.length) console.log(`${chalk.cyan('Website(s):')}     ${businessProfile.website.join(', ')}`);
            if (businessProfile.address) console.log(`${chalk.cyan('Address:')}        ${businessProfile.address}`);
            if (businessProfile.businessHoursTimezone) console.log(`${chalk.cyan('Timezone:')}       ${businessProfile.businessHoursTimezone}`);
        }

        // Save to output if specified
        if (options.output) {
            if (!fs.existsSync(options.output)) fs.mkdirSync(options.output, { recursive: true });

            const profileData = {
                number,
                jid: canonicalJid,
                lid: resolvedLid,
                isBusiness: Boolean(businessProfile),
                status,
                statusSetAt,
                profilePicUrl,
                profilePicLastModified: profilePicMeta?.lastModified || null,
                profilePicSizeKB: profilePicMeta?.sizeKB || null,
                businessProfile,
                linkedDevices: devices.map(d => ({
                    deviceId: d.deviceId,
                    label: d.label,
                    isMain: d.isMain,
                    jid: d.jid
                })),
                fetchedAt: new Date().toISOString()
            };

            const jsonPath = path.join(options.output, `profile-${number}.json`);
            fs.writeFileSync(jsonPath, JSON.stringify(profileData, null, 2));
            console.log(chalk.cyan(`\nProfile data saved to: ${jsonPath}`));

            if (profilePicUrl) {
                const picSpinner = ora('Downloading profile picture...').start();
                const picPath = path.join(options.output, `profile-${number}.jpg`);
                try {
                    await downloadFile(profilePicUrl, picPath);
                    picSpinner.succeed(`Profile picture saved to: ${picPath}`);
                } catch {
                    picSpinner.fail('Failed to download profile picture');
                }
            }
        }

        sock.end();
        process.exit(0);
    } catch (error) {
        console.error(chalk.red('Error fetching profile:'), error);
        process.exit(1);
    }
}

function fetchUrlHeadMetadata(url) {
    return new Promise((resolve) => {
        https.get(url, (res) => {
            const lastModifiedRaw = res.headers['last-modified'];
            const contentLength = res.headers['content-length'];
            res.destroy();
            resolve({
                lastModified: lastModifiedRaw ? new Date(lastModifiedRaw).toISOString() : null,
                sizeKB: contentLength ? Math.round((parseInt(contentLength, 10) / 1024) * 10) / 10 : null
            });
        }).on('error', () => resolve(null));
    });
}

function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https.get(url, (response) => {
            if (response.statusCode === 302 || response.statusCode === 301) {
                https.get(response.headers.location, (res) => {
                    res.pipe(file);
                    file.on('finish', () => {
                        file.close();
                        resolve();
                    });
                }).on('error', reject);
            } else {
                response.pipe(file);
                file.on('finish', () => {
                    file.close();
                    resolve();
                });
            }
        }).on('error', reject);
    });
}

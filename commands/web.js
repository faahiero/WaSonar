import http from 'http';
import https from 'https';
import { URL } from 'url';
import chalk from 'chalk';
import ora from 'ora';
import { createConnectedSocket } from '../lib/client.js';
import { checkAuth, resolveTargetJid } from '../lib/utils.js';
import { discoverDevices, sendProbe, computeRttStats } from '../lib/probe.js';

export async function web(options) {
    checkAuth();
    const port = parseInt(options.port, 10) || 3000;

    console.log(chalk.blue.bold('\nStarting WaSonar Web Intelligence Dashboard'));
    const connectSpinner = ora('Connecting to WhatsApp...').start();
    const sock = await createConnectedSocket();
    connectSpinner.succeed('Connected to WhatsApp');

    const sseClients = new Set();
    let monitorTimer = null;
    let monitorState = {
        running: false,
        number: null,
        jid: null,
        intervalMs: 1500,
        probeCount: 0,
        devices: [],
        historyByDevice: {},
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

    async function runProbeCycle() {
        if (!monitorState.running || !monitorState.devices.length) return;
        monitorState.probeCount++;
        const cycleNum = monitorState.probeCount;
        const results = await Promise.all(
            monitorState.devices.map(async (d) => {
                const res = await sendProbe(sock, d.probeJid);
                const hist = monitorState.historyByDevice[d.label] || [];
                hist.push(res.clientRtt);
                monitorState.historyByDevice[d.label] = hist;
                const stats = computeRttStats(hist, cycleNum);
                return {
                    ...res,
                    label: d.label,
                    deviceId: d.deviceId,
                    jid: d.jid,
                    stats
                };
            })
        );

        const entry = {
            cycle: cycleNum,
            timestamp: Date.now(),
            devices: results
        };
        monitorState.samples.push(entry);
        if (monitorState.samples.length > 150) {
            monitorState.samples.shift();
        }
        broadcast('probe', entry);

        if (monitorState.running) {
            monitorTimer = setTimeout(runProbeCycle, monitorState.intervalMs);
        }
    }

    const server = http.createServer(async (req, res) => {
        const parsedUrl = new URL(req.url, `http://localhost:${port}`);
        const pathname = parsedUrl.pathname;

        if (pathname === '/api/events') {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
            });
            res.write(`event: init\ndata: ${JSON.stringify(monitorState)}\n\n`);
            sseClients.add(res);
            req.on('close', () => sseClients.delete(res));
            return;
        }

        if (pathname === '/api/profile') {
            const number = parsedUrl.searchParams.get('number') || '';
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
                let photoLastModified = null;
                try {
                    profilePicUrl = await sock.profilePictureUrl(canonicalJid, 'image');
                    if (profilePicUrl) {
                        photoLastModified = await getPhotoLastModified(profilePicUrl);
                    }
                } catch {}

                let businessProfile = null;
                try {
                    const biz = await sock.getBusinessProfile(canonicalJid);
                    if (biz && (biz.description || biz.category || biz.email || biz.website?.length || biz.address)) {
                        businessProfile = biz;
                    }
                } catch {}

                const devices = await discoverDevices(sock, canonicalJid);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    number,
                    jid: canonicalJid,
                    lid: resolved.lid,
                    status,
                    statusSetAt,
                    profilePicUrl,
                    photoLastModified,
                    businessProfile,
                    devices
                }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
            return;
        }

        if (pathname === '/api/start' && req.method === 'POST') {
            const number = parsedUrl.searchParams.get('number') || '';
            const intervalMs = Math.max(500, parseInt(parsedUrl.searchParams.get('interval') || '1500', 10));
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
                    number,
                    jid: resolved.jid,
                    intervalMs,
                    probeCount: 0,
                    devices,
                    historyByDevice: {},
                    samples: []
                };
                devices.forEach(d => { monitorState.historyByDevice[d.label] = []; });
                broadcast('status', { running: true, number, jid: resolved.jid, devices });
                runProbeCycle();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, jid: resolved.jid, devices }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
            return;
        }

        if (pathname === '/api/stop' && req.method === 'POST') {
            stopMonitoring();
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
        console.log(chalk.dim('Press Ctrl+C to stop the server.\n'));
    });

    process.on('SIGINT', () => {
        stopMonitoring();
        server.close();
        sock.end();
        process.exit(0);
    });
}

function getPhotoLastModified(url) {
    return new Promise((resolve) => {
        https.get(url, (res) => {
            const lm = res.headers['last-modified'];
            res.destroy();
            resolve(lm ? new Date(lm).toISOString() : null);
        }).on('error', () => resolve(null));
    });
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>WaSonar // Live Intelligence Dashboard</title>
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
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'Inter', system-ui, -apple-system, sans-serif;
    padding: 24px;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--border);
    padding-bottom: 16px;
    margin-bottom: 24px;
  }
  .brand {
    font-size: 22px;
    font-weight: 800;
    letter-spacing: 1px;
    color: var(--accent);
  }
  .controls {
    display: flex;
    gap: 10px;
    align-items: center;
  }
  input, select, button {
    background: var(--panel);
    color: var(--text);
    border: 1px solid var(--border);
    padding: 10px 14px;
    border-radius: 8px;
    font-size: 14px;
  }
  input { width: 220px; }
  button {
    cursor: pointer;
    font-weight: 600;
    transition: 0.15s;
  }
  button.primary { background: var(--accent); color: #050811; border-color: var(--accent); }
  button.danger { background: var(--red); color: #fff; border-color: var(--red); }
  .grid {
    display: grid;
    grid-template-columns: 340px 1fr;
    gap: 20px;
  }
  .card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 18px;
  }
  .card h3 {
    font-size: 14px;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--muted);
    margin-bottom: 14px;
  }
  .avatar {
    width: 96px;
    height: 96px;
    border-radius: 50%;
    object-fit: cover;
    border: 2px solid var(--accent);
    margin-bottom: 12px;
    display: none;
  }
  .kv { margin-bottom: 8px; font-size: 13px; word-break: break-all; }
  .kv span { color: var(--muted); display: inline-block; width: 115px; }
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
    margin-bottom: 18px;
  }
  .dev-card {
    background: rgba(255,255,255,0.02);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px;
  }
  canvas {
    width: 100%;
    height: 260px;
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
</style>
</head>
<body>
  <header>
    <div class="brand">WASONAR // LIVE TELEMETRY</div>
    <div class="controls">
      <input id="numInput" type="text" placeholder="Target (e.g. 5588998044968)" />
      <select id="intervalInput">
        <option value="1000">1.0s interval</option>
        <option value="1500" selected>1.5s interval</option>
        <option value="3000">3.0s interval</option>
      </select>
      <button onclick="loadProfile()">Fetch OSINT Profile</button>
      <button class="primary" onclick="startSonar()">Start Live Probe</button>
      <button class="danger" onclick="stopSonar()">Stop</button>
    </div>
  </header>

  <div class="grid">
    <div class="card">
      <h3>Target OSINT Profile</h3>
      <img id="avatar" class="avatar" />
      <div id="profileDetails" style="color: var(--muted); font-size: 13px;">Enter a phone number above to inspect profile & linked devices.</div>
    </div>

    <div class="card">
      <h3>Real-Time Device Status & RTT (ms)</h3>
      <div id="devCards" class="dev-cards"></div>
      <canvas id="rttChart" width="900" height="260"></canvas>
      <table>
        <thead>
          <tr><th>Cycle</th><th>Time</th><th>Device</th><th>State</th><th>RTT</th><th>Avg / Jitter / Uptime</th></tr>
        </thead>
        <tbody id="logBody"></tbody>
      </table>
    </div>
  </div>

<script>
  const samples = [];
  const colors = ['#00f0ff', '#10b981', '#f59e0b', '#a855f7', '#ec4899'];

  async function loadProfile() {
    const num = document.getElementById('numInput').value.trim();
    if (!num) return;
    const box = document.getElementById('profileDetails');
    box.innerHTML = 'Querying WhatsApp servers...';
    const res = await fetch('/api/profile?number=' + encodeURIComponent(num));
    const data = await res.json();
    if (!res.ok) {
      box.innerHTML = '<span style="color:#ef4444">' + (data.error || 'Failed') + '</span>';
      return;
    }
    const av = document.getElementById('avatar');
    if (data.profilePicUrl) {
      av.src = data.profilePicUrl;
      av.style.display = 'block';
    } else {
      av.style.display = 'none';
    }
    box.innerHTML = [
      '<div class="kv"><span>Canonical JID:</span> ' + data.jid + '</div>',
      data.lid ? '<div class="kv"><span>Linked ID:</span> ' + data.lid + '</div>' : '',
      '<div class="kv"><span>Status/About:</span> ' + (data.status || '(private/none)') + '</div>',
      data.statusSetAt ? '<div class="kv"><span>Status Date:</span> ' + data.statusSetAt + '</div>' : '',
      data.photoLastModified ? '<div class="kv"><span>Photo Date:</span> ' + data.photoLastModified + '</div>' : '',
      '<div class="kv"><span>Devices Found:</span> ' + data.devices.length + '</div>',
      data.devices.map(d => '<div class="kv"><span>• ' + d.label + ':</span> ' + d.jid + '</div>').join('')
    ].join('');
  }

  async function startSonar() {
    const num = document.getElementById('numInput').value.trim();
    const interval = document.getElementById('intervalInput').value;
    if (!num) return;
    samples.length = 0;
    document.getElementById('logBody').innerHTML = '';
    loadProfile();
    await fetch('/api/start?number=' + encodeURIComponent(num) + '&interval=' + interval, { method: 'POST' });
  }

  async function stopSonar() {
    await fetch('/api/stop', { method: 'POST' });
  }

  function renderDevices(cycleData) {
    const container = document.getElementById('devCards');
    container.innerHTML = cycleData.devices.map(d => {
      const s = d.stats || {};
      return '<div class="dev-card">' +
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

    const tbody = document.getElementById('logBody');
    const timeStr = new Date(cycleData.timestamp).toLocaleTimeString();
    for (const d of cycleData.devices) {
      const s = d.stats || {};
      const tr = document.createElement('tr');
      tr.innerHTML = '<td>#' + cycleData.cycle + '</td>' +
        '<td>' + timeStr + '</td>' +
        '<td>' + d.label + '</td>' +
        '<td><span class="badge ' + d.state + '">' + d.state + '</span></td>' +
        '<td>' + (d.clientRtt !== null ? d.clientRtt + ' ms' : '-') + '</td>' +
        '<td>' + (s.avg !== null ? (s.avg + 'ms / ±' + s.jitter + 'ms / ' + s.uptimePct + '%') : '-') + '</td>';
      tbody.prepend(tr);
    }
    while (tbody.children.length > 30) tbody.removeChild(tbody.lastChild);
  }

  function drawChart() {
    const canvas = document.getElementById('rttChart');
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Draw threshold line at 850ms (ACTIVE vs STANDBY)
    const maxRtt = 3000;
    const y850 = h - (850 / maxRtt) * (h - 30) - 15;
    ctx.strokeStyle = 'rgba(245, 158, 11, 0.25)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(0, y850); ctx.lineTo(w, y850); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#f59e0b';
    ctx.font = '11px sans-serif';
    ctx.fillText('850ms (Active/Standby threshold)', 10, y850 - 5);

    if (!samples.length) return;
    const devLabels = samples[samples.length - 1].devices.map(d => d.label);

    devLabels.forEach((label, idx) => {
      const color = colors[idx % colors.length];
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      let started = false;
      samples.forEach((s, i) => {
        const dev = s.devices.find(d => d.label === label);
        if (!dev || dev.clientRtt === null) return;
        const x = (i / Math.max(1, samples.length - 1)) * (w - 40) + 20;
        const clamped = Math.min(maxRtt, dev.clientRtt);
        const y = h - (clamped / maxRtt) * (h - 30) - 15;
        if (!started) { ctx.moveTo(x, y); started = true; }
        else { ctx.lineTo(x, y); }
      });
      ctx.stroke();
    });
  }

  const evtSource = new EventSource('/api/events');
  evtSource.addEventListener('probe', (e) => {
    const data = JSON.parse(e.data);
    samples.push(data);
    if (samples.length > 60) samples.shift();
    renderDevices(data);
    drawChart();
  });
</script>
</body>
</html>`;

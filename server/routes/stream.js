const express = require('express');
const router = express.Router();
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');
const net = require('net');
const db = require('../database');
const { auth } = require('./auth');

// Track active FFmpeg processes for cleanup
const activeFFmpeg = new Map(); // cameraId -> { process, clients }
const MAX_CONCURRENT_STREAMS = 8;

/**
 * Camera Stream Proxy
 * 
 * Browsers CANNOT:
 *   - Play RTSP directly
 *   - Auth into IP cameras (blocked by modern browser security)
 *   - Handle cross-origin camera streams
 * 
 * This proxy sits between the browser and the physical camera,
 * handling auth and piping the stream/snapshot back.
 * 
 * Supported modes:
 *   - snapshot: Single JPEG frame (used for polling-based "live" view)
 *   - mjpeg:    Full MJPEG stream (multipart/x-mixed-replace)
 */

// Helper: fetch from IP camera with auth
function fetchFromCamera(camUrl, username, password, res, isStream = false) {
    const parsed = new URL(camUrl);
    const transport = parsed.protocol === 'https:' ? https : http;

    const opts = {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        auth: username && password ? `${username}:${password}` : undefined,
        headers: { 'User-Agent': 'Guardian-AI/1.0' },
        timeout: 8000,
    };

    const camReq = transport.request(opts, (camRes) => {
        if (camRes.statusCode === 401) {
            return res.status(502).json({ error: 'Camera authentication failed. Check username/password.' });
        }
        if (camRes.statusCode >= 400) {
            return res.status(502).json({ error: `Camera returned HTTP ${camRes.statusCode}` });
        }

        // Forward content type (image/jpeg or multipart/x-mixed-replace)
        res.setHeader('Content-Type', camRes.headers['content-type'] || (isStream ? 'multipart/x-mixed-replace' : 'image/jpeg'));
        res.setHeader('Cache-Control', 'no-cache, no-store');
        res.setHeader('Access-Control-Allow-Origin', '*');

        camRes.pipe(res);

        res.on('close', () => camReq.destroy());
    });

    camReq.on('error', (err) => {
        if (!res.headersSent) {
            if (err.code === 'ECONNREFUSED') res.status(502).json({ error: 'Cannot connect to camera. Is it online?' });
            else if (err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET') res.status(504).json({ error: 'Camera timeout. Check IP address.' });
            else res.status(502).json({ error: `Camera error: ${err.message}` });
        }
    });

    camReq.setTimeout(8000, () => {
        camReq.destroy();
        if (!res.headersSent) res.status(504).json({ error: 'Camera connection timed out' });
    });

    camReq.end();
}

// GET /api/stream/snapshot/:cameraId  — proxied single JPEG snapshot
router.get('/snapshot/:cameraId', auth, (req, res) => {
    const cam = db.prepare('SELECT * FROM cameras WHERE id = ? AND user_id = ?').get(req.params.cameraId, req.userId);
    if (!cam) return res.status(404).json({ error: 'Camera not found' });
    if (!cam.cam_ip) return res.status(400).json({ error: 'No IP configured for this camera' });

    const snapshotUrl = buildSnapshotUrl(cam);
    fetchFromCamera(snapshotUrl, cam.cam_username, cam.cam_password, res, false);
});

// GET /api/stream/mjpeg/:cameraId  — proxied MJPEG stream
router.get('/mjpeg/:cameraId', auth, (req, res) => {
    const cam = db.prepare('SELECT * FROM cameras WHERE id = ? AND user_id = ?').get(req.params.cameraId, req.userId);
    if (!cam) return res.status(404).json({ error: 'Camera not found' });
    if (!cam.cam_ip) return res.status(400).json({ error: 'No IP configured for this camera' });

    const mjpegUrl = buildMjpegUrl(cam);
    fetchFromCamera(mjpegUrl, cam.cam_username, cam.cam_password, res, true);
});

// GET /api/stream/rtsp/:cameraId — RTSP-to-MJPEG transcoding via FFmpeg
router.get('/rtsp/:cameraId', auth, (req, res) => {
    const cam = db.prepare('SELECT * FROM cameras WHERE id = ? AND user_id = ?').get(req.params.cameraId, req.userId);
    if (!cam) return res.status(404).json({ error: 'Camera not found' });
    if (!cam.cam_ip) return res.status(400).json({ error: 'No IP configured for this camera' });

    if (activeFFmpeg.size >= MAX_CONCURRENT_STREAMS && !activeFFmpeg.has(cam.id)) {
        return res.status(503).json({ error: `Max ${MAX_CONCURRENT_STREAMS} concurrent streams reached` });
    }

    const rtspUrl = buildRtspInfo(cam);
    if (!rtspUrl) return res.status(400).json({ error: 'Cannot build RTSP URL' });

    // Use sub-stream (subtype=1) for less bandwidth by default
    const streamUrl = req.query.hd === '1' ? rtspUrl : rtspUrl.replace('subtype=0', 'subtype=1');

    const BOUNDARY = '----mjpegboundary';
    res.setHeader('Content-Type', `multipart/x-mixed-replace; boundary=${BOUNDARY}`);
    res.setHeader('Cache-Control', 'no-cache, no-store');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Reuse existing FFmpeg process if another client is watching this camera
    let entry = activeFFmpeg.get(cam.id);
    if (entry && entry.process && !entry.process.killed) {
        entry.clients.add(res);
        res.on('close', () => {
            entry.clients.delete(res);
            if (entry.clients.size === 0) {
                // No more clients, kill FFmpeg after a grace period
                setTimeout(() => {
                    const e = activeFFmpeg.get(cam.id);
                    if (e && e.clients.size === 0) {
                        e.process.kill('SIGTERM');
                        activeFFmpeg.delete(cam.id);
                    }
                }, 5000);
            }
        });
        return;
    }

    // Spawn FFmpeg: RTSP → MJPEG frames on stdout
    const ffmpegArgs = [
        '-rtsp_transport', 'tcp',
        '-i', streamUrl,
        '-f', 'mjpeg',
        '-q:v', '5',         // JPEG quality (2=best, 31=worst)
        '-r', '15',           // 15 fps
        '-an',                // no audio
        '-vf', 'scale=640:-1', // scale down for bandwidth
        'pipe:1'
    ];

    const ffProcess = spawn('ffmpeg', ffmpegArgs, {
        stdio: ['ignore', 'pipe', 'pipe']
    });

    const clients = new Set([res]);
    activeFFmpeg.set(cam.id, { process: ffProcess, clients });

    // Parse MJPEG frames from FFmpeg stdout
    let buffer = Buffer.alloc(0);
    const SOI = Buffer.from([0xFF, 0xD8]); // JPEG start
    const EOI = Buffer.from([0xFF, 0xD9]); // JPEG end

    ffProcess.stdout.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);

        let soiIdx, eoiIdx;
        while (true) {
            soiIdx = buffer.indexOf(SOI);
            if (soiIdx === -1) break;
            eoiIdx = buffer.indexOf(EOI, soiIdx + 2);
            if (eoiIdx === -1) break;

            const frame = buffer.subarray(soiIdx, eoiIdx + 2);
            buffer = buffer.subarray(eoiIdx + 2);

            // Send frame to all connected clients
            const entry = activeFFmpeg.get(cam.id);
            if (entry) {
                for (const client of entry.clients) {
                    try {
                        client.write(`--${BOUNDARY}\r\n`);
                        client.write('Content-Type: image/jpeg\r\n');
                        client.write(`Content-Length: ${frame.length}\r\n\r\n`);
                        client.write(frame);
                        client.write('\r\n');
                    } catch { /* client disconnected */ }
                }
            }
        }

        // Prevent buffer from growing unbounded
        if (buffer.length > 2 * 1024 * 1024) {
            buffer = buffer.subarray(buffer.length - 512 * 1024);
        }
    });

    let stderrLog = '';
    ffProcess.stderr.on('data', (data) => {
        stderrLog += data.toString();
        // Only keep last 2KB of stderr
        if (stderrLog.length > 2048) stderrLog = stderrLog.slice(-2048);
    });

    ffProcess.on('error', (err) => {
        console.error(`FFmpeg spawn error for cam ${cam.id}:`, err.message);
        const entry = activeFFmpeg.get(cam.id);
        if (entry) {
            for (const client of entry.clients) {
                if (!client.headersSent) {
                    try { client.status(502).json({ error: 'FFmpeg not found. Install FFmpeg to enable RTSP streaming.' }); } catch {}
                }
            }
            activeFFmpeg.delete(cam.id);
        }
    });

    ffProcess.on('close', (code) => {
        const entry = activeFFmpeg.get(cam.id);
        if (entry) {
            activeFFmpeg.delete(cam.id);
            for (const client of entry.clients) {
                try { client.end(); } catch {}
            }
        }
        if (code !== 0 && code !== null) {
            console.error(`FFmpeg exited with code ${code} for cam ${cam.id}. Last stderr: ${stderrLog.slice(-500)}`);
        }
    });

    // Cleanup on client disconnect
    res.on('close', () => {
        const entry = activeFFmpeg.get(cam.id);
        if (entry) {
            entry.clients.delete(res);
            if (entry.clients.size === 0) {
                setTimeout(() => {
                    const e = activeFFmpeg.get(cam.id);
                    if (e && e.clients.size === 0) {
                        e.process.kill('SIGTERM');
                        activeFFmpeg.delete(cam.id);
                    }
                }, 5000);
            }
        }
    });
});

// GET /api/stream/probe/:cameraId — test if camera is reachable
router.get('/probe/:cameraId', auth, async (req, res) => {
    const cam = db.prepare('SELECT * FROM cameras WHERE id = ? AND user_id = ?').get(req.params.cameraId, req.userId);
    if (!cam) return res.status(404).json({ error: 'Camera not found' });
    if (!cam.cam_ip) return res.json({ online: false, reason: 'No IP configured' });

    const parsed = (() => { try { return new URL(`http://${cam.cam_ip}`); } catch { return null; } })();
    if (!parsed) return res.json({ online: false, reason: 'Invalid IP address' });

    // Test RTSP (554), HTTP, and ONVIF (8000) ports
    const testPort = (port) => new Promise((resolve) => {
        const sock = net.createConnection({ port, host: cam.cam_ip, timeout: 3000 });
        sock.on('connect', () => { sock.destroy(); resolve(true); });
        sock.on('error', () => { sock.destroy(); resolve(false); });
        sock.on('timeout', () => { sock.destroy(); resolve(false); });
    });

    const onvifPort = cam.onvif_port || 8000;
    const [httpOk, rtspOk, onvifOk] = await Promise.all([
        testPort(cam.cam_port || 80),
        testPort(554),
        testPort(onvifPort)
    ]);

    if (httpOk || rtspOk || onvifOk) {
        db.prepare('UPDATE cameras SET status = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?').run('active', cam.id);
        res.json({
            online: true,
            http_reachable: httpOk,
            rtsp_reachable: rtspOk,
            onvif_reachable: onvifOk,
            onvif_port: onvifPort,
            ptz_supported: onvifOk && cam.cam_brand === 'cpplus',
            rtsp_url: buildRtspInfo(cam),
            rtsp_stream: `/api/stream/rtsp/${cam.id}`,
            snapshot_url: `/api/stream/snapshot/${cam.id}`,
            mjpeg_url: `/api/stream/mjpeg/${cam.id}`
        });
    } else {
        db.prepare("UPDATE cameras SET status = 'offline' WHERE id = ?").run(cam.id);
        res.json({ online: false, reason: 'Camera unreachable — check IP address and network connection' });
    }
});

// ── ONVIF PTZ Control (WS-Security UsernameToken) ─────────────────────────────

function wsSecurityHeader(username, password) {
    const nonceBytes = crypto.randomBytes(16);
    const nonceB64 = nonceBytes.toString('base64');
    const created = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const digestInput = Buffer.concat([nonceBytes, Buffer.from(created), Buffer.from(password)]);
    const passwordDigest = crypto.createHash('sha1').update(digestInput).digest('base64');
    return `<wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">
      <wsse:UsernameToken>
        <wsse:Username>${username}</wsse:Username>
        <wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${passwordDigest}</wsse:Password>
        <wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonceB64}</wsse:Nonce>
        <wsu:Created>${created}</wsu:Created>
      </wsse:UsernameToken>
    </wsse:Security>`;
}

function onvifSoapRequest(host, port, path, soapBody, username, password) {
    return new Promise((resolve, reject) => {
        const envelope = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
            xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl"
            xmlns:tt="http://www.onvif.org/ver10/schema"
            xmlns:trt="http://www.onvif.org/ver10/media/wsdl">
  <s:Header>${wsSecurityHeader(username, password)}</s:Header>
  <s:Body>${soapBody}</s:Body>
</s:Envelope>`;

        const req = http.request({
            hostname: host, port, path, method: 'POST',
            headers: { 'Content-Type': 'application/soap+xml; charset=utf-8', 'Content-Length': Buffer.byteLength(envelope) },
            timeout: 5000,
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300 && !data.includes('ter:NotAuthorized')) {
                    resolve(data);
                } else if (data.includes('ter:NotAuthorized')) {
                    reject(new Error('ONVIF auth failed — check camera username/password'));
                } else {
                    // Extract SOAP fault reason if present
                    const reason = data.match(/<s:Text[^>]*>([^<]+)<\/s:Text>/)?.[1] || `HTTP ${res.statusCode}`;
                    reject(new Error(`ONVIF: ${reason}`));
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('ONVIF timeout')); });
        req.write(envelope);
        req.end();
    });
}

// Cache profile tokens per camera (they change on reboot)
const profileCache = new Map(); // camId -> { token, fetchedAt }

async function getProfileToken(cam) {
    const cached = profileCache.get(cam.id);
    if (cached && Date.now() - cached.fetchedAt < 3600000) return cached.token; // 1hr cache

    const onvifPort = cam.onvif_port || 8000;
    const user = cam.cam_username || 'admin';
    const pass = cam.cam_password || 'admin';

    const result = await onvifSoapRequest(cam.cam_ip, onvifPort, '/onvif/media_service',
        '<trt:GetProfiles/>', user, pass);
    const match = result.match(/token="([^"]+)"/);
    if (!match) throw new Error('No ONVIF profiles found');
    const token = match[1];
    profileCache.set(cam.id, { token, fetchedAt: Date.now() });
    return token;
}

// POST /api/stream/ptz/:cameraId/move — ONVIF ContinuousMove
router.post('/ptz/:cameraId/move', auth, async (req, res) => {
    const cam = db.prepare('SELECT * FROM cameras WHERE id = ? AND user_id = ?').get(req.params.cameraId, req.userId);
    if (!cam) return res.status(404).json({ error: 'Camera not found' });
    if (!cam.cam_ip) return res.status(400).json({ error: 'No IP configured' });

    const { x = 0, y = 0, zoom = 0 } = req.body;
    const duration = Math.min(Math.abs(req.body.duration || 500), 3000);
    const onvifPort = cam.onvif_port || 8000;
    const user = cam.cam_username || 'admin';
    const pass = cam.cam_password || 'admin';

    try {
        const profileToken = await getProfileToken(cam);
        const moveBody = `
    <tptz:ContinuousMove>
      <tptz:ProfileToken>${profileToken}</tptz:ProfileToken>
      <tptz:Velocity>
        <tt:PanTilt x="${x}" y="${y}"/>
        <tt:Zoom x="${zoom}"/>
      </tptz:Velocity>
    </tptz:ContinuousMove>`;

        await onvifSoapRequest(cam.cam_ip, onvifPort, '/onvif/ptz_service', moveBody, user, pass);
        // Auto-stop after duration
        setTimeout(async () => {
            try {
                const stopBody = `
                <tptz:Stop>
                  <tptz:ProfileToken>${profileToken}</tptz:ProfileToken>
                  <tptz:PanTilt>true</tptz:PanTilt>
                  <tptz:Zoom>true</tptz:Zoom>
                </tptz:Stop>`;
                await onvifSoapRequest(cam.cam_ip, onvifPort, '/onvif/ptz_service', stopBody, user, pass);
            } catch { /* ignore stop errors */ }
        }, duration);
        res.json({ ok: true });
    } catch (err) {
        res.status(502).json({ error: `PTZ error: ${err.message}` });
    }
});

// POST /api/stream/ptz/:cameraId/stop — ONVIF Stop
router.post('/ptz/:cameraId/stop', auth, async (req, res) => {
    const cam = db.prepare('SELECT * FROM cameras WHERE id = ? AND user_id = ?').get(req.params.cameraId, req.userId);
    if (!cam) return res.status(404).json({ error: 'Camera not found' });
    if (!cam.cam_ip) return res.status(400).json({ error: 'No IP configured' });

    const onvifPort = cam.onvif_port || 8000;
    const user = cam.cam_username || 'admin';
    const pass = cam.cam_password || 'admin';

    try {
        const profileToken = await getProfileToken(cam);
        const stopBody = `
    <tptz:Stop>
      <tptz:ProfileToken>${profileToken}</tptz:ProfileToken>
      <tptz:PanTilt>true</tptz:PanTilt>
      <tptz:Zoom>true</tptz:Zoom>
    </tptz:Stop>`;

        await onvifSoapRequest(cam.cam_ip, onvifPort, '/onvif/ptz_service', stopBody, user, pass);
        res.json({ ok: true });
    } catch (err) {
        res.status(502).json({ error: `PTZ stop error: ${err.message}` });
    }
});

// Helpers ———————————————————————————————————————————
function buildSnapshotUrl(cam) {
    const ip = cam.cam_ip;
    const port = cam.cam_port || 80;
    const base = `http://${ip}:${port}`;
    // Tapo cameras don't support HTTP snapshots — use RTSP frame grab via FFmpeg instead
    if (cam.cam_brand === 'tapo' || cam.cam_brand === 'tplink') return null;
    if (cam.cam_brand === 'cpplus') return `${base}/cgi-bin/snapshot.cgi?channel=0`;
    if (cam.cam_brand === 'hikvision') return `${base}/ISAPI/Streaming/channels/101/picture`;
    if (cam.cam_brand === 'dahua') return `${base}/cgi-bin/snapshot.cgi`;
    if (cam.stream_url) return cam.stream_url; // custom URL
    return `${base}/cgi-bin/snapshot.cgi`; // generic fallback
}

function buildMjpegUrl(cam) {
    const ip = cam.cam_ip;
    const port = cam.cam_port || 80;
    const base = `http://${ip}:${port}`;
    if (cam.cam_brand === 'cpplus') return `${base}/cgi-bin/mjpeg?stream=0`;
    if (cam.cam_brand === 'hikvision') return `${base}/ISAPI/Streaming/channels/101/httppreview`;
    if (cam.cam_brand === 'dahua') return `${base}/cgi-bin/mjpg/video.cgi?channel=0&subtype=0`;
    if (cam.stream_url) return cam.stream_url;
    return `${base}/video.mjpeg`;
}

function buildRtspInfo(cam) {
    if (!cam.cam_ip) return null;
    // URL-encode credentials to handle special chars like @ in usernames/passwords
    const user = encodeURIComponent(cam.cam_username || 'admin');
    const pass = encodeURIComponent(cam.cam_password || 'admin');
    const ip = cam.cam_ip;
    if (cam.cam_brand === 'tapo' || cam.cam_brand === 'tplink') return `rtsp://${user}:${pass}@${ip}:554/stream1`;
    if (cam.cam_brand === 'cpplus') return `rtsp://${user}:${pass}@${ip}:554/cam/realmonitor?channel=1&subtype=0`;
    if (cam.cam_brand === 'hikvision') return `rtsp://${user}:${pass}@${ip}:554/Streaming/Channels/101`;
    if (cam.cam_brand === 'dahua') return `rtsp://${user}:${pass}@${ip}:554/cam/realmonitor?channel=1&subtype=0`;
    return `rtsp://${user}:${pass}@${ip}:554/`;
}

// Cleanup all FFmpeg processes on shutdown
function cleanupStreams() {
    for (const [camId, entry] of activeFFmpeg) {
        if (entry.process && !entry.process.killed) {
            entry.process.kill('SIGTERM');
        }
    }
    activeFFmpeg.clear();
}

module.exports = { router, buildRtspInfo, cleanupStreams };

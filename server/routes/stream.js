const express = require('express');
const router = express.Router();
const http = require('http');
const https = require('https');
const db = require('../database');
const { auth } = require('./auth');

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

// GET /api/stream/probe/:cameraId — test if camera is reachable
router.get('/probe/:cameraId', auth, async (req, res) => {
    const cam = db.prepare('SELECT * FROM cameras WHERE id = ? AND user_id = ?').get(req.params.cameraId, req.userId);
    if (!cam) return res.status(404).json({ error: 'Camera not found' });
    if (!cam.cam_ip) return res.json({ online: false, reason: 'No IP configured' });

    const parsed = (() => { try { return new URL(`http://${cam.cam_ip}`); } catch { return null; } })();
    if (!parsed) return res.json({ online: false, reason: 'Invalid IP address' });

    const socket = require('net').createConnection({ port: cam.cam_port || 80, host: cam.cam_ip, timeout: 3000 });
    socket.on('connect', () => {
        socket.destroy();
        // Update last_seen
        db.prepare('UPDATE cameras SET status = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?').run('active', cam.id);
        res.json({ online: true, rtsp_url: buildRtspInfo(cam), snapshot_url: `/api/stream/snapshot/${cam.id}`, mjpeg_url: `/api/stream/mjpeg/${cam.id}` });
    });
    socket.on('error', () => {
        socket.destroy();
        db.prepare("UPDATE cameras SET status = 'offline' WHERE id = ?").run(cam.id);
        res.json({ online: false, reason: 'Port unreachable — check camera IP and network' });
    });
    socket.on('timeout', () => {
        socket.destroy();
        res.json({ online: false, reason: 'Connection timeout' });
    });
});

// Helpers ———————————————————————————————————————————
function buildSnapshotUrl(cam) {
    const ip = cam.cam_ip;
    const port = cam.cam_port || 80;
    const base = `http://${ip}:${port}`;
    // CP Plus specific first, then generic fallback
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
    const user = cam.cam_username || 'admin';
    const pass = cam.cam_password || 'admin';
    const ip = cam.cam_ip;
    if (cam.cam_brand === 'cpplus') return `rtsp://${user}:${pass}@${ip}:554/cam/realmonitor?channel=1&subtype=0`;
    if (cam.cam_brand === 'hikvision') return `rtsp://${user}:${pass}@${ip}:554/Streaming/Channels/101`;
    if (cam.cam_brand === 'dahua') return `rtsp://${user}:${pass}@${ip}:554/cam/realmonitor?channel=1&subtype=0`;
    return `rtsp://${user}:${pass}@${ip}:554/`;
}

module.exports = { router, buildRtspInfo };

const express = require('express');
const router = express.Router();
const db = require('../database');
const { auth } = require('./auth');
const path = require('path');
const fs = require('fs');

const snapshotsDir = path.join(__dirname, '..', '..', 'uploads', 'snapshots');
if (!fs.existsSync(snapshotsDir)) fs.mkdirSync(snapshotsDir, { recursive: true });

// GET /api/cameras
router.get('/', auth, (req, res) => {
    const cameras = db.prepare('SELECT * FROM cameras WHERE user_id = ? ORDER BY name').all(req.userId);
    res.json(cameras);
});

// POST /api/cameras
router.post('/', auth, (req, res) => {
    const { name, location, zone, stream_url, sensitivity, source_type,
        cam_ip, cam_port, cam_username, cam_password, cam_brand, onvif_port } = req.body;
    if (!name || !location || !zone) return res.status(400).json({ error: 'Name, location and zone required' });
    const result = db.prepare(`
        INSERT INTO cameras (user_id, name, location, zone, stream_url, sensitivity, source_type,
            cam_ip, cam_port, cam_username, cam_password, cam_brand, onvif_port)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(req.userId, name, location, zone, stream_url || '', sensitivity || 'medium',
        source_type || 'simulated', cam_ip || null, cam_port || 80,
        cam_username || 'admin', cam_password || 'admin', cam_brand || 'generic',
        onvif_port || 8000);
    res.json({ id: result.lastInsertRowid, message: 'Camera added' });
});

// PUT /api/cameras/:id
router.put('/:id', auth, (req, res) => {
    const { name, location, zone, status, sensitivity, stream_url, source_type,
        cam_ip, cam_port, cam_username, cam_password, cam_brand, onvif_port } = req.body;
    const cam = db.prepare('SELECT id FROM cameras WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
    if (!cam) return res.status(404).json({ error: 'Camera not found' });
    db.prepare(`
        UPDATE cameras SET name=?, location=?, zone=?, status=?, sensitivity=?, stream_url=?, source_type=?,
            cam_ip=?, cam_port=?, cam_username=?, cam_password=?, cam_brand=?, onvif_port=?
        WHERE id=?
    `).run(name, location, zone, status || 'active', sensitivity, stream_url || '',
        source_type || 'simulated', cam_ip || null, cam_port || 80,
        cam_username || 'admin', cam_password || 'admin', cam_brand || 'generic',
        onvif_port || 8000, req.params.id);
    res.json({ message: 'Camera updated' });
});

// DELETE /api/cameras/:id
router.delete('/:id', auth, (req, res) => {
    const cam = db.prepare('SELECT id FROM cameras WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
    if (!cam) return res.status(404).json({ error: 'Camera not found' });
    db.prepare('DELETE FROM cameras WHERE id = ?').run(req.params.id);
    res.json({ message: 'Camera deleted' });
});

// POST /api/cameras/:id/snapshot  — saves base64 snapshot from browser
router.post('/:id/snapshot', auth, (req, res) => {
    const cam = db.prepare('SELECT id FROM cameras WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
    if (!cam) return res.status(404).json({ error: 'Camera not found' });

    const { dataUrl, trigger } = req.body;  // trigger: 'manual' | 'motion'
    if (!dataUrl || !dataUrl.startsWith('data:image')) {
        return res.status(400).json({ error: 'Invalid image data' });
    }

    const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, '');
    const filename = `cam${req.params.id}_${Date.now()}.jpg`;
    const filepath = path.join(snapshotsDir, filename);

    try {
        fs.writeFileSync(filepath, Buffer.from(base64Data, 'base64'));
        const snapshotUrl = `/uploads/snapshots/${filename}`;

        // Update camera last_seen
        db.prepare('UPDATE cameras SET last_seen = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);

        // Log to activity
        db.prepare(
            'INSERT INTO activity_logs (user_id, camera_id, event_type, description, snapshot) VALUES (?,?,?,?,?)'
        ).run(req.userId, req.params.id, trigger === 'motion' ? 'motion_detected' : 'snapshot_taken',
            trigger === 'motion' ? 'Motion detected — automatic snapshot saved' : 'Manual snapshot captured',
            snapshotUrl);

        // If motion trigger, auto-create an open incident
        if (trigger === 'motion') {
            const incId = db.prepare(`
        INSERT INTO incidents (user_id, camera_id, type, severity, title, description, snapshot, ai_confidence, status)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).run(req.userId, req.params.id, 'motion_detected', 'low',
                'Motion Alert — Snapshot Captured',
                `Automatic motion detection triggered a snapshot from camera #${req.params.id}.`,
                snapshotUrl, 0.82, 'open').lastInsertRowid;

            db.prepare('INSERT INTO alerts (user_id, incident_id, type, message) VALUES (?,?,?,?)').run(
                req.userId, incId, 'low', `📷 Motion snapshot saved from camera`
            );
        }

        res.json({ snapshot: snapshotUrl, message: 'Snapshot saved' });
    } catch (err) {
        console.error('Snapshot save error:', err);
        res.status(500).json({ error: 'Failed to save snapshot' });
    }
});

// GET /api/cameras/:id/snapshots
router.get('/:id/snapshots', auth, (req, res) => {
    const cam = db.prepare('SELECT id FROM cameras WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
    if (!cam) return res.status(404).json({ error: 'Camera not found' });
    const logs = db.prepare(
        "SELECT * FROM activity_logs WHERE camera_id = ? AND snapshot IS NOT NULL ORDER BY created_at DESC LIMIT 20"
    ).all(req.params.id);
    res.json(logs);
});

// GET /api/cameras/rtsp-list — list real cameras with RTSP URLs (for AI detector)
// Authenticated via X-API-Key header
const AI_API_KEY = process.env.AI_API_KEY || 'camsarathi-ai-key-2024';
const { buildRtspInfo } = require('./stream');

router.get('/rtsp-list', (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== AI_API_KEY) {
        return res.status(401).json({ error: 'Invalid API key' });
    }

    const cameras = db.prepare(
        "SELECT * FROM cameras WHERE source_type != 'simulated' AND cam_ip IS NOT NULL AND status = 'active'"
    ).all();

    const result = cameras.map(cam => ({
        id: cam.id,
        name: cam.name,
        location: cam.location,
        brand: cam.cam_brand,
        rtsp_url: buildRtspInfo(cam),
    })).filter(c => c.rtsp_url);

    res.json({ cameras: result });
});

module.exports = router;

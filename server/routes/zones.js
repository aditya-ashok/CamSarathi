const express = require('express');
const router = express.Router();
const db = require('../database');
const { auth } = require('./auth');

const AI_API_KEY = process.env.AI_API_KEY || 'camsarathi-ai-key-2024';

// GET /api/zones/:cameraId — list zones for a camera (supports both auth and API key)
router.get('/:cameraId', (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey === AI_API_KEY) {
        const zones = db.prepare('SELECT * FROM detection_zones WHERE camera_id = ? AND active = 1').all(req.params.cameraId);
        return res.json({ zones });
    }
    // Fall through to auth middleware
    auth(req, res, () => {
        const zones = db.prepare('SELECT * FROM detection_zones WHERE camera_id = ? AND user_id = ?').all(req.params.cameraId, req.userId);
        res.json({ zones });
    });
});

// POST /api/zones — create a zone
router.post('/', auth, (req, res) => {
    const { camera_id, name, zone_type, polygon, alert_on, color } = req.body;
    if (!camera_id || !name || !polygon) {
        return res.status(400).json({ error: 'camera_id, name, and polygon are required' });
    }
    const cam = db.prepare('SELECT id FROM cameras WHERE id = ? AND user_id = ?').get(camera_id, req.userId);
    if (!cam) return res.status(404).json({ error: 'Camera not found' });

    const polyStr = typeof polygon === 'string' ? polygon : JSON.stringify(polygon);
    const result = db.prepare(`
        INSERT INTO detection_zones (camera_id, user_id, name, zone_type, polygon, alert_on, color)
        VALUES (?,?,?,?,?,?,?)
    `).run(camera_id, req.userId, name, zone_type || 'restricted', polyStr, alert_on || 'enter', color || '#ff4757');

    res.json({ id: result.lastInsertRowid, message: 'Zone created' });
});

// PUT /api/zones/:id — update a zone
router.put('/:id', auth, (req, res) => {
    const zone = db.prepare('SELECT id FROM detection_zones WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
    if (!zone) return res.status(404).json({ error: 'Zone not found' });

    const { name, zone_type, polygon, alert_on, color, active } = req.body;
    const polyStr = polygon ? (typeof polygon === 'string' ? polygon : JSON.stringify(polygon)) : undefined;

    db.prepare(`
        UPDATE detection_zones SET
            name = COALESCE(?, name),
            zone_type = COALESCE(?, zone_type),
            polygon = COALESCE(?, polygon),
            alert_on = COALESCE(?, alert_on),
            color = COALESCE(?, color),
            active = COALESCE(?, active)
        WHERE id = ?
    `).run(name, zone_type, polyStr, alert_on, color, active, req.params.id);

    res.json({ message: 'Zone updated' });
});

// DELETE /api/zones/:id — delete a zone
router.delete('/:id', auth, (req, res) => {
    const zone = db.prepare('SELECT id FROM detection_zones WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
    if (!zone) return res.status(404).json({ error: 'Zone not found' });
    db.prepare('DELETE FROM detection_zones WHERE id = ?').run(req.params.id);
    res.json({ message: 'Zone deleted' });
});

module.exports = router;

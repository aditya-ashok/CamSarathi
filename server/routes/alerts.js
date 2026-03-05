const express = require('express');
const router = express.Router();
const db = require('../database');
const { auth } = require('./auth');

// GET /api/alerts
router.get('/', auth, (req, res) => {
    const alerts = db.prepare(`
    SELECT a.*, i.type as incident_type, i.location as incident_location
    FROM alerts a
    LEFT JOIN incidents i ON a.incident_id = i.id
    LEFT JOIN cameras c ON i.camera_id = c.id
    WHERE a.user_id = ? AND (c.source_type IS NULL OR c.source_type != 'simulated')
    ORDER BY a.sent_at DESC LIMIT 50
  `).all(req.userId);
    const unread = db.prepare(`
    SELECT COUNT(*) as c FROM alerts a
    LEFT JOIN incidents i ON a.incident_id = i.id
    LEFT JOIN cameras c ON i.camera_id = c.id
    WHERE a.user_id = ? AND a.read = 0 AND (c.source_type IS NULL OR c.source_type != 'simulated')
  `).get(req.userId).c;
    res.json({ alerts, unread });
});

// PATCH /api/alerts/:id/read
router.patch('/:id/read', auth, (req, res) => {
    db.prepare('UPDATE alerts SET read = 1 WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
    res.json({ message: 'Marked as read' });
});

// PATCH /api/alerts/read-all
router.patch('/read-all', auth, (req, res) => {
    db.prepare('UPDATE alerts SET read = 1 WHERE user_id = ?').run(req.userId);
    res.json({ message: 'All alerts marked as read' });
});

module.exports = router;

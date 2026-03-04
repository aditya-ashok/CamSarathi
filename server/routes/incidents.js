const express = require('express');
const router = express.Router();
const db = require('../database');
const { auth } = require('./auth');

// GET /api/incidents
router.get('/', auth, (req, res) => {
    const { type, severity, status, limit = 50, offset = 0 } = req.query;
    let query = `
    SELECT i.*, s.name as staff_name, s.role as staff_role, c.name as camera_name, c.zone as camera_zone
    FROM incidents i
    LEFT JOIN staff s ON i.staff_id = s.id
    LEFT JOIN cameras c ON i.camera_id = c.id
    WHERE i.user_id = ?
  `;
    const params = [req.userId];
    if (type) { query += ' AND i.type = ?'; params.push(type); }
    if (severity) { query += ' AND i.severity = ?'; params.push(severity); }
    if (status) { query += ' AND i.status = ?'; params.push(status); }
    query += ' ORDER BY i.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const incidents = db.prepare(query).all(...params);
    const total = db.prepare(`SELECT COUNT(*) as count FROM incidents WHERE user_id = ?`).get(req.userId).count;
    res.json({ incidents, total });
});

// GET /api/incidents/:id
router.get('/:id', auth, (req, res) => {
    const incident = db.prepare(`
    SELECT i.*, s.name as staff_name, s.role as staff_role, s.phone as staff_phone, s.trust_score,
      c.name as camera_name, c.zone as camera_zone, c.location as camera_location
    FROM incidents i
    LEFT JOIN staff s ON i.staff_id = s.id
    LEFT JOIN cameras c ON i.camera_id = c.id
    WHERE i.id = ? AND i.user_id = ?
  `).get(req.params.id, req.userId);
    if (!incident) return res.status(404).json({ error: 'Incident not found' });

    const analyses = db.prepare('SELECT * FROM ai_analyses WHERE incident_id = ?').all(req.params.id);
    res.json({ ...incident, analyses });
});

// POST /api/incidents (Report new incident)
router.post('/', auth, (req, res) => {
    const { camera_id, staff_id, type, severity, title, description, location, ai_confidence } = req.body;
    if (!type || !title) return res.status(400).json({ error: 'Type and title required' });

    const result = db.prepare(`
    INSERT INTO incidents (user_id, camera_id, staff_id, type, severity, title, description, location, ai_confidence, status)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(req.userId, camera_id, staff_id, type, severity || 'low', title, description || '', location || '', ai_confidence || 0, 'open');

    const incidentId = result.lastInsertRowid;

    // Auto-create alert
    db.prepare('INSERT INTO alerts (user_id, incident_id, type, message) VALUES (?,?,?,?)').run(
        req.userId, incidentId, severity || 'low', `🚨 New ${type} incident: ${title}`
    );

    // Reduce trust score if staff involved
    if (staff_id) {
        const deduction = severity === 'high' ? 20 : severity === 'medium' ? 10 : 5;
        db.prepare('UPDATE staff SET trust_score = MAX(0, trust_score - ?) WHERE id = ?').run(deduction, staff_id);
    }

    res.json({ id: incidentId, message: 'Incident reported' });
});

// PATCH /api/incidents/:id/resolve
router.patch('/:id/resolve', auth, (req, res) => {
    const { action_taken } = req.body;
    const incident = db.prepare('SELECT id, staff_id FROM incidents WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
    if (!incident) return res.status(404).json({ error: 'Incident not found' });
    db.prepare(`
    UPDATE incidents SET status = 'resolved', reviewed_at = CURRENT_TIMESTAMP, action_taken = ? WHERE id = ?
  `).run(action_taken || '', req.params.id);
    res.json({ message: 'Incident resolved' });
});

// GET /api/incidents/stats/summary
router.get('/stats/summary', auth, (req, res) => {
    const stats = {
        total: db.prepare('SELECT COUNT(*) as c FROM incidents WHERE user_id = ?').get(req.userId).c,
        open: db.prepare("SELECT COUNT(*) as c FROM incidents WHERE user_id = ? AND status = 'open'").get(req.userId).c,
        today: db.prepare("SELECT COUNT(*) as c FROM incidents WHERE user_id = ? AND date(created_at) = date('now')").get(req.userId).c,
        high_severity: db.prepare("SELECT COUNT(*) as c FROM incidents WHERE user_id = ? AND severity = 'high'").get(req.userId).c,
        by_type: db.prepare("SELECT type, COUNT(*) as count FROM incidents WHERE user_id = ? GROUP BY type").all(req.userId),
        by_location: db.prepare("SELECT location, COUNT(*) as count FROM incidents WHERE user_id = ? GROUP BY location").all(req.userId),
        recent_7_days: db.prepare("SELECT date(created_at) as day, COUNT(*) as count FROM incidents WHERE user_id = ? AND created_at >= datetime('now', '-7 days') GROUP BY day ORDER BY day").all(req.userId),
    };
    res.json(stats);
});

module.exports = router;

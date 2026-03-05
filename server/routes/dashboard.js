const express = require('express');
const router = express.Router();
const db = require('../database');
const { auth } = require('./auth');

// GET /api/dashboard
router.get('/', auth, (req, res) => {
    const uid = req.userId;

    const stats = {
        cameras: {
            total: db.prepare('SELECT COUNT(*) as c FROM cameras WHERE user_id = ?').get(uid).c,
            active: db.prepare("SELECT COUNT(*) as c FROM cameras WHERE user_id = ? AND status = 'active'").get(uid).c,
        },
        staff: {
            total: db.prepare("SELECT COUNT(*) as c FROM staff WHERE user_id = ? AND status = 'active'").get(uid).c,
            terminated: db.prepare("SELECT COUNT(*) as c FROM staff WHERE user_id = ? AND status = 'terminated'").get(uid).c,
        },
        incidents: {
            total: db.prepare("SELECT COUNT(*) as c FROM incidents i LEFT JOIN cameras c ON i.camera_id = c.id WHERE i.user_id = ? AND (c.source_type IS NULL OR c.source_type != 'simulated')").get(uid).c,
            open: db.prepare("SELECT COUNT(*) as c FROM incidents i LEFT JOIN cameras c ON i.camera_id = c.id WHERE i.user_id = ? AND i.status = 'open' AND (c.source_type IS NULL OR c.source_type != 'simulated')").get(uid).c,
            today: db.prepare("SELECT COUNT(*) as c FROM incidents i LEFT JOIN cameras c ON i.camera_id = c.id WHERE i.user_id = ? AND date(i.created_at) = date('now') AND (c.source_type IS NULL OR c.source_type != 'simulated')").get(uid).c,
            high_severity: db.prepare("SELECT COUNT(*) as c FROM incidents i LEFT JOIN cameras c ON i.camera_id = c.id WHERE i.user_id = ? AND i.severity = 'high' AND i.status = 'open' AND (c.source_type IS NULL OR c.source_type != 'simulated')").get(uid).c,
        },
        alerts: {
            unread: db.prepare("SELECT COUNT(*) as c FROM alerts a LEFT JOIN incidents i ON a.incident_id = i.id LEFT JOIN cameras c ON i.camera_id = c.id WHERE a.user_id = ? AND a.read = 0 AND (c.source_type IS NULL OR c.source_type != 'simulated')").get(uid).c,
        },
        inventory: {
            total: db.prepare('SELECT COUNT(*) as c FROM inventory_items WHERE user_id = ?').get(uid).c,
            low: db.prepare("SELECT COUNT(*) as c FROM inventory_items WHERE user_id = ? AND status = 'low'").get(uid).c,
        }
    };

    const recent_incidents = db.prepare(`
    SELECT i.*, s.name as staff_name, c.name as camera_name
    FROM incidents i
    LEFT JOIN staff s ON i.staff_id = s.id
    LEFT JOIN cameras c ON i.camera_id = c.id
    WHERE i.user_id = ? AND (c.source_type IS NULL OR c.source_type != 'simulated')
    ORDER BY i.created_at DESC LIMIT 5
  `).all(uid);

    const recent_alerts = db.prepare(`
    SELECT a.* FROM alerts a
    LEFT JOIN incidents i ON a.incident_id = i.id
    LEFT JOIN cameras c ON i.camera_id = c.id
    WHERE a.user_id = ? AND (c.source_type IS NULL OR c.source_type != 'simulated')
    ORDER BY a.sent_at DESC LIMIT 5
  `).all(uid);

    const staff_list = db.prepare(`
    SELECT s.id, s.name, s.role, s.trust_score, s.status,
      (SELECT COUNT(*) FROM incidents WHERE staff_id = s.id AND status = 'open') as open_incidents
    FROM staff s WHERE s.user_id = ? ORDER BY s.trust_score ASC LIMIT 5
  `).all(uid);

    const timeline_7days = db.prepare(`
    SELECT date(created_at) as day, COUNT(*) as count, severity
    FROM incidents WHERE user_id = ? AND created_at >= datetime('now', '-7 days')
    GROUP BY day, severity ORDER BY day
  `).all(uid);

    const recent_activity = db.prepare(`
    SELECT al.*, s.name as staff_name, c.name as camera_name
    FROM activity_logs al
    LEFT JOIN staff s ON al.staff_id = s.id
    LEFT JOIN cameras c ON al.camera_id = c.id
    WHERE al.user_id = ? AND (c.source_type IS NULL OR c.source_type != 'simulated')
    ORDER BY al.created_at DESC LIMIT 10
  `).all(uid);

    res.json({ stats, recent_incidents, recent_alerts, staff_list, timeline_7days, recent_activity });
});

// POST /api/dashboard/simulate-ai-event (Simulate AI detecting something)
router.post('/simulate-ai-event', auth, (req, res) => {
    const uid = req.userId;
    const events = [
        { type: 'theft', severity: 'high', title: 'Food Item Removed from Refrigerator', description: 'AI detected an unauthorized removal of food items from the refrigerator. Staff member seen placing items in personal bag.', location: 'Kitchen', ai_confidence: 0.92 },
        { type: 'hygiene', severity: 'medium', title: 'Hygiene Alert: Hand Wash Protocol Skipped', description: 'Staff member skipped mandatory hand-washing before food preparation. Cross-contamination risk detected.', location: 'Kitchen', ai_confidence: 0.85 },
        { type: 'unauthorized_access', severity: 'high', title: 'Unauthorized Zone Entry', description: 'Staff entered a restricted area (Bedroom) without authorization during owner absence.', location: 'Bedroom', ai_confidence: 0.97 },
        { type: 'unusual_behavior', severity: 'low', title: 'Extended Phone Usage During Work Hours', description: 'Staff detected on personal phone for more than 20 minutes during paid work hours.', location: 'Living Room', ai_confidence: 0.78 },
        { type: 'motion_detected', severity: 'low', title: 'Unusual Motion After Shift Hours', description: 'Motion detected in kitchen area 2 hours after staff shift ended.', location: 'Kitchen', ai_confidence: 0.88 },
    ];

    const event = events[Math.floor(Math.random() * events.length)];
    const staff = db.prepare("SELECT id FROM staff WHERE user_id = ? AND status = 'active' ORDER BY RANDOM() LIMIT 1").get(uid);
    const camera = db.prepare("SELECT id FROM cameras WHERE user_id = ? AND source_type != 'simulated' ORDER BY RANDOM() LIMIT 1").get(uid);
    if (!camera) return res.status(400).json({ error: 'No real cameras found. Add an IP or webcam camera first.' });

    const incId = db.prepare(`
    INSERT INTO incidents (user_id, camera_id, staff_id, type, severity, title, description, location, ai_confidence, status)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(uid, camera?.id, staff?.id, event.type, event.severity, event.title, event.description, event.location, event.ai_confidence, 'open').lastInsertRowid;

    db.prepare('INSERT INTO alerts (user_id, incident_id, type, message) VALUES (?,?,?,?)').run(uid, incId, event.severity, `🚨 AI Alert: ${event.title}`);

    if (staff?.id) {
        const deduction = event.severity === 'high' ? 20 : event.severity === 'medium' ? 10 : 5;
        db.prepare('UPDATE staff SET trust_score = MAX(0, trust_score - ?) WHERE id = ?').run(deduction, staff.id);
    }

    res.json({ message: 'AI event simulated', incident: { id: incId, ...event } });
});

module.exports = router;

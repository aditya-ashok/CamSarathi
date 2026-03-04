const express = require('express');
const router = express.Router();
const db = require('../database');
const { auth } = require('./auth');

// GET /api/staff
router.get('/', auth, (req, res) => {
    const staff = db.prepare(`
    SELECT s.*, 
      (SELECT COUNT(*) FROM incidents WHERE staff_id = s.id) as incident_count,
      (SELECT COUNT(*) FROM incidents WHERE staff_id = s.id AND status = 'open') as open_incidents
    FROM staff s WHERE s.user_id = ? ORDER BY s.name
  `).all(req.userId);
    res.json(staff);
});

// GET /api/staff/:id
router.get('/:id', auth, (req, res) => {
    const staff = db.prepare('SELECT * FROM staff WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
    if (!staff) return res.status(404).json({ error: 'Staff not found' });
    const incidents = db.prepare('SELECT * FROM incidents WHERE staff_id = ? ORDER BY created_at DESC LIMIT 10').all(req.params.id);
    const zones = db.prepare('SELECT * FROM staff_access_zones WHERE staff_id = ?').all(req.params.id);
    res.json({ ...staff, incidents, zones });
});

// POST /api/staff
router.post('/', auth, (req, res) => {
    const { name, role, phone, shift_start, shift_end, salary, hired_date, notes } = req.body;
    if (!name || !role) return res.status(400).json({ error: 'Name and role required' });
    const result = db.prepare(`
    INSERT INTO staff (user_id, name, role, phone, shift_start, shift_end, salary, hired_date, notes)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(req.userId, name, role, phone || '', shift_start || '08:00', shift_end || '17:00', salary || 0, hired_date || '', notes || '');
    res.json({ id: result.lastInsertRowid, message: 'Staff added' });
});

// PUT /api/staff/:id
router.put('/:id', auth, (req, res) => {
    const { name, role, phone, status, shift_start, shift_end, salary, notes, trust_score } = req.body;
    const staff = db.prepare('SELECT id FROM staff WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
    if (!staff) return res.status(404).json({ error: 'Staff not found' });
    db.prepare(`
    UPDATE staff SET name=?, role=?, phone=?, status=?, shift_start=?, shift_end=?, salary=?, notes=?, trust_score=?
    WHERE id=?
  `).run(name, role, phone, status, shift_start, shift_end, salary, notes, trust_score, req.params.id);
    res.json({ message: 'Staff updated' });
});

// DELETE /api/staff/:id (terminate/fire)
router.delete('/:id', auth, (req, res) => {
    const staff = db.prepare('SELECT id FROM staff WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
    if (!staff) return res.status(404).json({ error: 'Staff not found' });
    db.prepare("UPDATE staff SET status = 'terminated' WHERE id = ?").run(req.params.id);
    res.json({ message: 'Staff terminated' });
});

// GET /api/staff/:id/incidents
router.get('/:id/incidents', auth, (req, res) => {
    const staff = db.prepare('SELECT id FROM staff WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
    if (!staff) return res.status(404).json({ error: 'Staff not found' });
    const incidents = db.prepare('SELECT * FROM incidents WHERE staff_id = ? ORDER BY created_at DESC').all(req.params.id);
    res.json(incidents);
});

module.exports = router;

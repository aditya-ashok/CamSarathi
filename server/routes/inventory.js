const express = require('express');
const router = express.Router();
const db = require('../database');
const { auth } = require('./auth');

// GET /api/inventory
router.get('/', auth, (req, res) => {
    const items = db.prepare('SELECT * FROM inventory_items WHERE user_id = ? ORDER BY category, name').all(req.userId);
    res.json(items);
});

// POST /api/inventory
router.post('/', auth, (req, res) => {
    const { name, category, quantity, unit, location } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const result = db.prepare('INSERT INTO inventory_items (user_id, name, category, quantity, unit, location) VALUES (?,?,?,?,?,?)').run(req.userId, name, category || 'food', quantity || 1, unit || 'pcs', location || 'fridge');
    res.json({ id: result.lastInsertRowid, message: 'Item added' });
});

// PUT /api/inventory/:id
router.put('/:id', auth, (req, res) => {
    const { name, quantity, unit, location, status } = req.body;
    const item = db.prepare('SELECT id FROM inventory_items WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    db.prepare('UPDATE inventory_items SET name=?, quantity=?, unit=?, location=?, status=?, last_checked=CURRENT_TIMESTAMP WHERE id=?').run(name, quantity, unit, location, status, req.params.id);
    res.json({ message: 'Item updated' });
});

// DELETE /api/inventory/:id
router.delete('/:id', auth, (req, res) => {
    const item = db.prepare('SELECT id FROM inventory_items WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    db.prepare('DELETE FROM inventory_items WHERE id = ?').run(req.params.id);
    res.json({ message: 'Item deleted' });
});

module.exports = router;

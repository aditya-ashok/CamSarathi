const express = require('express');
const router = express.Router();
const db = require('../database');
const { auth } = require('./auth');
const path = require('path');
const fs = require('fs');

const AI_API_KEY = process.env.AI_API_KEY || 'camsarathi-ai-key-2024';
const facesDir = path.join(__dirname, '..', '..', 'uploads', 'faces');
if (!fs.existsSync(facesDir)) fs.mkdirSync(facesDir, { recursive: true });

// GET /api/faces — list known faces (supports both auth and API key)
router.get('/', (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey === AI_API_KEY) {
        const faces = db.prepare('SELECT * FROM known_faces ORDER BY name').all();
        return res.json({ faces });
    }
    auth(req, res, () => {
        const faces = db.prepare('SELECT * FROM known_faces WHERE user_id = ? ORDER BY name').all(req.userId);
        res.json({ faces });
    });
});

// POST /api/faces — register a known face
router.post('/', auth, (req, res) => {
    const { name, role, photo, encoding } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const encStr = encoding ? (typeof encoding === 'string' ? encoding : JSON.stringify(encoding)) : null;
    const result = db.prepare(`
        INSERT INTO known_faces (user_id, name, role, photo, encoding) VALUES (?,?,?,?,?)
    `).run(req.userId, name, role || null, photo || null, encStr);

    res.json({ id: result.lastInsertRowid, message: 'Face registered' });
});

// POST /api/faces/:id/encoding — update face encoding (called by Python after extracting from photo)
router.post('/:id/encoding', (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== AI_API_KEY) return res.status(401).json({ error: 'Invalid API key' });

    const { encoding } = req.body;
    if (!encoding) return res.status(400).json({ error: 'Encoding is required' });

    const encStr = typeof encoding === 'string' ? encoding : JSON.stringify(encoding);
    db.prepare('UPDATE known_faces SET encoding = ? WHERE id = ?').run(encStr, req.params.id);
    res.json({ message: 'Encoding updated' });
});

// POST /api/faces/sighting — log a face sighting (called by Python detector)
router.post('/sighting', (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== AI_API_KEY) return res.status(401).json({ error: 'Invalid API key' });

    const { camera_id, known_face_id, snapshot, confidence } = req.body;
    db.prepare(`
        INSERT INTO face_sightings (camera_id, known_face_id, snapshot, confidence) VALUES (?,?,?,?)
    `).run(camera_id, known_face_id || null, snapshot || null, confidence || 0);

    res.json({ message: 'Sighting logged' });
});

// GET /api/faces/sightings — recent face sightings
router.get('/sightings', auth, (req, res) => {
    const { camera_id, date, limit } = req.query;
    let query = `
        SELECT fs.*, kf.name, kf.role, kf.photo as known_photo, c.name as camera_name
        FROM face_sightings fs
        LEFT JOIN known_faces kf ON fs.known_face_id = kf.id
        LEFT JOIN cameras c ON fs.camera_id = c.id
        WHERE c.user_id = ?
    `;
    const params = [req.userId];

    if (camera_id) { query += ' AND fs.camera_id = ?'; params.push(camera_id); }
    if (date) { query += ' AND date(fs.created_at) = ?'; params.push(date); }
    query += ` ORDER BY fs.created_at DESC LIMIT ?`;
    params.push(parseInt(limit) || 50);

    const sightings = db.prepare(query).all(...params);
    res.json({ sightings });
});

// DELETE /api/faces/:id — remove a known face
router.delete('/:id', auth, (req, res) => {
    const face = db.prepare('SELECT id FROM known_faces WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
    if (!face) return res.status(404).json({ error: 'Face not found' });
    db.prepare('DELETE FROM known_faces WHERE id = ?').run(req.params.id);
    res.json({ message: 'Face removed' });
});

// POST /api/faces/:id/photo — upload face photo (base64)
router.post('/:id/photo', auth, (req, res) => {
    const face = db.prepare('SELECT id FROM known_faces WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
    if (!face) return res.status(404).json({ error: 'Face not found' });

    const { dataUrl } = req.body;
    if (!dataUrl || !dataUrl.startsWith('data:image')) {
        return res.status(400).json({ error: 'Invalid image data' });
    }

    const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, '');
    const filename = `known_face_${req.params.id}.jpg`;
    const filepath = path.join(facesDir, filename);
    fs.writeFileSync(filepath, Buffer.from(base64Data, 'base64'));

    const photoUrl = `/uploads/faces/${filename}`;
    db.prepare('UPDATE known_faces SET photo = ? WHERE id = ?').run(photoUrl, req.params.id);
    res.json({ photo: photoUrl, message: 'Photo uploaded' });
});

module.exports = router;

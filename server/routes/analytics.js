const express = require('express');
const router = express.Router();
const db = require('../database');
const { auth } = require('./auth');

const AI_API_KEY = process.env.AI_API_KEY || 'camsarathi-ai-key-2024';

// GET /api/analytics/footfall — hourly/daily people counts
router.get('/footfall', auth, (req, res) => {
    const { camera_id, date, days } = req.query;

    if (date) {
        // Hourly breakdown for a specific date
        const rows = db.prepare(`
            SELECT hour, SUM(count) as count FROM footfall_counts
            WHERE user_id = ? AND substr(hour, 1, 10) = ? ${camera_id ? 'AND camera_id = ?' : ''}
            GROUP BY hour ORDER BY hour
        `).all(...[req.userId, date, camera_id].filter(Boolean));
        return res.json({ data: rows, date });
    }

    // Daily totals for last N days (default 7)
    const numDays = parseInt(days) || 7;
    const rows = db.prepare(`
        SELECT substr(hour, 1, 10) as day, SUM(count) as count FROM footfall_counts
        WHERE user_id = ? AND hour >= datetime('now', '-${numDays} days') ${camera_id ? 'AND camera_id = ?' : ''}
        GROUP BY day ORDER BY day
    `).all(...[req.userId, camera_id].filter(Boolean));
    res.json({ data: rows, days: numDays });
});

// POST /api/analytics/footfall — receive footfall data from detector (API key auth)
router.post('/footfall', (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== AI_API_KEY) return res.status(401).json({ error: 'Invalid API key' });

    const { camera_id, hour, count } = req.body;
    if (!camera_id || !hour) return res.status(400).json({ error: 'camera_id and hour required' });

    const camera = db.prepare('SELECT user_id FROM cameras WHERE id = ?').get(camera_id);
    if (!camera) return res.status(404).json({ error: 'Camera not found' });

    // Upsert: update if exists, insert if not
    const existing = db.prepare('SELECT id, count FROM footfall_counts WHERE camera_id = ? AND hour = ?').get(camera_id, hour);
    if (existing) {
        db.prepare('UPDATE footfall_counts SET count = ? WHERE id = ?').run(count, existing.id);
    } else {
        db.prepare('INSERT INTO footfall_counts (camera_id, user_id, hour, count) VALUES (?,?,?,?)').run(
            camera_id, camera.user_id, hour, count
        );
    }
    res.json({ message: 'Footfall updated' });
});

// GET /api/analytics/heatmap — heatmap point data
router.get('/heatmap', auth, (req, res) => {
    const { camera_id, date, days } = req.query;
    if (!camera_id) return res.status(400).json({ error: 'camera_id required' });

    const numDays = parseInt(days) || 1;
    const rows = db.prepare(`
        SELECT x, y, class, COUNT(*) as weight FROM heatmap_data
        WHERE camera_id = ? AND created_at >= datetime('now', '-${numDays} days')
        GROUP BY ROUND(x, 2), ROUND(y, 2), class
        ORDER BY weight DESC LIMIT 5000
    `).all(camera_id);

    res.json({ data: rows, camera_id: parseInt(camera_id) });
});

// POST /api/analytics/heatmap — batch insert heatmap points (API key auth)
router.post('/heatmap', (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== AI_API_KEY) return res.status(401).json({ error: 'Invalid API key' });

    const { camera_id, points } = req.body;
    if (!camera_id || !points || !points.length) return res.status(400).json({ error: 'camera_id and points required' });

    const hour = new Date().toISOString().slice(0, 13);
    const insert = db.prepare('INSERT INTO heatmap_data (camera_id, x, y, class, hour) VALUES (?,?,?,?,?)');
    const batch = db.transaction((pts) => {
        for (const p of pts) {
            insert.run(camera_id, p.x, p.y, p.class || 'person', hour);
        }
    });
    batch(points);

    res.json({ message: `${points.length} heatmap points saved` });
});

// GET /api/analytics/tone — tone detection history
router.get('/tone', auth, (req, res) => {
    const { camera_id, date, days } = req.query;
    const numDays = parseInt(days) || 7;

    let query = `
        SELECT tl.*, c.name as camera_name FROM tone_logs tl
        LEFT JOIN cameras c ON tl.camera_id = c.id
        WHERE tl.user_id = ?
    `;
    const params = [req.userId];

    if (camera_id) { query += ' AND tl.camera_id = ?'; params.push(camera_id); }
    if (date) {
        query += ' AND date(tl.created_at) = ?';
        params.push(date);
    } else {
        query += ` AND tl.created_at >= datetime('now', '-${numDays} days')`;
    }
    query += ' ORDER BY tl.created_at DESC LIMIT 100';

    const logs = db.prepare(query).all(...params);
    res.json({ data: logs });
});

// POST /api/analytics/tone — log tone data (API key auth)
router.post('/tone', (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== AI_API_KEY) return res.status(401).json({ error: 'Invalid API key' });

    const { camera_id, emotion, confidence, audio_clip } = req.body;
    if (!camera_id || !emotion) return res.status(400).json({ error: 'camera_id and emotion required' });

    const camera = db.prepare('SELECT user_id FROM cameras WHERE id = ?').get(camera_id);
    if (!camera) return res.status(404).json({ error: 'Camera not found' });

    db.prepare('INSERT INTO tone_logs (camera_id, user_id, emotion, confidence, audio_clip) VALUES (?,?,?,?,?)').run(
        camera_id, camera.user_id, emotion, confidence || 0, audio_clip || null
    );
    res.json({ message: 'Tone logged' });
});

// GET /api/analytics/summary — daily summary stats
router.get('/summary', auth, (req, res) => {
    const { date } = req.query;
    const targetDate = date || new Date().toISOString().slice(0, 10);
    const uid = req.userId;

    const incidents = db.prepare(`
        SELECT type, severity, COUNT(*) as count FROM incidents
        WHERE user_id = ? AND date(created_at) = ?
        GROUP BY type, severity
    `).all(uid, targetDate);

    const footfall = db.prepare(`
        SELECT camera_id, SUM(count) as total FROM footfall_counts
        WHERE user_id = ? AND substr(hour, 1, 10) = ?
        GROUP BY camera_id
    `).all(uid, targetDate);

    const tones = db.prepare(`
        SELECT emotion, COUNT(*) as count FROM tone_logs
        WHERE user_id = ? AND date(created_at) = ?
        GROUP BY emotion
    `).all(uid, targetDate);

    const faceSightings = db.prepare(`
        SELECT COUNT(*) as total,
            SUM(CASE WHEN known_face_id IS NOT NULL THEN 1 ELSE 0 END) as known,
            SUM(CASE WHEN known_face_id IS NULL THEN 1 ELSE 0 END) as unknown
        FROM face_sightings fs
        LEFT JOIN cameras c ON fs.camera_id = c.id
        WHERE c.user_id = ? AND date(fs.created_at) = ?
    `).get(uid, targetDate);

    const totalIncidents = incidents.reduce((s, r) => s + r.count, 0);
    const totalFootfall = footfall.reduce((s, r) => s + r.total, 0);
    const totalToneEvents = tones.reduce((s, r) => s + r.count, 0);

    res.json({
        date: targetDate,
        total_incidents: totalIncidents,
        total_footfall: totalFootfall,
        total_tone_events: totalToneEvents,
        total_face_sightings: faceSightings?.total || 0,
        incidents,
        footfall,
        tones,
        face_sightings: faceSightings,
    });
});

module.exports = router;

const express = require('express');
const router = express.Router();
const db = require('../database');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'guardian-ai-secret-2024';

// Middleware to authenticate JWT
const auth = (req, res, next) => {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token provided' });
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.userId = decoded.id;
        next();
    } catch {
        return res.status(401).json({ error: 'Invalid token' });
    }
};

// POST /api/auth/login
router.post('/login', (req, res) => {
    const { email, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const valid = bcrypt.compareSync(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
        token,
        user: { id: user.id, name: user.name, email: user.email, phone: user.phone, address: user.address, role: user.role }
    });
});

// POST /api/auth/register
router.post('/register', (req, res) => {
    const { name, email, password, phone, address } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password required' });

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) return res.status(400).json({ error: 'Email already registered' });

    const hash = bcrypt.hashSync(password, 10);
    const result = db.prepare('INSERT INTO users (name, email, password_hash, phone, address) VALUES (?,?,?,?,?)').run(name, email, hash, phone || '', address || '');
    const token = jwt.sign({ id: result.lastInsertRowid, email }, JWT_SECRET, { expiresIn: '7d' });

    res.json({ token, user: { id: result.lastInsertRowid, name, email } });
});

// GET /api/auth/me
router.get('/me', auth, (req, res) => {
    const user = db.prepare('SELECT id, name, email, phone, address, role, created_at, last_login FROM users WHERE id = ?').get(req.userId);
    res.json(user);
});

module.exports = { router, auth };

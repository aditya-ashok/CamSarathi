require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { WebSocketServer } = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Routes
const { router: authRouter } = require('./routes/auth');
const camerasRouter = require('./routes/cameras');
const staffRouter = require('./routes/staff');
const incidentsRouter = require('./routes/incidents');
const alertsRouter = require('./routes/alerts');
const inventoryRouter = require('./routes/inventory');
const dashboardRouter = require('./routes/dashboard');
const { router: streamRouter, cleanupStreams } = require('./routes/stream');
const zonesRouter = require('./routes/zones');
const facesRouter = require('./routes/faces');
const analyticsRouter = require('./routes/analytics');

app.use('/api/auth', authRouter);
app.use('/api/cameras', camerasRouter);
app.use('/api/staff', staffRouter);
app.use('/api/incidents', incidentsRouter);
app.use('/api/alerts', alertsRouter);
app.use('/api/inventory', inventoryRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/stream', streamRouter);
app.use('/api/zones', zonesRouter);
app.use('/api/faces', facesRouter);
app.use('/api/analytics', analyticsRouter);


// WebSocket for real-time alerts
const clients = new Set();

wss.on('connection', (ws) => {
    clients.add(ws);
    console.log('🔌 Client connected. Total:', clients.size);

    ws.on('close', () => {
        clients.delete(ws);
        console.log('🔌 Client disconnected. Total:', clients.size);
    });
});

// Broadcast to all WebSocket clients
const broadcast = (data) => {
    const msg = JSON.stringify(data);
    clients.forEach(client => {
        if (client.readyState === 1) client.send(msg);
    });
};

// Expose broadcast for other modules (AI detection, etc.)
app.set('broadcast', broadcast);

// Real-time alerts are now triggered by actual camera events only
// (no more simulated 45-second fake broadcasts)

// Serve index.html for all non-API routes
app.get('/{*path}', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n🛡️  AI Home Guardian Server running at http://localhost:${PORT}`);
    console.log(`📱 Demo Login: demo@guardian.ai / demo1234\n`);
});

// Cleanup FFmpeg processes on shutdown
process.on('SIGTERM', () => { cleanupStreams(); process.exit(0); });
process.on('SIGINT', () => { cleanupStreams(); process.exit(0); });

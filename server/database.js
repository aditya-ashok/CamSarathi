const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'guardian.db'));

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Initialize schema
db.exec(`
  -- Users / Homeowners
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'owner',
    avatar TEXT,
    phone TEXT,
    address TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME
  );

  -- Cameras / Zones
  CREATE TABLE IF NOT EXISTS cameras (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    location TEXT NOT NULL,
    zone TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    stream_url TEXT,
    sensitivity TEXT DEFAULT 'medium',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Household Staff
  CREATE TABLE IF NOT EXISTS staff (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    phone TEXT,
    photo TEXT,
    status TEXT DEFAULT 'active',
    shift_start TEXT DEFAULT '08:00',
    shift_end TEXT DEFAULT '17:00',
    salary REAL,
    hired_date TEXT,
    notes TEXT,
    trust_score INTEGER DEFAULT 100,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- AI Incidents / Events
  CREATE TABLE IF NOT EXISTS incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    camera_id INTEGER REFERENCES cameras(id),
    staff_id INTEGER REFERENCES staff(id),
    type TEXT NOT NULL,
    severity TEXT DEFAULT 'low',
    title TEXT NOT NULL,
    description TEXT,
    location TEXT,
    snapshot TEXT,
    ai_confidence REAL DEFAULT 0.0,
    status TEXT DEFAULT 'open',
    reviewed_at DATETIME,
    action_taken TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Incident Types: 'theft', 'hygiene', 'unauthorized_access', 'unusual_behavior', 'package_delivery', 'visitor', 'motion_detected'

  -- Activity Logs (every motion/event)
  CREATE TABLE IF NOT EXISTS activity_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    camera_id INTEGER REFERENCES cameras(id),
    staff_id INTEGER REFERENCES staff(id),
    event_type TEXT NOT NULL,
    description TEXT,
    snapshot TEXT,
    metadata TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Alerts / Notifications
  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    incident_id INTEGER REFERENCES incidents(id),
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    read INTEGER DEFAULT 0,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- AI Analysis Jobs
  CREATE TABLE IF NOT EXISTS ai_analyses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id INTEGER REFERENCES incidents(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    analysis_type TEXT NOT NULL,
    result TEXT,
    confidence REAL,
    tags TEXT,
    processed_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Staff Access Zones (allowed zones per staff)
  CREATE TABLE IF NOT EXISTS staff_access_zones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_id INTEGER NOT NULL REFERENCES staff(id),
    zone TEXT NOT NULL,
    allowed INTEGER DEFAULT 1
  );

  -- Fridge / Storage Items tracking
  CREATE TABLE IF NOT EXISTS inventory_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    category TEXT DEFAULT 'food',
    quantity REAL DEFAULT 1,
    unit TEXT DEFAULT 'pcs',
    location TEXT DEFAULT 'fridge',
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_checked DATETIME DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'present'
  );
`);

// Safe migrations — add new columns without breaking existing DB
try { db.exec("ALTER TABLE cameras ADD COLUMN source_type TEXT DEFAULT 'simulated'"); } catch { }
try { db.exec("ALTER TABLE cameras ADD COLUMN motion_threshold INTEGER DEFAULT 25"); } catch { }
try { db.exec("ALTER TABLE cameras ADD COLUMN cam_ip TEXT"); } catch { }
try { db.exec("ALTER TABLE cameras ADD COLUMN cam_port INTEGER DEFAULT 80"); } catch { }
try { db.exec("ALTER TABLE cameras ADD COLUMN cam_username TEXT DEFAULT 'admin'"); } catch { }
try { db.exec("ALTER TABLE cameras ADD COLUMN cam_password TEXT DEFAULT 'admin'"); } catch { }
try { db.exec("ALTER TABLE cameras ADD COLUMN cam_brand TEXT DEFAULT 'generic'"); } catch { }


// Seed demo data
const seedData = () => {
    const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get('demo@guardian.ai');
    if (existingUser) return;

    const bcrypt = require('bcryptjs');
    const hash = bcrypt.hashSync('demo1234', 10);

    const userId = db.prepare(`
    INSERT INTO users (name, email, password_hash, phone, address)
    VALUES (?, ?, ?, ?, ?)
  `).run('Arjun Mehta', 'demo@guardian.ai', hash, '+91-98765-43210', 'Koramangala, Bengaluru').lastInsertRowid;

    // Cameras
    const camIds = [];
    const cameras = [
        { name: 'Kitchen Cam', location: 'Kitchen Counter', zone: 'kitchen' },
        { name: 'Main Entrance', location: 'Front Door', zone: 'entrance' },
        { name: 'Living Room', location: 'TV Wall Corner', zone: 'living_room' },
        { name: 'Bedroom 1', location: 'Master Bedroom', zone: 'bedroom' },
        { name: 'Backyard', location: 'Garden Area', zone: 'outdoor' },
    ];
    cameras.forEach(c => {
        const id = db.prepare(`INSERT INTO cameras (user_id, name, location, zone) VALUES (?,?,?,?)`).run(userId, c.name, c.location, c.zone).lastInsertRowid;
        camIds.push(id);
    });

    // Staff
    const staffData = [
        { name: 'Sunita Devi', role: 'Cook', phone: '+91-77001-23456', shift_start: '07:00', shift_end: '13:00', salary: 12000, hired_date: '2023-06-15', trust_score: 45 },
        { name: 'Ramesh Kumar', role: 'Housekeeping', phone: '+91-88012-34567', shift_start: '09:00', shift_end: '15:00', salary: 10000, hired_date: '2024-01-10', trust_score: 88 },
        { name: 'Priya Nair', role: 'Babysitter', phone: '+91-99023-45678', shift_start: '08:00', shift_end: '18:00', salary: 15000, hired_date: '2024-11-01', trust_score: 95 },
    ];
    const staffIds = [];
    staffData.forEach(s => {
        const id = db.prepare(`
      INSERT INTO staff (user_id, name, role, phone, shift_start, shift_end, salary, hired_date, trust_score)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(userId, s.name, s.role, s.phone, s.shift_start, s.shift_end, s.salary, s.hired_date, s.trust_score).lastInsertRowid;
        staffIds.push(id);
    });

    // Incidents
    const incidentsData = [
        {
            camera_id: camIds[0], staff_id: staffIds[0], type: 'theft', severity: 'high',
            title: 'Food Removed from Refrigerator', description: 'AI detected staff member opening refrigerator and removing multiple items (fruits: 3 mangoes, 2 bananas) without explicit permission from homeowner. Items were placed in personal bag.',
            location: 'Kitchen', ai_confidence: 0.94, status: 'resolved', action_taken: 'Staff terminated after review of footage',
            created_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()
        },
        {
            camera_id: camIds[0], staff_id: staffIds[0], type: 'hygiene', severity: 'medium',
            title: 'Hygiene Protocol Violation', description: 'AI detected cook handling raw meat without washing hands and subsequently touching cooked food preparation area. Cross-contamination risk flagged.',
            location: 'Kitchen', ai_confidence: 0.87, status: 'resolved', action_taken: 'Staff warned, protocol refresher conducted',
            created_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
        },
        {
            camera_id: camIds[3], staff_id: staffIds[0], type: 'unauthorized_access', severity: 'high',
            title: 'Unauthorized Entry to Bedroom', description: 'Cook entered master bedroom without permission during homeowner absence. Staff access zone violation detected.',
            location: 'Bedroom 1', ai_confidence: 0.99, status: 'resolved', action_taken: 'Documented and reviewed with staff',
            created_at: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString()
        },
        {
            camera_id: camIds[0], staff_id: staffIds[1], type: 'unusual_behavior', severity: 'low',
            title: 'Prolonged Phone Usage During Work', description: 'Housekeeping staff spent 25 minutes on personal phone call during working hours instead of completing assigned tasks.',
            location: 'Kitchen', ai_confidence: 0.78, status: 'open',
            created_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
        },
        {
            camera_id: camIds[1], staff_id: null, type: 'visitor', severity: 'low',
            title: 'Unknown Visitor at Entrance', description: 'Person not in known contacts list detected at front door. Doorbell rang twice. Person left after 3 minutes.',
            location: 'Main Entrance', ai_confidence: 0.91, status: 'open',
            created_at: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString()
        }
    ];

    incidentsData.forEach(inc => {
        const incId = db.prepare(`
      INSERT INTO incidents (user_id, camera_id, staff_id, type, severity, title, description, location, ai_confidence, status, action_taken, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(userId, inc.camera_id, inc.staff_id, inc.type, inc.severity, inc.title, inc.description, inc.location, inc.ai_confidence, inc.status, inc.action_taken || null, inc.created_at).lastInsertRowid;

        // Alerts for open incidents
        if (inc.status === 'open') {
            db.prepare(`INSERT INTO alerts (user_id, incident_id, type, message) VALUES (?,?,?,?)`).run(
                userId, incId, inc.severity, `🚨 ${inc.title} detected at ${inc.location}`
            );
        }
    });

    // Inventory items
    const items = ['Mangoes', 'Bananas', 'Apples', 'Milk', 'Cheese', 'Leftover Rice', 'Yogurt', 'Eggs', 'Orange Juice', 'Butter'];
    items.forEach((item, i) => {
        db.prepare(`INSERT INTO inventory_items (user_id, name, category, quantity, unit, location, status) VALUES (?,?,?,?,?,?,?)`).run(
            userId, item, 'food', Math.floor(Math.random() * 5) + 1, 'pcs', 'fridge',
            i < 7 ? 'present' : 'low'
        );
    });

    // Activity logs
    const activities = [
        { camera_id: camIds[0], staff_id: staffIds[0], event_type: 'motion_detected', description: 'Motion in kitchen area', created_at: new Date(Date.now() - 30 * 60 * 1000).toISOString() },
        { camera_id: camIds[0], staff_id: staffIds[0], event_type: 'fridge_opened', description: 'Refrigerator door opened', created_at: new Date(Date.now() - 28 * 60 * 1000).toISOString() },
        { camera_id: camIds[1], staff_id: null, event_type: 'person_detected', description: 'Person detected at entrance', created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() },
        { camera_id: camIds[2], staff_id: staffIds[1], event_type: 'motion_detected', description: 'Motion in living room', created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() },
    ];
    activities.forEach(a => {
        db.prepare(`INSERT INTO activity_logs (user_id, camera_id, staff_id, event_type, description, created_at) VALUES (?,?,?,?,?,?)`).run(
            userId, a.camera_id, a.staff_id, a.event_type, a.description, a.created_at
        );
    });

    console.log('✅ Demo data seeded successfully');
};

seedData();

module.exports = db;

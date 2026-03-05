// ====== STATE ======
let token = localStorage.getItem('guardian_token') || null;
let currentUser = null;
let currentView = 'dashboard';
let ws = null;

const API = '/api';

// ====== INIT ======
document.addEventListener('DOMContentLoaded', () => {
  if (token) {
    initApp();
  } else {
    showScreen('login');
  }

  // Login/Register form listeners
  document.getElementById('login-form').addEventListener('submit', handleLogin);
  document.getElementById('register-form').addEventListener('submit', handleRegister);
});

// ====== API HELPER ======
async function api(method, path, body = null) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' }
  };
  if (token) opts.headers['Authorization'] = `Bearer ${token}`;
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(API + path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'API error');
  return data;
}

// ====== SCREENS ======
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(`${name}-screen`).classList.add('active');
}

function showLogin() { showScreen('login'); }
function showRegister() { showScreen('register'); }

// ====== AUTH ======
async function handleLogin(e) {
  e.preventDefault();
  const btn = document.getElementById('login-btn');
  btn.innerHTML = '<div class="spinner"></div>';
  const errEl = document.getElementById('login-error');
  errEl.classList.add('hidden');
  try {
    const data = await api('POST', '/auth/login', {
      email: document.getElementById('login-email').value,
      password: document.getElementById('login-password').value
    });
    token = data.token;
    localStorage.setItem('guardian_token', token);
    currentUser = data.user;
    initApp();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  } finally {
    btn.innerHTML = '<span>Sign In</span><span class="btn-arrow">→</span>';
  }
}

async function handleRegister(e) {
  e.preventDefault();
  const errEl = document.getElementById('reg-error');
  errEl.classList.add('hidden');
  try {
    const data = await api('POST', '/auth/register', {
      name: document.getElementById('reg-name').value,
      email: document.getElementById('reg-email').value,
      password: document.getElementById('reg-password').value,
      phone: document.getElementById('reg-phone').value,
    });
    token = data.token;
    localStorage.setItem('guardian_token', token);
    currentUser = data.user;
    initApp();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
}

function logout() {
  token = null;
  currentUser = null;
  localStorage.removeItem('guardian_token');
  if (ws) ws.close();
  ws = null;
  showScreen('login');
}

// ====== APP INIT ======
async function initApp() {
  try {
    currentUser = await api('GET', '/auth/me');
    document.getElementById('sidebar-user-name').textContent = currentUser.name;
    document.getElementById('user-avatar-sm').textContent = currentUser.name.charAt(0).toUpperCase();
    showScreen('app');
    connectWebSocket();
    navigate('dashboard');
  } catch (err) {
    console.error('Init failed:', err);
    logout();
  }
}

// ====== WEBSOCKET ======
function connectWebSocket() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);

  ws.onopen = () => {
    document.getElementById('ws-status').style.opacity = '1';
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.event === 'ai_event') {
      handleLiveAIEvent(msg.data, msg.timestamp);
    }
  };

  ws.onclose = () => {
    setTimeout(connectWebSocket, 3000);
  };
}

function handleLiveAIEvent(data, timestamp) {
  showToast(data.severity === 'high' ? 'danger' : data.severity === 'medium' ? 'warning' : 'info',
    '🤖 AI Detection', data.message);

  const feed = document.getElementById('live-activity-feed');
  if (feed) {
    const time = new Date(timestamp).toLocaleTimeString();
    const item = createEl('div', 'activity-item');
    item.innerHTML = `
      <span class="activity-icon">${data.severity === 'high' ? '🚨' : data.severity === 'medium' ? '⚠️' : '📡'}</span>
      <div class="activity-text">${data.message}</div>
      <div class="activity-time">${time}</div>
    `;
    feed.prepend(item);
    if (feed.children.length > 15) feed.lastChild.remove();
  }
}

// ====== NAVIGATION ======
function navigate(view) {
  currentView = view;
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.view === view);
  });
  document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
  document.getElementById(`view-${view}`).classList.add('active');

  const titles = {
    dashboard: '📊 Dashboard',
    incidents: '🚨 Incidents',
    cameras: '📹 Cameras',
    staff: '👥 Staff Management',
    inventory: '🧊 Fridge & Storage',
    alerts: '🔔 Alerts'
  };
  document.getElementById('page-title').textContent = titles[view];

  const loaders = {
    dashboard: loadDashboard,
    incidents: loadIncidents,
    cameras: loadCameras,
    staff: loadStaff,
    inventory: loadInventory,
    alerts: loadAlerts
  };
  if (loaders[view]) loaders[view]();
}

// ====== DASHBOARD ======
async function loadDashboard() {
  try {
    const data = await api('GET', '/dashboard');
    renderStats(data.stats);
    renderRecentIncidents(data.recent_incidents);
    renderStaffTrust(data.staff_list);
    renderChart(data.timeline_7days);
    renderRecentAlerts(data.recent_alerts);
    renderActivityFeed(data.recent_activity);
    updateBadges(data.stats);
  } catch (err) {
    showToast('danger', 'Error', err.message);
  }
}

function renderStats(stats) {
  const grid = document.getElementById('stats-grid');
  grid.innerHTML = '';
  const cards = [
    { icon: '📹', value: stats.cameras.total, label: 'Total Cameras', sub: `${stats.cameras.active} active`, color: 'primary' },
    { icon: '👥', value: stats.staff.total, label: 'Active Staff', sub: `${stats.staff.terminated} terminated`, color: 'success' },
    { icon: '🚨', value: stats.incidents.open, label: 'Open Incidents', sub: `${stats.incidents.today} today`, color: 'danger' },
    { icon: '⚠️', value: stats.incidents.high_severity, label: 'High Severity', sub: `${stats.incidents.total} total incidents`, color: 'warning' },
    { icon: '🔔', value: stats.alerts.unread, label: 'Unread Alerts', sub: 'Requires attention', color: 'primary' },
    { icon: '🧊', value: stats.inventory.total, label: 'Tracked Items', sub: `${stats.inventory.low} running low`, color: 'success' },
  ];
  cards.forEach(c => {
    const el = createEl('div', `stat-card ${c.color}`);
    el.innerHTML = `
      <div class="stat-icon">${c.icon}</div>
      <div class="stat-value">${c.value}</div>
      <div class="stat-label">${c.label}</div>
      <div class="stat-sub">${c.sub}</div>
    `;
    grid.appendChild(el);
  });
}

function renderRecentIncidents(incidents) {
  const list = document.getElementById('recent-incidents-list');
  list.innerHTML = '';
  if (!incidents.length) { list.innerHTML = '<div class="empty-state"><span class="empty-icon">✅</span><p>No incidents</p></div>'; return; }
  incidents.forEach(inc => {
    const el = createEl('div', 'incident-mini');
    el.onclick = () => showIncidentDetail(inc.id);
    el.innerHTML = `
      <div class="severity-dot ${inc.severity}"></div>
      <div class="incident-mini-info">
        <div class="incident-mini-title">${inc.title}</div>
        <div class="incident-mini-meta">${inc.location || ''} · ${timeAgo(inc.created_at)}${inc.staff_name ? ` · ${inc.staff_name}` : ''}</div>
      </div>
    `;
    list.appendChild(el);
  });
}

function renderStaffTrust(staff) {
  const list = document.getElementById('staff-trust-list');
  list.innerHTML = '';
  if (!staff.length) { list.innerHTML = '<div class="empty-state"><span class="empty-icon">👤</span><p>No staff added</p></div>'; return; }
  staff.forEach(s => {
    const score = s.trust_score || 0;
    const color = score >= 80 ? 'var(--success)' : score >= 50 ? 'var(--warning)' : 'var(--danger)';
    const el = createEl('div', 'trust-item');
    el.innerHTML = `
      <div class="trust-avatar" style="background: ${color}20; color: ${color}">${s.name.charAt(0)}</div>
      <div class="trust-info">
        <div class="trust-name">${s.name}</div>
        <div class="trust-role">${s.role}${s.open_incidents > 0 ? ` · <span style="color:var(--danger)">${s.open_incidents} open incidents</span>` : ''}</div>
      </div>
      <div class="trust-bar-wrap">
        <div class="trust-score-num" style="color:${color}">${score}</div>
        <div class="trust-bar-bg"><div class="trust-bar-fill" style="width:${score}%;background:${color}"></div></div>
      </div>
    `;
    list.appendChild(el);
  });
}

function renderChart(data) {
  const container = document.getElementById('incident-chart');
  container.innerHTML = '';

  // Build 7-day labels
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }

  const counts = {};
  data.forEach(row => { counts[row.day] = (counts[row.day] || 0) + row.count; });
  const max = Math.max(...days.map(d => counts[d] || 0), 1);

  days.forEach(day => {
    const count = counts[day] || 0;
    const pct = (count / max) * 100;
    const label = new Date(day + 'T00:00:00').toLocaleDateString('en', { weekday: 'short' });
    const wrap = createEl('div', 'chart-bar-wrap');
    wrap.innerHTML = `
      <div class="chart-bar" style="height:${Math.max(pct, 4)}%" data-count="${count}"></div>
      <div class="chart-label">${label}</div>
    `;
    container.appendChild(wrap);
  });
}

function renderRecentAlerts(alerts) {
  const list = document.getElementById('recent-alerts-list');
  list.innerHTML = '';
  if (!alerts.length) { list.innerHTML = '<div class="empty-state"><span class="empty-icon">🔔</span><p>No alerts</p></div>'; return; }
  alerts.forEach(a => {
    const el = createEl('div', `alert-item ${a.type} ${a.read ? '' : 'unread'}`);
    el.innerHTML = `
      <div class="alert-icon-wrap">${a.type === 'high' ? '🚨' : a.type === 'medium' ? '⚠️' : '🔔'}</div>
      <div class="alert-content">
        <div class="alert-message">${a.message}</div>
        <div class="alert-time">${timeAgo(a.sent_at)}</div>
      </div>
    `;
    list.appendChild(el);
  });
}

function renderActivityFeed(activities) {
  const feed = document.getElementById('live-activity-feed');
  feed.innerHTML = '';
  if (!activities.length) {
    feed.innerHTML = '<div class="empty-state"><span>📡</span><p>No activity yet</p></div>';
    return;
  }
  activities.forEach(a => {
    const icons = { motion_detected: '🔍', fridge_opened: '🧊', person_detected: '👤', ai_alert: '🤖' };
    const el = createEl('div', 'activity-item');
    el.innerHTML = `
      <span class="activity-icon">${icons[a.event_type] || '📍'}</span>
      <div class="activity-text">${a.description}${a.staff_name ? ` — ${a.staff_name}` : ''}${a.camera_name ? ` (${a.camera_name})` : ''}</div>
      <div class="activity-time">${timeAgo(a.created_at)}</div>
    `;
    feed.appendChild(el);
  });
}

function updateBadges(stats) {
  const incBadge = document.getElementById('incidents-badge');
  const alertBadge = document.getElementById('alerts-badge');
  const bellBadge = document.getElementById('bell-badge');

  if (stats.incidents.open > 0) { incBadge.textContent = stats.incidents.open; incBadge.style.display = ''; }
  else incBadge.style.display = 'none';

  if (stats.alerts.unread > 0) {
    alertBadge.textContent = stats.alerts.unread; alertBadge.style.display = '';
    bellBadge.textContent = stats.alerts.unread; bellBadge.style.display = '';
  } else { alertBadge.style.display = 'none'; bellBadge.style.display = 'none'; }
}

// ====== INCIDENTS ======
async function loadIncidents() {
  const list = document.getElementById('incidents-list');
  list.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Loading incidents...</p></div>';
  try {
    const params = new URLSearchParams();
    const typeFilter = document.getElementById('filter-type')?.value;
    const sevFilter = document.getElementById('filter-severity')?.value;
    const statusFilter = document.getElementById('filter-status')?.value;
    if (typeFilter) params.set('type', typeFilter);
    if (sevFilter) params.set('severity', sevFilter);
    if (statusFilter) params.set('status', statusFilter);
    params.set('limit', '100');

    const data = await api('GET', `/incidents?${params}`);
    renderIncidentsList(data.incidents);
  } catch (err) {
    list.innerHTML = `<div class="empty-state"><p>Error: ${err.message}</p></div>`;
  }
}

function renderIncidentsList(incidents) {
  const list = document.getElementById('incidents-list');
  list.innerHTML = '';
  if (!incidents.length) {
    list.innerHTML = '<div class="empty-state"><span class="empty-icon">✅</span><p>No incidents found</p></div>';
    return;
  }
  incidents.forEach(inc => {
    const typeLabels = {
      theft: '🔴 Theft', hygiene: '🟡 Hygiene', unauthorized_access: '⛔ Unauthorized',
      unusual_behavior: '🔶 Behavior', motion_detected: '📡 Motion', visitor: '👤 Visitor'
    };
    const el = createEl('div', `incident-card ${inc.severity}`);
    el.onclick = () => showIncidentDetail(inc.id);
    el.innerHTML = `
      <div class="incident-card-header">
        <div class="incident-title">${inc.title}</div>
        <div class="incident-badges">
          <span class="badge ${inc.severity}">${inc.severity.toUpperCase()}</span>
          <span class="badge ${inc.status}">${inc.status}</span>
          <span class="badge type">${typeLabels[inc.type] || inc.type}</span>
        </div>
      </div>
      <div class="incident-desc">${inc.description}</div>
      <div class="incident-meta">
        <span>📍 ${inc.location || 'Unknown'}</span>
        ${inc.staff_name ? `<span>👤 ${inc.staff_name} (${inc.staff_role})</span>` : ''}
        ${inc.camera_name ? `<span>📹 ${inc.camera_name}</span>` : ''}
        <span>🕐 ${timeAgo(inc.created_at)}</span>
        <div class="ai-confidence">
          <span>AI:</span>
          <div class="confidence-bar"><div class="confidence-fill" style="width:${(inc.ai_confidence * 100).toFixed(0)}%"></div></div>
          <span>${(inc.ai_confidence * 100).toFixed(0)}%</span>
        </div>
      </div>
    `;
    list.appendChild(el);
  });
}

async function showIncidentDetail(id) {
  openModal();
  document.getElementById('modal-body').innerHTML = '<div class="loading-state"><div class="spinner"></div></div>';
  try {
    const inc = await api('GET', `/incidents/${id}`);
    const typeLabels = {
      theft: '🔴 Theft', hygiene: '🟡 Hygiene', unauthorized_access: '⛔ Unauthorized',
      unusual_behavior: '🔶 Unusual Behavior', motion_detected: '📡 Motion', visitor: '👤 Visitor'
    };
    document.getElementById('modal-body').innerHTML = `
      <div class="modal-header">
        <div class="modal-title">Incident Report</div>
        <button class="modal-close" onclick="closeModal()">✕</button>
      </div>
      <div class="incident-detail-info">
        <div style="margin-bottom:12px">
          <div style="font-size:17px;font-weight:700;margin-bottom:8px">${inc.title}</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <span class="badge ${inc.severity}">${inc.severity.toUpperCase()}</span>
            <span class="badge ${inc.status}">${inc.status}</span>
            <span class="badge type">${typeLabels[inc.type] || inc.type}</span>
          </div>
        </div>
        <div class="detail-row"><span class="detail-label">📝 Description</span><span class="detail-value">${inc.description}</span></div>
        <div class="detail-row"><span class="detail-label">📍 Location</span><span class="detail-value">${inc.location || 'Unknown'}</span></div>
        ${inc.staff_name ? `<div class="detail-row"><span class="detail-label">👤 Staff</span><span class="detail-value">${inc.staff_name} (${inc.staff_role}) — Trust Score: ${inc.trust_score}/100</span></div>` : ''}
        ${inc.camera_name ? `<div class="detail-row"><span class="detail-label">📹 Camera</span><span class="detail-value">${inc.camera_name} — ${inc.camera_location}</span></div>` : ''}
        <div class="detail-row"><span class="detail-label">🕐 Detected</span><span class="detail-value">${new Date(inc.created_at).toLocaleString()}</span></div>
        ${inc.action_taken ? `<div class="detail-row"><span class="detail-label">✅ Action Taken</span><span class="detail-value">${inc.action_taken}</span></div>` : ''}

        <div class="ai-analysis-box">
          <div class="ai-analysis-title">🤖 AI Confidence Score</div>
          <div class="ai-meter">
            <div class="ai-meter-bar"><div class="ai-meter-fill" style="width:${(inc.ai_confidence * 100).toFixed(0)}%"></div></div>
            <div class="ai-meter-value">${(inc.ai_confidence * 100).toFixed(0)}%</div>
          </div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:6px">
            ${inc.ai_confidence >= 0.9 ? '✅ Very High Confidence — Strong evidence' : inc.ai_confidence >= 0.7 ? '⚠️ High Confidence — Review recommended' : '🔍 Medium Confidence — Further investigation advised'}
          </div>
        </div>

        ${inc.status === 'open' ? `
        <div style="background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:10px;padding:14px;margin-top:4px">
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;font-weight:600">RESOLVE INCIDENT</div>
          <textarea id="action-taken-input" class="form-input" placeholder="Describe action taken (e.g. Staff terminated, warning issued)..."></textarea>
          <div style="display:flex;gap:8px;margin-top:10px">
            <button class="btn-primary btn-sm" onclick="resolveIncident(${inc.id})">✅ Mark Resolved</button>
            ${inc.staff_id ? `<button class="btn-danger" onclick="confirmTerminateStaff(${inc.staff_id}, '${inc.staff_name}')">🔥 Terminate Staff</button>` : ''}
          </div>
        </div>
        ` : `<div style="color:var(--success);font-size:13px;font-weight:600">✅ Incident Resolved</div>`}
      </div>
    `;
  } catch (err) {
    showToast('danger', 'Error', err.message);
    closeModal();
  }
}

async function resolveIncident(id) {
  const action = document.getElementById('action-taken-input')?.value || '';
  try {
    await api('PATCH', `/incidents/${id}/resolve`, { action_taken: action });
    showToast('success', 'Resolved', 'Incident marked as resolved');
    closeModal();
    if (currentView === 'incidents') loadIncidents();
    if (currentView === 'dashboard') loadDashboard();
  } catch (err) {
    showToast('danger', 'Error', err.message);
  }
}

function showReportModal() {
  openModal();
  document.getElementById('modal-body').innerHTML = `
    <div class="modal-header">
      <div class="modal-title">🚨 Report New Incident</div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div class="form-grid">
      <div class="form-field">
        <label>Incident Title *</label>
        <input type="text" id="inc-title" class="form-input" placeholder="Brief title of the incident" />
      </div>
      <div class="form-grid two-col">
        <div class="form-field">
          <label>Type *</label>
          <select id="inc-type" class="form-input">
            <option value="theft">Theft</option>
            <option value="hygiene">Hygiene Violation</option>
            <option value="unauthorized_access">Unauthorized Access</option>
            <option value="unusual_behavior">Unusual Behavior</option>
            <option value="motion_detected">Motion Detected</option>
            <option value="visitor">Visitor</option>
          </select>
        </div>
        <div class="form-field">
          <label>Severity</label>
          <select id="inc-severity" class="form-input">
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>
      </div>
      <div class="form-field">
        <label>Location</label>
        <input type="text" id="inc-location" class="form-input" placeholder="e.g. Kitchen, Bedroom" />
      </div>
      <div class="form-field">
        <label>Description</label>
        <textarea id="inc-desc" class="form-input" placeholder="Detailed description of what happened..."></textarea>
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" onclick="reportIncident()">Report Incident</button>
    </div>
  `;
}

async function reportIncident() {
  const title = document.getElementById('inc-title')?.value;
  if (!title) { showToast('warning', 'Validation', 'Title is required'); return; }
  try {
    await api('POST', '/incidents', {
      title,
      type: document.getElementById('inc-type').value,
      severity: document.getElementById('inc-severity').value,
      location: document.getElementById('inc-location').value,
      description: document.getElementById('inc-desc').value,
    });
    showToast('success', 'Reported', 'Incident has been reported');
    closeModal();
    loadIncidents();
  } catch (err) {
    showToast('danger', 'Error', err.message);
  }
}

// ====== CAMERAS ======
// Tracks active webcam streams and motion detectors per camera card
const activeStreams = {};   // camId → { stream: MediaStream, videoEl, loopId }
const motionDetectors = {}; // camId → { intervalId, prevImageData }

async function loadCameras() {
  // Stop any running streams from previous render
  stopAllStreams();
  const grid = document.getElementById('cameras-grid');
  grid.innerHTML = '<div class="loading-state"><div class="spinner"></div></div>';
  try {
    const cameras = await api('GET', '/cameras');
    renderCameras(cameras);
  } catch (err) {
    showToast('danger', 'Error', err.message);
  }
}

function stopAllStreams() {
  Object.values(activeStreams).forEach(s => {
    if (s.stream) s.stream.getTracks().forEach(t => t.stop());
    if (s.loopId) clearInterval(s.loopId);
  });
  Object.keys(activeStreams).forEach(k => delete activeStreams[k]);
  Object.values(motionDetectors).forEach(d => clearInterval(d.intervalId));
  Object.keys(motionDetectors).forEach(k => delete motionDetectors[k]);
}

function renderCameras(cameras) {
  const grid = document.getElementById('cameras-grid');
  grid.innerHTML = '';
  if (!cameras.length) {
    grid.innerHTML = '<div class="empty-state"><span class="empty-icon">📹</span><p>No cameras added yet</p></div>';
    return;
  }
  cameras.forEach(cam => renderCameraCard(cam, grid));
}

function renderCameraCard(cam, grid) {
  const zoneColors = { kitchen: '#ff6b6b', entrance: '#ffd43b', living_room: '#74c0fc', bedroom: '#a78bfa', outdoor: '#69db7c' };
  const color = zoneColors[cam.zone] || '#5b7fff';
  const isIP = cam.source_type === 'ip';
  const isWebcam = cam.source_type === 'webcam';
  const hasIP = !!cam.cam_ip;
  const isCPPlus = cam.cam_brand === 'cpplus';
  const isPTZ = isIP && hasIP && isCPPlus;

  const el = createEl('div', 'camera-card');
  el.dataset.camId = cam.id;
  el.innerHTML = `
      <div class="camera-feed" id="feed-wrap-${cam.id}">
        <!-- Feed area: webcam video, IP snapshot, PTZ panel, or placeholder -->
        ${isWebcam ? `
          <video id="cam-video-${cam.id}" class="cam-real-video" autoplay muted playsinline></video>
          <canvas id="cam-canvas-${cam.id}" class="cam-motion-canvas" style="display:none"></canvas>
        ` : isPTZ ? `
          <div class="ptz-panel">
            <div class="ptz-header">PTZ CONTROL</div>
            <div class="ptz-dpad">
              <button class="ptz-btn ptz-up" onmousedown="ptzMove(${cam.id},0,0.5,0)" onmouseup="ptzStop(${cam.id})" ontouchstart="ptzMove(${cam.id},0,0.5,0)" ontouchend="ptzStop(${cam.id})">&#9650;</button>
              <button class="ptz-btn ptz-left" onmousedown="ptzMove(${cam.id},-0.5,0,0)" onmouseup="ptzStop(${cam.id})" ontouchstart="ptzMove(${cam.id},-0.5,0,0)" ontouchend="ptzStop(${cam.id})">&#9664;</button>
              <button class="ptz-btn ptz-center" onclick="ptzStop(${cam.id})">&#9632;</button>
              <button class="ptz-btn ptz-right" onmousedown="ptzMove(${cam.id},0.5,0,0)" onmouseup="ptzStop(${cam.id})" ontouchstart="ptzMove(${cam.id},0.5,0,0)" ontouchend="ptzStop(${cam.id})">&#9654;</button>
              <button class="ptz-btn ptz-down" onmousedown="ptzMove(${cam.id},0,-0.5,0)" onmouseup="ptzStop(${cam.id})" ontouchstart="ptzMove(${cam.id},0,-0.5,0)" ontouchend="ptzStop(${cam.id})">&#9660;</button>
            </div>
            <div class="ptz-zoom-row">
              <button class="ptz-btn ptz-zoom" onmousedown="ptzMove(${cam.id},0,0,-0.5)" onmouseup="ptzStop(${cam.id})">-</button>
              <span class="ptz-zoom-label">ZOOM</span>
              <button class="ptz-btn ptz-zoom" onmousedown="ptzMove(${cam.id},0,0,0.5)" onmouseup="ptzStop(${cam.id})">+</button>
            </div>
            <button class="ptz-app-btn" onclick="openEzyKamApp()">View Live in ezyKam+</button>
          </div>
        ` : isIP && hasIP ? `
          <img id="cam-img-${cam.id}" class="cam-ip-img" src="/api/stream/rtsp/${cam.id}?tok=${token}"
            onerror="onRtspFeedError(${cam.id}, this)" />
          <div id="cam-fallback-${cam.id}" style="display:none;position:absolute;top:4px;left:4px;font-size:9px;color:#ffd43b;background:rgba(0,0,0,0.6);padding:2px 6px;border-radius:4px;z-index:5">SNAPSHOT MODE</div>
          <div id="cam-offline-${cam.id}" class="cam-offline-msg" style="display:none">
            <span>📡</span><p>Camera Offline</p><p style="font-size:11px;color:var(--text-dim)">${cam.cam_ip || ''}</p>
          </div>
        ` : `
          <div class="camera-feed-bg"></div>
          <div class="camera-feed-overlay"></div>
          <div class="camera-scanline"></div>
          <span class="camera-icon-lg">📹</span>
        `}
        <div class="camera-zone-badge" style="color:${color};border-color:${color}40;background:${color}15">${cam.zone.replace(/_/g, ' ').toUpperCase()}</div>
        <div class="camera-status-indicator" id="cam-status-${cam.id}">
          <span class="${cam.status === 'active' ? 'status-live' : ''}">${cam.status === 'active' ? 'LIVE' : 'OFFLINE'}</span>
        </div>
        <div class="cam-overlay-btns">
          ${isWebcam ?
      `<button class="cam-btn cam-btn-snap" onclick="takeSnapshot(${cam.id})" title="Take Snapshot">📸</button>
             <button class="cam-btn cam-btn-full" onclick="openCamera(${cam.id})" title="Fullscreen">⛶</button>
             <button class="cam-btn cam-btn-stop" onclick="stopWebcam(${cam.id})" title="Stop">⏹</button>` :
      isPTZ ?
        `<button class="cam-btn cam-btn-full" onclick="openPTZFullscreen(${cam.id})" title="PTZ Fullscreen">⛶</button>
             <button class="cam-btn cam-btn-probe" onclick="probeCamera(${cam.id})" title="Test Connection">🔌</button>` :
      isIP && hasIP ?
        `<button class="cam-btn cam-btn-snap" onclick="takeIPSnapshot(${cam.id})" title="Capture Snapshot">📸</button>
             <button class="cam-btn cam-btn-full" onclick="openCameraFullscreen(${cam.id})" title="Fullscreen">⛶</button>
             <button class="cam-btn cam-btn-probe" onclick="probeCamera(${cam.id})" title="Test Connection">🔌</button>` :
        `<button class="cam-btn cam-btn-start" onclick="startWebcam(${cam.id})" title="Use Webcam">📷 Start Webcam</button>`
    }
          <div class="motion-indicator" id="motion-${cam.id}" style="display:none">🔴 MOTION</div>
        </div>
      </div>
      <div class="camera-info">
        <div class="camera-name">${cam.name}</div>
        <div class="camera-location">📍 ${cam.location}</div>
        <div class="cam-type-tag">
          ${isWebcam ? '<span class="tag-webcam">💻 Device Webcam</span>' :
      isPTZ ? `<span class="tag-ip" style="color:#00d4aa;border-color:rgba(0,212,170,0.3)">🎮 PTZ Camera — ${cam.cam_brand?.toUpperCase()} — ${cam.cam_ip}</span>` :
      isIP && hasIP ? `<span class="tag-ip">📡 IP Camera — ${cam.cam_brand?.toUpperCase() || 'IP'} — ${cam.cam_ip}</span>` :
        '<span class="tag-sim">🔮 Simulated</span>'}
        </div>
        <div style="font-size:11px;color:var(--text-dim);margin-top:2px">Sensitivity: ${cam.sensitivity} &nbsp;|&nbsp; Motion threshold: ${cam.motion_threshold || 25}px</div>
        <div class="camera-actions">
          <button class="btn-secondary btn-sm" onclick="showCameraModal(${JSON.stringify(cam).replace(/"/g, '&quot;')})">Edit</button>
          <button class="btn-secondary btn-sm" onclick="showCameraSnapshots(${cam.id})">📸 Snapshots</button>
          <button class="btn-danger" onclick="deleteCamera(${cam.id})">Remove</button>
        </div>
      </div>
    `;
  grid.appendChild(el);

  // RTSP stream auto-starts via <img src> — no polling needed
  // Snapshot polling is used as fallback only (triggered by onRtspFeedError)
  // Auto-attach webcam if it was active
  if (isWebcam) {
    startWebcam(cam.id);
  }
}

// ── Webcam via getUserMedia ──────────────────────────────────────────────────
async function startWebcam(camId) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: false });
    const video = document.getElementById(`cam-video-${camId}`);
    if (!video) { stream.getTracks().forEach(t => t.stop()); return; }
    video.srcObject = stream;
    activeStreams[camId] = { stream, videoEl: video };
    updateCameraStatusBadge(camId, true);
    showToast('success', 'Webcam', 'Live feed started');
    startMotionDetection(camId);
  } catch (err) {
    showToast('warning', 'Webcam', `Could not access camera: ${err.message}`);
  }
}

function stopWebcam(camId) {
  const s = activeStreams[camId];
  if (s && s.stream) s.stream.getTracks().forEach(t => t.stop());
  delete activeStreams[camId];
  stopMotionDetection(camId);
  updateCameraStatusBadge(camId, false);
  showToast('info', 'Webcam', 'Feed stopped');
}

// ── Snapshot capture (webcam) ────────────────────────────────────────────────
async function takeSnapshot(camId) {
  const s = activeStreams[camId];
  if (!s || !s.videoEl) return showToast('warning', 'Snapshot', 'No active feed');
  const canvas = document.getElementById(`cam-canvas-${camId}`) || document.createElement('canvas');
  canvas.width = s.videoEl.videoWidth;
  canvas.height = s.videoEl.videoHeight;
  canvas.getContext('2d').drawImage(s.videoEl, 0, 0);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  await uploadSnapshot(camId, dataUrl, 'manual');
}

async function takeIPSnapshot(camId) {
  // For IP cams, the server fetches the frame. We just log an activity.
  try {
    const res = await fetch(`/api/stream/snapshot/${camId}?t=${Date.now()}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) { showToast('danger', 'Snapshot', 'Camera unreachable'); return; }
    const blob = await res.blob();
    const dataUrl = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
    await uploadSnapshot(camId, dataUrl, 'manual');
  } catch (err) {
    showToast('danger', 'Snapshot', err.message);
  }
}

async function uploadSnapshot(camId, dataUrl, trigger = 'manual') {
  try {
    const data = await api('POST', `/cameras/${camId}/snapshot`, { dataUrl, trigger });
    showToast('success', '📸 Snapshot', trigger === 'motion' ? 'Motion snapshot saved!' : 'Snapshot captured & saved');
    // Show mini preview toast
    const img = document.createElement('img');
    img.src = dataUrl; img.style.cssText = 'width:200px;border-radius:8px;margin-top:6px';
    const toast = document.querySelector('.toast:last-child');
    if (toast) toast.appendChild(img);
  } catch (err) {
    showToast('danger', 'Error', err.message);
  }
}

// ── RTSP fallback: if RTSP stream fails, fall back to snapshot polling ──────
function onRtspFeedError(camId, imgEl) {
  // Prevent infinite onerror loop
  if (imgEl.dataset.fallback === 'true') return;
  imgEl.dataset.fallback = 'true';
  imgEl.onerror = null;

  console.warn(`RTSP stream failed for cam ${camId}, falling back to snapshot polling`);
  const fallbackBadge = document.getElementById(`cam-fallback-${camId}`);

  // Try snapshot mode first
  const testImg = new Image();
  testImg.onload = () => {
    // Snapshot works — use polling fallback
    if (fallbackBadge) fallbackBadge.style.display = '';
    imgEl.src = testImg.src;
    imgEl.style.display = '';
    updateCameraStatusBadge(camId, true);
    startIPSnapshotPolling({ id: camId });
  };
  testImg.onerror = () => {
    // Both RTSP and snapshot failed — camera is offline
    imgEl.style.display = 'none';
    const offline = document.getElementById(`cam-offline-${camId}`);
    if (offline) offline.style.display = 'flex';
    updateCameraStatusBadge(camId, false);
  };
  testImg.src = `/api/stream/snapshot/${camId}?t=${Date.now()}&tok=${token}`;
}

// ── IP Camera snapshot polling (fallback mode) ──────────────────────────────
function startIPSnapshotPolling(cam) {
  if (activeStreams[cam.id]?.loopId) return; // already polling
  const intervalId = setInterval(() => {
    const img = document.getElementById(`cam-img-${cam.id}`);
    if (!img) { clearInterval(intervalId); return; }
    const newImg = new Image();
    newImg.onload = () => {
      img.src = newImg.src;
      img.style.display = '';
      const offline = document.getElementById(`cam-offline-${cam.id}`);
      if (offline) offline.style.display = 'none';
      updateCameraStatusBadge(cam.id, true);
    };
    newImg.onerror = () => {
      updateCameraStatusBadge(cam.id, false);
    };
    newImg.src = `/api/stream/snapshot/${cam.id}?t=${Date.now()}&tok=${token}`;
  }, 3000);
  activeStreams[cam.id] = { loopId: intervalId };
}

// ── Canvas-based Motion Detection ────────────────────────────────────────────
function startMotionDetection(camId) {
  const state = { prevData: null };
  const THRESHOLD = 30; // pixel difference threshold
  const MIN_CHANGED = 0.02; // 2% of pixels must change

  const intervalId = setInterval(() => {
    const s = activeStreams[camId];
    if (!s || !s.videoEl || s.videoEl.readyState < 2) return;
    const canvas = document.getElementById(`cam-canvas-${camId}`) || document.createElement('canvas');
    const video = s.videoEl;
    canvas.width = video.videoWidth >> 2; // scale down 4x for perf
    canvas.height = video.videoHeight >> 2;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const current = ctx.getImageData(0, 0, canvas.width, canvas.height);

    if (state.prevData) {
      let changedPixels = 0;
      const total = current.data.length / 4;
      for (let i = 0; i < current.data.length; i += 4) {
        const diff = Math.abs(current.data[i] - state.prevData[i]) +
          Math.abs(current.data[i + 1] - state.prevData[i + 1]) +
          Math.abs(current.data[i + 2] - state.prevData[i + 2]);
        if (diff > THRESHOLD) changedPixels++;
      }
      const ratio = changedPixels / total;
      const motionEl = document.getElementById(`motion-${camId}`);
      if (ratio > MIN_CHANGED) {
        if (motionEl) { motionEl.style.display = ''; }
        // Auto-snapshot on motion (throttled — max once per 15s)
        const key = `motion_snap_${camId}`;
        const lastSnap = parseInt(sessionStorage.getItem(key) || '0');
        if (Date.now() - lastSnap > 15000) {
          sessionStorage.setItem(key, Date.now());
          takeSnapshot(camId).catch(() => { });
        }
      } else {
        if (motionEl) { motionEl.style.display = 'none'; }
      }
    }
    state.prevData = current.data.slice();
  }, 500);

  motionDetectors[camId] = { intervalId };
}

function stopMotionDetection(camId) {
  if (motionDetectors[camId]) {
    clearInterval(motionDetectors[camId].intervalId);
    delete motionDetectors[camId];
  }
  const motionEl = document.getElementById(`motion-${camId}`);
  if (motionEl) motionEl.style.display = 'none';
}

// ── Online probe ─────────────────────────────────────────────────────────────
async function probeCamera(camId) {
  showToast('info', '🔌 Testing', 'Checking camera connection...');
  try {
    const res = await api('GET', `/stream/probe/${camId}`);
    if (res.online) {
      const ports = [];
      if (res.rtsp_reachable) ports.push('RTSP:554');
      if (res.http_reachable) ports.push(`HTTP:${res.http_port || 80}`);
      if (res.onvif_reachable) ports.push(`ONVIF:${res.onvif_port || 8000}`);
      let msg = `Ports open: ${ports.join(', ')}`;
      if (res.ptz_supported) msg += ' | PTZ Ready';
      showToast('success', '✅ Camera Online', msg);
      updateCameraStatusBadge(camId, true);
    } else {
      showToast('danger', '❌ Camera Offline', res.reason);
      updateCameraStatusBadge(camId, false);
    }
  } catch (err) { showToast('danger', 'Error', err.message); }
}

// ── PTZ Control Functions ─────────────────────────────────────────────────────
async function ptzMove(camId, x, y, zoom) {
  try {
    await api('POST', `/stream/ptz/${camId}/move`, { x, y, zoom, duration: 800 });
  } catch (err) {
    showToast('danger', 'PTZ', err.message);
  }
}

async function ptzStop(camId) {
  try {
    await api('POST', `/stream/ptz/${camId}/stop`);
  } catch { /* ignore */ }
}

function openEzyKamApp() {
  // Try deep link to ezyKam+ app, fall back to app store
  const deepLink = 'ezykam://';
  const appStoreUrl = 'https://play.google.com/store/apps/details?id=com.ml.cpsmart';
  const iosUrl = 'https://apps.apple.com/app/ezycam/id1574988498';

  // Try to detect mobile
  const ua = navigator.userAgent.toLowerCase();
  if (/android/.test(ua)) {
    window.location = deepLink;
    setTimeout(() => { window.open(appStoreUrl, '_blank'); }, 1500);
  } else if (/iphone|ipad/.test(ua)) {
    window.location = deepLink;
    setTimeout(() => { window.open(iosUrl, '_blank'); }, 1500);
  } else {
    showToast('info', 'ezyKam+', 'Open the ezyKam+ app on your phone to view the live feed. The camera streams via P2P — only accessible through the app.');
  }
}

function openPTZFullscreen(camId) {
  openModal();
  document.getElementById('modal-body').innerHTML = `
      <div class="modal-header">
        <div class="modal-title">🎮 PTZ Camera Control</div>
        <button class="modal-close" onclick="closeModal()">&#10005;</button>
      </div>
      <div class="ptz-fullscreen">
        <div class="ptz-fs-info">
          <p>This camera streams via P2P cloud (ezyKam+ app).</p>
          <p>Use the controls below to pan, tilt and zoom the camera.</p>
        </div>
        <div class="ptz-panel ptz-panel-lg">
          <div class="ptz-dpad ptz-dpad-lg">
            <button class="ptz-btn ptz-up" onmousedown="ptzMove(${camId},0,0.5,0)" onmouseup="ptzStop(${camId})" ontouchstart="ptzMove(${camId},0,0.5,0)" ontouchend="ptzStop(${camId})">&#9650;</button>
            <button class="ptz-btn ptz-left" onmousedown="ptzMove(${camId},-0.5,0,0)" onmouseup="ptzStop(${camId})" ontouchstart="ptzMove(${camId},-0.5,0,0)" ontouchend="ptzStop(${camId})">&#9664;</button>
            <button class="ptz-btn ptz-center" onclick="ptzStop(${camId})">&#9632;</button>
            <button class="ptz-btn ptz-right" onmousedown="ptzMove(${camId},0.5,0,0)" onmouseup="ptzStop(${camId})" ontouchstart="ptzMove(${camId},0.5,0,0)" ontouchend="ptzStop(${camId})">&#9654;</button>
            <button class="ptz-btn ptz-down" onmousedown="ptzMove(${camId},0,-0.5,0)" onmouseup="ptzStop(${camId})" ontouchstart="ptzMove(${camId},0,-0.5,0)" ontouchend="ptzStop(${camId})">&#9660;</button>
          </div>
          <div class="ptz-zoom-row ptz-zoom-lg">
            <button class="ptz-btn ptz-zoom" onmousedown="ptzMove(${camId},0,0,-0.5)" onmouseup="ptzStop(${camId})">- Zoom Out</button>
            <button class="ptz-btn ptz-zoom" onmousedown="ptzMove(${camId},0,0,0.5)" onmouseup="ptzStop(${camId})">+ Zoom In</button>
          </div>
          <button class="ptz-app-btn ptz-app-btn-lg" onclick="openEzyKamApp()">Open ezyKam+ App for Live View</button>
        </div>
      </div>
      <p style="font-size:12px;color:var(--text-dim);text-align:center;margin-top:10px">
        PTZ via ONVIF &nbsp;|&nbsp; Live view via ezyKam+ app
      </p>
    `;
}

function updateCameraStatusBadge(camId, online) {
  const badge = document.getElementById(`cam-status-${camId}`);
  if (!badge) return;
  badge.innerHTML = online
    ? '<span class="status-live">LIVE</span>'
    : '<span style="color:var(--text-dim);font-size:10px">OFFLINE</span>';
}

// ── Fullscreen viewer ─────────────────────────────────────────────────────────
function openCameraFullscreen(camId) {
  openModal();
  document.getElementById('modal-body').innerHTML = `
      <div class="modal-header">
        <div class="modal-title">📹 Camera Feed — Live View</div>
        <button class="modal-close" onclick="closeModal()">✕</button>
      </div>
      <div style="position:relative;background:#000;border-radius:12px;overflow:hidden;aspect-ratio:16/9">
        <img id="fullscreen-feed" src="/api/stream/rtsp/${camId}?hd=1&tok=${token}"
          style="width:100%;height:100%;object-fit:contain"
          onerror="fullscreenFeedFallback(${camId}, this)" />
        <div id="fullscreen-mode-badge" style="display:none;position:absolute;top:8px;left:8px;font-size:10px;color:#ffd43b;background:rgba(0,0,0,0.6);padding:3px 8px;border-radius:4px">SNAPSHOT MODE</div>
        <div style="position:absolute;bottom:12px;right:12px;display:flex;gap:8px">
          <button class="cam-btn cam-btn-snap" onclick="takeIPSnapshot(${camId})">📸 Snapshot</button>
        </div>
      </div>
      <p style="font-size:12px;color:var(--text-dim);text-align:center;margin-top:10px">
        RTSP live stream via FFmpeg — HD mode
      </p>
    `;

  // Cleanup RTSP stream when modal closes
  const origClose = window.closeModal;
  window.closeModal = () => {
    const img = document.getElementById('fullscreen-feed');
    if (img) img.src = ''; // disconnect RTSP stream
    if (window._fullscreenPollId) clearInterval(window._fullscreenPollId);
    window.closeModal = origClose;
    origClose();
  };
}

function fullscreenFeedFallback(camId, imgEl) {
  imgEl.onerror = null;
  // Fall back to snapshot polling in fullscreen
  const badge = document.getElementById('fullscreen-mode-badge');
  if (badge) badge.style.display = '';
  imgEl.src = `/api/stream/snapshot/${camId}?t=${Date.now()}&tok=${token}`;
  window._fullscreenPollId = setInterval(() => {
    const img = document.getElementById('fullscreen-feed');
    if (!img) { clearInterval(window._fullscreenPollId); return; }
    img.src = `/api/stream/snapshot/${camId}?t=${Date.now()}&tok=${token}`;
  }, 2000);
}

// ── Snapshot history viewer ───────────────────────────────────────────────────
async function showCameraSnapshots(camId) {
  openModal();
  document.getElementById('modal-body').innerHTML = '<div class="loading-state"><div class="spinner"></div></div>';
  try {
    const logs = await api('GET', `/cameras/${camId}/snapshots`);
    document.getElementById('modal-body').innerHTML = `
          <div class="modal-header">
            <div class="modal-title">📸 Snapshot History</div>
            <button class="modal-close" onclick="closeModal()">✕</button>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;max-height:60vh;overflow-y:auto;padding:4px">
            ${logs.length ? logs.map(l => `
              <div style="background:rgba(255,255,255,0.05);border-radius:8px;overflow:hidden;cursor:pointer" onclick="window.open('${l.snapshot}','_blank')">
                <img src="${l.snapshot}" style="width:100%;aspect-ratio:16/9;object-fit:cover" onerror="this.style.display='none'" />
                <div style="padding:6px;font-size:10px;color:var(--text-dim)">${new Date(l.created_at).toLocaleString()}</div>
                <div style="padding:0 6px 6px;font-size:11px;color:var(--text-muted)">${l.description || l.event_type}</div>
              </div>`).join('') : '<div class="empty-state"><span>📸</span><p>No snapshots yet</p></div>'}
          </div>
        `;
  } catch (err) { showToast('danger', 'Error', err.message); closeModal(); }
}

// ── Add / Edit camera modal ───────────────────────────────────────────────────
function showCameraModal(camData = null) {
  const cam = typeof camData === 'object' && camData !== null ? camData : {};
  const id = cam.id || null;
  openModal();
  document.getElementById('modal-body').innerHTML = `
    <div class="modal-header">
      <div class="modal-title">${id ? 'Edit Camera' : '📹 Add Camera'}</div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>

    <!-- Source type selector -->
    <div class="cam-source-tabs" id="cam-source-tabs">
      <button class="cam-source-tab ${(!cam.source_type || cam.source_type === 'simulated') ? 'active' : ''}" onclick="switchCamTab('simulated')">🔮 Simulated</button>
      <button class="cam-source-tab ${cam.source_type === 'webcam' ? 'active' : ''}" onclick="switchCamTab('webcam')">💻 Webcam</button>
      <button class="cam-source-tab ${cam.source_type === 'ip' ? 'active' : ''}" onclick="switchCamTab('ip')">📡 IP Camera</button>
    </div>

    <div class="form-grid">
      <div class="form-grid two-col">
        <div class="form-field">
          <label>Camera Name *</label>
          <input type="text" id="cam-name" class="form-input" value="${cam.name || ''}" placeholder="e.g. Kitchen Cam" />
        </div>
        <div class="form-field">
          <label>Zone *</label>
          <select id="cam-zone" class="form-input">
            ${['kitchen', 'entrance', 'living_room', 'bedroom', 'outdoor'].map(z => `<option value="${z}" ${cam.zone === z ? 'selected' : ''}>${z.replace(/_/g, ' ')}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-field">
        <label>Physical Location</label>
        <input type="text" id="cam-location" class="form-input" value="${cam.location || ''}" placeholder="e.g. Kitchen Counter, Above Fridge" />
      </div>
      <div class="form-field">
        <label>Detection Sensitivity</label>
        <select id="cam-sensitivity" class="form-input">
          ${['low', 'medium', 'high'].map(s => `<option value="${s}" ${cam.sensitivity === s ? 'selected' : ''}>${s.charAt(0).toUpperCase() + s.slice(1)}</option>`).join('')}
        </select>
      </div>

      <!-- IP Camera specific fields -->
      <div id="ip-cam-fields" style="${cam.source_type === 'ip' ? '' : 'display:none'}">
        <div style="background:rgba(91,127,255,0.08);border:1px solid rgba(91,127,255,0.25);border-radius:10px;padding:14px;margin-top:4px">
          <div style="font-size:12px;font-weight:700;color:var(--primary);margin-bottom:12px">📡 IP Camera Configuration</div>
          
          <div class="form-field" style="margin-bottom:10px">
            <label>Camera Brand</label>
            <select id="cam-brand" class="form-input" onchange="autofillCPPlusHints()">
              <option value="cpplus" ${cam.cam_brand === 'cpplus' ? 'selected' : ''}>CP PLUS (ezyKam+ / E28A)</option>
              <option value="hikvision" ${cam.cam_brand === 'hikvision' ? 'selected' : ''}>Hikvision</option>
              <option value="dahua" ${cam.cam_brand === 'dahua' ? 'selected' : ''}>Dahua</option>
              <option value="generic" ${(!cam.cam_brand || cam.cam_brand === 'generic') ? 'selected' : ''}>Generic / Other</option>
            </select>
          </div>

          <div class="form-grid two-col">
            <div class="form-field">
              <label>Camera IP Address *</label>
              <input type="text" id="cam-ip" class="form-input" value="${cam.cam_ip || ''}" placeholder="192.168.1.108" />
            </div>
            <div class="form-field">
              <label>HTTP Port</label>
              <input type="number" id="cam-port" class="form-input" value="${cam.cam_port || 80}" placeholder="80" />
            </div>
          </div>

          <div class="form-grid two-col">
            <div class="form-field">
              <label>Username</label>
              <input type="text" id="cam-username" class="form-input" value="${cam.cam_username || 'admin'}" placeholder="admin" />
            </div>
            <div class="form-field">
              <label>Password</label>
              <input type="password" id="cam-password" class="form-input" value="${cam.cam_password || ''}" placeholder="admin / your password" />
            </div>
          </div>
          
          <div id="cam-url-hints" style="font-size:11px;color:var(--text-dim);margin-top:8px;line-height:1.7;background:rgba(0,0,0,0.2);padding:8px;border-radius:6px">
            <!-- filled by autofillCPPlusHints() -->
          </div>
        </div>
      </div>
      
      <!-- Hidden source type value -->
      <input type="hidden" id="cam-source-type" value="${cam.source_type || 'simulated'}" />
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      ${cam.source_type === 'ip' || (document.getElementById && false) ? `<button class="btn-secondary" onclick="testCameraConn()">🔌 Test Connection</button>` : ''}
      <button class="btn-primary" onclick="saveCamera(${id || 'null'})">${id ? 'Save Changes' : 'Add Camera'}</button>
    </div>
  `;

  // Show URL hints for CP Plus by default if it's an IP camera
  if (!cam.source_type || cam.source_type === 'ip') autofillCPPlusHints();
}

function switchCamTab(type) {
  document.querySelectorAll('.cam-source-tab').forEach(t => t.classList.remove('active'));
  event.target.classList.add('active');
  document.getElementById('cam-source-type').value = type;
  const ipFields = document.getElementById('ip-cam-fields');
  if (ipFields) ipFields.style.display = type === 'ip' ? '' : 'none';
  autofillCPPlusHints();
}

function autofillCPPlusHints() {
  const brand = document.getElementById('cam-brand')?.value;
  const ip = document.getElementById('cam-ip')?.value || '192.168.x.x';
  const user = document.getElementById('cam-username')?.value || 'admin';
  const pass = document.getElementById('cam-password')?.value || 'admin';
  const hintsEl = document.getElementById('cam-url-hints');
  if (!hintsEl) return;
  const hints = {
    cpplus: {
      name: 'CP PLUS (E28A / ezyKam+)',
      rtsp: `rtsp://${user}:${pass}@${ip}:554/cam/realmonitor?channel=1&subtype=0`,
      snapshot: `http://${ip}/cgi-bin/snapshot.cgi?channel=0`,
      mjpeg: `http://${ip}/cgi-bin/mjpeg?stream=0`,
      note: 'Default credentials: admin / admin. Find IP in CP Plus app → Device Info.'
    },
    hikvision: {
      name: 'Hikvision',
      rtsp: `rtsp://${user}:${pass}@${ip}:554/Streaming/Channels/101`,
      snapshot: `http://${ip}/ISAPI/Streaming/channels/101/picture`,
      mjpeg: `http://${ip}/ISAPI/Streaming/channels/101/httppreview`,
      note: 'Default credentials: admin / 12345'
    },
    dahua: {
      name: 'Dahua',
      rtsp: `rtsp://${user}:${pass}@${ip}:554/cam/realmonitor?channel=1&subtype=0`,
      snapshot: `http://${ip}/cgi-bin/snapshot.cgi`,
      mjpeg: `http://${ip}/cgi-bin/mjpg/video.cgi?channel=0`,
      note: 'Default credentials: admin / admin'
    },
    generic: { rtsp: `rtsp://${user}:${pass}@${ip}:554/`, snapshot: `http://${ip}/cgi-bin/snapshot.cgi`, mjpeg: `http://${ip}/video.mjpeg`, note: 'Configure manually.' }
  };
  const h = hints[brand] || hints.generic;
  hintsEl.innerHTML = `
      ${h.name ? `<strong>${h.name}</strong><br>` : ''}
      🎞️ RTSP: <code style="color:var(--primary-light)">${h.rtsp}</code><br>
      📸 Snapshot: <code style="color:var(--success)">${h.snapshot}</code><br>
      🎥 MJPEG: <code style="color:var(--warning)">${h.mjpeg}</code><br>
      ${h.note ? `💡 ${h.note}` : ''}
    `;
}

async function saveCamera(id) {
  const sourceType = document.getElementById('cam-source-type')?.value || 'simulated';
  const body = {
    name: document.getElementById('cam-name')?.value,
    location: document.getElementById('cam-location')?.value,
    zone: document.getElementById('cam-zone')?.value,
    sensitivity: document.getElementById('cam-sensitivity')?.value,
    source_type: sourceType,
    status: 'active',
    // IP camera fields
    cam_ip: document.getElementById('cam-ip')?.value || null,
    cam_port: parseInt(document.getElementById('cam-port')?.value) || 80,
    cam_username: document.getElementById('cam-username')?.value || 'admin',
    cam_password: document.getElementById('cam-password')?.value || 'admin',
    cam_brand: document.getElementById('cam-brand')?.value || 'generic',
  };
  if (!body.name || !body.location) { showToast('warning', 'Validation', 'Name and location required'); return; }
  if (sourceType === 'ip' && !body.cam_ip) { showToast('warning', 'Validation', 'IP address is required for IP cameras'); return; }
  try {
    if (id) await api('PUT', `/cameras/${id}`, body);
    else await api('POST', '/cameras', body);
    showToast('success', 'Saved', `Camera ${id ? 'updated' : 'added'}`);
    closeModal();
    loadCameras();
  } catch (err) {
    showToast('danger', 'Error', err.message);
  }
}

async function deleteCamera(id) {
  if (!confirm('Remove this camera?')) return;
  stopWebcam(id);
  stopMotionDetection(id);
  try {
    await api('DELETE', `/cameras/${id}`);
    showToast('success', 'Removed', 'Camera removed');
    loadCameras();
  } catch (err) {
    showToast('danger', 'Error', err.message);
  }
}

// ====== STAFF ======

async function loadStaff() {
  const grid = document.getElementById('staff-grid');
  grid.innerHTML = '<div class="loading-state"><div class="spinner"></div></div>';
  try {
    const staff = await api('GET', '/staff');
    renderStaff(staff);
  } catch (err) {
    showToast('danger', 'Error', err.message);
  }
}

function renderStaff(staff) {
  const grid = document.getElementById('staff-grid');
  grid.innerHTML = '';
  if (!staff.length) {
    grid.innerHTML = '<div class="empty-state"><span class="empty-icon">👥</span><p>No staff members added</p></div>';
    return;
  }
  const avatarColors = ['#5b7fff', '#a855f7', '#00d4aa', '#ffa502', '#ff4757', '#2ed573'];
  staff.forEach((s, i) => {
    const score = s.trust_score || 0;
    const scoreColor = score >= 80 ? 'var(--success)' : score >= 50 ? 'var(--warning)' : 'var(--danger)';
    const color = avatarColors[i % avatarColors.length];
    const el = createEl('div', `staff-card ${s.status === 'terminated' ? 'terminated' : ''}`);
    el.innerHTML = `
      <div class="staff-card-header">
        <div class="staff-avatar" style="background:${color}22;color:${color}">${s.name.charAt(0)}</div>
        <div class="staff-basic">
          <div class="staff-name">${s.name}</div>
          <div class="staff-role">${s.role}</div>
        </div>
        <div class="trust-score-display">
          <div class="trust-number" style="color:${scoreColor}">${score}</div>
          <div class="trust-label">Trust Score</div>
        </div>
      </div>
      <div class="staff-details">
        <div class="staff-detail-row"><span>📱</span> ${s.phone || 'No phone'}</div>
        <div class="staff-detail-row"><span>🕐</span> Shift: ${s.shift_start} – ${s.shift_end}</div>
        <div class="staff-detail-row"><span>💰</span> ₹${(s.salary || 0).toLocaleString()}/month</div>
        <div class="staff-detail-row"><span>📅</span> Hired: ${s.hired_date || 'Unknown'}</div>
        ${s.incident_count > 0 ? `<div class="incident-count-badge">🚨 ${s.incident_count} incident${s.incident_count !== 1 ? 's' : ''} (${s.open_incidents} open)</div>` : ''}
      </div>
      <div style="margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-muted);margin-bottom:4px">
          <span>Trust Score</span><span style="color:${scoreColor};font-weight:700">${score}/100</span>
        </div>
        <div class="trust-bar-bg" style="height:6px"><div class="trust-bar-fill" style="width:${score}%;background:${scoreColor}"></div></div>
      </div>
      <div class="staff-actions">
        ${s.status !== 'terminated' ? `
          <button class="btn-secondary btn-sm" onclick="showStaffModal(${s.id})">Edit</button>
          <button class="btn-danger" onclick="confirmTerminateStaff(${s.id}, '${s.name}')">🔥 Terminate</button>
        ` : `<span style="color:var(--danger);font-size:12px;font-weight:600">⛔ Employment Terminated</span>`}
      </div>
    `;
    grid.appendChild(el);
  });
}

function showStaffModal(id = null) {
  openModal();
  document.getElementById('modal-body').innerHTML = `
    <div class="modal-header">
      <div class="modal-title">${id ? 'Edit Staff' : '👤 Add New Staff'}</div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div class="form-grid">
      <div class="form-grid two-col">
        <div class="form-field">
          <label>Full Name *</label>
          <input type="text" id="staff-name" class="form-input" placeholder="Staff member name" />
        </div>
        <div class="form-field">
          <label>Role *</label>
          <select id="staff-role" class="form-input">
            <option value="Cook">Cook</option>
            <option value="Housekeeping">Housekeeping</option>
            <option value="Driver">Driver</option>
            <option value="Security">Security</option>
            <option value="Babysitter">Babysitter</option>
            <option value="Gardener">Gardener</option>
            <option value="Other">Other</option>
          </select>
        </div>
      </div>
      <div class="form-grid two-col">
        <div class="form-field">
          <label>Phone</label>
          <input type="text" id="staff-phone" class="form-input" placeholder="+91-..." />
        </div>
        <div class="form-field">
          <label>Monthly Salary (₹)</label>
          <input type="number" id="staff-salary" class="form-input" placeholder="12000" />
        </div>
      </div>
      <div class="form-grid two-col">
        <div class="form-field">
          <label>Shift Start</label>
          <input type="time" id="staff-shift-start" class="form-input" value="08:00" />
        </div>
        <div class="form-field">
          <label>Shift End</label>
          <input type="time" id="staff-shift-end" class="form-input" value="17:00" />
        </div>
      </div>
      <div class="form-field">
        <label>Hired Date</label>
        <input type="date" id="staff-hired" class="form-input" />
      </div>
      <div class="form-field">
        <label>Notes</label>
        <textarea id="staff-notes" class="form-input" placeholder="Any additional notes about this staff member..."></textarea>
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" onclick="saveStaff(${id || 'null'})">${id ? 'Save Changes' : 'Add Staff'}</button>
    </div>
  `;
}

async function saveStaff(id) {
  const body = {
    name: document.getElementById('staff-name').value,
    role: document.getElementById('staff-role').value,
    phone: document.getElementById('staff-phone').value,
    salary: parseFloat(document.getElementById('staff-salary').value) || 0,
    shift_start: document.getElementById('staff-shift-start').value,
    shift_end: document.getElementById('staff-shift-end').value,
    hired_date: document.getElementById('staff-hired').value,
    notes: document.getElementById('staff-notes').value,
    status: 'active',
    trust_score: 100
  };
  if (!body.name) { showToast('warning', 'Validation', 'Name is required'); return; }
  try {
    if (id) await api('PUT', `/staff/${id}`, body);
    else await api('POST', '/staff', body);
    showToast('success', 'Saved', `Staff ${id ? 'updated' : 'added'}`);
    closeModal();
    loadStaff();
  } catch (err) {
    showToast('danger', 'Error', err.message);
  }
}

function confirmTerminateStaff(id, name) {
  openModal();
  document.getElementById('modal-body').innerHTML = `
    <div class="modal-header">
      <div class="modal-title">🔥 Terminate Employment</div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div style="text-align:center;padding:20px 0">
      <div style="font-size:48px;margin-bottom:16px">⚠️</div>
      <p style="font-size:16px;font-weight:600;margin-bottom:8px">Terminate ${name}?</p>
      <p style="color:var(--text-muted);font-size:14px;margin-bottom:24px">This action will mark this staff member as terminated. All incident records will be preserved.</p>
      <div style="display:flex;gap:12px;justify-content:center">
        <button class="btn-secondary" onclick="closeModal()">Cancel</button>
        <button class="btn-danger" style="padding:10px 20px;font-size:14px" onclick="terminateStaff(${id})">🔥 Yes, Terminate</button>
      </div>
    </div>
  `;
}

async function terminateStaff(id) {
  try {
    await api('DELETE', `/staff/${id}`);
    showToast('info', 'Terminated', 'Staff member has been terminated');
    closeModal();
    loadStaff();
    if (currentView === 'dashboard') loadDashboard();
  } catch (err) {
    showToast('danger', 'Error', err.message);
  }
}

// ====== INVENTORY ======
const foodEmojis = { Mangoes: '🥭', Bananas: '🍌', Apples: '🍎', Milk: '🥛', Cheese: '🧀', Eggs: '🥚', Butter: '🧈', 'Orange Juice': '🍊', Yogurt: '🫙', Rice: '🍚', Bread: '🍞', Vegetables: '🥦', Chicken: '🍗', Fish: '🐟', Fruits: '🍑' };

async function loadInventory() {
  const grid = document.getElementById('inventory-grid');
  grid.innerHTML = '<div class="loading-state"><div class="spinner"></div></div>';
  try {
    const items = await api('GET', '/inventory');
    renderInventory(items);
  } catch (err) {
    showToast('danger', 'Error', err.message);
  }
}

function renderInventory(items) {
  const grid = document.getElementById('inventory-grid');
  grid.innerHTML = '';
  if (!items.length) {
    grid.innerHTML = '<div class="empty-state"><span class="empty-icon">🧊</span><p>No items tracked</p></div>';
    return;
  }
  items.forEach(item => {
    const emoji = foodEmojis[item.name] || '🍽️';
    const el = createEl('div', `inventory-card ${item.status}`);
    el.innerHTML = `
      <div class="inventory-emoji">${emoji}</div>
      <div class="inventory-name">${item.name}</div>
      <div class="inventory-qty">${item.quantity} ${item.unit}</div>
      <div class="inventory-location">📍 ${item.location}</div>
      <span class="inventory-status-badge status-${item.status}">${item.status.toUpperCase()}</span>
      <div style="display:flex;gap:6px;margin-top:10px">
        <button class="btn-secondary btn-sm" onclick="showEditInventoryModal(${item.id},'${item.name}',${item.quantity},'${item.unit}','${item.location}','${item.status}')">Edit</button>
        <button class="btn-danger" onclick="deleteInventoryItem(${item.id})">✕</button>
      </div>
    `;
    grid.appendChild(el);
  });
}

function showInventoryModal(id = null, name = '', qty = 1, unit = 'pcs', location = 'fridge', status = 'present') {
  openModal();
  document.getElementById('modal-body').innerHTML = `
    <div class="modal-header">
      <div class="modal-title">${id ? 'Edit Item' : '🧊 Add Inventory Item'}</div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div class="form-grid">
      <div class="form-field">
        <label>Item Name *</label>
        <input type="text" id="inv-name" class="form-input" value="${name}" placeholder="e.g. Mangoes, Milk" />
      </div>
      <div class="form-grid two-col">
        <div class="form-field">
          <label>Quantity</label>
          <input type="number" id="inv-qty" class="form-input" value="${qty}" min="0" />
        </div>
        <div class="form-field">
          <label>Unit</label>
          <input type="text" id="inv-unit" class="form-input" value="${unit}" placeholder="pcs, kg, litres" />
        </div>
      </div>
      <div class="form-grid two-col">
        <div class="form-field">
          <label>Storage Location</label>
          <select id="inv-location" class="form-input">
            <option value="fridge" ${location === 'fridge' ? 'selected' : ''}>Fridge</option>
            <option value="freezer" ${location === 'freezer' ? 'selected' : ''}>Freezer</option>
            <option value="pantry" ${location === 'pantry' ? 'selected' : ''}>Pantry</option>
            <option value="cabinet" ${location === 'cabinet' ? 'selected' : ''}>Cabinet</option>
            <option value="counter" ${location === 'counter' ? 'selected' : ''}>Counter</option>
          </select>
        </div>
        <div class="form-field">
          <label>Status</label>
          <select id="inv-status" class="form-input">
            <option value="present" ${status === 'present' ? 'selected' : ''}>Present</option>
            <option value="low" ${status === 'low' ? 'selected' : ''}>Running Low</option>
            <option value="missing" ${status === 'missing' ? 'selected' : ''}>Missing</option>
          </select>
        </div>
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" onclick="saveInventoryItem(${id || 'null'})">${id ? 'Save' : 'Add Item'}</button>
    </div>
  `;
}

function showEditInventoryModal(id, name, qty, unit, location, status) {
  showInventoryModal(id, name, qty, unit, location, status);
}

async function saveInventoryItem(id) {
  const body = {
    name: document.getElementById('inv-name').value,
    quantity: parseFloat(document.getElementById('inv-qty').value),
    unit: document.getElementById('inv-unit').value,
    location: document.getElementById('inv-location').value,
    status: document.getElementById('inv-status').value,
  };
  if (!body.name) { showToast('warning', 'Validation', 'Item name required'); return; }
  try {
    if (id) await api('PUT', `/inventory/${id}`, body);
    else await api('POST', '/inventory', body);
    showToast('success', 'Saved', 'Item saved');
    closeModal();
    loadInventory();
  } catch (err) {
    showToast('danger', 'Error', err.message);
  }
}

async function deleteInventoryItem(id) {
  if (!confirm('Remove this item?')) return;
  try {
    await api('DELETE', `/inventory/${id}`);
    showToast('success', 'Removed', 'Item removed');
    loadInventory();
  } catch (err) {
    showToast('danger', 'Error', err.message);
  }
}

// ====== ALERTS ======
async function loadAlerts() {
  const list = document.getElementById('alerts-list');
  list.innerHTML = '<div class="loading-state"><div class="spinner"></div></div>';
  try {
    const data = await api('GET', '/alerts');
    renderAlerts(data.alerts);
  } catch (err) {
    showToast('danger', 'Error', err.message);
  }
}

function renderAlerts(alerts) {
  const list = document.getElementById('alerts-list');
  list.innerHTML = '';
  if (!alerts.length) {
    list.innerHTML = '<div class="empty-state"><span class="empty-icon">🔔</span><p>No alerts</p></div>';
    return;
  }
  alerts.forEach(a => {
    const el = createEl('div', `alert-item ${a.type} ${a.read ? '' : 'unread'}`);
    if (!a.read) {
      const dot = createEl('div', 'alert-unread-dot');
      el.insertBefore(dot, el.firstChild);
    }
    el.innerHTML = `
      ${!a.read ? '<div class="alert-unread-dot"></div>' : ''}
      <div class="alert-icon-wrap">${a.type === 'high' ? '🚨' : a.type === 'medium' ? '⚠️' : '🔔'}</div>
      <div class="alert-content">
        <div class="alert-message">${a.message}</div>
        <div class="alert-time">${new Date(a.sent_at).toLocaleString()}</div>
      </div>
    `;
    el.onclick = async () => {
      if (!a.read) {
        await api('PATCH', `/alerts/${a.id}/read`);
        el.classList.remove('unread');
        a.read = 1;
        if (a.incident_id) { closeModal(); showIncidentDetail(a.incident_id); }
      }
    };
    list.appendChild(el);
  });
}

async function markAllRead() {
  try {
    await api('PATCH', '/alerts/read-all');
    showToast('success', 'Done', 'All alerts marked as read');
    loadAlerts();
    document.getElementById('bell-badge').style.display = 'none';
    document.getElementById('alerts-badge').style.display = 'none';
  } catch (err) {
    showToast('danger', 'Error', err.message);
  }
}

// ====== AI SIMULATE ======
async function simulateAIEvent() {
  try {
    const data = await api('POST', '/dashboard/simulate-ai-event');
    showToast('danger', '🤖 AI Detection!', data.incident.title);
    if (currentView === 'dashboard') loadDashboard();
    if (currentView === 'incidents') loadIncidents();
  } catch (err) {
    showToast('danger', 'Error', err.message);
  }
}

// ====== MODAL ======
function openModal() {
  document.getElementById('modal-overlay').classList.remove('hidden');
}

function closeModal(e) {
  if (!e || e.target === document.getElementById('modal-overlay')) {
    document.getElementById('modal-overlay').classList.add('hidden');
    document.getElementById('modal-body').innerHTML = '';
  }
}

// ====== TOAST ======
function showToast(type, title, msg) {
  const icons = { danger: '🚨', success: '✅', warning: '⚠️', info: 'ℹ️' };
  const container = document.getElementById('toast-container');
  const toast = createEl('div', `toast ${type}`);
  toast.innerHTML = `
    <div class="toast-icon">${icons[type] || '🔔'}</div>
    <div class="toast-body">
      <div class="toast-title">${title}</div>
      <div class="toast-msg">${msg}</div>
    </div>
    <span class="toast-close" onclick="this.parentElement.remove()">✕</span>
  `;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

// ====== UTILS ======
function createEl(tag, className) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  return el;
}

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

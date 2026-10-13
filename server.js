'use strict';
process.env.TZ = process.env.TZ || 'Africa/Casablanca';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { db, tx } = require('./db');

const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const MAX_DAYS_AHEAD = 60;

/* ------------------------------------------------------------------ */
/* Session secret + SQLite session store                               */
/* ------------------------------------------------------------------ */
function getSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const f = path.join(__dirname, '.session-secret');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
  const s = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}

class SqliteStore extends session.Store {
  get(sid, cb) {
    try {
      const r = db.prepare('SELECT data, expires FROM sessions WHERE sid = ?').get(sid);
      if (!r || r.expires < Date.now()) return cb(null, null);
      cb(null, JSON.parse(r.data));
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try {
      const exp = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 864e5;
      db.prepare('INSERT OR REPLACE INTO sessions (sid, data, expires) VALUES (?,?,?)')
        .run(sid, JSON.stringify(sess), exp);
      cb && cb(null);
    } catch (e) { cb && cb(e); }
  }
  destroy(sid, cb) {
    try { db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid); cb && cb(null); }
    catch (e) { cb && cb(e); }
  }
}
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()), 36e5).unref();

/* ------------------------------------------------------------------ */
/* App setup                                                           */
/* ------------------------------------------------------------------ */
const app = express();
if (IS_PROD) app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '50kb' }));
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy':
      "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
  });
  next();
});
app.use(session({
  name: 'sid',
  secret: getSecret(),
  resave: false,
  saveUninitialized: false,
  store: new SqliteStore(),
  cookie: { httpOnly: true, sameSite: 'lax', secure: IS_PROD, maxAge: 7 * 864e5 },
}));

// CSRF defence for a JSON API: state-changing requests must be JSON (cannot be
// sent cross-site by a plain HTML form) and, when present, Origin must match Host.
app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const origin = req.get('origin');
    if (origin) {
      try { if (new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'Bad origin' }); }
      catch { return res.status(403).json({ error: 'Bad origin' }); }
    }
    if (req.body && Object.keys(req.body).length && !req.is('application/json'))
      return res.status(415).json({ error: 'JSON required' });
  }
  next();
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const int = (v, d = 0) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
const fromMin = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function parseDate(s) {
  if (!DATE_RE.test(s)) return null;
  const d = new Date(s + 'T00:00:00');
  return Number.isNaN(d.getTime()) || ymd(d) !== s ? null : d;
}
function dateInRange(s) {
  const d = parseDate(s);
  if (!d) return false;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((d - today) / 864e5);
  return diff >= 0 && diff <= MAX_DAYS_AHEAD;
}
function isPast(date, start) {
  const now = new Date();
  return date < ymd(now) || (date === ymd(now) && toMin(start) <= now.getHours() * 60 + now.getMinutes());
}

const wrap = (fn) => (req, res, next) => { try { fn(req, res, next); } catch (e) { next(e); } };
const publicUser = (u) => u && ({ id: u.id, name: u.name, email: u.email, role: u.role, phone: u.phone });

function loadUser(req, res, next) {
  if (req.session.uid) {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.uid);
    if (u && u.active) req.user = u;
    else req.session.destroy(() => {});
  }
  next();
}
app.use(loadUser);
const requireAuth = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Please log in' }));
const requireRole = (...roles) => (req, res, next) =>
  !req.user ? res.status(401).json({ error: 'Please log in' })
    : roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Not allowed' });

/* Simple in-memory login throttle: 10 failures / 15 min per ip+email */
const fails = new Map();
function throttled(key) {
  const e = fails.get(key);
  return e && e.until > Date.now() && e.n >= 10;
}
function noteFail(key) {
  const now = Date.now();
  const e = fails.get(key);
  if (!e || e.until < now) fails.set(key, { n: 1, until: now + 15 * 60e3 });
  else e.n++;
}

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */
app.post('/api/register', wrap((req, res) => {
  const b = req.body || {};
  const name = str(b.name, 80), email = str(b.email, 120).toLowerCase();
  const password = typeof b.password === 'string' ? b.password : '';
  const role = b.role === 'professional' ? 'professional' : 'client';
  const phone = str(b.phone, 30);
  if (name.length < 2) return res.status(400).json({ error: 'Name is required' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Valid email is required' });
  if (password.length < 8 || password.length > 100) return res.status(400).json({ error: 'Password must be 8–100 characters' });

  let profession_id = 0;
  if (role === 'professional') {
    profession_id = int(b.profession_id);
    if (!db.prepare('SELECT 1 FROM professions WHERE id = ?').get(profession_id))
      return res.status(400).json({ error: 'Please choose a profession' });
  }
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email))
    return res.status(409).json({ error: 'This email is already registered' });

  const hash = bcrypt.hashSync(password, 11);
  const uid = tx(() => {
    const r = db.prepare('INSERT INTO users (name,email,password_hash,role,phone) VALUES (?,?,?,?,?)')
      .run(name, email, hash, role, phone);
    const id = Number(r.lastInsertRowid);
    if (role === 'professional') {
      db.prepare(`INSERT INTO professionals (user_id,profession_id,bio,city,address,price,duration_min)
                  VALUES (?,?,?,?,?,?,?)`)
        .run(id, profession_id, str(b.bio, 600), str(b.city, 60), str(b.address, 150),
          Math.max(0, Math.min(100000, int(b.price))), [15, 20, 30, 45, 60, 90, 120].includes(int(b.duration_min)) ? int(b.duration_min) : 30);
      // sensible default: Mon–Fri 09:00–17:00
      const a = db.prepare('INSERT INTO availability (pro_id,weekday,start,end) VALUES (?,?,?,?)');
      for (let d = 1; d <= 5; d++) a.run(id, d, '09:00', '17:00');
    }
    return id;
  });
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Session error' });
    req.session.uid = uid;
    res.status(201).json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(uid)) });
  });
}));

app.post('/api/login', wrap((req, res) => {
  const email = str(req.body && req.body.email, 120).toLowerCase();
  const password = typeof (req.body && req.body.password) === 'string' ? req.body.password : '';
  const key = req.ip + '|' + email;
  if (throttled(key)) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  // compare against a dummy hash when the user is unknown to keep timing similar
  const ok = bcrypt.compareSync(password, u ? u.password_hash : '$2a$11$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvali');
  if (!u || !ok) { noteFail(key); return res.status(401).json({ error: 'Incorrect email or password' }); }
  if (!u.active) return res.status(403).json({ error: 'This account has been disabled' });
  fails.delete(key);
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Session error' });
    req.session.uid = u.id;
    res.json({ user: publicUser(u) });
  });
}));

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => { res.clearCookie('sid'); res.json({ ok: true }); });
});

app.get('/api/me', (req, res) => res.json({ user: publicUser(req.user) || null }));

app.post('/api/me/password', requireAuth, wrap((req, res) => {
  const { current, next: np } = req.body || {};
  if (typeof np !== 'string' || np.length < 8 || np.length > 100)
    return res.status(400).json({ error: 'New password must be 8–100 characters' });
  if (!bcrypt.compareSync(String(current || ''), req.user.password_hash))
    return res.status(400).json({ error: 'Current password is incorrect' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(np, 11), req.user.id);
  res.json({ ok: true });
}));

app.put('/api/me', requireAuth, wrap((req, res) => {
  const name = str(req.body.name, 80), phone = str(req.body.phone, 30);
  if (name.length < 2) return res.status(400).json({ error: 'Name is required' });
  db.prepare('UPDATE users SET name = ?, phone = ? WHERE id = ?').run(name, phone, req.user.id);
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)) });
}));

/* ------------------------------------------------------------------ */
/* Professions & directory (public)                                    */
/* ------------------------------------------------------------------ */
app.get('/api/professions', (req, res) => {
  res.json(db.prepare(`
    SELECT p.id, p.name_en, p.name_fr,
      (SELECT COUNT(*) FROM professionals x JOIN users u ON u.id = x.user_id
        WHERE x.profession_id = p.id AND u.active = 1 AND x.accepting = 1) AS pros
    FROM professions p ORDER BY p.name_en`).all());
});

const PRO_SELECT = `
  SELECT u.id, u.name, u.phone, p.bio, p.city, p.address, p.price, p.duration_min, p.accepting,
         pr.id AS profession_id, pr.name_en AS profession, pr.name_fr AS profession_fr
  FROM professionals p
  JOIN users u ON u.id = p.user_id
  JOIN professions pr ON pr.id = p.profession_id`;

app.get('/api/professionals', (req, res) => {
  const where = ['u.active = 1', 'p.accepting = 1'], args = [];
  const prof = int(req.query.profession);
  if (prof) { where.push('p.profession_id = ?'); args.push(prof); }
  const city = str(req.query.city, 60);
  if (city) { where.push('p.city LIKE ?'); args.push('%' + city.replace(/[%_]/g, '') + '%'); }
  const q = str(req.query.q, 60).replace(/[%_]/g, '');
  if (q) { where.push('(u.name LIKE ? OR p.bio LIKE ? OR pr.name_en LIKE ? OR pr.name_fr LIKE ?)'); args.push(...Array(4).fill('%' + q + '%')); }
  const rows = db.prepare(`${PRO_SELECT} WHERE ${where.join(' AND ')} ORDER BY u.name LIMIT 100`).all(...args);
  // phone only shown to logged-in users
  res.json(rows.map((r) => ({ ...r, phone: req.user ? r.phone : undefined })));
});

app.get('/api/professionals/:id', wrap((req, res) => {
  const r = db.prepare(`${PRO_SELECT} WHERE u.id = ? AND u.active = 1`).get(int(req.params.id));
  if (!r) return res.status(404).json({ error: 'Not found' });
  if (!req.user) delete r.phone;
  res.json(r);
}));

function slotsFor(proId, date) {
  const pro = db.prepare('SELECT duration_min, accepting FROM professionals WHERE user_id = ?').get(proId);
  if (!pro || !pro.accepting) return [];
  const wd = parseDate(date).getDay();
  const windows = db.prepare('SELECT start, end FROM availability WHERE pro_id = ? AND weekday = ? ORDER BY start').all(proId, wd);
  const taken = db.prepare(`SELECT start, end FROM bookings WHERE pro_id = ? AND date = ? AND status IN ('pending','confirmed')`)
    .all(proId, date).map((b) => [toMin(b.start), toMin(b.end)]);
  const out = new Set();
  for (const w of windows) {
    for (let s = toMin(w.start); s + pro.duration_min <= toMin(w.end); s += pro.duration_min) {
      const e = s + pro.duration_min;
      if (taken.some(([a, b]) => s < b && e > a)) continue;
      if (isPast(date, fromMin(s))) continue;
      out.add(fromMin(s));
    }
  }
  return [...out].sort();
}

app.get('/api/professionals/:id/slots', wrap((req, res) => {
  const date = str(req.query.date, 10);
  if (!dateInRange(date)) return res.status(400).json({ error: `Pick a date within the next ${MAX_DAYS_AHEAD} days` });
  const id = int(req.params.id);
  if (!db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1 AND role = ?').get(id, 'professional'))
    return res.status(404).json({ error: 'Not found' });
  res.json({ date, slots: slotsFor(id, date) });
}));

/* ------------------------------------------------------------------ */
/* Bookings                                                            */
/* ------------------------------------------------------------------ */
const BOOKING_SELECT = `
  SELECT b.id, b.date, b.start, b.end, b.status, b.note, b.created_at,
         b.client_id, c.name AS client_name, c.phone AS client_phone, c.email AS client_email,
         b.pro_id, pu.name AS pro_name, pr.name_en AS profession, p.city, p.address, p.price
  FROM bookings b
  JOIN users c ON c.id = b.client_id
  JOIN users pu ON pu.id = b.pro_id
  JOIN professionals p ON p.user_id = b.pro_id
  JOIN professions pr ON pr.id = p.profession_id`;

app.post('/api/bookings', requireRole('client'), wrap((req, res) => {
  const proId = int(req.body.pro_id), date = str(req.body.date, 10), start = str(req.body.start, 5);
  const note = str(req.body.note, 500);
  if (!dateInRange(date) || !TIME_RE.test(start)) return res.status(400).json({ error: 'Invalid date or time' });
  const pro = db.prepare(`SELECT p.duration_min FROM professionals p JOIN users u ON u.id = p.user_id
                          WHERE p.user_id = ? AND u.active = 1 AND p.accepting = 1`).get(proId);
  if (!pro) return res.status(404).json({ error: 'Professional not found' });

  try {
    const id = tx(() => {
      if (!slotsFor(proId, date).includes(start)) throw Object.assign(new Error('That time is no longer available'), { status: 409 });
      const end = fromMin(toMin(start) + pro.duration_min);
      const r = db.prepare('INSERT INTO bookings (client_id,pro_id,date,start,end,note) VALUES (?,?,?,?,?,?)')
        .run(req.user.id, proId, date, start, end, note);
      return Number(r.lastInsertRowid);
    });
    res.status(201).json(db.prepare(`${BOOKING_SELECT} WHERE b.id = ?`).get(id));
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    if (/UNIQUE/.test(e.message)) return res.status(409).json({ error: 'That time is no longer available' });
    throw e;
  }
}));

app.get('/api/bookings', requireAuth, wrap((req, res) => {
  let where = '1=1', args = [];
  if (req.user.role === 'client') { where = 'b.client_id = ?'; args = [req.user.id]; }
  else if (req.user.role === 'professional') { where = 'b.pro_id = ?'; args = [req.user.id]; }
  const status = str(req.query.status, 20);
  if (status) { where += ' AND b.status = ?'; args.push(status); }
  const rows = db.prepare(`${BOOKING_SELECT} WHERE ${where} ORDER BY b.date DESC, b.start DESC LIMIT 300`).all(...args);
  // clients never see other contact details than the pro's name; pros see client contact
  res.json(rows.map((r) => {
    if (req.user.role === 'client') { delete r.client_phone; delete r.client_email; }
    return r;
  }));
}));

// allowed transitions per actor
const TRANSITIONS = {
  client:       { pending: ['cancelled'], confirmed: ['cancelled'] },
  professional: { pending: ['confirmed', 'declined', 'cancelled'], confirmed: ['cancelled', 'completed'] },
  admin:        { pending: ['confirmed', 'declined', 'cancelled'], confirmed: ['cancelled', 'completed'] },
};
app.patch('/api/bookings/:id', requireAuth, wrap((req, res) => {
  const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(int(req.params.id));
  if (!b) return res.status(404).json({ error: 'Not found' });
  const u = req.user;
  const owns = u.role === 'admin' || (u.role === 'client' && b.client_id === u.id) || (u.role === 'professional' && b.pro_id === u.id);
  if (!owns) return res.status(404).json({ error: 'Not found' });
  const next = str(req.body.status, 20);
  if (!(TRANSITIONS[u.role][b.status] || []).includes(next))
    return res.status(400).json({ error: `Cannot change a ${b.status} booking to ${next}` });
  if (next === 'completed' && isPast(b.date, b.start) === false)
    return res.status(400).json({ error: 'Only past appointments can be marked completed' });
  db.prepare('UPDATE bookings SET status = ? WHERE id = ?').run(next, b.id);
  res.json(db.prepare(`${BOOKING_SELECT} WHERE b.id = ?`).get(b.id));
}));

/* ------------------------------------------------------------------ */
/* Professional: own profile + weekly availability                      */
/* ------------------------------------------------------------------ */
app.get('/api/pro/profile', requireRole('professional'), wrap((req, res) => {
  res.json({
    profile: db.prepare(`${PRO_SELECT} WHERE u.id = ?`).get(req.user.id),
    availability: db.prepare('SELECT weekday, start, end FROM availability WHERE pro_id = ? ORDER BY weekday, start').all(req.user.id),
  });
}));

app.put('/api/pro/profile', requireRole('professional'), wrap((req, res) => {
  const b = req.body || {};
  const profession_id = int(b.profession_id);
  if (!db.prepare('SELECT 1 FROM professions WHERE id = ?').get(profession_id))
    return res.status(400).json({ error: 'Invalid profession' });
  const dur = int(b.duration_min);
  if (![15, 20, 30, 45, 60, 90, 120].includes(dur)) return res.status(400).json({ error: 'Invalid appointment length' });
  db.prepare(`UPDATE professionals SET profession_id=?, bio=?, city=?, address=?, price=?, duration_min=?, accepting=? WHERE user_id=?`)
    .run(profession_id, str(b.bio, 600), str(b.city, 60), str(b.address, 150),
      Math.max(0, Math.min(100000, int(b.price))), dur, b.accepting ? 1 : 0, req.user.id);
  res.json({ ok: true });
}));

app.put('/api/pro/availability', requireRole('professional'), wrap((req, res) => {
  const list = Array.isArray(req.body.availability) ? req.body.availability : null;
  if (!list || list.length > 50) return res.status(400).json({ error: 'Invalid availability' });
  const clean = [];
  for (const w of list) {
    const weekday = int(w.weekday, -1);
    if (weekday < 0 || weekday > 6 || !TIME_RE.test(w.start) || !TIME_RE.test(w.end) || toMin(w.start) >= toMin(w.end))
      return res.status(400).json({ error: 'Each window needs a day and a start time before its end time' });
    clean.push([weekday, w.start, w.end]);
  }
  tx(() => {
    db.prepare('DELETE FROM availability WHERE pro_id = ?').run(req.user.id);
    const ins = db.prepare('INSERT INTO availability (pro_id,weekday,start,end) VALUES (?,?,?,?)');
    for (const c of clean) ins.run(req.user.id, ...c);
  });
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ */
/* Admin                                                               */
/* ------------------------------------------------------------------ */
app.get('/api/admin/stats', requireRole('admin'), (req, res) => {
  const one = (sql) => db.prepare(sql).get();
  res.json({
    clients: one(`SELECT COUNT(*) n FROM users WHERE role='client'`).n,
    professionals: one(`SELECT COUNT(*) n FROM users WHERE role='professional'`).n,
    bookings: one('SELECT COUNT(*) n FROM bookings').n,
    pending: one(`SELECT COUNT(*) n FROM bookings WHERE status='pending'`).n,
    upcoming: one(`SELECT COUNT(*) n FROM bookings WHERE status='confirmed' AND date >= date('now','localtime')`).n,
    byProfession: db.prepare(`
      SELECT pr.name_en AS name, COUNT(b.id) AS bookings
      FROM professions pr
      LEFT JOIN professionals p ON p.profession_id = pr.id
      LEFT JOIN bookings b ON b.pro_id = p.user_id
      GROUP BY pr.id HAVING bookings > 0 ORDER BY bookings DESC`).all(),
  });
});

app.get('/api/admin/users', requireRole('admin'), (req, res) => {
  res.json(db.prepare(`
    SELECT u.id, u.name, u.email, u.role, u.phone, u.active, u.created_at, pr.name_en AS profession
    FROM users u
    LEFT JOIN professionals p ON p.user_id = u.id
    LEFT JOIN professions pr ON pr.id = p.profession_id
    ORDER BY u.created_at DESC LIMIT 500`).all());
});

app.patch('/api/admin/users/:id', requireRole('admin'), wrap((req, res) => {
  const id = int(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: "You can't change your own status" });
  const r = db.prepare('UPDATE users SET active = ? WHERE id = ?').run(req.body.active ? 1 : 0, id);
  if (!r.changes) return res.status(404).json({ error: 'Not found' });
  if (!req.body.active) db.prepare('DELETE FROM sessions WHERE data LIKE ?').run(`%"uid":${id}%`);
  res.json({ ok: true });
}));

app.post('/api/admin/professions', requireRole('admin'), wrap((req, res) => {
  const en = str(req.body.name_en, 60), fr = str(req.body.name_fr, 60);
  if (en.length < 2) return res.status(400).json({ error: 'English name is required' });
  try {
    const r = db.prepare('INSERT INTO professions (name_en,name_fr) VALUES (?,?)').run(en, fr);
    res.status(201).json({ id: Number(r.lastInsertRowid), name_en: en, name_fr: fr });
  } catch { res.status(409).json({ error: 'That profession already exists' }); }
}));

/* ------------------------------------------------------------------ */
/* Static frontend + errors                                            */
/* ------------------------------------------------------------------ */
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

/* First-run admin account */
function ensureAdmin() {
  if (db.prepare(`SELECT 1 FROM users WHERE role='admin'`).get()) return;
  const email = (process.env.ADMIN_EMAIL || 'admin@example.com').toLowerCase();
  let password = process.env.ADMIN_PASSWORD;
  const generated = !password;
  if (generated) password = crypto.randomBytes(9).toString('base64url');
  db.prepare(`INSERT INTO users (name,email,password_hash,role) VALUES ('Administrator',?,?, 'admin')`)
    .run(email, bcrypt.hashSync(password, 11));
  console.log(`\nAdmin account created: ${email}${generated ? ' / ' + password : ''}`);
  if (generated) console.log('(generated password – shown once; set ADMIN_EMAIL / ADMIN_PASSWORD to choose your own)\n');
}

if (require.main === module) {
  ensureAdmin();
  app.listen(PORT, () => console.log(`Booking app running on http://localhost:${PORT}`));
}
module.exports = { app, ensureAdmin };

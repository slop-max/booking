'use strict';
// End-to-end API test. Starts the server on a temp database and exercises the main flows.
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const PORT = 3111, BASE = `http://localhost:${PORT}`;
const dbFile = path.join(os.tmpdir(), `booking-test-${Date.now()}.db`);

class Client {
  constructor() { this.cookie = ''; }
  async call(method, url, body) {
    const res = await fetch(BASE + '/api' + url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => ({})) };
  }
}

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function nextWeekday(wd) { // next date (>= tomorrow) falling on weekday wd
  const d = new Date(); d.setDate(d.getDate() + 1);
  while (d.getDay() !== wd) d.setDate(d.getDate() + 1);
  return ymd(d);
}

let passed = 0;
const ok = (name, fn) => fn().then(() => { passed++; console.log('  ✓', name); }, (e) => { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; });

(async () => {
  const srv = spawn('node', ['--no-warnings', 'server.js'], {
    cwd: __dirname, stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, PORT, DB_FILE: dbFile, ADMIN_EMAIL: 'admin@test.ma', ADMIN_PASSWORD: 'Admin-test-123', SESSION_SECRET: 'x'.repeat(40) },
  });
  await new Promise((r) => srv.stdout.on('data', (d) => /running/.test(String(d)) && r()));
  console.log('Running tests…');

  const client = new Client(), client2 = new Client(), pro = new Client(), admin = new Client(), anon = new Client();
  let proId, professionId, bookingId;
  const monday = nextWeekday(1);

  await ok('registration validates input', async () => {
    assert.equal((await anon.call('POST', '/register', { name: 'A', email: 'bad', password: 'short' })).status, 400);
    assert.equal((await anon.call('POST', '/register', { name: 'Pro', email: 'p@x.ma', password: 'password1', role: 'professional' })).status, 400, 'pro needs profession');
  });

  await ok('professions list is seeded', async () => {
    const r = await anon.call('GET', '/professions');
    assert.ok(r.data.length >= 10);
    professionId = r.data.find((p) => p.name_en === 'Dentist').id;
  });

  await ok('register professional + client, duplicate email rejected', async () => {
    let r = await pro.call('POST', '/register', { name: 'Dr Test', email: 'dr@test.ma', password: 'password1', role: 'professional', profession_id: professionId, city: 'Casablanca', price: 250, duration_min: 30 });
    assert.equal(r.status, 201); proId = r.data.user.id; assert.equal(r.data.user.role, 'professional');
    r = await client.call('POST', '/register', { name: 'Client One', email: 'c1@test.ma', password: 'password1', phone: '0600000000' });
    assert.equal(r.status, 201); assert.equal(r.data.user.role, 'client');
    r = await client2.call('POST', '/register', { name: 'Client Two', email: 'C2@test.ma', password: 'password1' });
    assert.equal(r.status, 201);
    r = await anon.call('POST', '/register', { name: 'Dup', email: 'c1@TEST.ma', password: 'password1' });
    assert.equal(r.status, 409);
  });

  await ok('session works; roles are enforced', async () => {
    assert.equal((await client.call('GET', '/me')).data.user.email, 'c1@test.ma');
    assert.equal((await anon.call('GET', '/bookings')).status, 401);
    assert.equal((await client.call('GET', '/pro/profile')).status, 403);
    assert.equal((await client.call('GET', '/admin/users')).status, 403);
    assert.equal((await pro.call('GET', '/admin/stats')).status, 403);
    assert.equal((await pro.call('POST', '/bookings', { pro_id: proId, date: monday, start: '09:00' })).status, 403);
  });

  await ok('wrong password rejected, correct one accepted', async () => {
    const c = new Client();
    assert.equal((await c.call('POST', '/login', { email: 'c1@test.ma', password: 'nope-nope' })).status, 401);
    assert.equal((await c.call('POST', '/login', { email: 'c1@test.ma', password: 'password1' })).status, 200);
    assert.equal((await c.call('POST', '/logout')).status, 200);
    assert.equal((await c.call('GET', '/me')).data.user, null);
  });

  await ok('directory search by profession and city', async () => {
    let r = await anon.call('GET', `/professionals?profession=${professionId}`);
    assert.ok(r.data.some((p) => p.id === proId));
    assert.equal(r.data[0].phone, undefined, 'phone hidden from anonymous visitors');
    r = await anon.call('GET', '/professionals?city=Nowhere');
    assert.equal(r.data.length, 0);
  });

  await ok('slots reflect default Mon–Fri 09:00–17:00 with 30 min steps', async () => {
    const r = await client.call('GET', `/professionals/${proId}/slots?date=${monday}`);
    assert.equal(r.data.slots.length, 16);
    assert.equal(r.data.slots[0], '09:00'); assert.equal(r.data.slots.at(-1), '16:30');
    const sun = await client.call('GET', `/professionals/${proId}/slots?date=${nextWeekday(0)}`);
    assert.equal(sun.data.slots.length, 0);
    assert.equal((await client.call('GET', `/professionals/${proId}/slots?date=2020-01-01`)).status, 400);
    assert.equal((await client.call('GET', `/professionals/${proId}/slots?date=2026-02-31`)).status, 400);
  });

  await ok('client books; the same slot cannot be double-booked', async () => {
    let r = await client.call('POST', '/bookings', { pro_id: proId, date: monday, start: '10:00', note: 'Tooth ache' });
    assert.equal(r.status, 201); assert.equal(r.data.status, 'pending'); assert.equal(r.data.end, '10:30');
    bookingId = r.data.id;
    r = await client2.call('POST', '/bookings', { pro_id: proId, date: monday, start: '10:00' });
    assert.equal(r.status, 409);
    r = await client2.call('POST', '/bookings', { pro_id: proId, date: monday, start: '10:15' });
    assert.equal(r.status, 409, 'off-grid time is not offered');
    const slots = (await client2.call('GET', `/professionals/${proId}/slots?date=${monday}`)).data.slots;
    assert.ok(!slots.includes('10:00'));
  });

  await ok('privacy: other clients cannot see or change the booking', async () => {
    assert.equal((await client2.call('GET', '/bookings')).data.length, 0);
    assert.equal((await client2.call('PATCH', `/bookings/${bookingId}`, { status: 'cancelled' })).status, 404);
    const mine = (await client.call('GET', '/bookings')).data[0];
    assert.equal(mine.client_phone, undefined);
  });

  await ok('professional sees the request with client contact and confirms it', async () => {
    const list = (await pro.call('GET', '/bookings')).data;
    assert.equal(list.length, 1); assert.equal(list[0].client_phone, '0600000000');
    assert.equal((await client.call('PATCH', `/bookings/${bookingId}`, { status: 'confirmed' })).status, 400, 'client cannot confirm');
    assert.equal((await pro.call('PATCH', `/bookings/${bookingId}`, { status: 'confirmed' })).data.status, 'confirmed');
    assert.equal((await pro.call('PATCH', `/bookings/${bookingId}`, { status: 'completed' })).status, 400, 'future booking cannot be completed');
  });

  await ok('cancelling frees the slot again', async () => {
    assert.equal((await client.call('PATCH', `/bookings/${bookingId}`, { status: 'cancelled' })).data.status, 'cancelled');
    assert.equal((await client.call('PATCH', `/bookings/${bookingId}`, { status: 'confirmed' })).status, 400);
    const slots = (await client2.call('GET', `/professionals/${proId}/slots?date=${monday}`)).data.slots;
    assert.ok(slots.includes('10:00'));
    assert.equal((await client2.call('POST', '/bookings', { pro_id: proId, date: monday, start: '10:00' })).status, 201);
  });

  await ok('professional edits hours; slots update', async () => {
    let r = await pro.call('PUT', '/pro/availability', { availability: [{ weekday: 1, start: '10:00', end: '11:00' }] });
    assert.equal(r.status, 200);
    r = await client.call('GET', `/professionals/${proId}/slots?date=${monday}`);
    assert.deepEqual(r.data.slots, ['10:30']);
    assert.equal((await pro.call('PUT', '/pro/availability', { availability: [{ weekday: 1, start: '12:00', end: '11:00' }] })).status, 400);
    assert.equal((await pro.call('PUT', '/pro/profile', { profession_id: professionId, duration_min: 17 })).status, 400);
  });

  await ok('admin: stats, add profession, disable user kills access', async () => {
    assert.equal((await admin.call('POST', '/login', { email: 'admin@test.ma', password: 'Admin-test-123' })).status, 200);
    const s = (await admin.call('GET', '/admin/stats')).data;
    assert.equal(s.professionals, 1); assert.equal(s.clients, 2);
    assert.equal((await admin.call('POST', '/admin/professions', { name_en: 'Interior Designer', name_fr: "Décorateur d'intérieur" })).status, 201);
    assert.equal((await admin.call('POST', '/admin/professions', { name_en: 'Interior Designer' })).status, 409);
    const users = (await admin.call('GET', '/admin/users')).data;
    const c2 = users.find((u) => u.email === 'c2@test.ma');
    assert.equal((await admin.call('PATCH', `/admin/users/${c2.id}`, { active: false })).status, 200);
    assert.equal((await client2.call('GET', '/me')).data.user, null, 'existing session is revoked');
    assert.equal((await new Client().call('POST', '/login', { email: 'c2@test.ma', password: 'password1' })).status, 403);
  });

  await ok('password change', async () => {
    assert.equal((await client.call('POST', '/me/password', { current: 'wrong', next: 'newpassword1' })).status, 400);
    assert.equal((await client.call('POST', '/me/password', { current: 'password1', next: 'newpassword1' })).status, 200);
    assert.equal((await new Client().call('POST', '/login', { email: 'c1@test.ma', password: 'newpassword1' })).status, 200);
  });

  await ok('cross-site requests are blocked and the frontend is served', async () => {
    const res = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
    assert.equal(res.status, 403);
    const html = await (await fetch(BASE + '/')).text();
    assert.ok(html.includes('<main id="app"'));
    assert.equal((await fetch(BASE + '/app.js')).status, 200);
  });

  srv.kill();
  for (const s of ['', '-wal', '-shm']) fs.rmSync(dbFile + s, { force: true });
  console.log(`\n${process.exitCode ? 'FAILED' : 'All ' + passed + ' checks passed'}`);
})();

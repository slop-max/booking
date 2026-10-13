'use strict';
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const app = $('#app'), nav = $('#nav'), modalRoot = $('#modal-root');
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // week starts Monday
  const DURATIONS = [15, 20, 30, 45, 60, 90, 120];
  const state = { user: null, professions: [], filters: { q: '', city: '', profession: '' }, returnTo: null };

  /* ---------- helpers ---------- */
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => (n ? `${n} MAD` : 'Price on request');
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const fmtDate = (s) => new Date(s + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const badge = (s) => `<span class="badge b-${esc(s)}">${esc(s)}</span>`;

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
  }

  async function api(method, url, body) {
    const res = await fetch('/api' + url, {
      method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok) {
      if (res.status === 401 && state.user) { state.user = null; renderNav(); location.hash = '#/login'; }
      throw new Error(data.error || 'Request failed');
    }
    return data;
  }
  const go = (h) => { if (location.hash === h) route(); else location.hash = h; };

  /* ---------- nav ---------- */
  function renderNav() {
    const u = state.user;
    const cur = location.hash || '#/';
    const link = (h, t) => `<a href="${h}" class="${cur === h ? 'active' : ''}">${t}</a>`;
    let html = link('#/find', 'Find a professional');
    if (!u) html += link('#/login', 'Log in') + `<a class="btn sm" href="#/register">Sign up</a>`;
    else {
      if (u.role === 'client') html += link('#/bookings', 'My appointments');
      if (u.role === 'professional') html += link('#/pro', 'Appointments') + link('#/pro/profile', 'My profile & hours');
      if (u.role === 'admin') html += link('#/admin', 'Admin');
      html += link('#/account', esc(u.name.split(' ')[0])) + `<button data-action="logout">Log out</button>`;
    }
    nav.innerHTML = html;
  }

  /* ---------- router ---------- */
  const routes = {
    '': home, '/': home, '/find': find, '/login': loginView, '/register': registerView,
    '/bookings': clientBookings, '/pro': proBookings, '/pro/profile': proProfile,
    '/admin': admin, '/account': account,
  };
  const guards = { '/bookings': ['client'], '/pro': ['professional'], '/pro/profile': ['professional'], '/admin': ['admin'], '/account': ['client', 'professional', 'admin'] };

  async function route() {
    closeModal();
    const path = (location.hash.slice(1) || '/').split('?')[0];
    renderNav();
    const g = guards[path];
    if (g && !state.user) { state.returnTo = location.hash; return go('#/login'); }
    if (g && !g.includes(state.user.role)) return go('#/');
    const view = routes[path] || home;
    app.innerHTML = '<p class="muted">Loading…</p>';
    try { await view(); } catch (e) { app.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
    window.scrollTo(0, 0);
  }

  /* ---------- auth views ---------- */
  function afterAuth(user) {
    state.user = user;
    const to = state.returnTo; state.returnTo = null;
    if (to) return go(to);
    go(user.role === 'professional' ? '#/pro' : user.role === 'admin' ? '#/admin' : '#/find');
  }

  function loginView() {
    if (state.user) return go('#/');
    app.innerHTML = `
      <div class="card auth"><h1>Log in</h1>
        <div id="err"></div>
        <form id="f" class="stack">
          <div><label for="email">Email</label><input id="email" type="email" autocomplete="username" required></div>
          <div><label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" required></div>
          <button class="btn" style="width:100%">Log in</button>
        </form>
        <p class="muted small">No account yet? <a href="#/register">Sign up</a></p>
      </div>`;
    $('#f').onsubmit = async (e) => {
      e.preventDefault();
      try { const r = await api('POST', '/login', { email: $('#email').value, password: $('#pw').value }); afterAuth(r.user); }
      catch (er) { $('#err').innerHTML = `<div class="err">${esc(er.message)}</div>`; }
    };
  }

  function registerView() {
    if (state.user) return go('#/');
    const opts = state.professions.map((p) => `<option value="${p.id}">${esc(p.name_en)}</option>`).join('');
    app.innerHTML = `
      <div class="card auth"><h1>Create your account</h1>
        <div id="err"></div>
        <div class="tabs" id="roleTabs">
          <button type="button" class="on" data-role="client">I need an appointment</button>
          <button type="button" data-role="professional">I'm a professional</button>
        </div>
        <form id="f">
          <div class="field"><label for="name">Full name</label><input id="name" autocomplete="name" required maxlength="80"></div>
          <div class="two">
            <div class="field"><label for="email">Email</label><input id="email" type="email" autocomplete="username" required></div>
            <div class="field"><label for="phone">Phone</label><input id="phone" type="tel" autocomplete="tel" placeholder="06 00 00 00 00" maxlength="30"></div>
          </div>
          <div class="field"><label for="pw">Password (min. 8 characters)</label><input id="pw" type="password" autocomplete="new-password" minlength="8" required></div>
          <div id="proFields" hidden>
            <div class="field"><label for="prof">Profession</label><select id="prof"><option value="">Choose…</option>${opts}</select></div>
            <div class="two">
              <div class="field"><label for="city">City</label><input id="city" maxlength="60" placeholder="Casablanca"></div>
              <div class="field"><label for="price">Price per appointment (MAD)</label><input id="price" type="number" min="0" max="100000" placeholder="0 = on request"></div>
            </div>
            <div class="field"><label for="addr">Address</label><input id="addr" maxlength="150"></div>
            <div class="field"><label for="dur">Appointment length</label><select id="dur">${DURATIONS.map((d) => `<option ${d === 30 ? 'selected' : ''} value="${d}">${d} min</option>`).join('')}</select></div>
            <div class="field"><label for="bio">About you</label><textarea id="bio" maxlength="600"></textarea></div>
            <p class="muted small">Default hours are Mon–Fri 09:00–17:00. You can change them after signing up.</p>
          </div>
          <button class="btn" style="width:100%">Create account</button>
        </form>
        <p class="muted small">Already registered? <a href="#/login">Log in</a></p>
      </div>`;
    let role = 'client';
    $('#roleTabs').onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      role = b.dataset.role;
      document.querySelectorAll('#roleTabs button').forEach((x) => x.classList.toggle('on', x === b));
      $('#proFields').hidden = role !== 'professional';
    };
    $('#f').onsubmit = async (e) => {
      e.preventDefault();
      const body = { role, name: $('#name').value, email: $('#email').value, phone: $('#phone').value, password: $('#pw').value };
      if (role === 'professional') Object.assign(body, {
        profession_id: Number($('#prof').value), city: $('#city').value, price: Number($('#price').value || 0),
        address: $('#addr').value, duration_min: Number($('#dur').value), bio: $('#bio').value,
      });
      try { const r = await api('POST', '/register', body); await loadProfessions(); afterAuth(r.user); }
      catch (er) { $('#err').innerHTML = `<div class="err">${esc(er.message)}</div>`; }
    };
  }

  /* ---------- home / directory ---------- */
  function home() {
    if (state.user) return go(state.user.role === 'professional' ? '#/pro' : state.user.role === 'admin' ? '#/admin' : '#/find');
    const chips = state.professions.filter((p) => p.pros > 0).slice(0, 12)
      .map((p) => `<button class="chip" data-action="browse" data-id="${p.id}">${esc(p.name_en)}</button>`).join('');
    app.innerHTML = `
      <div class="hero"><h1>Book an appointment with a professional</h1>
        <p class="muted">Doctors, lawyers, tutors, barbers and more — pick a time that suits you.</p>
        <div class="chips">${chips}</div>
        <a class="btn" href="#/find">Browse professionals</a>
        <a class="btn ghost" href="#/register">Offer your services</a></div>`;
  }

  async function find() {
    const f = state.filters;
    const opts = state.professions.map((p) => `<option value="${p.id}" ${String(p.id) === String(f.profession) ? 'selected' : ''}>${esc(p.name_en)} (${p.pros})</option>`).join('');
    app.innerHTML = `
      <h1>Find a professional</h1>
      <form id="sf" class="row" style="margin-bottom:16px">
        <div style="flex:2;min-width:180px"><input id="q" placeholder="Name or keyword" value="${esc(f.q)}" aria-label="Search"></div>
        <div style="flex:1;min-width:150px"><select id="fp" aria-label="Profession"><option value="">All professions</option>${opts}</select></div>
        <div style="flex:1;min-width:120px"><input id="fc" placeholder="City" value="${esc(f.city)}" aria-label="City"></div>
        <button class="btn">Search</button>
      </form>
      <div id="results"></div>`;
    $('#sf').onsubmit = (e) => { e.preventDefault(); f.q = $('#q').value; f.city = $('#fc').value; f.profession = $('#fp').value; loadResults(); };
    $('#fp').onchange = () => $('#sf').requestSubmit();
    await loadResults();
  }

  async function loadResults() {
    const f = state.filters;
    const qs = new URLSearchParams({ q: f.q, city: f.city, profession: f.profession });
    const list = await api('GET', '/professionals?' + qs);
    $('#results').innerHTML = list.length ? `<div class="grid">${list.map((p) => `
      <article class="card pro">
        <h3>${esc(p.name)}</h3>
        <div class="meta">${esc(p.profession)}${p.city ? ' · ' + esc(p.city) : ''}</div>
        <div class="meta">${money(p.price)} · ${p.duration_min} min</div>
        <p>${esc(p.bio) || '<span class="muted">No description yet.</span>'}</p>
        <button class="btn" data-action="book" data-id="${p.id}">Book</button>
      </article>`).join('')}</div>` : '<div class="empty">No professionals match your search.</div>';
    window.__pros = Object.fromEntries(list.map((p) => [p.id, p]));
  }

  /* ---------- booking modal ---------- */
  function closeModal() { modalRoot.innerHTML = ''; }
  function openModal(html) {
    modalRoot.innerHTML = `<div class="overlay" data-action="overlay"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
    const first = modalRoot.querySelector('input,select,button'); if (first) first.focus();
  }

  function bookModal(id) {
    if (!state.user) { state.returnTo = '#/find'; toast('Please log in to book'); return go('#/login'); }
    if (state.user.role !== 'client') return toast('Use a client account to book appointments');
    const p = window.__pros[id]; if (!p) return;
    let date = '', slot = '';
    openModal(`
      <h2 style="margin-top:0">Book ${esc(p.name)}</h2>
      <p class="muted small">${esc(p.profession)} · ${p.duration_min} min · ${money(p.price)}${p.address ? '<br>' + esc(p.address) : ''}</p>
      <div id="merr"></div>
      <div class="field"><label for="d">Date</label><input id="d" type="date" min="${today()}" max="${addDays(60)}"></div>
      <div id="slots" class="muted small">Choose a date to see available times.</div>
      <div class="field" style="margin-top:12px"><label for="n">Note for the professional (optional)</label><textarea id="n" maxlength="500"></textarea></div>
      <div class="row" style="justify-content:flex-end"><button class="btn ghost" data-action="close">Cancel</button><button class="btn" id="ok" disabled>Request appointment</button></div>`);
    $('#d').onchange = async () => {
      date = $('#d').value; slot = ''; $('#ok').disabled = true;
      if (!date) return;
      $('#slots').textContent = 'Loading…';
      try {
        const r = await api('GET', `/professionals/${id}/slots?date=${encodeURIComponent(date)}`);
        $('#slots').innerHTML = r.slots.length
          ? `<div class="slots">${r.slots.map((s) => `<button type="button" data-slot="${s}">${s}</button>`).join('')}</div>`
          : 'No free times on this day — try another date.';
      } catch (e) { $('#slots').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
    };
    $('#slots').onclick = (e) => {
      const b = e.target.closest('[data-slot]'); if (!b) return;
      slot = b.dataset.slot;
      document.querySelectorAll('#slots button').forEach((x) => x.classList.toggle('on', x === b));
      $('#ok').disabled = false;
    };
    $('#ok').onclick = async () => {
      $('#ok').disabled = true;
      try {
        await api('POST', '/bookings', { pro_id: id, date, start: slot, note: $('#n').value });
        closeModal(); toast('Request sent — awaiting confirmation'); go('#/bookings');
      } catch (e) {
        $('#merr').innerHTML = `<div class="err">${esc(e.message)}</div>`;
        $('#d').dispatchEvent(new Event('change')); // refresh slots
      }
    };
  }

  /* ---------- bookings lists ---------- */
  const isUpcoming = (b) => ['pending', 'confirmed'].includes(b.status) && b.date >= today();
  let bookingTab = 'upcoming';

  function bookingCard(b, role) {
    const who = role === 'client'
      ? `<strong>${esc(b.pro_name)}</strong> <span class="muted">· ${esc(b.profession)}</span>${b.address ? `<div class="muted small">${esc(b.address)}${b.city ? ', ' + esc(b.city) : ''}</div>` : ''}`
      : `<strong>${esc(b.client_name)}</strong>${role === 'professional' ? `<div class="muted small">${esc(b.client_phone || '')} ${esc(b.client_email)}</div>` : `<span class="muted"> with ${esc(b.pro_name)} · ${esc(b.profession)}</span>`}`;
    const acts = [];
    if (role === 'professional' || role === 'admin') {
      if (b.status === 'pending') acts.push(['confirmed', 'Confirm', ''], ['declined', 'Decline', 'danger']);
      if (b.status === 'confirmed') {
        if (b.date < today() || (b.date === today())) acts.push(['completed', 'Mark completed', 'ghost']);
        acts.push(['cancelled', 'Cancel', 'danger']);
      }
    } else if (['pending', 'confirmed'].includes(b.status)) acts.push(['cancelled', 'Cancel', 'danger']);
    return `<div class="card bk">
      <div><div class="when">${fmtDate(b.date)} · ${esc(b.start)}–${esc(b.end)}</div>${who}
        ${b.note ? `<div class="small" style="margin-top:4px">“${esc(b.note)}”</div>` : ''}</div>
      <div class="row">${badge(b.status)}${acts.map(([s, t, c]) => `<button class="btn sm ${c}" data-action="status" data-id="${b.id}" data-status="${s}">${t}</button>`).join('')}</div>
    </div>`;
  }

  async function renderBookings(role, title) {
    const list = await api('GET', '/bookings');
    const up = list.filter(isUpcoming).reverse(), past = list.filter((b) => !isUpcoming(b));
    const pendingN = list.filter((b) => b.status === 'pending').length;
    const shown = bookingTab === 'upcoming' ? up : past;
    app.innerHTML = `<h1>${title}</h1>
      ${role === 'professional' && pendingN ? `<p class="badge b-pending" style="margin-bottom:12px">${pendingN} request${pendingN > 1 ? 's' : ''} waiting for your answer</p>` : ''}
      <div class="tabs"><button class="${bookingTab === 'upcoming' ? 'on' : ''}" data-tab="upcoming">Upcoming (${up.length})</button>
        <button class="${bookingTab === 'past' ? 'on' : ''}" data-tab="past">History (${past.length})</button></div>
      ${shown.length ? shown.map((b) => bookingCard(b, role)).join('') : `<div class="empty">${bookingTab === 'upcoming' ? 'Nothing scheduled.' : 'No past appointments.'}${role === 'client' && bookingTab === 'upcoming' ? ' <a href="#/find">Find a professional</a>' : ''}</div>`}`;
  }
  const clientBookings = () => renderBookings('client', 'My appointments');
  const proBookings = () => renderBookings('professional', 'Appointments');

  /* ---------- professional profile & hours ---------- */
  async function proProfile() {
    const { profile: p, availability } = await api('GET', '/pro/profile');
    const byDay = {}; availability.forEach((a) => (byDay[a.weekday] = byDay[a.weekday] || []).push(a));
    const opts = state.professions.map((x) => `<option value="${x.id}" ${x.id === p.profession_id ? 'selected' : ''}>${esc(x.name_en)}</option>`).join('');
    app.innerHTML = `<h1>My profile &amp; hours</h1>
      <form id="pf" class="card" style="margin-bottom:20px"><h2 style="margin-top:0">Public profile</h2>
        <div class="two"><div class="field"><label for="prof">Profession</label><select id="prof">${opts}</select></div>
          <div class="field"><label for="city">City</label><input id="city" maxlength="60" value="${esc(p.city)}"></div></div>
        <div class="field"><label for="addr">Address</label><input id="addr" maxlength="150" value="${esc(p.address)}"></div>
        <div class="two"><div class="field"><label for="price">Price (MAD, 0 = on request)</label><input id="price" type="number" min="0" max="100000" value="${p.price}"></div>
          <div class="field"><label for="dur">Appointment length</label><select id="dur">${DURATIONS.map((d) => `<option value="${d}" ${d === p.duration_min ? 'selected' : ''}>${d} min</option>`).join('')}</select></div></div>
        <div class="field"><label for="bio">About you</label><textarea id="bio" maxlength="600">${esc(p.bio)}</textarea></div>
        <div class="field"><label><input type="checkbox" id="acc" ${p.accepting ? 'checked' : ''}> Accepting new appointments (uncheck to hide your profile)</label></div>
        <button class="btn">Save profile</button></form>
      <form id="af" class="card"><h2 style="margin-top:0">Weekly availability</h2>
        <p class="muted small">Clients can book slots inside these windows. Leave a day empty if you don't work. Add a second window for a lunch break.</p>
        <div id="week">${DAY_ORDER.map((d) => dayBlock(d, byDay[d] || [])).join('')}</div>
        <button class="btn" style="margin-top:8px">Save availability</button></form>`;

    $('#pf').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('PUT', '/pro/profile', { profession_id: Number($('#prof').value), city: $('#city').value, address: $('#addr').value,
          price: Number($('#price').value || 0), duration_min: Number($('#dur').value), bio: $('#bio').value, accepting: $('#acc').checked });
        toast('Profile saved');
      } catch (er) { toast(er.message); }
    };
    $('#week').onclick = (e) => {
      const add = e.target.closest('[data-add]'), del = e.target.closest('[data-del]');
      if (add) { const box = $(`[data-day="${add.dataset.add}"] .wins`); box.insertAdjacentHTML('beforeend', winRow('09:00', '17:00')); }
      if (del) del.closest('.wrow').remove();
    };
    $('#af').onsubmit = async (e) => {
      e.preventDefault();
      const out = [];
      document.querySelectorAll('#week [data-day]').forEach((blk) => {
        blk.querySelectorAll('.wrow').forEach((r) => {
          const [s, en] = r.querySelectorAll('input');
          if (s.value && en.value) out.push({ weekday: Number(blk.dataset.day), start: s.value, end: en.value });
        });
      });
      try { await api('PUT', '/pro/availability', { availability: out }); toast('Availability saved'); }
      catch (er) { toast(er.message); }
    };
  }
  const winRow = (s, e) => `<div class="wrow"><strong></strong><input type="time" value="${s}" aria-label="Start"><span>to</span><input type="time" value="${e}" aria-label="End"><button type="button" class="btn sm danger" data-del="1" aria-label="Remove">✕</button></div>`;
  function dayBlock(d, wins) {
    return `<div data-day="${d}" style="padding:8px 0;border-top:1px solid var(--line)">
      <div class="row between"><strong>${DAYS[d]}</strong><button type="button" class="btn sm ghost" data-add="${d}">+ Add hours</button></div>
      <div class="wins" style="margin-top:6px">${wins.map((w) => winRow(w.start, w.end)).join('')}</div></div>`;
  }

  /* ---------- admin ---------- */
  async function admin() {
    const [s, users, bookings] = await Promise.all([api('GET', '/admin/stats'), api('GET', '/admin/users'), api('GET', '/bookings')]);
    app.innerHTML = `<h1>Admin</h1>
      <div class="stats">
        <div class="stat"><b>${s.clients}</b>Clients</div><div class="stat"><b>${s.professionals}</b>Professionals</div>
        <div class="stat"><b>${s.bookings}</b>Bookings</div><div class="stat"><b>${s.pending}</b>Pending</div><div class="stat"><b>${s.upcoming}</b>Upcoming</div></div>
      <h2>Professions</h2>
      <form id="pf" class="row"><div style="flex:1;min-width:160px"><input id="en" placeholder="Name (English)" required maxlength="60"></div>
        <div style="flex:1;min-width:160px"><input id="fr" placeholder="Name (French)" maxlength="60"></div><button class="btn">Add profession</button></form>
      ${s.byProfession.length ? `<p class="muted small" style="margin-top:10px">Bookings by profession: ${s.byProfession.map((x) => `${esc(x.name)} (${x.bookings})`).join(' · ')}</p>` : ''}
      <h2>Users</h2>
      <div class="tablewrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Joined</th><th></th></tr></thead><tbody>
      ${users.map((u) => `<tr><td>${esc(u.name)}${u.profession ? `<div class="muted small">${esc(u.profession)}</div>` : ''}</td><td>${esc(u.email)}</td>
        <td><span class="badge b-role">${esc(u.role)}</span></td><td class="small">${esc(u.created_at.slice(0, 10))}</td>
        <td>${u.id === state.user.id ? '' : `<button class="btn sm ${u.active ? 'danger' : 'ghost'}" data-action="toggle-user" data-id="${u.id}" data-active="${u.active ? 0 : 1}">${u.active ? 'Disable' : 'Enable'}</button>`}</td></tr>`).join('')}
      </tbody></table></div>
      <h2>Recent bookings</h2>
      ${bookings.slice(0, 20).map((b) => bookingCard(b, 'admin')).join('') || '<div class="empty">No bookings yet.</div>'}`;
    $('#pf').onsubmit = async (e) => {
      e.preventDefault();
      try { await api('POST', '/admin/professions', { name_en: $('#en').value, name_fr: $('#fr').value }); await loadProfessions(); toast('Profession added'); admin(); }
      catch (er) { toast(er.message); }
    };
  }

  /* ---------- account ---------- */
  function account() {
    const u = state.user;
    app.innerHTML = `<h1>My account</h1>
      <form id="af" class="card auth" style="margin:0 0 20px;max-width:520px"><h2 style="margin-top:0">Details</h2>
        <div class="field"><label for="name">Full name</label><input id="name" value="${esc(u.name)}" required maxlength="80"></div>
        <div class="field"><label for="phone">Phone</label><input id="phone" value="${esc(u.phone || '')}" maxlength="30"></div>
        <p class="muted small">${esc(u.email)} · ${esc(u.role)}</p><button class="btn">Save</button></form>
      <form id="pw" class="card auth" style="margin:0;max-width:520px"><h2 style="margin-top:0">Change password</h2>
        <div class="field"><label for="cur">Current password</label><input id="cur" type="password" autocomplete="current-password" required></div>
        <div class="field"><label for="new">New password (min. 8 characters)</label><input id="new" type="password" minlength="8" autocomplete="new-password" required></div>
        <button class="btn">Update password</button></form>`;
    $('#af').onsubmit = async (e) => {
      e.preventDefault();
      try { const r = await api('PUT', '/me', { name: $('#name').value, phone: $('#phone').value }); state.user = r.user; renderNav(); toast('Saved'); }
      catch (er) { toast(er.message); }
    };
    $('#pw').onsubmit = async (e) => {
      e.preventDefault();
      try { await api('POST', '/me/password', { current: $('#cur').value, next: $('#new').value }); e.target.reset(); toast('Password updated'); }
      catch (er) { toast(er.message); }
    };
  }

  /* ---------- global click handling ---------- */
  document.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-action],[data-tab]');
    if (!t) return;
    if (t.dataset.tab) { bookingTab = t.dataset.tab; return route(); }
    switch (t.dataset.action) {
      case 'logout': await api('POST', '/logout'); state.user = null; toast('Logged out'); go('#/'); break;
      case 'browse': state.filters = { q: '', city: '', profession: t.dataset.id }; go('#/find'); break;
      case 'book': bookModal(Number(t.dataset.id)); break;
      case 'close': closeModal(); break;
      case 'overlay': if (e.target === t) closeModal(); break;
      case 'status': {
        if (t.dataset.status === 'cancelled' && !confirm('Cancel this appointment?')) return;
        try { await api('PATCH', `/bookings/${t.dataset.id}`, { status: t.dataset.status }); toast('Updated'); route(); }
        catch (er) { toast(er.message); }
        break;
      }
      case 'toggle-user':
        try { await api('PATCH', `/admin/users/${t.dataset.id}`, { active: t.dataset.active === '1' }); route(); }
        catch (er) { toast(er.message); }
        break;
      default:
    }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  /* ---------- boot ---------- */
  async function loadProfessions() { state.professions = await api('GET', '/professions'); }
  window.addEventListener('hashchange', route);
  (async () => {
    try {
      const [me] = await Promise.all([api('GET', '/me'), loadProfessions()]);
      state.user = me.user;
    } catch { /* offline */ }
    route();
  })();
})();

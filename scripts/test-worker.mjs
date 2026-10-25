// Worker tests with mocked Supabase, Google and Brevo. No real calendar or email is touched.
import assert from 'node:assert/strict';
import worker from '../worker/worker.js';
const { computeSlots, dhakaDate, at, eventId, encrypt, decrypt } = worker._test;
let passed = 0; const ok = (n) => { passed++; console.log('  ✓', n); };

// ---------- slot engine ----------
const settings = { open_time: '10:00:00', close_time: '19:00:00', working_days: [6, 0, 1, 2, 3, 4], slot_step_min: 30, min_notice_min: 120, max_days_ahead: 30,
  modes: ['office', 'meet', 'phone'], office_address: '201–202 BUET Market', calendar_id: 'primary', notify_email: 'office@example.com' };
const now = Date.parse('2026-10-25T06:00:00+06:00'); // Sunday 6 AM Dhaka
const labels = (slots) => slots.map(t => new Date(t + 6 * 3600e3).toISOString().slice(11, 16));
let s = computeSlots({ date: '2026-10-26', settings, duration: 30, now });
assert.equal(s.length, 18); assert.equal(labels(s)[0], '10:00'); assert.equal(labels(s).at(-1), '18:30'); ok('10:00–19:00 gives 18 half-hour slots, last ends at 19:00');
assert.equal(labels(computeSlots({ date: '2026-10-26', settings, duration: 60, now })).at(-1), '18:00'); ok('60-min service: last start 18:00');
assert.equal(computeSlots({ date: '2026-10-30', settings, duration: 30, now }).length, 0); ok('Friday closed');
assert.equal(computeSlots({ date: '2026-10-24', settings, duration: 30, now }).length, 0); ok('past date closed');
assert.equal(computeSlots({ date: '2026-11-25', settings, duration: 30, now }).length, 0); ok('beyond 30 days closed');
assert.equal(computeSlots({ date: '2026-10-26', settings, duration: 30, now, offDays: [{ from_date: '2026-10-26', to_date: '2026-10-27' }] }).length, 0); ok('office off day closed');
s = computeSlots({ date: '2026-10-25', settings, duration: 30, now: Date.parse('2026-10-25T11:10:00+06:00') });
assert.equal(labels(s)[0], '13:30'); ok('2-hour minimum notice today');
s = computeSlots({ date: '2026-10-26', settings, duration: 30, now, busy: [{ start: '2026-10-26T11:15:00+06:00', end: '2026-10-26T12:00:00+06:00' }] });
assert.ok(!labels(s).includes('11:00') && !labels(s).includes('11:30') && labels(s).includes('12:00') && labels(s).includes('10:30')); ok('busy Google event blocks overlapping slots only');
assert.equal(dhakaDate(Date.parse('2026-10-25T19:30:00Z')), '2026-10-26'); ok('Dhaka date rollover');
assert.match(eventId('3f2a0c1e-1111-4222-8333-444455556666'), /^[a-v0-9]{5,1024}$/); ok('Google event ID is valid base32hex');

// ---------- crypto ----------
const key = Buffer.from(new Uint8Array(32).map((_, i) => i * 7)).toString('base64');
const env = { SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x', SUPABASE_SECRET_KEY: 'sb_secret_x',
  TOKEN_ENCRYPTION_KEY: key, GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret', PUBLIC_SITE_URL: 'https://appointments.example',
  ALLOWED_ORIGINS: 'https://appointments.example', EMAIL_ENABLED: 'true', BREVO_API_KEY: 'brevo', BREVO_SENDER_EMAIL: 'brilliancycomms@gmail.com' };
const ct = await encrypt(env, 'refresh-123');
assert.notEqual(ct, 'refresh-123'); assert.equal(await decrypt(env, ct), 'refresh-123'); ok('refresh token encryption round-trip');

// ---------- mocked booking flow ----------
const SERVICE = { id: '11111111-1111-4111-8111-111111111111', name: 'General consultation', duration_min: 30, active: true };
const REF = { code: 'BR21510926', full_name: 'Aziz Ahmed', email: 'brilliancyaziz@gmail.com', notify: true };
const state = { bookings: [], outbox: [], google: { id: 1, refresh_token_enc: ct, google_email: 'office@gmail.com' }, events: [], mails: [], busy: [] };
const reply = (data, status = 200) => new Response(data === null ? '' : JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = init.method || 'GET';
  const body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
  const p = url.pathname;
  if (url.host === 'abc.supabase.co') {
    if (p.endsWith('/appt_settings')) return reply([{ ...settings }]);
    if (p.endsWith('/appt_services')) return reply([SERVICE]);
    if (p.endsWith('/appt_off_days')) return reply([]);
    if (p.endsWith('/appt_google')) { if (method === 'PATCH') { Object.assign(state.google, body); return reply(null, 204); } return reply([state.google]); }
    if (p.endsWith('/appt_referrers')) return reply([REF]);
    if (p.endsWith('/appt_audit')) return reply(null, 201);
    if (p.endsWith('/rpc/appt_claim_emails')) { const j = state.outbox.filter(o => o.status === 'pending'); j.forEach(o => { o.status = 'sending'; o.attempts = 1; }); return reply(j); }
    if (p.endsWith('/appt_email_outbox')) {
      if (method === 'POST') { for (const o of body) if (!state.outbox.some(x => x.booking_id === o.booking_id && x.kind === o.kind && x.to_email === o.to_email)) state.outbox.push({ ...o, id: state.outbox.length + 1, status: 'pending', idem_key: crypto.randomUUID(), attempts: 0 }); return reply(null, 201); }
      if (method === 'PATCH') { const id = Number(url.searchParams.get('id').slice(3)); Object.assign(state.outbox.find(o => o.id === id), body); return reply(null, 204); }
    }
    if (p.endsWith('/appt_bookings')) {
      const idem = url.searchParams.get('idempotency_key'), id = url.searchParams.get('id'), hash = url.searchParams.get('manage_token_hash');
      if (method === 'GET') {
        if (idem) return reply(state.bookings.filter(b => 'eq.' + b.idempotency_key === idem));
        if (id) return reply(state.bookings.filter(b => 'eq.' + b.id === id));
        if (hash) return reply(state.bookings.filter(b => 'eq.' + b.manage_token_hash === hash));
        if (url.searchParams.get('or')) return reply([]);
        return reply(state.bookings.filter(b => ['confirmed', 'calendar_pending'].includes(b.status)));
      }
      if (method === 'POST') {
        const clash = state.bookings.some(b => ['confirmed', 'calendar_pending'].includes(b.status) && b.start_at < body.end_at && b.end_at > body.start_at);
        if (clash) return reply({ code: '23P01' }, 409);
        const row = { ...body, id: crypto.randomUUID(), google_event_id: null, meet_link: null, created_at: new Date().toISOString() };
        state.bookings.push(row); return reply([row], 201);
      }
      if (method === 'PATCH') { const row = state.bookings.find(b => 'eq.' + b.id === id); Object.assign(row, body); return reply([row]); }
    }
  }
  if (url.host === 'oauth2.googleapis.com') return reply({ access_token: 'ya29.test', expires_in: 3600 });
  if (url.host === 'www.googleapis.com') {
    assert.equal(init.headers.Authorization, 'Bearer ya29.test');
    if (p.endsWith('/freeBusy')) return reply({ calendars: { primary: { busy: state.busy } } });
    if (p.includes('/events') && method === 'POST') {
      assert.equal(url.searchParams.get('sendUpdates'), 'all');
      state.events.push(body); return reply({ ...body, hangoutLink: body.conferenceData ? 'https://meet.google.com/abc-defg-hij' : undefined });
    }
    if (p.includes('/events/') && method === 'DELETE') { state.deleted = p; return new Response(null, { status: 204 }); }
  }
  if (url.host === 'api.brevo.com') { state.mails.push(body); return reply({ messageId: 'm1' }, 201); }
  throw new Error('Unexpected fetch ' + method + ' ' + url);
};
const waits = []; const ctx = { waitUntil: (p) => waits.push(p) };
const call = async (path, init = {}) => { const r = await worker.fetch(new Request('https://api.example' + path, { ...init, headers: { Origin: 'https://appointments.example', 'Content-Type': 'application/json', ...(init.headers || {}) } }), env, ctx); return { status: r.status, data: await r.json() }; };

// pick tomorrow-ish working day relative to real now
let day = dhakaDate(Date.now() + 86400e3);
while (new Date(day + 'T00:00:00Z').getUTCDay() === 5) day = dhakaDate(at(day, '00:00') + 86400e3);
state.busy = [{ start: `${day}T10:00:00+06:00`, end: `${day}T11:00:00+06:00` }];

const cfg = await call('/api/public/config');
assert.equal(cfg.status, 200); assert.deepEqual(cfg.data.referrers, [{ code: 'BR21510926', name: 'Aziz Ahmed' }]); assert.ok(!JSON.stringify(cfg.data).includes(REF.email)); ok('public config lists referrer names without contact details');
const sl = await call(`/api/public/slots?date=${day}&service=${SERVICE.id}`);
assert.equal(sl.status, 200); assert.equal(sl.data.slots[0].label, '11:00 AM'); ok('slots exclude Google Calendar busy time');

const form = { idempotency_key: crypto.randomUUID(), service_id: SERVICE.id, mode: 'meet', start: sl.data.slots[0].start, name: 'Test Client', phone: '01711-000000',
  email: 'client@example.com', institution: 'BUET', note: 'Thesis help', referrer_code: 'br21510926', referrer_source: 'link' };
const bk = await call('/api/public/bookings', { method: 'POST', body: JSON.stringify(form) });
assert.equal(bk.status, 201, JSON.stringify(bk.data)); assert.equal(bk.data.booking.status, 'confirmed');
const row = state.bookings[0];
assert.equal(row.status, 'confirmed'); assert.equal(row.referrer_code, 'BR21510926'); assert.equal(row.referrer_source, 'link'); assert.equal(row.client_phone, '01711000000');
assert.equal(row.meet_link, 'https://meet.google.com/abc-defg-hij'); ok('booking confirmed, stored with referrer, Meet link saved');
assert.equal(state.events.length, 1); assert.equal(state.events[0].attendees[0].email, 'client@example.com');
assert.match(state.events[0].description, /Referred by: Aziz Ahmed \(BR21510926\)/); assert.equal(state.events[0].start.dateTime, row.start_at); ok('Google event created with client invite and referrer');
await Promise.all(waits);
assert.equal(state.mails.length, 3);
assert.ok(state.mails.some(m => m.subject.startsWith('Your referral booked') && m.to[0].email === REF.email && !m.textContent.includes(form.phone))); assert.ok(state.mails.some(m => m.subject.startsWith('Appointment confirmed') && m.textContent.includes('/manage?token=' + bk.data.manage_token)));
assert.ok(state.mails.some(m => m.subject.startsWith('New appointment') && m.to[0].email === 'office@example.com')); ok('confirmation, office alert and referrer alert emails sent');

const again = await call('/api/public/bookings', { method: 'POST', body: JSON.stringify(form) });
assert.equal(again.status, 201); assert.equal(state.bookings.length, 1); assert.equal(again.data.manage_token, bk.data.manage_token); ok('retried request returns the same booking');

const taken = await call('/api/public/bookings', { method: 'POST', body: JSON.stringify({ ...form, idempotency_key: crypto.randomUUID() }) });
assert.equal(taken.status, 409); assert.equal(taken.data.error.code, 'SLOT_TAKEN'); ok('second client cannot take the same slot');
const bad = await call('/api/public/bookings', { method: 'POST', body: JSON.stringify({ ...form, idempotency_key: crypto.randomUUID(), referrer_code: 'NOPE', start: sl.data.slots[3].start }) });
assert.equal(bad.status, 400); ok('unknown referrer rejected');

const mg = await call('/api/public/manage?token=' + bk.data.manage_token);
assert.equal(mg.status, 200); assert.equal(mg.data.booking.can_cancel, true); ok('manage link shows booking');
const cancel = await call('/api/public/manage/cancel', { method: 'POST', body: JSON.stringify({ token: bk.data.manage_token }) });
assert.equal(cancel.status, 200); assert.equal(row.status, 'cancelled'); assert.ok(state.deleted?.includes(eventId(row.id))); assert.equal(row.google_event_id, null);
await Promise.all(waits);
assert.ok(state.mails.some(m => m.subject.startsWith('Appointment cancelled'))); assert.ok(state.mails.some(m => m.subject.startsWith('Cancelled by client'))); ok('client cancel deletes Google event and emails both sides');

const wrong = await call('/api/public/manage?token=' + 'x'.repeat(43));
assert.equal(wrong.status, 404); ok('invalid manage token rejected');
const noAuth = await call('/api/admin/bookings?from=2026-10-01&to=2026-10-31');
assert.equal(noAuth.status, 401); ok('admin endpoints require sign-in');
const pre = await worker.fetch(new Request('https://api.example/api/public/bookings', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }), env, ctx);
assert.equal(pre.status, 403); ok('CORS rejects unknown origins');

console.log(`Worker tests passed: ${passed}`);

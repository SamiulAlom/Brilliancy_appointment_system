// End-to-end tests of the Node.js + MySQL server against a real MySQL/MariaDB database.
// Google and Brevo are mocked. Usage: TEST_DATABASE_URL=mysql://user:pass@localhost:3306/appt_test node scripts/test-server.mjs
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { openDatabase } from '../server/index.js';
import { handle, runCron, computeSlots, dhakaDate, at, encrypt, eventId } from '../server/app.js';

const URL_ = process.env.TEST_DATABASE_URL || 'mysql://appt:apptpass@localhost:3306/appt_test';
let passed = 0; const ok = (n) => { passed++; console.log('  ✓', n); };

// fresh database
const raw = await mysql.createConnection({ uri: URL_ });
for (const t of ['appt_admins', 'appt_settings', 'appt_services', 'appt_off_days', 'appt_referrers', 'appt_google', 'appt_bookings', 'appt_email_outbox', 'appt_audit']) await raw.query(`DROP TABLE IF EXISTS ${t}`);
await raw.end();
const db = await openDatabase(URL_);
await (await openDatabase(URL_)).pool.end(); // migrations are idempotent
const key = Buffer.from(new Uint8Array(32).map((_, i) => i * 7)).toString('base64');
const env = { TOKEN_ENCRYPTION_KEY: key, PUBLIC_SITE_URL: 'https://appointment.example.com', SETUP_CODE: 'setup-code-123', GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'cs',
  EMAIL_ENABLED: 'true', BREVO_API_KEY: 'brevo', BREVO_SENDER_EMAIL: 'brilliancycomms@gmail.com', BREVO_SENDER_NAME: 'Brilliancy Research' };
const services = await db.q('SELECT * FROM appt_services ORDER BY sort_order');
assert.equal(services.length, 7); ok('migrations create tables and seed 7 services once');
const settingsRow = await db.one('SELECT office_address FROM appt_settings');
assert.equal(settingsRow.office_address, 'Level 13, Fareast Tower, 35 Topkhana Road, Dhaka 1000'); ok('default office address is the new one');

// mocks
const state = { events: [], mails: [], busy: [], deleted: [] };
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url); const method = init.method || 'GET';
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
  const reply = (d, s = 200) => new Response(d === null ? null : JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
  if (url.host === 'oauth2.googleapis.com') return reply({ access_token: 'ya29.test', expires_in: 3600 });
  if (url.host === 'www.googleapis.com') {
    if (url.pathname.endsWith('/freeBusy')) return reply({ calendars: { primary: { busy: state.busy } } });
    if (method === 'POST') { state.events.push(body); return reply({ ...body, hangoutLink: body.conferenceData ? 'https://meet.google.com/abc-defg-hij' : undefined }); }
    if (method === 'DELETE') { state.deleted.push(url.pathname); return new Response(null, { status: 204 }); }
  }
  if (url.host === 'api.brevo.com') { state.mails.push(body); return reply({ messageId: 'm' }, 201); }
  throw new Error('unexpected fetch ' + url);
};
const waits = []; const later = (p) => { waits.push(p); return p; };
let ipN = 0;
const call = (method, path, body = {}, token, ip) => handle(db, env, { method, url: new URL('http://x' + path), headers: token ? { authorization: 'Bearer ' + token } : {}, body, ip: ip || '10.0.0.' + (++ipN % 200) }, later)
  .then(r => r, e => ({ status: e.status || 500, json: { error: { code: e.code, message: e.message } } }));

// slot engine
const st = { open_time: '10:00', close_time: '19:00', working_days: [6, 0, 1, 2, 3, 4], slot_step_min: 30, min_notice_min: 120, max_days_ahead: 30 };
assert.equal(computeSlots({ date: '2026-10-26', settings: st, duration: 30, now: Date.parse('2026-10-25T06:00:00+06:00') }).length, 18);
assert.equal(computeSlots({ date: '2026-10-30', settings: st, duration: 30, now: Date.parse('2026-10-25T06:00:00+06:00') }).length, 0); ok('slot engine: 18 slots, Friday closed');

// admin setup + login
assert.equal((await call('GET', '/api/auth/setup-status')).json.needs_setup, true);
assert.equal((await call('POST', '/api/auth/setup', { setup_code: 'wrong-code-12', email: 'a@b.co', full_name: 'X', password: 'longpassword1' })).status, 403);
const s1 = await call('POST', '/api/auth/setup', { setup_code: 'setup-code-123', email: 'Admin@Example.com', full_name: 'Hasanul Banna', password: 'correct horse battery' });
assert.equal(s1.status, 200); assert.ok(s1.json.access_token);
assert.equal((await call('POST', '/api/auth/setup', { setup_code: 'setup-code-123', email: 'x@y.co', full_name: 'Y', password: 'another password' })).status, 409); ok('first-admin setup needs the setup code and works only once');
assert.equal((await call('POST', '/api/auth/login', { username: 'admin@example.com', password: 'nope' })).status, 401);
const lg = await call('POST', '/api/auth/login', { username: 'admin@example.com', password: 'correct horse battery' });
assert.equal(lg.status, 200); const T = lg.json.access_token;
assert.equal((await call('GET', '/api/admin/me', {}, T)).json.admin.full_name, 'Hasanul Banna');
assert.equal((await call('GET', '/api/admin/me', {}, T.slice(0, -2) + 'xx')).status, 401);
assert.equal((await call('GET', '/api/admin/me')).status, 401); ok('login, signed session, tampered token rejected');
const pw = await call('POST', '/api/admin/password', { current: 'correct horse battery', password: 'new correct horse' }, T);
assert.equal(pw.status, 200); assert.equal((await call('POST', '/api/auth/login', { username: 'admin@example.com', password: 'new correct horse' })).status, 200); ok('change password');
for (let i = 0; i < 10; i++) await call('POST', '/api/auth/login', { username: 'admin@example.com', password: 'bad' }, null, '9.9.9.9');
assert.equal((await call('POST', '/api/auth/login', { username: 'admin@example.com', password: 'new correct horse' }, null, '9.9.9.9')).status, 429); ok('login rate limit');

// referrers bulk + google connection
const bulk = await call('POST', '/api/admin/referrers/bulk', { rows: [
  { code: 'BR21510926', full_name: 'Aziz Ahmed', designation: 'Communication', email: 'aziz@example.com', phone: '017' },
  { code: 'BR21011024', full_name: 'Jannatul Ferdous', designation: 'Consultant', email: '', phone: '' }] }, T);
assert.equal(bulk.json.count, 2);
assert.equal((await call('POST', '/api/admin/referrers/bulk', { rows: [{ code: 'bad code!', full_name: 'X' }] }, T)).status, 400);
assert.equal((await db.q('SELECT * FROM appt_referrers')).length, 2); ok('bulk referrer import validates before writing');
await db.q('UPDATE appt_google SET refresh_token_enc = ?, google_email = ? WHERE id = 1', [await encrypt(env, 'refresh-1'), 'brilliancycomms@gmail.com']);

// public booking flow
let day = dhakaDate(Date.now() + 86400e3); while (new Date(day + 'T00:00:00Z').getUTCDay() === 5) day = dhakaDate(at(day, '00:00') + 86400e3);
state.busy = [{ start: `${day}T10:00:00+06:00`, end: `${day}T11:00:00+06:00` }];
const cfg = await call('GET', '/api/public/config');
assert.deepEqual(cfg.json.referrers.map(r => r.code).sort(), ['BR21011024', 'BR21510926']); assert.ok(!JSON.stringify(cfg.json).includes('aziz@example.com')); ok('public config hides referrer contacts');
const svc = services[0];
const sl = await call('GET', `/api/public/slots?date=${day}&service=${svc.id}`);
assert.equal(sl.json.slots[0].label, '11:00 AM'); ok('slots exclude Google busy time');
const form = { idempotency_key: crypto.randomUUID(), service_id: svc.id, mode: 'meet', start: sl.json.slots[0].start, name: 'Test Client', phone: '01711-000000',
  email: 'client@example.com', institution: 'BUET', note: 'Thesis help', referrer_code: 'br21510926', referrer_source: 'link' };
const bk = await call('POST', '/api/public/bookings', form);
assert.equal(bk.status, 201, JSON.stringify(bk.json));
const row = await db.one('SELECT * FROM appt_bookings WHERE client_email = ?', ['client@example.com']);
assert.equal(row.status, 'confirmed'); assert.equal(row.client_phone, '01711000000'); assert.equal(row.referrer_code, 'BR21510926'); assert.equal(row.meet_link, 'https://meet.google.com/abc-defg-hij');
assert.equal(new Date(row.start_at).toISOString(), form.start); ok('booking stored in UTC, confirmed on calendar with Meet link');
assert.equal(state.events[0].id, eventId(row.id)); assert.match(state.events[0].description, /Referred by: Aziz Ahmed \(BR21510926\)/); ok('Google event created with deterministic ID and referrer');
await Promise.all(waits);
assert.equal(state.mails.length, 3); assert.ok(state.mails.some(m => m.subject.startsWith('Appointment confirmed') && m.textContent.includes('https://appointment.example.com/manage?token=' + bk.json.manage_token)));
ok('confirmation, office alert and referrer alert emails sent');
const again = await call('POST', '/api/public/bookings', form);
assert.equal(again.status, 201); assert.equal(again.json.manage_token, bk.json.manage_token); assert.equal((await db.q('SELECT id FROM appt_bookings')).length, 1); ok('retried request returns the same booking');
assert.equal((await call('POST', '/api/public/bookings', { ...form, idempotency_key: crypto.randomUUID() })).json.error.code, 'SLOT_TAKEN'); ok('taken slot rejected');

// concurrency: two clients race for the same free slot → exactly one wins
const free = sl.json.slots[6].start;
const race = await Promise.all([1, 2, 3].map(i => call('POST', '/api/public/bookings', { ...form, idempotency_key: crypto.randomUUID(), start: free, phone: '0181100000' + i, email: `race${i}@example.com`, referrer_code: null, referrer_source: 'none' })));
assert.equal(race.filter(r => r.status === 201).length, 1); assert.equal(race.filter(r => r.json?.error?.code === 'SLOT_TAKEN').length, 2); ok('simultaneous bookings: exactly one wins (row lock)');

// other service
const otherSlots = await call('GET', `/api/public/slots?date=${day}&service=other`);
const oth = await call('POST', '/api/public/bookings', { ...form, idempotency_key: crypto.randomUUID(), service_id: 'other', service_other: 'Plagiarism check', start: otherSlots.json.slots.at(-1).start, phone: '01900000001', email: 'other@example.com', referrer_code: null, referrer_source: 'none' });
assert.equal(oth.status, 201, JSON.stringify(oth.json));
const orow = await db.one('SELECT * FROM appt_bookings WHERE client_email = ?', ['other@example.com']);
assert.equal(orow.service_name, 'Other: Plagiarism check'); assert.equal(orow.service_id, null); assert.equal(orow.duration_min, 30); ok('"Something else" service booking');

// admin views
const from = dhakaDate(Date.now()), to = dhakaDate(Date.now() + 10 * 86400e3);
const list = await call('GET', `/api/admin/bookings?from=${from}&to=${to}`, {}, T);
assert.equal(list.json.bookings.length, 3); assert.ok(!('manage_token_hash' in list.json.bookings[0])); assert.equal(list.json.bookings.find(b => b.client_email === 'client@example.com').referrer_label, 'Aziz Ahmed'); ok('admin bookings list');
const rep = await call('GET', `/api/admin/referrals?from=${from}&to=${to}`, {}, T);
assert.equal(rep.json.rows.find(r => r.referrer_code === 'BR21510926').total, 1); ok('referral report');
const hist = await call('GET', `/api/admin/client-history?phone=01711000000&email=client@example.com`, {}, T);
assert.equal(hist.json.bookings.length, 1); ok('client history');
const upd = await call('POST', '/api/admin/bookings/update', { id: orow.id, status: 'completed', internal_note: 'Done' }, T);
assert.equal(upd.json.booking.status, 'completed'); assert.equal(upd.json.booking.internal_note, 'Done'); ok('admin marks completed with note');
const sv = await call('POST', '/api/admin/settings', { open_time: '10:00', close_time: '19:00', working_days: [6, 0, 1, 2, 3, 4], modes: ['office', 'meet', 'phone'], slot_step_min: 30, min_notice_min: 120, max_days_ahead: 30, office_address: 'Level 13, Fareast Tower, 35 Topkhana Road, Dhaka 1000', calendar_id: 'primary', notify_email: 'office@example.com' }, T);
assert.equal(sv.status, 200); const as = await call('GET', '/api/admin/settings', {}, T);
assert.equal(as.json.settings.notify_email, 'office@example.com'); assert.equal(as.json.google.redirect_uri, 'https://appointment.example.com/api/google/callback'); assert.equal(as.json.admins.length, 1); ok('settings save/load, Google redirect URI on own domain');
const off = await call('POST', '/api/admin/off-days', { from: day, to: day, reason: 'Holiday' }, T);
assert.equal(off.status, 200); assert.equal((await call('GET', `/api/public/slots?date=${day}&service=${svc.id}`)).json.slots.length, 0); ok('office off day closes the date');
await db.q('DELETE FROM appt_off_days');
assert.equal((await call('POST', '/api/admin/admins', { email: 'second@example.com', full_name: 'Second Admin', password: 'short' }, T)).status, 400);
assert.equal((await call('POST', '/api/admin/admins', { email: 'second@example.com', full_name: 'Second Admin', password: 'second admin password' }, T)).status, 200); ok('add another admin');

// manage + cancel
const mg = await call('GET', '/api/public/manage?token=' + bk.json.manage_token);
assert.equal(mg.json.booking.can_cancel, true);
const cancel = await call('POST', '/api/public/manage/cancel', { token: bk.json.manage_token });
assert.equal(cancel.json.booking.status, 'cancelled'); assert.ok(state.deleted.some(p => p.includes(eventId(row.id))));
await Promise.all(waits);
assert.ok(state.mails.some(m => m.subject.startsWith('Appointment cancelled'))); assert.ok(state.mails.some(m => m.subject.startsWith('Cancelled by client'))); ok('client cancel removes event and emails both sides');
assert.equal((await call('POST', '/api/public/bookings', { ...form, idempotency_key: crypto.randomUUID(), phone: '01722222222', email: 'new@example.com' })).status, 201); ok('cancelled slot can be booked again');

// cron: calendar retry + reminder queue
const pendingId = crypto.randomUUID();
const st2 = Date.now() + 20 * 3600e3;
await db.q(`INSERT INTO appt_bookings (id, idempotency_key, service_name, duration_min, mode, start_at, end_at, status, client_name, client_phone, client_email, manage_token_hash, created_at)
  VALUES (?, ?, 'General consultation', 30, 'office', ?, ?, 'calendar_pending', 'Pending Client', '01733333333', 'pending@example.com', ?, ?)`, [pendingId, crypto.randomUUID(), new Date(st2), new Date(st2 + 1800e3), 'h' + Date.now(), new Date(Date.now() - 48 * 3600e3)]);
await Promise.all(waits);
await runCron(db, env);
await runCron(db, env); // a batch already in flight leaves new mail for the next minute
const pend = await db.one('SELECT status FROM appt_bookings WHERE id = ?', [pendingId]);
assert.equal(pend.status, 'confirmed'); ok('cron retries calendar-pending bookings');
const rem = await db.q(`SELECT * FROM appt_email_outbox WHERE kind = 'reminder' AND booking_id = ?`, [pendingId]);
assert.equal(rem.length, 1); assert.equal(rem[0].status, 'accepted'); ok('cron queues and sends ~24h reminders');

// branded HTML emails
assert.ok(state.mails.length && state.mails.every(m => m.htmlContent && m.htmlContent.includes('/brand/email-logo.jpg') && m.textContent)); ok('emails are branded HTML cards with a text version');
assert.ok(!state.mails.some(m => /<script/i.test(m.htmlContent))); ok('email HTML has no scripts');

// admin delete: upcoming booking is removed from calendar, client emailed, row erased
const del = await call('POST', '/api/public/bookings', { ...form, start: sl.json.slots[10].start, idempotency_key: crypto.randomUUID(), phone: '01744444444', email: 'delete-me@example.com', name: 'Delete <Me>' });
assert.equal(del.status, 201); await Promise.all(waits);
const delRow = await db.one(`SELECT id, google_event_id FROM appt_bookings WHERE client_email = 'delete-me@example.com'`);
assert.equal((await call('POST', '/api/admin/bookings/delete', { id: delRow.id })).status, 401);
const mailsBefore = state.mails.length;
const dr = await call('POST', '/api/admin/bookings/delete', { id: delRow.id, notify_client: true }, T);
assert.equal(dr.status, 200); assert.equal(dr.json.emailed, true);
assert.equal(await db.one('SELECT id FROM appt_bookings WHERE id = ?', [delRow.id]), null);
assert.equal((await db.q('SELECT id FROM appt_email_outbox WHERE booking_id = ?', [delRow.id])).length, 0);
assert.ok(state.deleted.some(p => p.includes(delRow.google_event_id)));
const delMail = state.mails.slice(mailsBefore).find(m => m.to[0].email === 'delete-me@example.com');
assert.ok(delMail && delMail.subject.startsWith('Appointment cancelled') && delMail.htmlContent.includes('Dear Delete &lt;Me&gt;,') && !delMail.htmlContent.includes('<Me>'));
assert.ok((await db.one(`SELECT detail FROM appt_audit WHERE action = 'delete' AND booking_id = ?`, [delRow.id])).detail.includes('delete-me@example.com'));
assert.equal((await call('POST', '/api/admin/bookings/delete', { id: delRow.id }, T)).status, 404); ok('admin can delete an appointment (calendar removed, client emailed, audited)');
const pastDel = await call('POST', '/api/admin/bookings/delete', { id: pendingId, notify_client: false }, T);
assert.equal(pastDel.json.emailed, false); ok('delete without emailing the client');

// communication team portal
assert.equal((await call('POST', '/api/admin/team', { email: 'Caller@Example.com', full_name: 'Caller One', phone: '01800000000', password: 'short' }, T)).status, 400);
assert.equal((await call('POST', '/api/admin/team', { email: 'Caller@Example.com', full_name: 'Caller One', phone: '01800000000', password: 'caller password 1' }, T)).status, 200);
assert.equal((await call('POST', '/api/admin/team', { email: 'second.caller@example.com', full_name: 'Caller Two', password: 'caller password 2' }, T)).status, 200);
const setTeam = (await call('GET', '/api/admin/settings', {}, T)).json.team;
assert.equal(setTeam.length, 2); assert.ok(!('password_hash' in setTeam[0])); ok('admin creates team members');
assert.equal((await call('POST', '/api/team/login', { username: 'caller@example.com', password: 'wrong password!' })).status, 401);
const tl = await call('POST', '/api/team/login', { username: 'caller@example.com', password: 'caller password 1' });
assert.equal(tl.status, 200); const TT = tl.json.access_token; ok('team member signs in');
assert.equal((await call('GET', '/api/admin/settings', {}, TT)).status, 401); assert.equal((await call('GET', '/api/team/me', {}, T)).status, 401); ok('team and admin sessions are not interchangeable');
assert.equal((await call('POST', '/api/admin/bookings/delete', { id: pendingId }, TT)).status, 401); ok('team cannot use admin actions');
const dayFrom = dhakaDate(Date.now()), dayTo = dhakaDate(Date.now() + 40 * 86400e3);
const tb = await call('GET', `/api/team/bookings?from=${dayFrom}&to=${dayTo}`, {}, TT);
assert.equal(tb.status, 200); assert.ok(tb.json.bookings.length >= 1); assert.equal(tb.json.members.length, 2);
const tbk = tb.json.bookings.find(b => b.status === 'confirmed');
assert.ok(tbk.client_phone && !('internal_note' in tbk) && !('manage_token_hash' in tbk) && !('idempotency_key' in tbk)); ok('team sees bookings with contact details but no admin-only fields');
const due1 = await call('GET', '/api/team/bookings?view=due', {}, TT);
assert.ok(due1.json.bookings.some(b => b.id === tbk.id)); ok('new bookings appear in the to-call list');
assert.equal((await call('POST', '/api/team/update', { booking_id: tbk.id }, TT)).status, 400);
const u1 = await call('POST', '/api/team/update', { booking_id: tbk.id, outcome: 'no_answer', assign: 'me' }, TT);
assert.equal(u1.json.booking.follow_status, 'no_answer'); assert.equal(u1.json.booking.assigned_name, 'Caller One'); assert.equal(u1.json.activity.length, 1);
const later2h = new Date(Date.now() + 2 * 3600e3).toISOString();
const u2 = await call('POST', '/api/team/update', { booking_id: tbk.id, follow_status: 'follow_up', follow_up_at: later2h, note: 'Call after <b>lunch</b>' }, TT);
assert.equal(u2.json.booking.follow_status, 'follow_up'); assert.equal(u2.json.booking.follow_up_at, later2h); assert.equal(u2.json.activity[0].note, 'Call after <b>lunch</b>');
assert.ok((await call('GET', '/api/team/bookings?view=due', {}, TT)).json.bookings.some(b => b.id === tbk.id)); ok('call-back due within a day stays on the to-call list');
const u3 = await call('POST', '/api/team/update', { booking_id: tbk.id, outcome: 'reached', note: 'Confirmed, will bring documents' }, TT);
assert.equal(u3.json.booking.follow_status, 'called'); assert.equal(u3.json.booking.follow_up_at, null); assert.ok(u3.json.booking.last_contact_at);
assert.ok(!(await call('GET', '/api/team/bookings?view=due', {}, TT)).json.bookings.some(b => b.id === tbk.id)); ok('reaching the client logs the call and clears it from the list');
assert.equal((await call('POST', '/api/team/update', { booking_id: tbk.id, outcome: 'teleport' }, TT)).status, 400);
assert.equal((await call('POST', '/api/team/update', { booking_id: tbk.id, assign: crypto.randomUUID() }, TT)).status, 400); ok('team updates are validated');
const adminLog = await call('GET', '/api/admin/activity?booking_id=' + tbk.id, {}, T);
assert.equal(adminLog.json.activity.length, 3); assert.equal(adminLog.json.activity[2].actor_name, 'Caller One');
assert.equal((await call('POST', '/api/admin/activity', { booking_id: tbk.id, follow_status: 'done', note: 'Handled' }, T)).json.booking.follow_status, 'done'); ok('admins see and add to the call log');
assert.equal((await call('POST', '/api/admin/team', { email: 'caller@example.com', full_name: 'Caller One', active: false }, T)).status, 200);
assert.equal((await call('GET', '/api/team/me', {}, TT)).status, 403);
assert.equal((await call('POST', '/api/team/login', { username: 'caller@example.com', password: 'caller password 1' })).status, 401); ok('deactivated team member is locked out');

// bulk team accounts + temporary passwords + forced change
const tbulk = await call('POST', '/api/admin/team/bulk', { rows: [
  { email: 'Bulk.One@example.com', full_name: 'Bulk One', phone: '01900000001' }, { email: 'bulk.two@example.com', full_name: 'Bulk Two' },
  { email: 'bulk.one@example.com', full_name: 'Bulk One Again' }, { email: 'second.caller@example.com', full_name: 'Caller Two' }] }, T);
assert.equal(tbulk.status, 200); assert.equal(tbulk.json.created.length, 2); assert.equal(tbulk.json.skipped.length, 2);
const pw1 = tbulk.json.created[0].password;
assert.match(pw1, /^[A-HJ-NP-Za-km-z2-9]{4}-[A-HJ-NP-Za-km-z2-9]{4}-[A-HJ-NP-Za-km-z2-9]{4}$/); assert.notEqual(pw1, tbulk.json.created[1].password);
assert.equal((await call('POST', '/api/admin/team/bulk', { rows: [{ email: 'bad', full_name: 'X' }] }, T)).status, 400);
assert.equal((await call('POST', '/api/admin/team/bulk', { rows: [{ email: 'x@example.com', full_name: 'X Y' }] }, TT)).status, 401); ok('admin creates team accounts in bulk with unique temporary passwords');
const bl = await call('POST', '/api/team/login', { username: 'bulk.one@example.com', password: pw1 });
assert.equal(bl.json.must_change, true); const BT = bl.json.access_token;
assert.equal((await call('GET', '/api/team/me', {}, BT)).json.member.must_change, true);
assert.equal((await call('POST', '/api/team/password', { current: pw1, password: pw1 }, BT)).status, 400);
assert.equal((await call('POST', '/api/team/password', { current: pw1, password: 'my own password 1' }, BT)).status, 200);
assert.equal((await call('GET', '/api/team/me', {}, BT)).json.member.must_change, false); ok('first sign-in must change the temporary password');
// admin reset
const bulkOne = (await call('GET', '/api/admin/settings', {}, T)).json.team.find(t => t.email === 'bulk.one@example.com');
const rs = await call('POST', '/api/admin/team/reset', { id: bulkOne.id }, T);
assert.equal(rs.status, 200); assert.equal((await call('POST', '/api/team/login', { username: 'bulk.one@example.com', password: 'my own password 1' })).status, 401);
assert.equal((await call('POST', '/api/team/login', { username: 'bulk.one@example.com', password: rs.json.member.password })).json.must_change, true); ok('admin password reset issues a new temporary password');
// forgot password by email (team and admin)
const mailsB = state.mails.length;
assert.equal((await call('POST', '/api/auth/forgot', { role: 'team', email: 'nobody@example.com' })).json.ok, true);
assert.equal(state.mails.length, mailsB); ok('forgot password does not reveal unknown emails');
assert.equal((await call('POST', '/api/auth/forgot', { role: 'team', email: 'Bulk.Two@example.com' })).status, 200);
const rmail = state.mails[state.mails.length - 1];
assert.ok(rmail.subject.startsWith('Reset your') && rmail.to[0].email === 'bulk.two@example.com' && rmail.htmlContent.includes('/brand/email-logo.jpg'));
const rtoken = decodeURIComponent(/\/team\?reset=([A-Za-z0-9_.-]+)/.exec(rmail.textContent)[1]);
assert.equal((await call('POST', '/api/auth/reset', { token: rtoken, password: 'short' })).status, 400);
assert.equal((await call('POST', '/api/auth/reset', { token: rtoken.slice(0, -2) + 'xx', password: 'brand new password' })).status, 400);
assert.equal((await call('POST', '/api/auth/reset', { token: rtoken, password: 'brand new password' })).json.role, 'team');
assert.equal((await call('POST', '/api/auth/reset', { token: rtoken, password: 'another new password' })).status, 400);
const after = await call('POST', '/api/team/login', { username: 'bulk.two@example.com', password: 'brand new password' });
assert.equal(after.status, 200); assert.equal(after.json.must_change, false); ok('emailed reset link works once and sets a new password');
await call('POST', '/api/auth/forgot', { role: 'admin', email: 'second@example.com' });
const amail = state.mails[state.mails.length - 1]; assert.ok(amail.textContent.includes('/admin?reset='));
const atoken = /\/admin\?reset=([A-Za-z0-9_.-]+)/.exec(amail.textContent)[1];
assert.equal((await call('POST', '/api/auth/reset', { token: atoken, password: 'admin reset password' })).json.role, 'admin');
assert.equal((await call('POST', '/api/auth/login', { username: 'second@example.com', password: 'admin reset password' })).status, 200); ok('administrators can reset a forgotten password too');

const health = await call('GET', '/api/health');
assert.equal(health.json.database, true); assert.equal(health.json.configured, true); ok('health check');
await db.pool.end();
console.log(`Server tests passed: ${passed}`);

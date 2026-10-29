// Brilliancy Appointments API (Node.js + MySQL). Runs on the Hostinger VPS (EasyPanel).
// Environment: DATABASE_URL, PUBLIC_SITE_URL, TOKEN_ENCRYPTION_KEY, SETUP_CODE,
//              GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, BREVO_API_KEY, BREVO_SENDER_EMAIL, BREVO_SENDER_NAME, EMAIL_ENABLED
import { randomUUID, scrypt as scryptCb, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

export const REVISION = 'appointments-3-mysql';
import { emailContent, resetEmail } from './email.js';
const ZONE = 'Asia/Dhaka';
const OFFSET = '+06:00'; // Bangladesh has no daylight saving time.
const ACTIVE = ['calendar_pending', 'confirmed'];
const STATUSES = ['calendar_pending', 'confirmed', 'completed', 'no_show', 'cancelled'];
const MODES = { office: 'In office', meet: 'Google Meet (online)', phone: 'Phone call' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL = /^[^\s@,()"]+@[^\s@,()"]+\.[^\s@,()"]+$/;
const MAX_UPCOMING_PER_CLIENT = 3;
const OTHER_SERVICE_ID = 'other';
const OTHER_DURATION_MIN = 30;
const SESSION_HOURS = 12;
const GOOGLE_SCOPES = 'openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy';
const scrypt = promisify(scryptCb);

export class ApiError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const fail = (status, code, message) => { throw new ApiError(status, code, message); };

// ---------------------------------------------------------------- time helpers
const pad = (n) => String(n).padStart(2, '0');
export function dhakaDate(ms) { const d = new Date(ms + 6 * 3600e3); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
export const at = (date, hhmm) => Date.parse(`${date}T${hhmm.slice(0, 5)}:00${OFFSET}`);
const weekday = (date) => new Date(date + 'T00:00:00Z').getUTCDay();
const addDays = (date, n) => dhakaDate(at(date, '00:00') + n * 86400e3);
const fmtWhen = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso));
const fmtTime = (ms) => new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(ms));
const iso = (d) => (d == null ? null : d instanceof Date ? d.toISOString() : new Date(d).toISOString());
const sqlTime = (ms) => new Date(ms);           // mysql2 stores Date as UTC (timezone: 'Z')
const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

/** Pure slot engine. Returns available start times (epoch ms) for one Dhaka date. */
export function computeSlots({ date, settings, duration, offDays = [], busy = [], now = Date.now() }) {
  if (!DATE.test(date) || Number.isNaN(at(date, '00:00'))) return [];
  const today = dhakaDate(now);
  if (date < today || date > addDays(today, settings.max_days_ahead)) return [];
  if (!settings.working_days.map(Number).includes(weekday(date))) return [];
  if (offDays.some(o => o.from_date <= date && date <= o.to_date)) return [];
  const open = at(date, settings.open_time), close = at(date, settings.close_time);
  const step = settings.slot_step_min * 60e3, len = duration * 60e3;
  const earliest = now + settings.min_notice_min * 60e3;
  const ranges = busy.map(b => [Date.parse(b.start), Date.parse(b.end)]).filter(([s, e]) => e > s);
  const out = [];
  for (let t = open; t + len <= close; t += step) {
    if (t < earliest) continue;
    if (ranges.some(([s, e]) => t < e && t + len > s)) continue;
    out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------- crypto helpers (WebCrypto)
const enc = new TextEncoder();
const b64 = (buf) => Buffer.from(buf).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const unb64url = (s) => new Uint8Array(Buffer.from(s, 'base64url'));
async function sha256(text) { return b64url(await crypto.subtle.digest('SHA-256', enc.encode(text))); }
let keyCache = null;
async function keys(env) {
  if (keyCache?.raw === env.TOKEN_ENCRYPTION_KEY) return keyCache;
  let bytes; try { bytes = unb64(env.TOKEN_ENCRYPTION_KEY || ''); } catch { bytes = new Uint8Array(); }
  if (bytes.length !== 32) fail(503, 'SETUP_REQUIRED', 'TOKEN_ENCRYPTION_KEY must be 32 random bytes in base64.');
  const base = await crypto.subtle.importKey('raw', bytes, 'HKDF', false, ['deriveKey']);
  const derive = (info, alg, usages) => crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode(info) }, base, alg, false, usages);
  keyCache = { raw: env.TOKEN_ENCRYPTION_KEY,
    aes: await derive('appt-token-encryption', { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']),
    hmac: await derive('appt-signing', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign', 'verify']) };
  return keyCache;
}
export async function encrypt(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, (await keys(env)).aes, enc.encode(text));
  return b64(iv) + '.' + b64(ct);
}
export async function decrypt(env, value) {
  const [ivPart, ct] = value.split('.');
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(ivPart) }, (await keys(env)).aes, unb64(ct)));
}
async function sign(env, text) { return b64url(await crypto.subtle.sign('HMAC', (await keys(env)).hmac, enc.encode(text))); }
async function verifySig(env, text, sig) { try { return await crypto.subtle.verify('HMAC', (await keys(env)).hmac, unb64url(sig), enc.encode(text)); } catch { return false; } }
const manageToken = (env, idem) => sign(env, 'manage:' + idem);

// Passwords: scrypt with per-user salt. Format: scrypt$16384$8$1$salt$hash
export async function hashPassword(pw) {
  const salt = randomBytes(16);
  const hash = await scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${hash.toString('base64')}`;
}
async function checkPassword(pw, stored) {
  const [alg, N, r, p, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt') { await scrypt(pw, 'x', 64); return false; }
  const want = Buffer.from(hash, 'base64');
  const got = await scrypt(pw, Buffer.from(salt, 'base64'), want.length, { N: +N, r: +r, p: +p });
  return got.length === want.length && timingSafeEqual(got, want);
}
async function issueSession(env, adminId) {
  const payload = b64url(enc.encode(JSON.stringify({ a: adminId, e: Date.now() + SESSION_HOURS * 3600e3 })));
  return payload + '.' + await sign(env, 'session:' + payload);
}

// ---------------------------------------------------------------- data layer
export function createStore(pool) {
  const q = async (sql, params = [], conn = pool) => (await conn.query(sql, params))[0];
  const one = async (sql, params, conn) => (await q(sql, params, conn))[0] || null;
  return { pool, q, one };
}
const bool = (v) => v === 1 || v === true || v === '1';
function mapSettings(s) {
  return { ...s, working_days: String(s.working_days).split(',').filter(x => x !== '').map(Number), modes: String(s.modes).split(',').filter(Boolean),
    open_time: String(s.open_time).slice(0, 5), close_time: String(s.close_time).slice(0, 5), updated_at: iso(s.updated_at) };
}
function mapBooking(b) {
  if (!b) return b;
  return { ...b, start_at: iso(b.start_at), end_at: iso(b.end_at), created_at: iso(b.created_at), updated_at: iso(b.updated_at), cancelled_at: iso(b.cancelled_at),
    follow_up_at: iso(b.follow_up_at), last_contact_at: iso(b.last_contact_at), follow_status: b.follow_status || 'new',
    client_note: b.client_note || '', internal_note: b.internal_note || '' };
}
const mapOff = (o) => ({ id: o.id, from_date: ymd(o.from_date), to_date: ymd(o.to_date), reason: o.reason });
const mapRef = (r) => ({ ...r, notify: bool(r.notify), active: bool(r.active), created_at: iso(r.created_at) });
const mapService = (s) => ({ ...s, active: bool(s.active), created_at: iso(s.created_at) });

async function loadSettings(db) {
  const s = await db.one('SELECT * FROM appt_settings WHERE id = 1');
  if (!s) fail(503, 'SETUP_REQUIRED', 'Settings row missing.');
  return mapSettings(s);
}
const activeReferrers = async (db) => (await db.q('SELECT code, full_name, email, notify FROM appt_referrers WHERE active = 1 ORDER BY full_name')).map(mapRef);
const futureOffDays = async (db, from) => (await db.q('SELECT id, from_date, to_date, reason FROM appt_off_days WHERE to_date >= ? ORDER BY from_date', [from])).map(mapOff);
async function dbBusy(db, fromMs, toMs, conn) {
  const rows = await db.q(`SELECT id, start_at, end_at FROM appt_bookings WHERE status IN (?) AND start_at < ? AND end_at > ?`, [ACTIVE, sqlTime(toMs), sqlTime(fromMs)], conn);
  return rows.map(r => ({ start: iso(r.start_at), end: iso(r.end_at) }));
}
const getBooking = async (db, id) => mapBooking(await db.one('SELECT * FROM appt_bookings WHERE id = ?', [id]));
const audit = (db, actor, action, booking_id, detail = {}) =>
  db.q('INSERT INTO appt_audit (actor_admin_id, action, booking_id, detail) VALUES (?, ?, ?, ?)', [actor || null, action, booking_id || null, JSON.stringify(detail)]).catch(() => {});

// ---------------------------------------------------------------- outbound HTTP
async function upstream(url, options = {}, label = 'service') {
  try { return await fetch(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(12000) }); }
  catch { fail(503, 'SERVICE_UNAVAILABLE', `Could not reach ${label}. Try again shortly.`); }
}

// ---------------------------------------------------------------- Google Calendar
let tokenCache = null;
const googleRow = async (db) => (await db.one('SELECT * FROM appt_google WHERE id = 1')) || {};
async function googleAccessToken(db, env) {
  const g = await googleRow(db);
  if (!g.refresh_token_enc) return null;
  if (tokenCache && tokenCache.enc === g.refresh_token_enc && tokenCache.exp > Date.now() + 60e3) return tokenCache.token;
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) fail(503, 'SETUP_REQUIRED', 'Google OAuth client is not configured on the server.');
  const refresh = await decrypt(env, g.refresh_token_enc);
  const r = await upstream('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: refresh, grant_type: 'refresh_token' }) }, 'Google');
  const data = await r.json().catch(() => ({}));
  if (data.error === 'invalid_grant') {
    await db.q('UPDATE appt_google SET refresh_token_enc = NULL, last_error = ? WHERE id = 1', ['Google access was revoked or expired. Reconnect the office calendar in Admin → Settings.']);
    tokenCache = null; return null;
  }
  if (!r.ok || !data.access_token) fail(503, 'CALENDAR_UNAVAILABLE', 'Google Calendar is temporarily unavailable. Please try again in a minute.');
  tokenCache = { enc: g.refresh_token_enc, token: data.access_token, exp: Date.now() + (data.expires_in || 3000) * 1000 };
  return data.access_token;
}
async function gcal(token, path, { method = 'GET', body } = {}) {
  const r = await upstream('https://www.googleapis.com/calendar/v3/' + path, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }, 'Google Calendar');
  const data = r.status === 204 ? null : await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, data };
}
async function googleBusy(db, env, settings, fromMs, toMs) {
  const token = await googleAccessToken(db, env);
  if (!token) return null;
  const { ok, data } = await gcal(token, 'freeBusy', { method: 'POST', body: { timeMin: new Date(fromMs).toISOString(), timeMax: new Date(toMs).toISOString(), timeZone: ZONE, items: [{ id: settings.calendar_id }] } });
  const cal = data?.calendars?.[settings.calendar_id];
  if (!ok || !cal || cal.errors?.length) fail(503, 'CALENDAR_UNAVAILABLE', 'Could not check the office calendar. Please try again in a minute.');
  return cal.busy || [];
}
export const eventId = (bookingId) => 'bk' + bookingId.replace(/-/g, '');
function eventBody(b, settings, referrer) {
  const lines = [`Service: ${b.service_name}`, `Meeting: ${MODES[b.mode]}`, '', `Client: ${b.client_name}`, `Phone: ${b.client_phone}`, `Email: ${b.client_email}`,
    b.client_institution ? `Institution: ${b.client_institution}` : null, `Referred by: ${referrer}`, b.client_note ? `\nClient note:\n${b.client_note}` : null,
    '', `Booking ID: ${b.id}`, 'Booked via Brilliancy Appointments'].filter(v => v !== null);
  const body = { id: eventId(b.id), summary: `${b.service_name} — ${b.client_name}`, description: lines.join('\n'),
    start: { dateTime: b.start_at, timeZone: ZONE }, end: { dateTime: b.end_at, timeZone: ZONE },
    attendees: [{ email: b.client_email, displayName: b.client_name }],
    location: b.mode === 'office' ? settings.office_address : b.mode === 'phone' ? `Phone call: ${b.client_phone}` : undefined,
    extendedProperties: { private: { bookingId: b.id } }, reminders: { useDefault: true } };
  if (b.mode === 'meet') body.conferenceData = { createRequest: { requestId: b.id, conferenceSolutionKey: { type: 'hangoutsMeet' } } };
  return body;
}
async function referrerLabel(db, b) {
  if (b.referrer_source === 'other') return `Other: ${b.referrer_other}`;
  if (!b.referrer_code) return 'No referrer';
  const e = await db.one('SELECT full_name, code FROM appt_referrers WHERE code = ?', [b.referrer_code]);
  return e ? `${e.full_name} (${e.code})` : b.referrer_code;
}
const noteCalendarError = (db, id, msg) => db.q('UPDATE appt_bookings SET calendar_error = ? WHERE id = ?', [String(msg).slice(0, 500), id]);
async function syncCreate(db, env, b, settings) {
  let token;
  try { token = await googleAccessToken(db, env); } catch (e) { await noteCalendarError(db, b.id, e.message); return false; }
  if (!token) { await noteCalendarError(db, b.id, 'Office Google Calendar is not connected.'); return false; }
  const path = `calendars/${encodeURIComponent(settings.calendar_id)}/events`;
  let res = await gcal(token, `${path}?sendUpdates=all&conferenceDataVersion=1`, { method: 'POST', body: eventBody(b, settings, await referrerLabel(db, b)) });
  if (res.status === 409) res = await gcal(token, `${path}/${eventId(b.id)}`);
  if (!res.ok || !res.data?.id) { await noteCalendarError(db, b.id, `Google Calendar HTTP ${res.status}: ${res.data?.error?.message || 'unknown error'}`); return false; }
  await db.q(`UPDATE appt_bookings SET status = 'confirmed', google_event_id = ?, meet_link = ?, calendar_error = NULL, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND status = 'calendar_pending'`,
    [res.data.id, res.data.hangoutLink || null, b.id]);
  await db.q('UPDATE appt_google SET last_ok_at = CURRENT_TIMESTAMP(3), last_error = NULL WHERE id = 1');
  return true;
}
async function syncDelete(db, env, b, settings) {
  try {
    const token = await googleAccessToken(db, env);
    if (!token) return false;
    const res = await gcal(token, `calendars/${encodeURIComponent(settings.calendar_id)}/events/${encodeURIComponent(b.google_event_id)}?sendUpdates=all`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404 && res.status !== 410) { await noteCalendarError(db, b.id, `Google delete HTTP ${res.status}`); return false; }
    await db.q('UPDATE appt_bookings SET google_event_id = NULL, calendar_error = NULL WHERE id = ?', [b.id]);
    return true;
  } catch (e) { await noteCalendarError(db, b.id, e.message).catch(() => {}); return false; }
}

// ---------------------------------------------------------------- email (Brevo)
function sendMail(env, { to_email, to_name, subject, text, html, replyTo, idem }) {
  return fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
    headers: { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ sender: { name: env.BREVO_SENDER_NAME || 'Brilliancy Research', email: env.BREVO_SENDER_EMAIL },
      to: [{ email: to_email, name: to_name || undefined }], subject, textContent: text, htmlContent: html, replyTo,
      headers: { idempotencyKey: idem || randomUUID() } }) });
}
function brevoSend(env, settings, job, b, c) {
  return fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
    headers: { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ sender: { name: env.BREVO_SENDER_NAME || 'Brilliancy Research', email: env.BREVO_SENDER_EMAIL },
      to: [{ email: job.to_email, name: job.to_name || undefined }], subject: c.subject, textContent: c.text, htmlContent: c.html,
      replyTo: job.kind === 'admin_alert' ? { email: b.client_email, name: b.client_name } : { email: settings.notify_email },
      headers: { idempotencyKey: job.idem_key } }) });
}
const emailReady = (env) => String(env.EMAIL_ENABLED).toLowerCase() === 'true' && !!env.BREVO_API_KEY && EMAIL.test(env.BREVO_SENDER_EMAIL || '');
async function queueEmails(db, list) {
  for (const e of list) await db.q('INSERT IGNORE INTO appt_email_outbox (booking_id, kind, to_email, to_name, idem_key) VALUES (?, ?, ?, ?, ?)', [e.booking_id, e.kind, e.to_email, e.to_name || '', randomUUID()]);
}
let emailRun = null;
export function processEmails(db, env) { emailRun ??= sendEmails(db, env).finally(() => { emailRun = null; }); return emailRun; }
async function sendEmails(db, env) {
  if (!emailReady(env)) return 0;
  const jobs = await db.q(`SELECT * FROM appt_email_outbox WHERE status = 'pending' AND not_before <= CURRENT_TIMESTAMP(3) ORDER BY id LIMIT 10`);
  if (!jobs.length) return 0;
  const settings = await loadSettings(db);
  let sent = 0;
  for (const job of jobs) {
    await db.q(`UPDATE appt_email_outbox SET status = 'sending', attempts = attempts + 1 WHERE id = ?`, [job.id]);
    job.attempts += 1;
    let status = 'failed', error = null;
    try {
      const b = await getBooking(db, job.booking_id);
      const stillActive = b && (ACTIVE.includes(b.status) || job.kind === 'cancellation');
      if (!stillActive || (job.kind === 'reminder' && Date.parse(b.start_at) < Date.now())) { status = 'skipped'; error = 'Booking no longer active.'; }
      else {
        b._manage = await manageToken(env, b.idempotency_key);
        b._referrer = await referrerLabel(db, b);
        const c = emailContent(job.kind, b, settings, env, job.to_email !== b.client_email);
        const res = await brevoSend(env, settings, job, b, c);
        const result = await res.json().catch(() => null);
        if (res.ok) { status = 'accepted'; sent++; }
        else if (result?.code === 'duplicate_parameter') { status = 'accepted'; error = 'Previously accepted by Brevo.'; }
        else { status = res.status === 429 || res.status >= 500 ? 'pending' : 'failed'; error = `Brevo HTTP ${res.status}: ${result?.message || ''}`.slice(0, 300); }
      }
    } catch (e) { status = 'pending'; error = 'Brevo unavailable: ' + String(e.message || e).slice(0, 200); }
    if (status === 'pending' && job.attempts >= 5) status = 'needs_review';
    await db.q('UPDATE appt_email_outbox SET status = ?, last_error = ?, not_before = ? WHERE id = ?', [status, error, sqlTime(Date.now() + 60e3 * job.attempts), job.id]).catch(() => {});
  }
  return sent;
}

// ---------------------------------------------------------------- helpers
const str = (v, max, { min = 0, name = 'field' } = {}) => {
  const s = typeof v === 'string' ? v.trim() : v == null ? '' : fail(400, 'INVALID_INPUT', `Check ${name}.`);
  if (s.length < min || s.length > max) fail(400, 'INVALID_INPUT', `Check ${name}.`);
  return s;
};
function publicBooking(b, settings) {
  return { id: b.id, service_name: b.service_name, duration_min: b.duration_min, mode: b.mode, mode_label: MODES[b.mode],
    start_at: b.start_at, end_at: b.end_at, when_label: fmtWhen(b.start_at),
    status: b.status === 'calendar_pending' ? 'confirmed' : b.status, client_name: b.client_name, meet_link: b.meet_link,
    office_address: settings.office_address, can_cancel: ACTIVE.includes(b.status) && Date.parse(b.start_at) > Date.now() };
}
const adminView = (b) => { const { manage_token_hash, idempotency_key, ...rest } = b; return rest; };

// Simple in-memory rate limiter (single server instance).
const hits = new Map();
function limit(key, max, windowMs) {
  const now = Date.now(), arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) fail(429, 'RATE_LIMIT', 'Too many attempts. Please wait a few minutes and try again.');
  arr.push(now); hits.set(key, arr);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(t => now - t < windowMs)) hits.delete(k);
}

// ---------------------------------------------------------------- public routes
async function publicConfig(db) {
  const [settings, services, referrers, google] = await Promise.all([loadSettings(db),
    db.q('SELECT id, name, description, duration_min FROM appt_services WHERE active = 1 ORDER BY sort_order, name'), activeReferrers(db), googleRow(db)]);
  const today = dhakaDate(Date.now());
  return { today, timezone: ZONE,
    settings: { open_time: settings.open_time, close_time: settings.close_time, working_days: settings.working_days, slot_step_min: settings.slot_step_min,
      min_notice_min: settings.min_notice_min, max_days_ahead: settings.max_days_ahead, modes: settings.modes, office_address: settings.office_address },
    services, referrers: referrers.map(r => ({ code: r.code, name: r.full_name })), off_days: await futureOffDays(db, today),
    calendar_connected: !!google.refresh_token_enc, other_duration_min: OTHER_DURATION_MIN };
}
async function slotsFor(db, env, date, serviceId, conn) {
  if (!DATE.test(date || '')) fail(400, 'INVALID_INPUT', 'Choose a valid date.');
  if (serviceId !== OTHER_SERVICE_ID && !UUID.test(serviceId || '')) fail(400, 'INVALID_INPUT', 'Choose a service.');
  const settings = await loadSettings(db);
  const service = serviceId === OTHER_SERVICE_ID ? { id: null, name: 'Other', duration_min: OTHER_DURATION_MIN }
    : await db.one('SELECT * FROM appt_services WHERE id = ? AND active = 1', [serviceId]);
  if (!service) fail(404, 'SERVICE_NOT_FOUND', 'This service is not available.');
  const offDays = await futureOffDays(db, date);
  const from = at(date, '00:00'), to = from + 86400e3;
  const base = { date, settings, duration: service.duration_min, offDays };
  if (!computeSlots({ ...base, busy: [] }).length) return { settings, service, slots: [] };
  const [mine, google] = await Promise.all([dbBusy(db, from, to, conn), googleBusy(db, env, settings, from, to)]);
  return { settings, service, slots: computeSlots({ ...base, busy: [...mine, ...(google || [])] }) };
}
async function createBooking(db, env, body, ip, later) {
  limit('book:' + ip, 12, 3600e3);
  if (!UUID.test(body.idempotency_key || '')) fail(400, 'INVALID_INPUT', 'Refresh the page and try again.');
  const idem = body.idempotency_key.toLowerCase();
  const existing = mapBooking(await db.one('SELECT * FROM appt_bookings WHERE idempotency_key = ?', [idem]));
  if (existing) return { booking: publicBooking(existing, await loadSettings(db)), manage_token: await manageToken(env, idem) };

  const name = str(body.name, 120, { min: 2, name: 'your name' });
  const phone = str(body.phone, 30, { min: 8, name: 'phone number' }).replace(/[\s()-]/g, '');
  if (!/^\+?[0-9]{8,15}$/.test(phone)) fail(400, 'INVALID_INPUT', 'Enter a valid phone number, e.g. 01711-000000.');
  const email = str(body.email, 200, { min: 5, name: 'email' }).toLowerCase();
  if (!EMAIL.test(email)) fail(400, 'INVALID_INPUT', 'Enter a valid email address.');
  const institution = str(body.institution, 200, { name: 'institution' });
  const note = str(body.note, 1500, { name: 'note' });
  if (!MODES[body.mode]) fail(400, 'INVALID_INPUT', 'Choose how you want to meet.');
  const start = Date.parse(body.start || '');
  if (Number.isNaN(start)) fail(400, 'INVALID_INPUT', 'Choose a time.');
  let referrer = null, referrer_code = null, referrer_source = 'none', referrer_other = '';
  if (body.referrer_source === 'other') { referrer_source = 'other'; referrer_other = str(body.referrer_other, 120, { min: 2, name: 'referrer name' }); }
  else if (body.referrer_code) {
    referrer = (await activeReferrers(db)).find(x => x.code.toLowerCase() === String(body.referrer_code).toLowerCase());
    if (!referrer) fail(400, 'INVALID_INPUT', 'The selected referring employee was not found. Choose again.');
    referrer_code = referrer.code; referrer_source = body.referrer_source === 'link' ? 'link' : 'dropdown';
  }
  const serviceOther = body.service_id === OTHER_SERVICE_ID ? str(body.service_other, 120, { min: 3, name: 'the service you need' }) : null;

  // Check the slot against Google first (outside the lock), then re-check the database inside a locked transaction.
  const date = dhakaDate(start);
  const { settings, service: found, slots } = await slotsFor(db, env, date, body.service_id);
  const service = serviceOther ? { ...found, name: 'Other: ' + serviceOther } : found;
  if (!settings.modes.includes(body.mode)) fail(400, 'INVALID_INPUT', 'This meeting type is not offered.');
  if (!slots.includes(start)) fail(409, 'SLOT_TAKEN', 'Sorry, that time is no longer available. Please choose another time.');
  const upcoming = await db.one(`SELECT COUNT(*) AS n FROM appt_bookings WHERE status IN (?) AND start_at > CURRENT_TIMESTAMP(3) AND (client_phone = ? OR client_email = ?)`, [ACTIVE, phone, email]);
  if (Number(upcoming.n) >= MAX_UPCOMING_PER_CLIENT) fail(429, 'TOO_MANY_BOOKINGS', `You already have ${upcoming.n} upcoming appointments. Please cancel one or contact us.`);

  const token = await manageToken(env, idem);
  const id = randomUUID(), end = start + service.duration_min * 60e3;
  const conn = await db.pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('SELECT id FROM appt_settings WHERE id = 1 FOR UPDATE');   // one booking write at a time → no overlaps
    const clash = await conn.query(`SELECT id FROM appt_bookings WHERE status IN (?) AND start_at < ? AND end_at > ? LIMIT 1`, [ACTIVE, sqlTime(end), sqlTime(start)]);
    if (clash[0].length) { await conn.rollback(); fail(409, 'SLOT_TAKEN', 'Sorry, that time was just booked. Please choose another time.'); }
    await conn.query(`INSERT INTO appt_bookings (id, idempotency_key, service_id, service_name, duration_min, mode, start_at, end_at, status,
        client_name, client_phone, client_email, client_institution, client_note, referrer_code, referrer_source, referrer_other, manage_token_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'calendar_pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, idem, service.id || null, service.name, service.duration_min, body.mode, sqlTime(start), sqlTime(end),
        name, phone, email, institution, note, referrer_code, referrer_source, referrer_other, await sha256(token)]);
    await conn.commit();
  } catch (e) {
    await conn.rollback().catch(() => {});
    if (e.code === 'ER_DUP_ENTRY') { const again = mapBooking(await db.one('SELECT * FROM appt_bookings WHERE idempotency_key = ?', [idem])); if (again) return { booking: publicBooking(again, settings), manage_token: token }; }
    throw e;
  } finally { conn.release(); }

  let b = await getBooking(db, id);
  if (await syncCreate(db, env, b, settings).catch(() => false)) b = await getBooking(db, id);
  await queueEmails(db, [
    { booking_id: id, kind: 'confirmation', to_email: email, to_name: name },
    { booking_id: id, kind: 'admin_alert', to_email: settings.notify_email, to_name: 'Brilliancy Research' },
    ...(referrer?.email && referrer.notify ? [{ booking_id: id, kind: 'referrer_alert', to_email: referrer.email, to_name: referrer.full_name }] : []),
  ]).catch(() => {});
  later(processEmails(db, env));
  return { booking: publicBooking(b, settings), manage_token: token };
}
async function bookingByToken(db, token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) fail(404, 'NOT_FOUND', 'This booking link is invalid.');
  const b = mapBooking(await db.one('SELECT * FROM appt_bookings WHERE manage_token_hash = ?', [await sha256(token)]));
  if (!b) fail(404, 'NOT_FOUND', 'This booking link is invalid or the booking was removed.');
  return b;
}
async function cancelBooking(db, env, b, by, actorId, later) {
  if (!ACTIVE.includes(b.status)) fail(409, 'NOT_ACTIVE', 'This appointment is already closed.');
  if (by === 'client' && Date.parse(b.start_at) <= Date.now()) fail(409, 'ALREADY_STARTED', 'This appointment has already started. Please contact us.');
  const r = await db.q(`UPDATE appt_bookings SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP(3), cancelled_by = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND status IN (?)`, [by, b.id, ACTIVE]);
  if (!r.affectedRows) fail(409, 'NOT_ACTIVE', 'This appointment was already changed. Refresh.');
  const settings = await loadSettings(db);
  const updated = await getBooking(db, b.id);
  if (updated.google_event_id) await syncDelete(db, env, updated, settings);
  await queueEmails(db, [{ booking_id: b.id, kind: 'cancellation', to_email: b.client_email, to_name: b.client_name },
    ...(by === 'client' ? [{ booking_id: b.id, kind: 'cancellation', to_email: settings.notify_email, to_name: 'Brilliancy Research' }] : [])]).catch(() => {});
  await audit(db, actorId, 'cancel', b.id, { by });
  later(processEmails(db, env));
  return getBooking(db, b.id);
}

// ---------------------------------------------------------------- auth
async function authAdmin(db, env, header) {
  const m = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(header || '');
  if (!m || !(await verifySig(env, 'session:' + m[1], m[2]))) fail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
  let s; try { s = JSON.parse(Buffer.from(m[1], 'base64url').toString()); } catch { fail(401, 'SIGN_IN_REQUIRED', 'Please sign in.'); }
  if (!(s.e > Date.now())) fail(401, 'SESSION_EXPIRED', 'Your session has expired. Please sign in again.');
  const admin = await db.one('SELECT id, full_name, email FROM appt_admins WHERE id = ? AND active = 1', [s.a]);
  if (!admin) fail(403, 'ADMIN_REQUIRED', 'An active administrator account is required.');
  return admin;
}
async function login(db, env, body, ip) {
  limit('login:' + ip, 10, 15 * 60e3);
  const email = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
  if (!EMAIL.test(email) || typeof body.password !== 'string' || !body.password || body.password.length > 256) fail(400, 'INVALID_LOGIN', 'Enter your email address and password.');
  const a = await db.one('SELECT id, password_hash FROM appt_admins WHERE email = ? AND active = 1', [email]);
  const ok = await checkPassword(body.password, a?.password_hash);
  if (!a || !ok) fail(401, 'INVALID_CREDENTIALS', 'Invalid email or password.');
  return { access_token: await issueSession(env, a.id) };
}
async function setup(db, env, body, ip) {
  limit('setup:' + ip, 5, 15 * 60e3);
  const count = await db.one('SELECT COUNT(*) AS n FROM appt_admins');
  if (Number(count.n) > 0) fail(409, 'ALREADY_SET_UP', 'An administrator already exists. Please sign in.');
  if (!env.SETUP_CODE || env.SETUP_CODE.length < 8) fail(503, 'SETUP_REQUIRED', 'Set SETUP_CODE (8+ characters) in the server environment first.');
  if (typeof body.setup_code !== 'string' || body.setup_code.length !== env.SETUP_CODE.length || !timingSafeEqual(Buffer.from(body.setup_code), Buffer.from(env.SETUP_CODE))) fail(403, 'BAD_SETUP_CODE', 'The setup code is not correct.');
  const email = str(body.email, 200, { min: 5, name: 'email' }).toLowerCase();
  if (!EMAIL.test(email)) fail(400, 'INVALID_INPUT', 'Enter a valid email address.');
  const name = str(body.full_name, 120, { min: 2, name: 'your name' });
  if (typeof body.password !== 'string' || body.password.length < 10) fail(400, 'WEAK_PASSWORD', 'Use a password of at least 10 characters.');
  const id = randomUUID();
  await db.q('INSERT INTO appt_admins (id, email, full_name, password_hash) VALUES (?, ?, ?, ?)', [id, email, name, await hashPassword(body.password)]);
  await audit(db, id, 'admin_setup', null, { email });
  return { access_token: await issueSession(env, id) };
}
async function changePassword(db, admin, body) {
  const a = await db.one('SELECT password_hash FROM appt_admins WHERE id = ?', [admin.id]);
  if (!(await checkPassword(String(body.current || ''), a?.password_hash))) fail(403, 'INVALID_CREDENTIALS', 'Your current password is not correct.');
  if (typeof body.password !== 'string' || body.password.length < 10) fail(400, 'WEAK_PASSWORD', 'Use a password of at least 10 characters.');
  await db.q('UPDATE appt_admins SET password_hash = ? WHERE id = ?', [await hashPassword(body.password), admin.id]);
  await audit(db, admin.id, 'password_change');
  return { ok: true };
}
async function saveAdmin(db, admin, body) {
  const email = str(body.email, 200, { min: 5, name: 'email' }).toLowerCase();
  if (!EMAIL.test(email)) fail(400, 'INVALID_INPUT', 'Enter a valid email address.');
  const existing = await db.one('SELECT id FROM appt_admins WHERE email = ?', [email]);
  if (existing) {
    if (existing.id === admin.id && body.active === false) fail(409, 'SELF_CHANGE', 'You cannot deactivate your own account.');
    await db.q('UPDATE appt_admins SET full_name = ?, active = ? WHERE id = ?', [str(body.full_name, 120, { min: 2, name: 'name' }), body.active === false ? 0 : 1, existing.id]);
    if (typeof body.password === 'string' && body.password) {
      if (body.password.length < 10) fail(400, 'WEAK_PASSWORD', 'Use a password of at least 10 characters.');
      await db.q('UPDATE appt_admins SET password_hash = ? WHERE id = ?', [await hashPassword(body.password), existing.id]);
    }
  } else {
    if (typeof body.password !== 'string' || body.password.length < 10) fail(400, 'WEAK_PASSWORD', 'Give the new administrator a password of at least 10 characters.');
    await db.q('INSERT INTO appt_admins (id, email, full_name, password_hash) VALUES (?, ?, ?, ?)', [randomUUID(), email, str(body.full_name, 120, { min: 2, name: 'name' }), await hashPassword(body.password)]);
  }
  await audit(db, admin.id, 'admin_save', null, { email });
  return { ok: true };
}


// ---------------------------------------------------------------- communication team
// Team members sign in to a separate portal. They can see bookings and log calls / tasks,
// but cannot change settings, cancel or delete. Sessions are signed with a different prefix
// from admin sessions, so one can never be used as the other.
const FOLLOW = { new: 'To call', called: 'Contacted', no_answer: 'No answer', follow_up: 'Call back', done: 'Done' };
const OUTCOMES = { reached: 'Spoke with client', no_answer: 'No answer', busy: 'Busy / call later', wrong_number: 'Wrong number', whatsapp: 'Messaged on WhatsApp', email: 'Sent an email', note: 'Note' };
async function issueTeamSession(env, id) {
  const payload = b64url(enc.encode(JSON.stringify({ t: id, e: Date.now() + SESSION_HOURS * 3600e3 })));
  return payload + '.' + await sign(env, 'team:' + payload);
}
async function authTeam(db, env, header) {
  const m = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(header || '');
  if (!m || !(await verifySig(env, 'team:' + m[1], m[2]))) fail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
  let s; try { s = JSON.parse(Buffer.from(m[1], 'base64url').toString()); } catch { fail(401, 'SIGN_IN_REQUIRED', 'Please sign in.'); }
  if (!(s.e > Date.now())) fail(401, 'SESSION_EXPIRED', 'Your session has expired. Please sign in again.');
  const member = await db.one('SELECT id, full_name, email, phone, must_change FROM appt_team WHERE id = ? AND active = 1', [s.t]);
  if (member) member.must_change = bool(member.must_change);
  if (!member) fail(403, 'TEAM_REQUIRED', 'Your team account is not active. Ask an administrator.');
  return member;
}
async function teamLogin(db, env, body, ip) {
  limit('team-login:' + ip, 10, 15 * 60e3);
  const email = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
  if (!EMAIL.test(email) || typeof body.password !== 'string' || !body.password || body.password.length > 256) fail(400, 'INVALID_LOGIN', 'Enter your email address and password.');
  const t = await db.one('SELECT id, password_hash, must_change FROM appt_team WHERE email = ? AND active = 1', [email]);
  const good = await checkPassword(body.password, t?.password_hash);
  if (!t || !good) fail(401, 'INVALID_CREDENTIALS', 'Invalid email or password.');
  await db.q('UPDATE appt_team SET last_login_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [t.id]);
  return { access_token: await issueTeamSession(env, t.id), must_change: bool(t.must_change) };
}
// What the team sees: contact details and booking facts, never admin-only notes or tokens.
function teamView(b, refs, team) {
  return { id: b.id, start_at: b.start_at, end_at: b.end_at, duration_min: b.duration_min, service_name: b.service_name, mode: b.mode, meet_link: b.meet_link,
    status: b.status, client_name: b.client_name, client_phone: b.client_phone, client_email: b.client_email, client_institution: b.client_institution,
    client_note: b.client_note, created_at: b.created_at,
    referrer_label: b.referrer_source === 'other' ? `Other: ${b.referrer_other}` : b.referrer_code ? (refs[b.referrer_code]?.full_name || b.referrer_code) : 'No one',
    follow_status: b.follow_status, follow_up_at: b.follow_up_at, last_contact_at: b.last_contact_at,
    assigned_to: b.assigned_to, assigned_name: b.assigned_to ? (team[b.assigned_to]?.full_name || 'Former member') : null };
}
async function teamLookups(db) {
  const [refs, team] = await Promise.all([db.q('SELECT code, full_name FROM appt_referrers'), db.q('SELECT id, full_name, active FROM appt_team ORDER BY full_name')]);
  return { refs: Object.fromEntries(refs.map(r => [r.code, r])), team: Object.fromEntries(team.map(t => [t.id, t])), members: team.filter(t => bool(t.active)).map(t => ({ id: t.id, full_name: t.full_name })) };
}
async function teamBookings(db, url) {
  const { refs, team, members } = await teamLookups(db);
  let rows;
  if (url.searchParams.get('view') === 'due') {
    // Everything that still needs a call: upcoming bookings not yet contacted, plus call-backs that are due.
    rows = await db.q(`SELECT * FROM appt_bookings WHERE status IN (?) AND (
        (follow_status IN ('new','no_answer') AND end_at > ?) OR (follow_status = 'follow_up' AND (follow_up_at IS NULL OR follow_up_at <= ?)))
      ORDER BY COALESCE(follow_up_at, start_at) LIMIT 500`, [[...ACTIVE, 'completed', 'no_show'], sqlTime(Date.now()), sqlTime(Date.now() + 86400e3)]);
  } else {
    const { from, to } = dateRange(url);
    rows = await db.q('SELECT * FROM appt_bookings WHERE start_at >= ? AND start_at < ? ORDER BY start_at LIMIT 2000', [sqlTime(at(from, '00:00')), sqlTime(at(to, '00:00') + 86400e3)]);
  }
  return { bookings: rows.map(mapBooking).map(b => teamView(b, refs, team)), members, follow_labels: FOLLOW, outcome_labels: OUTCOMES };
}
async function activityFor(db, bookingId) {
  if (!UUID.test(bookingId || '')) fail(400, 'INVALID_INPUT', 'Unknown booking.');
  const rows = await db.q('SELECT id, actor_type, actor_name, outcome, follow_status, follow_up_at, note, created_at FROM appt_activity WHERE booking_id = ? ORDER BY created_at DESC, id DESC LIMIT 200', [bookingId]);
  return { activity: rows.map(r => ({ ...r, follow_up_at: iso(r.follow_up_at), created_at: iso(r.created_at) })) };
}
// One call / task update: optional outcome, note, new follow-up status, call-back time and assignment, logged as one entry.
async function logActivity(db, actor, body) {
  if (!UUID.test(body.booking_id || '')) fail(400, 'INVALID_INPUT', 'Unknown booking.');
  const b = await getBooking(db, body.booking_id);
  if (!b) fail(404, 'NOT_FOUND', 'Booking not found. It may have been deleted.');
  const outcome = body.outcome ? (OUTCOMES[body.outcome] ? body.outcome : fail(400, 'INVALID_INPUT', 'Unknown call outcome.')) : null;
  const status = body.follow_status ? (FOLLOW[body.follow_status] ? body.follow_status : fail(400, 'INVALID_INPUT', 'Unknown follow-up status.')) : null;
  const note = str(body.note, 2000, { name: 'note' }) || null;
  let followAt;   // undefined = unchanged, null = clear
  if (body.follow_up_at === null || body.follow_up_at === '') followAt = null;
  else if (body.follow_up_at !== undefined) { const t = Date.parse(body.follow_up_at); if (!Number.isFinite(t)) fail(400, 'INVALID_INPUT', 'Check the call-back time.'); followAt = t; }
  let assign;     // undefined = unchanged
  if (body.assign === 'me' && actor.type === 'team') assign = actor.id;
  else if (body.assign === 'none') assign = null;
  else if (body.assign !== undefined) { const m = await db.one('SELECT id FROM appt_team WHERE id = ? AND active = 1', [String(body.assign)]); if (!m) fail(400, 'INVALID_INPUT', 'Unknown team member.'); assign = m.id; }
  if (!outcome && !status && !note && followAt === undefined && assign === undefined) fail(400, 'INVALID_INPUT', 'Add a call outcome, note or status.');
  const sets = [], vals = [];
  const newStatus = status || (outcome === 'reached' ? 'called' : outcome === 'no_answer' || outcome === 'busy' ? 'no_answer' : null);
  if (newStatus) { sets.push('follow_status = ?'); vals.push(newStatus); }
  if (followAt !== undefined) { sets.push('follow_up_at = ?'); vals.push(followAt === null ? null : sqlTime(followAt)); }
  else if (newStatus && newStatus !== 'follow_up') { sets.push('follow_up_at = NULL'); }
  if (assign !== undefined) { sets.push('assigned_to = ?'); vals.push(assign); }
  if (outcome && outcome !== 'note') sets.push('last_contact_at = CURRENT_TIMESTAMP(3)');
  if (sets.length) await db.q(`UPDATE appt_bookings SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?`, [...vals, b.id]);
  const assignNote = assign === undefined ? '' : assign === null ? 'Unassigned' : `Assigned to ${(await db.one('SELECT full_name FROM appt_team WHERE id = ?', [assign]))?.full_name}`;
  await db.q('INSERT INTO appt_activity (booking_id, actor_type, actor_id, actor_name, outcome, follow_status, follow_up_at, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [b.id, actor.type, actor.id, actor.name, outcome, newStatus, followAt ? sqlTime(followAt) : null, [note, assignNote].filter(Boolean).join(' · ') || null]);
  const { refs, team } = await teamLookups(db);
  return { booking: teamView(await getBooking(db, b.id), refs, team), ...(await activityFor(db, b.id)) };
}
async function teamPassword(db, member, body) {
  const t = await db.one('SELECT password_hash FROM appt_team WHERE id = ?', [member.id]);
  if (!(await checkPassword(String(body.current || ''), t?.password_hash))) fail(403, 'INVALID_CREDENTIALS', 'Your current password is not correct.');
  if (typeof body.password !== 'string' || body.password.length < 10) fail(400, 'WEAK_PASSWORD', 'Use a password of at least 10 characters.');
  if (body.password === body.current) fail(400, 'SAME_PASSWORD', 'Choose a password different from the current one.');
  await db.q('UPDATE appt_team SET password_hash = ?, must_change = 0 WHERE id = ?', [await hashPassword(body.password), member.id]);
  return { ok: true };
}
async function saveTeamMember(db, admin, body) {
  const email = str(body.email, 200, { min: 5, name: 'email' }).toLowerCase();
  if (!EMAIL.test(email)) fail(400, 'INVALID_INPUT', 'Enter a valid email address.');
  const name = str(body.full_name, 120, { min: 2, name: 'name' });
  const phone = str(body.phone, 30, { name: 'phone' }) || null;
  const existing = await db.one('SELECT id FROM appt_team WHERE email = ?', [email]);
  if (existing) {
    await db.q('UPDATE appt_team SET full_name = ?, phone = ?, active = ? WHERE id = ?', [name, phone, body.active === false ? 0 : 1, existing.id]);
    if (typeof body.password === 'string' && body.password) {
      if (body.password.length < 10) fail(400, 'WEAK_PASSWORD', 'Use a password of at least 10 characters.');
      await db.q('UPDATE appt_team SET password_hash = ? WHERE id = ?', [await hashPassword(body.password), existing.id]);
    }
  } else {
    if (typeof body.password !== 'string' || body.password.length < 10) fail(400, 'WEAK_PASSWORD', 'Give the team member a password of at least 10 characters.');
    await db.q('INSERT INTO appt_team (id, email, full_name, phone, password_hash) VALUES (?, ?, ?, ?, ?)', [randomUUID(), email, name, phone, await hashPassword(body.password)]);
  }
  await audit(db, admin.id, 'team_save', null, { email });
  return { ok: true };
}

// Temporary passwords: 12 characters from an alphabet without look-alikes (no 0/O, 1/l/I), grouped for reading aloud.
const PW_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
export function tempPassword() {
  const bytes = randomBytes(12); let out = '';
  for (let i = 0; i < 12; i++) out += PW_CHARS[bytes[i] % PW_CHARS.length] + (i === 3 || i === 7 ? '-' : '');
  return out;
}
// Create many team accounts at once. Each gets a temporary password (shown to the admin once) and must change it at first sign-in.
async function bulkTeam(db, admin, body) {
  if (!Array.isArray(body.rows) || !body.rows.length || body.rows.length > 200) fail(400, 'INVALID_INPUT', 'Choose between 1 and 200 people.');
  const rows = body.rows.map((r, i) => {
    const email = str(r.email, 200, { min: 5, name: `email on row ${i + 1}` }).toLowerCase();
    if (!EMAIL.test(email)) fail(400, 'INVALID_INPUT', `Check the email on row ${i + 1}.`);
    return { email, full_name: str(r.full_name, 120, { min: 2, name: `name on row ${i + 1}` }), phone: str(r.phone, 30, { name: 'phone' }) || null };
  });
  const created = [], skipped = [], seen = new Set();
  for (const r of rows) {
    if (seen.has(r.email)) { skipped.push({ ...r, reason: 'Listed twice' }); continue; }
    seen.add(r.email);
    if (await db.one('SELECT id FROM appt_team WHERE email = ?', [r.email])) { skipped.push({ ...r, reason: 'Already has an account' }); continue; }
    const password = tempPassword();
    await db.q('INSERT INTO appt_team (id, email, full_name, phone, password_hash, must_change) VALUES (?, ?, ?, ?, ?, 1)', [randomUUID(), r.email, r.full_name, r.phone, await hashPassword(password)]);
    created.push({ ...r, password });
  }
  await audit(db, admin.id, 'team_bulk', null, { created: created.length, skipped: skipped.length });
  return { created, skipped };
}
async function resetTeamPassword(db, admin, body) {
  if (!UUID.test(body.id || '')) fail(400, 'INVALID_INPUT', 'Unknown team member.');
  const t = await db.one('SELECT id, email, full_name, phone FROM appt_team WHERE id = ?', [body.id]);
  if (!t) fail(404, 'NOT_FOUND', 'Team member not found.');
  const password = tempPassword();
  await db.q('UPDATE appt_team SET password_hash = ?, must_change = 1, active = 1 WHERE id = ?', [await hashPassword(password), t.id]);
  await audit(db, admin.id, 'team_reset', null, { email: t.email });
  return { member: { email: t.email, full_name: t.full_name, phone: t.phone, password } };
}

// "Forgot password?" for team members and administrators: an emailed link, signed and valid for 60 minutes.
// The link carries a fingerprint of the current password hash, so it stops working once the password changes (one use).
const RESET_MIN = 60;
const ROLE_TABLE = { team: 'appt_team', admin: 'appt_admins' };
async function forgotPassword(db, env, body, ip) {
  limit('forgot:' + ip, 5, 15 * 60e3);
  const role = body.role === 'admin' ? 'admin' : 'team';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!EMAIL.test(email)) fail(400, 'INVALID_INPUT', 'Enter your email address.');
  limit('forgot-email:' + email, 3, 60 * 60e3);
  const u = await db.one(`SELECT id, full_name, email, password_hash FROM ${ROLE_TABLE[role]} WHERE email = ? AND active = 1`, [email]);
  if (u && emailReady(env)) {
    const payload = b64url(enc.encode(JSON.stringify({ r: role, id: u.id, e: Date.now() + RESET_MIN * 60e3, h: (await sha256(u.password_hash)).slice(0, 16) })));
    const token = payload + '.' + await sign(env, 'reset:' + payload);
    const site = (env.PUBLIC_SITE_URL || '').replace(/\/$/, '');
    const url = `${site}/${role === 'team' ? 'team' : 'admin'}?reset=${token}`;
    const c = resetEmail({ name: u.full_name, email: u.email, url, role, minutes: RESET_MIN }, await loadSettings(db), env);
    const res = await sendMail(env, { to_email: u.email, to_name: u.full_name, ...c }).catch(() => null);
    await audit(db, null, 'password_reset_requested', null, { role, email, sent: !!res?.ok });
  }
  return { ok: true };   // same answer whether or not the account exists
}
async function resetPassword(db, env, body, ip) {
  limit('reset:' + ip, 10, 15 * 60e3);
  const m = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(typeof body.token === 'string' ? body.token : '');
  const bad = () => fail(400, 'INVALID_RESET', 'This reset link is invalid or has expired. Ask for a new one.');
  if (!m || !(await verifySig(env, 'reset:' + m[1], m[2]))) bad();
  let p; try { p = JSON.parse(Buffer.from(m[1], 'base64url').toString()); } catch { bad(); }
  if (!(p.e > Date.now()) || !ROLE_TABLE[p.r]) bad();
  const u = await db.one(`SELECT id, password_hash FROM ${ROLE_TABLE[p.r]} WHERE id = ? AND active = 1`, [p.id]);
  if (!u || (await sha256(u.password_hash)).slice(0, 16) !== p.h) bad();
  if (typeof body.password !== 'string' || body.password.length < 10) fail(400, 'WEAK_PASSWORD', 'Use a password of at least 10 characters.');
  await db.q(`UPDATE ${ROLE_TABLE[p.r]} SET password_hash = ?${p.r === 'team' ? ', must_change = 0' : ''} WHERE id = ?`, [await hashPassword(body.password), u.id]);
  await audit(db, p.r === 'admin' ? u.id : null, 'password_reset', null, { role: p.r });
  return { ok: true, role: p.r };
}

// ---------------------------------------------------------------- admin routes
function dateRange(url) {
  const from = url.searchParams.get('from'), to = url.searchParams.get('to');
  if (!DATE.test(from || '') || !DATE.test(to || '') || to < from) fail(400, 'INVALID_INPUT', 'Choose a valid date range.');
  if (at(to, '00:00') - at(from, '00:00') > 400 * 86400e3) fail(400, 'INVALID_INPUT', 'Choose a range of up to 400 days.');
  return { from, to };
}
async function adminBookings(db, url) {
  const { from, to } = dateRange(url);
  const status = url.searchParams.get('status');
  const params = [sqlTime(at(from, '00:00')), sqlTime(at(to, '00:00') + 86400e3)];
  let where = 'start_at >= ? AND start_at < ?';
  if (status && STATUSES.includes(status)) { where += ' AND status = ?'; params.push(status); }
  const [rows, refs] = await Promise.all([db.q(`SELECT * FROM appt_bookings WHERE ${where} ORDER BY start_at LIMIT 2000`, params), db.q('SELECT code, full_name FROM appt_referrers')]);
  const byCode = Object.fromEntries(refs.map(e => [e.code, e]));
  return { bookings: rows.map(mapBooking).map(b => ({ ...adminView(b),
    referrer_label: b.referrer_source === 'other' ? `Other: ${b.referrer_other}` : b.referrer_code ? (byCode[b.referrer_code]?.full_name || b.referrer_code) : '—' })) };
}
async function adminUpdateBooking(db, env, admin, body, later) {
  if (!UUID.test(body.id || '')) fail(400, 'INVALID_INPUT', 'Unknown booking.');
  const b = await getBooking(db, body.id);
  if (!b) fail(404, 'NOT_FOUND', 'Booking not found.');
  if (body.internal_note !== undefined) {
    await db.q('UPDATE appt_bookings SET internal_note = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [str(body.internal_note, 2000, { name: 'note' }), b.id]);
    await audit(db, admin.id, 'note', b.id);
  }
  if (body.status && body.status !== b.status) {
    if (body.status === 'cancelled') await cancelBooking(db, env, b, 'admin', admin.id, later);
    else if (['completed', 'no_show'].includes(body.status) && ['confirmed', 'calendar_pending', 'completed', 'no_show'].includes(b.status)) {
      await db.q('UPDATE appt_bookings SET status = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [body.status, b.id]);
      await audit(db, admin.id, 'status', b.id, { from: b.status, to: body.status });
    } else if (body.status === 'retry_calendar' && b.status === 'calendar_pending') await syncCreate(db, env, b, await loadSettings(db));
    else fail(409, 'INVALID_TRANSITION', 'That status change is not allowed. Cancelled bookings cannot be reopened; book a new time instead.');
  }
  return { booking: adminView(await getBooking(db, b.id)) };
}
// Permanently remove a booking. An upcoming one is first taken off Google Calendar and,
// if asked, the client gets the cancellation email before the record is erased.
async function adminDeleteBooking(db, env, admin, body) {
  if (!UUID.test(body.id || '')) fail(400, 'INVALID_INPUT', 'Unknown booking.');
  const b = await getBooking(db, body.id);
  if (!b) fail(404, 'NOT_FOUND', 'Booking not found. It may already be deleted.');
  const settings = await loadSettings(db);
  const upcoming = ACTIVE.includes(b.status) && Date.parse(b.start_at) > Date.now();
  let emailed = false;
  if (b.google_event_id) await syncDelete(db, env, b, settings);
  if (upcoming && body.notify_client !== false && emailReady(env)) {
    const c = emailContent('cancellation', { ...b, cancelled_by: 'admin' }, settings, env);
    const res = await brevoSend(env, settings, { kind: 'cancellation', to_email: b.client_email, to_name: b.client_name, idem_key: randomUUID() }, b, c).catch(() => null);
    emailed = !!res?.ok;
  }
  await db.q('DELETE FROM appt_email_outbox WHERE booking_id = ?', [b.id]);
  await db.q('DELETE FROM appt_activity WHERE booking_id = ?', [b.id]);
  await db.q('DELETE FROM appt_bookings WHERE id = ?', [b.id]);
  await audit(db, admin.id, 'delete', b.id, { client: b.client_name, email: b.client_email, start_at: b.start_at, service: b.service_name, status: b.status, emailed });
  return { deleted: true, emailed };
}
async function referralReport(db, url) {
  const { from, to } = dateRange(url);
  const rows = await db.q(`SELECT b.referrer_code, r.full_name,
      CASE WHEN b.referrer_source = 'other' THEN CONCAT('Other: ', b.referrer_other) WHEN b.referrer_code IS NULL THEN 'No referrer' ELSE r.full_name END AS referrer_label,
      COUNT(*) AS total, SUM(b.status IN ('confirmed','calendar_pending')) AS upcoming, SUM(b.status = 'completed') AS completed,
      SUM(b.status = 'no_show') AS no_show, SUM(b.status = 'cancelled') AS cancelled
    FROM appt_bookings b LEFT JOIN appt_referrers r ON r.code = b.referrer_code
    WHERE DATE(b.start_at + INTERVAL 6 HOUR) BETWEEN ? AND ?
    GROUP BY b.referrer_code, r.full_name, referrer_label ORDER BY total DESC, referrer_label`, [from, to]);
  return { rows: rows.map(r => ({ ...r, total: Number(r.total), upcoming: Number(r.upcoming), completed: Number(r.completed), no_show: Number(r.no_show), cancelled: Number(r.cancelled) })) };
}
async function adminSettings(db, env) {
  const [settings, services, offDays, google, referrers, admins] = await Promise.all([loadSettings(db), db.q('SELECT * FROM appt_services ORDER BY sort_order, name'),
    futureOffDays(db, addDays(dhakaDate(Date.now()), -30)), googleRow(db), db.q('SELECT * FROM appt_referrers ORDER BY full_name'),
    db.q('SELECT id, email, full_name, active FROM appt_admins ORDER BY full_name')]);
  const team = await db.q('SELECT id, email, full_name, phone, active, must_change, last_login_at FROM appt_team ORDER BY full_name');
  return { settings, services: services.map(mapService), off_days: offDays,
    google: { connected: !!google.refresh_token_enc, email: google.google_email, connected_at: iso(google.connected_at), last_ok_at: iso(google.last_ok_at), last_error: google.last_error,
      redirect_uri: (env.PUBLIC_SITE_URL || '').replace(/\/$/, '') + '/api/google/callback' },
    referrers: referrers.map(mapRef), admins: admins.map(a => ({ ...a, active: bool(a.active) })),
    team: team.map(t => ({ ...t, active: bool(t.active), must_change: bool(t.must_change), last_login_at: iso(t.last_login_at) })) };
}
async function saveSettings(db, admin, b) {
  const days = Array.isArray(b.working_days) ? [...new Set(b.working_days.map(Number))] : [];
  if (!TIME.test(b.open_time || '') || !TIME.test(b.close_time || '') || b.close_time <= b.open_time) fail(400, 'INVALID_INPUT', 'Check opening and closing times.');
  if (!days.length || days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) fail(400, 'INVALID_INPUT', 'Choose at least one working day.');
  const modes = Array.isArray(b.modes) ? [...new Set(b.modes)].filter(m => MODES[m]) : [];
  if (!modes.length) fail(400, 'INVALID_INPUT', 'Choose at least one meeting type.');
  const int = (v, lo, hi, n) => { const x = Number(v); if (!Number.isInteger(x) || x < lo || x > hi) fail(400, 'INVALID_INPUT', `Check ${n}.`); return x; };
  const notify = str(b.notify_email, 200, { name: 'notification email' });
  if (!EMAIL.test(notify)) fail(400, 'INVALID_INPUT', 'Check the notification email.');
  const row = [b.open_time, b.close_time, days.join(','), modes.join(','), int(b.slot_step_min, 5, 240, 'slot step'), int(b.min_notice_min, 0, 10080, 'minimum notice'),
    int(b.max_days_ahead, 1, 180, 'days ahead'), str(b.office_address, 200, { min: 3, name: 'office address' }), str(b.calendar_id || 'primary', 200, { min: 1, name: 'calendar ID' }), notify];
  await db.q(`UPDATE appt_settings SET open_time = ?, close_time = ?, working_days = ?, modes = ?, slot_step_min = ?, min_notice_min = ?, max_days_ahead = ?,
    office_address = ?, calendar_id = ?, notify_email = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = 1`, row);
  await audit(db, admin.id, 'settings', null, { open: b.open_time, close: b.close_time });
  return { ok: true };
}
async function saveService(db, admin, b) {
  const duration = Number(b.duration_min);
  if (!Number.isInteger(duration) || duration < 15 || duration > 480) fail(400, 'INVALID_INPUT', 'Duration must be 15–480 minutes.');
  const row = [str(b.name, 120, { min: 1, name: 'service name' }), str(b.description, 600, { name: 'description' }), duration,
    Number.isInteger(Number(b.sort_order)) ? Number(b.sort_order) : 100, b.active === false ? 0 : 1];
  if (b.id) { if (!UUID.test(b.id)) fail(400, 'INVALID_INPUT', 'Unknown service.'); await db.q('UPDATE appt_services SET name = ?, description = ?, duration_min = ?, sort_order = ?, active = ? WHERE id = ?', [...row, b.id]); }
  else await db.q('INSERT INTO appt_services (id, name, description, duration_min, sort_order, active) VALUES (?, ?, ?, ?, ?, ?)', [randomUUID(), ...row]);
  await audit(db, admin.id, 'service', null, { name: row[0] });
  return { ok: true };
}
async function saveOffDay(db, admin, b) {
  if (b.delete) { if (!UUID.test(b.id || '')) fail(400, 'INVALID_INPUT', 'Unknown off day.'); await db.q('DELETE FROM appt_off_days WHERE id = ?', [b.id]); return { ok: true }; }
  if (!DATE.test(b.from || '') || !DATE.test(b.to || '') || b.to < b.from) fail(400, 'INVALID_INPUT', 'Choose a valid date range.');
  await db.q('INSERT INTO appt_off_days (id, from_date, to_date, reason) VALUES (?, ?, ?, ?)', [randomUUID(), b.from, b.to, str(b.reason, 200, { name: 'reason' })]);
  await audit(db, admin.id, 'off_day', null, b);
  return { ok: true };
}
function referrerRow(b) {
  const code = str(b.code, 30, { min: 2, name: 'employee ID' });
  if (!/^[A-Za-z0-9-]{2,30}$/.test(code)) fail(400, 'INVALID_INPUT', `Employee ID "${code}" may use letters, numbers and hyphens only.`);
  const email = str(b.email, 200, { name: 'email' }).toLowerCase();
  if (email && !EMAIL.test(email)) fail(400, 'INVALID_INPUT', `Check the email address for ${code}.`);
  return [code, str(b.full_name, 120, { min: 1, name: 'name' }), str(b.designation, 120, { name: 'designation' }), email || null, str(b.phone, 30, { name: 'phone' }), b.notify === false ? 0 : 1, b.active === false ? 0 : 1];
}
const UPSERT_REF = `INSERT INTO appt_referrers (code, full_name, designation, email, phone, notify, active) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON DUPLICATE KEY UPDATE full_name = VALUES(full_name), designation = VALUES(designation), email = VALUES(email), phone = VALUES(phone), notify = VALUES(notify), active = VALUES(active)`;
async function saveReferrer(db, admin, b) { const row = referrerRow(b); await db.q(UPSERT_REF, row); await audit(db, admin.id, 'referrer', null, { code: row[0] }); return { ok: true }; }
async function bulkReferrers(db, admin, b) {
  if (!Array.isArray(b.rows) || !b.rows.length || b.rows.length > 500) fail(400, 'INVALID_INPUT', 'Paste between 1 and 500 rows.');
  const rows = b.rows.map(referrerRow);   // validate everything before writing anything
  for (const row of rows) await db.q(UPSERT_REF, row);
  await audit(db, admin.id, 'referrer_bulk', null, { count: rows.length });
  return { ok: true, count: rows.length };
}
async function clientHistory(db, url) {
  const phone = (url.searchParams.get('phone') || '').replace(/[^0-9+]/g, '').slice(0, 16);
  const email = (url.searchParams.get('email') || '').toLowerCase().slice(0, 200);
  if (!phone && !EMAIL.test(email)) fail(400, 'INVALID_INPUT', 'Phone or email required.');
  const rows = await db.q('SELECT id, start_at, service_name, status, mode FROM appt_bookings WHERE client_phone = ? OR client_email = ? ORDER BY start_at DESC LIMIT 50', [phone || '-', EMAIL.test(email) ? email : '-']);
  return { bookings: rows.map(r => ({ ...r, start_at: iso(r.start_at) })) };
}
async function googleStart(env, admin) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) fail(503, 'SETUP_REQUIRED', 'Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to the server environment first.');
  const payload = b64url(enc.encode(JSON.stringify({ a: admin.id, e: Date.now() + 10 * 60e3, n: randomUUID() })));
  const state = payload + '.' + await sign(env, 'oauth:' + payload);
  const p = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: env.PUBLIC_SITE_URL.replace(/\/$/, '') + '/api/google/callback', response_type: 'code',
    scope: GOOGLE_SCOPES, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state });
  return { url: 'https://accounts.google.com/o/oauth2/v2/auth?' + p };
}
async function googleCallback(db, env, url) {
  const site = (env.PUBLIC_SITE_URL || '').replace(/\/$/, '');
  const back = (msg) => ({ redirect: `${site}/admin?google=${encodeURIComponent(msg)}` });
  if (url.searchParams.get('error')) return back('denied');
  const [payload, sig] = (url.searchParams.get('state') || '').split('.');
  if (!payload || !sig || !(await verifySig(env, 'oauth:' + payload, sig))) return back('invalid_state');
  let st; try { st = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { return back('invalid_state'); }
  if (!(st.e > Date.now())) return back('expired');
  const r = await upstream('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: url.searchParams.get('code') || '', client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: site + '/api/google/callback', grant_type: 'authorization_code' }) }, 'Google');
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.refresh_token) return back(t.refresh_token ? 'failed' : 'no_refresh_token');
  const scopes = (t.scope || '').split(' ');
  if (!scopes.some(s => s.endsWith('/calendar.events')) || !scopes.some(s => s.endsWith('/calendar.freebusy'))) return back('missing_permission');
  let email = null; try { email = JSON.parse(Buffer.from(t.id_token.split('.')[1], 'base64url').toString()).email || null; } catch {}
  await db.q('UPDATE appt_google SET google_email = ?, refresh_token_enc = ?, connected_at = CURRENT_TIMESTAMP(3), connected_by = ?, last_error = NULL WHERE id = 1', [email, await encrypt(env, t.refresh_token), st.a]);
  tokenCache = null;
  await db.q(`UPDATE appt_bookings SET calendar_attempts = 0 WHERE status = 'calendar_pending' AND end_at > CURRENT_TIMESTAMP(3)`);
  await audit(db, st.a, 'google_connect', null, { email });
  return back('connected');
}
async function googleDisconnect(db, env, admin) {
  const g = await googleRow(db);
  if (g.refresh_token_enc) { const token = await decrypt(env, g.refresh_token_enc).catch(() => null); if (token) await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(token), { method: 'POST' }).catch(() => {}); }
  await db.q('UPDATE appt_google SET refresh_token_enc = NULL, last_error = NULL WHERE id = 1');
  tokenCache = null;
  await audit(db, admin.id, 'google_disconnect');
  return { ok: true };
}

// ---------------------------------------------------------------- scheduled work (every minute)
export async function runCron(db, env) {
  const settings = await loadSettings(db);
  if ((await googleRow(db)).refresh_token_enc) {
    const due = (await db.q(`SELECT * FROM appt_bookings WHERE ((status = 'calendar_pending' AND end_at > CURRENT_TIMESTAMP(3)) OR (status = 'cancelled' AND google_event_id IS NOT NULL))
      AND calendar_attempts < 30 ORDER BY start_at LIMIT 5`)).map(mapBooking);
    for (const b of due) {
      await db.q('UPDATE appt_bookings SET calendar_attempts = calendar_attempts + 1 WHERE id = ?', [b.id]);
      if (b.status === 'calendar_pending') await syncCreate(db, env, b, settings).catch(() => {});
      else await syncDelete(db, env, b, settings);
    }
  }
  await db.q(`INSERT IGNORE INTO appt_email_outbox (booking_id, kind, to_email, to_name, idem_key)
    SELECT id, 'reminder', client_email, client_name, UUID() FROM appt_bookings
    WHERE status = 'confirmed' AND start_at BETWEEN CURRENT_TIMESTAMP(3) + INTERVAL 1 HOUR AND CURRENT_TIMESTAMP(3) + INTERVAL 24 HOUR
      AND TIMESTAMPDIFF(HOUR, created_at, start_at) > 26`).catch(() => {});
  await processEmails(db, env);
}

// ---------------------------------------------------------------- router
/** handle({ method, url: URL, headers, body (parsed JSON or {}), ip }) → { status, json } | { redirect } */
export async function handle(db, env, req, later = (p) => p.catch(() => {})) {
  const p = req.url.pathname.replace(/\/+$/, '') || '/';
  const need = (m) => { if (req.method !== m) fail(405, 'METHOD_NOT_ALLOWED', `Use ${m}.`); };
  const ok = (json, status = 200) => ({ status, json });
  if (p === '/api/health') {
    let database = true; try { await db.q('SELECT 1'); } catch { database = false; }
    let crypto_ok = true; try { await keys(env); } catch { crypto_ok = false; }
    return ok({ service: 'brilliancy-appointments', revision: REVISION, database, configured: database && crypto_ok && !!env.PUBLIC_SITE_URL,
      google_client: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET), email_enabled: String(env.EMAIL_ENABLED).toLowerCase() === 'true' && !!env.BREVO_API_KEY });
  }
  if (p === '/api/google/callback') { need('GET'); return googleCallback(db, env, req.url); }
  if (p === '/api/public/config') { need('GET'); return ok(await publicConfig(db)); }
  if (p === '/api/public/slots') {
    need('GET');
    const { slots } = await slotsFor(db, env, req.url.searchParams.get('date'), req.url.searchParams.get('service'));
    return ok({ date: req.url.searchParams.get('date'), slots: slots.map(t => ({ start: new Date(t).toISOString(), label: fmtTime(t) })) });
  }
  if (p === '/api/public/bookings') { need('POST'); return ok(await createBooking(db, env, req.body, req.ip, later), 201); }
  if (p === '/api/public/manage') { need('GET'); const b = await bookingByToken(db, req.url.searchParams.get('token')); return ok({ booking: publicBooking(b, await loadSettings(db)) }); }
  if (p === '/api/public/manage/cancel') { need('POST'); const b = await cancelBooking(db, env, await bookingByToken(db, req.body.token), 'client', null, later); return ok({ booking: publicBooking(b, await loadSettings(db)) }); }
  if (p === '/api/auth/login') { need('POST'); return ok(await login(db, env, req.body, req.ip)); }
  if (p === '/api/auth/setup-status') { need('GET'); const c = await db.one('SELECT COUNT(*) AS n FROM appt_admins'); return ok({ needs_setup: Number(c.n) === 0 }); }
  if (p === '/api/auth/setup') { need('POST'); return ok(await setup(db, env, req.body, req.ip)); }
  if (p === '/api/auth/forgot') { need('POST'); return ok(await forgotPassword(db, env, req.body, req.ip)); }
  if (p === '/api/auth/reset') { need('POST'); return ok(await resetPassword(db, env, req.body, req.ip)); }
  if (p === '/api/team/login') { need('POST'); return ok(await teamLogin(db, env, req.body, req.ip)); }
  if (p.startsWith('/api/team/')) {
    const member = await authTeam(db, env, req.headers.authorization);
    const actor = { type: 'team', id: member.id, name: member.full_name };
    const r = p.slice('/api/team/'.length);
    if (r === 'me') return ok({ member });
    if (r === 'bookings') { need('GET'); return ok(await teamBookings(db, req.url)); }
    if (r === 'activity') { need('GET'); return ok(await activityFor(db, req.url.searchParams.get('booking_id'))); }
    if (r === 'update') { need('POST'); return ok(await logActivity(db, actor, req.body)); }
    if (r === 'password') { need('POST'); return ok(await teamPassword(db, member, req.body)); }
    fail(404, 'NOT_FOUND', 'This endpoint does not exist.');
  }
  if (p.startsWith('/api/admin/')) {
    const admin = await authAdmin(db, env, req.headers.authorization);
    const r = p.slice('/api/admin/'.length);
    if (r === 'me') return ok({ admin });
    if (r === 'bookings') { need('GET'); return ok(await adminBookings(db, req.url)); }
    if (r === 'bookings/update') { need('POST'); return ok(await adminUpdateBooking(db, env, admin, req.body, later)); }
    if (r === 'bookings/delete') { need('POST'); return ok(await adminDeleteBooking(db, env, admin, req.body)); }
    if (r === 'activity') { if (req.method === 'GET') return ok(await activityFor(db, req.url.searchParams.get('booking_id'))); need('POST'); return ok(await logActivity(db, { type: 'admin', id: admin.id, name: admin.full_name }, req.body)); }
    if (r === 'team') { need('POST'); return ok(await saveTeamMember(db, admin, req.body)); }
    if (r === 'team/bulk') { need('POST'); return ok(await bulkTeam(db, admin, req.body)); }
    if (r === 'team/reset') { need('POST'); return ok(await resetTeamPassword(db, admin, req.body)); }
    if (r === 'client-history') { need('GET'); return ok(await clientHistory(db, req.url)); }
    if (r === 'referrals') { need('GET'); return ok(await referralReport(db, req.url)); }
    if (r === 'settings') { if (req.method === 'GET') return ok(await adminSettings(db, env)); need('POST'); return ok(await saveSettings(db, admin, req.body)); }
    if (r === 'services') { need('POST'); return ok(await saveService(db, admin, req.body)); }
    if (r === 'referrers') { need('POST'); return ok(await saveReferrer(db, admin, req.body)); }
    if (r === 'referrers/bulk') { need('POST'); return ok(await bulkReferrers(db, admin, req.body)); }
    if (r === 'off-days') { need('POST'); return ok(await saveOffDay(db, admin, req.body)); }
    if (r === 'admins') { need('POST'); return ok(await saveAdmin(db, admin, req.body)); }
    if (r === 'password') { need('POST'); return ok(await changePassword(db, admin, req.body)); }
    if (r === 'google/start') { need('POST'); return ok(await googleStart(env, admin)); }
    if (r === 'google/disconnect') { need('POST'); return ok(await googleDisconnect(db, env, admin)); }
  }
  fail(404, 'NOT_FOUND', 'This endpoint does not exist.');
}

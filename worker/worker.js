// Brilliancy Appointments API. Paste this complete file into the Cloudflare Worker editor.
// Secrets belong in Settings > Variables and Secrets, never in this file.
// Required: SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY (secret), ALLOWED_ORIGINS, PUBLIC_SITE_URL,
//           GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (secret), TOKEN_ENCRYPTION_KEY (secret, 32 random bytes base64).
// Email:    BREVO_API_KEY (secret), BREVO_SENDER_EMAIL, BREVO_SENDER_NAME, EMAIL_ENABLED=true
// Optional: TURNSTILE_SECRET_KEY (secret) to block spam bookings.
// Cron Trigger: * * * * * (every minute) for calendar retries, reminders and emails.

const REVISION = 'appointments-1';
const ZONE = 'Asia/Dhaka';
const OFFSET = '+06:00'; // Bangladesh has no daylight saving time.
const ACTIVE = ['calendar_pending', 'confirmed'];
const MODES = { office: 'In office', meet: 'Google Meet (online)', phone: 'Phone call' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL = /^[^\s@,()"]+@[^\s@,()"]+\.[^\s@,()"]+$/;
const MAX_UPCOMING_PER_CLIENT = 3;
const GOOGLE_SCOPES = 'openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy';

class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new ApiError(status, code, message); };

// ---------------------------------------------------------------- time helpers
const pad = (n) => String(n).padStart(2, '0');
function dhakaDate(ms) { // 'YYYY-MM-DD' in Dhaka for a UTC epoch ms
  const d = new Date(ms + 6 * 3600e3);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
const at = (date, hhmm) => Date.parse(`${date}T${hhmm.slice(0, 5)}:00${OFFSET}`);
const weekday = (date) => new Date(date + 'T00:00:00Z').getUTCDay();
const addDays = (date, n) => dhakaDate(at(date, '00:00') + n * 86400e3);
const fmtWhen = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso));
const fmtTime = (ms) => new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(ms));

/** Pure slot engine. Returns available start times (epoch ms) for one Dhaka date. */
function computeSlots({ date, settings, duration, offDays = [], busy = [], now = Date.now() }) {
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

// ---------------------------------------------------------------- crypto helpers
const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const b64url = (buf) => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => unb64(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
async function sha256(text) { return b64url(await crypto.subtle.digest('SHA-256', enc.encode(text))); }
const keyCache = new Map();
async function keys(env) {
  const raw = env.TOKEN_ENCRYPTION_KEY || '';
  if (keyCache.has(raw)) return keyCache.get(raw);
  let bytes; try { bytes = unb64(raw); } catch { bytes = new Uint8Array(); }
  if (bytes.length !== 32) fail(503, 'SETUP_REQUIRED', 'TOKEN_ENCRYPTION_KEY must be 32 random bytes in base64.');
  const base = await crypto.subtle.importKey('raw', bytes, 'HKDF', false, ['deriveKey']);
  const derive = (info, alg, usages) => crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode(info) }, base, alg, false, usages);
  const k = {
    aes: await derive('appt-token-encryption', { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']),
    hmac: await derive('appt-signing', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign', 'verify']),
  };
  keyCache.set(raw, k);
  return k;
}
async function encrypt(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, (await keys(env)).aes, enc.encode(text));
  return b64(iv) + '.' + b64(ct);
}
async function decrypt(env, value) {
  const [iv, ct] = value.split('.');
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, (await keys(env)).aes, unb64(ct)));
}
async function sign(env, text) { return b64url(await crypto.subtle.sign('HMAC', (await keys(env)).hmac, enc.encode(text))); }
async function verifySig(env, text, sig) {
  try { return await crypto.subtle.verify('HMAC', (await keys(env)).hmac, unb64url(sig), enc.encode(text)); } catch { return false; }
}
// Manage token is derived from the booking's idempotency key so a retried request returns the same link.
const manageToken = (env, idem) => sign(env, 'manage:' + idem);

// ---------------------------------------------------------------- Supabase
function sbUrl(env) {
  if (!/^https:\/\/[a-z0-9]+\.supabase\.co\/?$/.test(env.SUPABASE_URL || '') ||
      !env.SUPABASE_PUBLISHABLE_KEY?.startsWith('sb_publishable_') || !env.SUPABASE_SECRET_KEY?.startsWith('sb_secret_')) {
    fail(503, 'SETUP_REQUIRED', 'The appointment service needs its Supabase settings.');
  }
  return env.SUPABASE_URL.replace(/\/$/, '');
}
async function upstream(url, options = {}, label = 'Supabase') {
  try {
    const r = await fetch(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(12000) });
    if (r.status >= 300 && r.status < 400) { await r.body?.cancel(); fail(503, 'UPSTREAM_REDIRECT', `${label} returned an unexpected redirect.`); }
    return r;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    fail(503, 'SERVICE_UNAVAILABLE', `Could not reach ${label}. Try again shortly.`);
  }
}
async function db(env, path, { method = 'GET', body, prefer } = {}) {
  const headers = { apikey: env.SUPABASE_SECRET_KEY, Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (prefer) headers.Prefer = prefer;
  const r = await upstream(sbUrl(env) + '/rest/v1/' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) {
    if (data?.code === '23P01') fail(409, 'SLOT_TAKEN', 'Sorry, that time was just booked. Please choose another time.');
    if (data?.code === '23505') fail(409, 'DUPLICATE', 'This record already exists.');
    if (['23514', '22P02', '22007', '22008', '23502'].includes(data?.code)) fail(400, 'INVALID_INPUT', 'Check the form values and try again.');
    if (['PGRST202', 'PGRST205', '42P01', '42883'].includes(data?.code) || r.status === 401 || r.status === 403) {
      fail(503, 'SETUP_REQUIRED', 'The appointment database setup is incomplete. Run supabase/migrations/001_appointments.sql.');
    }
    fail(503, 'DATABASE_ERROR', 'The appointment database returned an error. Try again shortly.');
  }
  return data;
}
const rpc = (env, name, args = {}) => db(env, 'rpc/' + name, { method: 'POST', body: args });
const q = encodeURIComponent;

async function loadSettings(env) {
  const [s] = await db(env, 'appt_settings?id=eq.1&select=*');
  if (!s) fail(503, 'SETUP_REQUIRED', 'Settings row missing. Rerun the setup SQL.');
  return s;
}
const activeReferrers = (env) => db(env, 'appt_referrers?active=is.true&select=code,full_name,email,notify&order=full_name');
const futureOffDays = (env, from) => db(env, `appt_off_days?to_date=gte.${from}&select=id,from_date,to_date,reason&order=from_date`);
async function dbBusy(env, fromMs, toMs, exceptId) {
  const rows = await db(env, `appt_bookings?select=id,start_at,end_at&status=in.(${ACTIVE.join(',')})&start_at=lt.${q(new Date(toMs).toISOString())}&end_at=gt.${q(new Date(fromMs).toISOString())}`);
  return rows.filter(r => r.id !== exceptId).map(r => ({ start: r.start_at, end: r.end_at }));
}

// ---------------------------------------------------------------- Google Calendar
let tokenCache = null; // { enc, token, exp }
async function googleRow(env) { const [g] = await db(env, 'appt_google?id=eq.1&select=*'); return g || {}; }
async function googleAccessToken(env) {
  const g = await googleRow(env);
  if (!g.refresh_token_enc) return null;
  if (tokenCache && tokenCache.enc === g.refresh_token_enc && tokenCache.exp > Date.now() + 60e3) return tokenCache.token;
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) fail(503, 'SETUP_REQUIRED', 'Google OAuth client is not configured on the Worker.');
  const refresh = await decrypt(env, g.refresh_token_enc);
  const r = await upstream('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: refresh, grant_type: 'refresh_token' }),
  }, 'Google');
  const data = await r.json().catch(() => ({}));
  if (data.error === 'invalid_grant') {
    // Revoked/expired: stop using it and tell admins to reconnect. Bookings continue as "calendar pending".
    await db(env, 'appt_google?id=eq.1', { method: 'PATCH', body: { refresh_token_enc: null, last_error: 'Google access was revoked or expired. Reconnect the office calendar in Admin → Settings.' } });
    tokenCache = null;
    return null;
  }
  if (!r.ok || !data.access_token) fail(503, 'CALENDAR_UNAVAILABLE', 'Google Calendar is temporarily unavailable. Please try again in a minute.');
  tokenCache = { enc: g.refresh_token_enc, token: data.access_token, exp: Date.now() + (data.expires_in || 3000) * 1000 };
  return data.access_token;
}
async function gcal(token, path, { method = 'GET', body } = {}) {
  const r = await upstream('https://www.googleapis.com/calendar/v3/' + path, {
    method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  }, 'Google Calendar');
  const data = r.status === 204 ? null : await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, data };
}
/** Busy ranges from the office Google Calendar, or null when no calendar is connected. Throws if Google fails. */
async function googleBusy(env, settings, fromMs, toMs) {
  const token = await googleAccessToken(env);
  if (!token) return null;
  const { ok, data } = await gcal(token, 'freeBusy', { method: 'POST', body: {
    timeMin: new Date(fromMs).toISOString(), timeMax: new Date(toMs).toISOString(), timeZone: ZONE, items: [{ id: settings.calendar_id }],
  } });
  const cal = data?.calendars?.[settings.calendar_id];
  if (!ok || !cal || cal.errors?.length) fail(503, 'CALENDAR_UNAVAILABLE', 'Could not check the office calendar. Please try again in a minute.');
  return cal.busy || [];
}
const eventId = (bookingId) => 'bk' + bookingId.replace(/-/g, ''); // base32hex-safe, deterministic → no duplicates on retry
function eventBody(b, settings, referrer) {
  const lines = [
    `Service: ${b.service_name}`, `Meeting: ${MODES[b.mode]}`, '',
    `Client: ${b.client_name}`, `Phone: ${b.client_phone}`, `Email: ${b.client_email}`,
    b.client_institution ? `Institution: ${b.client_institution}` : null,
    `Referred by: ${referrer}`, b.client_note ? `\nClient note:\n${b.client_note}` : null,
    '', `Booking ID: ${b.id}`, 'Booked via Brilliancy Appointments',
  ].filter(v => v !== null);
  const body = {
    id: eventId(b.id),
    summary: `${b.service_name} — ${b.client_name}`,
    description: lines.join('\n'),
    start: { dateTime: b.start_at, timeZone: ZONE }, end: { dateTime: b.end_at, timeZone: ZONE },
    attendees: [{ email: b.client_email, displayName: b.client_name }],
    location: b.mode === 'office' ? settings.office_address : b.mode === 'phone' ? `Phone call: ${b.client_phone}` : undefined,
    extendedProperties: { private: { bookingId: b.id } },
    reminders: { useDefault: true },
  };
  if (b.mode === 'meet') body.conferenceData = { createRequest: { requestId: b.id, conferenceSolutionKey: { type: 'hangoutsMeet' } } };
  return body;
}
async function referrerLabel(env, b) {
  if (b.referrer_source === 'other') return `Other: ${b.referrer_other}`;
  if (!b.referrer_code) return 'No referrer';
  const [e] = await db(env, `appt_referrers?code=eq.${q(b.referrer_code)}&select=full_name,code`);
  return e ? `${e.full_name} (${e.code})` : b.referrer_code;
}
/** Create the Google event for a booking. Returns true when the booking is confirmed on the calendar. */
async function syncCreate(env, b, settings) {
  let token;
  try { token = await googleAccessToken(env); } catch (e) { await noteCalendarError(env, b.id, e.message); return false; }
  if (!token) { await noteCalendarError(env, b.id, 'Office Google Calendar is not connected.'); return false; }
  const path = `calendars/${q(settings.calendar_id)}/events`;
  let res = await gcal(token, `${path}?sendUpdates=all&conferenceDataVersion=1`, { method: 'POST', body: eventBody(b, settings, await referrerLabel(env, b)) });
  if (res.status === 409) res = await gcal(token, `${path}/${eventId(b.id)}`); // already created by an earlier attempt
  if (!res.ok || !res.data?.id) {
    await noteCalendarError(env, b.id, `Google Calendar HTTP ${res.status}: ${res.data?.error?.message || 'unknown error'}`);
    return false;
  }
  await db(env, `appt_bookings?id=eq.${b.id}&status=eq.calendar_pending`, { method: 'PATCH', body: {
    status: 'confirmed', google_event_id: res.data.id, meet_link: res.data.hangoutLink || null, calendar_error: null, updated_at: new Date().toISOString(),
  } });
  await db(env, 'appt_google?id=eq.1', { method: 'PATCH', body: { last_ok_at: new Date().toISOString(), last_error: null } });
  return true;
}
async function syncDelete(env, b, settings) {
  try {
    const token = await googleAccessToken(env);
    if (!token) return false;
    const res = await gcal(token, `calendars/${q(settings.calendar_id)}/events/${q(b.google_event_id)}?sendUpdates=all`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404 && res.status !== 410) { await noteCalendarError(env, b.id, `Google delete HTTP ${res.status}`); return false; }
    await db(env, `appt_bookings?id=eq.${b.id}`, { method: 'PATCH', body: { google_event_id: null, calendar_error: null } });
    return true;
  } catch (e) { await noteCalendarError(env, b.id, e.message).catch(() => {}); return false; }
}
const noteCalendarError = (env, id, msg) => db(env, `appt_bookings?id=eq.${id}`, { method: 'PATCH', body: { calendar_error: String(msg).slice(0, 500) } });

// ---------------------------------------------------------------- email (Brevo)
function emailContent(kind, b, settings, env, forAdmin = false) {
  const site = (env.PUBLIC_SITE_URL || '').replace(/\/$/, '');
  const when = fmtWhen(b.start_at) + ' (Bangladesh time)';
  const where = b.mode === 'office' ? `Venue: Brilliancy Research, ${settings.office_address}`
    : b.mode === 'meet' ? (b.meet_link ? `Google Meet: ${b.meet_link}` : 'Google Meet: the link is in your Google Calendar invitation.')
    : `Phone call: we will call you on ${b.client_phone}.`;
  const manage = b._manage ? `\nView or cancel your appointment:\n${site}/manage?token=${b._manage}\n` : '';
  if (kind === 'confirmation') return { subject: `Appointment confirmed: ${fmtWhen(b.start_at)}`, text:
    `Dear ${b.client_name},\n\nYour appointment with Brilliancy Research is confirmed.\n\nService: ${b.service_name}\nDate & time: ${when}\nDuration: ${b.duration_min} minutes\n${where}\n${manage}\nIf you need to change the time, cancel using the link above and book a new slot.\n\nBrilliancy Research\n${settings.office_address}` };
  if (kind === 'reminder') return { subject: `Reminder: your appointment on ${fmtWhen(b.start_at)}`, text:
    `Dear ${b.client_name},\n\nThis is a reminder of your appointment with Brilliancy Research.\n\nService: ${b.service_name}\nDate & time: ${when}\n${where}\n${manage}\nBrilliancy Research` };
  if (kind === 'cancellation' && forAdmin) return { subject: `Cancelled by client: ${b.client_name} — ${fmtWhen(b.start_at)}`, text:
    `The client cancelled this appointment. The slot is free again.\n\nService: ${b.service_name}\nWhen: ${when}\nClient: ${b.client_name}\nPhone: ${b.client_phone}\nEmail: ${b.client_email}\n\nAdmin: ${site}/admin` };
  if (kind === 'cancellation') return { subject: `Appointment cancelled: ${fmtWhen(b.start_at)}`, text:
    `Dear ${b.client_name},\n\nYour appointment (${b.service_name}, ${when}) has been cancelled.\nYou can book a new time at ${site}/\n\nBrilliancy Research` };
  if (kind === 'referrer_alert') return { subject: `Your referral booked: ${b.client_name} — ${fmtWhen(b.start_at)}`, text:
    `Hello,\n\nA client you referred has booked an appointment with Brilliancy Research.\n\nClient: ${b.client_name}\nService: ${b.service_name}\nWhen: ${when}\nMeeting: ${MODES[b.mode]}\n\nThank you for the referral.\nBrilliancy Research` };
  return { subject: `New appointment: ${b.client_name} — ${fmtWhen(b.start_at)}`, text:
    `New booking\n\nService: ${b.service_name}\nWhen: ${when}\nMeeting: ${MODES[b.mode]}\nClient: ${b.client_name}\nPhone: ${b.client_phone}\nEmail: ${b.client_email}\nInstitution: ${b.client_institution || '-'}\nReferred by: ${b._referrer}\nNote: ${b.client_note || '-'}\nCalendar: ${b.status === 'confirmed' ? 'added to Google Calendar' : 'pending (will retry automatically)'}\n\nAdmin: ${site}/admin` };
}
function queueEmails(env, list) {
  return db(env, 'appt_email_outbox?on_conflict=booking_id,kind,to_email', { method: 'POST', body: list, prefer: 'resolution=ignore-duplicates,return=minimal' });
}
async function processEmails(env) {
  if (String(env.EMAIL_ENABLED).toLowerCase() !== 'true' || !env.BREVO_API_KEY || !EMAIL.test(env.BREVO_SENDER_EMAIL || '')) return 0;
  const jobs = await rpc(env, 'appt_claim_emails', { p_limit: 10 });
  if (!jobs.length) return 0;
  const settings = await loadSettings(env);
  let sent = 0;
  for (const job of jobs) {
    let status = 'failed', error = null;
    try {
      const [b] = await db(env, `appt_bookings?id=eq.${job.booking_id}&select=*`);
      const stillActive = b && (ACTIVE.includes(b.status) || job.kind === 'cancellation');
      if (!stillActive || (job.kind === 'reminder' && Date.parse(b.start_at) < Date.now())) {
        status = 'skipped'; error = 'Booking no longer active.';
      } else {
        b._manage = await manageToken(env, b.idempotency_key);
        b._referrer = await referrerLabel(env, b);
        const c = emailContent(job.kind, b, settings, env, job.to_email !== b.client_email);
        const res = await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
          headers: { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ sender: { name: env.BREVO_SENDER_NAME || 'Brilliancy Research', email: env.BREVO_SENDER_EMAIL },
            to: [{ email: job.to_email, name: job.to_name || undefined }], subject: c.subject, textContent: c.text,
            replyTo: job.kind === 'admin_alert' ? { email: b.client_email, name: b.client_name } : { email: settings.notify_email },
            headers: { idempotencyKey: job.idem_key } }),
        });
        const result = await res.json().catch(() => null);
        if (res.ok) { status = 'accepted'; sent++; }
        else if (result?.code === 'duplicate_parameter') { status = 'accepted'; error = 'Previously accepted by Brevo.'; }
        else { status = res.status === 429 || res.status >= 500 ? 'pending' : 'failed'; error = `Brevo HTTP ${res.status}: ${result?.message || ''}`.slice(0, 300); }
      }
    } catch (e) { status = 'pending'; error = 'Brevo unavailable: ' + String(e.message || e).slice(0, 200); }
    if (status === 'pending' && job.attempts >= 5) status = 'needs_review';
    await db(env, `appt_email_outbox?id=eq.${job.id}`, { method: 'PATCH', body: {
      status, last_error: error, lease_until: null, not_before: new Date(Date.now() + 60e3 * job.attempts).toISOString(),
    } }).catch(() => {});
  }
  return sent;
}

// ---------------------------------------------------------------- request helpers
async function readJson(request, limit = 16384) {
  const text = await request.text();
  if (text.length > limit) fail(413, 'TOO_LARGE', 'Request is too large.');
  try { const v = JSON.parse(text || '{}'); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch {}
  fail(400, 'INVALID_JSON', 'Invalid request.');
}
const str = (v, max, { min = 0, name = 'field' } = {}) => {
  const s = typeof v === 'string' ? v.trim() : v == null ? '' : fail(400, 'INVALID_INPUT', `Check ${name}.`);
  if (s.length < min || s.length > max) fail(400, 'INVALID_INPUT', `Check ${name}.`);
  return s;
};
async function verifyTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET_KEY) return;
  if (typeof token !== 'string' || !token) fail(400, 'CAPTCHA_REQUIRED', 'Please complete the security check.');
  const r = await upstream('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST', body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token, remoteip: ip || '' }),
  }, 'Turnstile');
  if (!(await r.json().catch(() => ({}))).success) fail(400, 'CAPTCHA_FAILED', 'Security check failed. Please try again.');
}
async function authAdmin(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!/^Bearer [A-Za-z0-9._-]+$/.test(auth)) fail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
  const r = await upstream(sbUrl(env) + '/auth/v1/user', { headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, Authorization: auth } });
  if (r.status === 401 || r.status === 403) fail(401, 'SESSION_EXPIRED', 'Your session has expired. Please sign in again.');
  if (!r.ok) fail(503, 'AUTH_UNAVAILABLE', 'Could not verify your account. Try again shortly.');
  const user = await r.json();
  if (!UUID.test(user.id || '')) fail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
  const admin = await rpc(env, 'appt_admin_for_user', { p_auth_user_id: user.id });
  if (!admin?.id) fail(403, 'ADMIN_REQUIRED', 'An active administrator account is required.');
  return admin;
}
const audit = (env, actor, action, booking_id, detail = {}) =>
  db(env, 'appt_audit', { method: 'POST', body: { actor_employee_id: actor, action, booking_id, detail }, prefer: 'return=minimal' }).catch(() => {});
function publicBooking(b, settings) {
  return {
    id: b.id, service_name: b.service_name, duration_min: b.duration_min, mode: b.mode, mode_label: MODES[b.mode],
    start_at: b.start_at, end_at: b.end_at, when_label: fmtWhen(b.start_at),
    status: b.status === 'calendar_pending' ? 'confirmed' : b.status, // clients see "confirmed" either way
    client_name: b.client_name, meet_link: b.meet_link, office_address: settings.office_address,
    can_cancel: ACTIVE.includes(b.status) && Date.parse(b.start_at) > Date.now(),
  };
}

// ---------------------------------------------------------------- public routes
async function publicConfig(env) {
  const [settings, services, referrers, google] = await Promise.all([
    loadSettings(env), db(env, 'appt_services?active=is.true&select=id,name,description,duration_min&order=sort_order,name'),
    activeReferrers(env), googleRow(env),
  ]);
  const today = dhakaDate(Date.now());
  return {
    today, timezone: ZONE,
    settings: { open_time: settings.open_time.slice(0, 5), close_time: settings.close_time.slice(0, 5), working_days: settings.working_days,
      slot_step_min: settings.slot_step_min, min_notice_min: settings.min_notice_min, max_days_ahead: settings.max_days_ahead,
      modes: settings.modes, office_address: settings.office_address },
    services, referrers: referrers.map(r => ({ code: r.code, name: r.full_name })),
    off_days: await futureOffDays(env, today), calendar_connected: !!google.refresh_token_enc,
  };
}
async function slotsFor(env, date, serviceId) {
  if (!DATE.test(date || '')) fail(400, 'INVALID_INPUT', 'Choose a valid date.');
  if (!UUID.test(serviceId || '')) fail(400, 'INVALID_INPUT', 'Choose a service.');
  const [settings, [service], offDays] = await Promise.all([
    loadSettings(env), db(env, `appt_services?id=eq.${serviceId}&active=is.true&select=*`), futureOffDays(env, date),
  ]);
  if (!service) fail(404, 'SERVICE_NOT_FOUND', 'This service is not available.');
  const from = at(date, '00:00'), to = from + 86400e3;
  const base = { date, settings, duration: service.duration_min, offDays };
  if (!computeSlots({ ...base, busy: [] }).length) return { settings, service, slots: [] };
  const [mine, google] = await Promise.all([dbBusy(env, from, to), googleBusy(env, settings, from, to)]);
  const slots = computeSlots({ ...base, busy: [...mine, ...(google || [])] });
  return { settings, service, slots, calendarChecked: google !== null };
}
async function createBooking(request, env, ctx) {
  const body = await readJson(request);
  await verifyTurnstile(env, body.turnstile_token, request.headers.get('CF-Connecting-IP'));
  if (!UUID.test(body.idempotency_key || '')) fail(400, 'INVALID_INPUT', 'Refresh the page and try again.');
  const idem = body.idempotency_key.toLowerCase();
  // A retried request (e.g. network drop) returns the original booking instead of failing.
  const [existing] = await db(env, `appt_bookings?idempotency_key=eq.${idem}&select=*`);
  if (existing) return { booking: publicBooking(existing, await loadSettings(env)), manage_token: await manageToken(env, idem) };

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

  // Referrer: employee code (from link or dropdown), "other" with a typed name, or none.
  let referrer = null, referrer_code = null, referrer_source = 'none', referrer_other = '';
  if (body.referrer_source === 'other') { referrer_source = 'other'; referrer_other = str(body.referrer_other, 120, { min: 2, name: 'referrer name' }); }
  else if (body.referrer_code) {
    referrer = (await activeReferrers(env)).find(x => x.code.toLowerCase() === String(body.referrer_code).toLowerCase());
    if (!referrer) fail(400, 'INVALID_INPUT', 'The selected referring employee was not found. Choose again.');
    referrer_code = referrer.code; referrer_source = body.referrer_source === 'link' ? 'link' : 'dropdown';
  }

  // Re-check that the slot is free right now: database + office Google Calendar.
  const date = dhakaDate(start);
  const { settings, service, slots } = await slotsFor(env, date, body.service_id);
  if (!settings.modes.includes(body.mode)) fail(400, 'INVALID_INPUT', 'This meeting type is not offered.');
  if (!slots.includes(start)) fail(409, 'SLOT_TAKEN', 'Sorry, that time is no longer available. Please choose another time.');

  const nowIso = new Date().toISOString();
  const upcoming = await db(env, `appt_bookings?select=id&status=in.(${ACTIVE.join(',')})&start_at=gt.${q(nowIso)}&or=(client_phone.eq.${q('"' + phone + '"')},client_email.eq.${q('"' + email + '"')})`);
  if (upcoming.length >= MAX_UPCOMING_PER_CLIENT) fail(429, 'TOO_MANY_BOOKINGS', `You already have ${upcoming.length} upcoming appointments. Please cancel one or contact us.`);

  const token = await manageToken(env, idem);
  let b;
  try {
    [b] = await db(env, 'appt_bookings', { method: 'POST', prefer: 'return=representation', body: {
      idempotency_key: idem, service_id: service.id, service_name: service.name, duration_min: service.duration_min, mode: body.mode,
      start_at: new Date(start).toISOString(), end_at: new Date(start + service.duration_min * 60e3).toISOString(), status: 'calendar_pending',
      client_name: name, client_phone: phone, client_email: email, client_institution: institution, client_note: note,
      referrer_code, referrer_source, referrer_other, manage_token_hash: await sha256(token),
    } });
  } catch (e) {
    if (e.code === 'DUPLICATE') { // concurrent retry with the same key
      const [again] = await db(env, `appt_bookings?idempotency_key=eq.${idem}&select=*`);
      if (again) return { booking: publicBooking(again, settings), manage_token: token };
    }
    throw e;
  }
  if (await syncCreate(env, b, settings).catch(() => false)) [b] = await db(env, `appt_bookings?id=eq.${b.id}&select=*`);
  await queueEmails(env, [
    { booking_id: b.id, kind: 'confirmation', to_email: email, to_name: name },
    { booking_id: b.id, kind: 'admin_alert', to_email: settings.notify_email, to_name: 'Brilliancy Research' },
    ...(referrer?.email && referrer.notify ? [{ booking_id: b.id, kind: 'referrer_alert', to_email: referrer.email, to_name: referrer.full_name }] : []),
  ]).catch(() => {});
  ctx.waitUntil(processEmails(env).catch(() => {}));
  return { booking: publicBooking(b, settings), manage_token: token };
}
async function bookingByToken(env, token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) fail(404, 'NOT_FOUND', 'This booking link is invalid.');
  const [b] = await db(env, `appt_bookings?manage_token_hash=eq.${q(await sha256(token))}&select=*`);
  if (!b) fail(404, 'NOT_FOUND', 'This booking link is invalid or the booking was removed.');
  return b;
}
async function cancelBooking(env, ctx, b, by, actorId) {
  if (!ACTIVE.includes(b.status)) fail(409, 'NOT_ACTIVE', 'This appointment is already closed.');
  if (by === 'client' && Date.parse(b.start_at) <= Date.now()) fail(409, 'ALREADY_STARTED', 'This appointment has already started. Please contact us.');
  const [updated] = await db(env, `appt_bookings?id=eq.${b.id}&status=in.(${ACTIVE.join(',')})`, { method: 'PATCH', prefer: 'return=representation', body: {
    status: 'cancelled', cancelled_at: new Date().toISOString(), cancelled_by: by, updated_at: new Date().toISOString(),
  } });
  if (!updated) fail(409, 'NOT_ACTIVE', 'This appointment was already changed. Refresh.');
  const settings = await loadSettings(env);
  if (updated.google_event_id) await syncDelete(env, updated, settings); // on failure the Cron retries
  await queueEmails(env, [
    { booking_id: b.id, kind: 'cancellation', to_email: b.client_email, to_name: b.client_name },
    ...(by === 'client' ? [{ booking_id: b.id, kind: 'cancellation', to_email: settings.notify_email, to_name: 'Brilliancy Research' }] : []),
  ]).catch(() => {});
  await audit(env, actorId || null, 'cancel', b.id, { by });
  ctx.waitUntil(processEmails(env).catch(() => {}));
  return updated;
}

// ---------------------------------------------------------------- admin routes
async function usernameLogin(request, env) {
  const body = await readJson(request);
  const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
  if (!username || username.length > 200 || typeof body.password !== 'string' || !body.password || body.password.length > 256) fail(400, 'INVALID_LOGIN', 'Enter your email address and password.');
  if (!EMAIL.test(username)) fail(400, 'INVALID_LOGIN', 'Enter your email address and password.');
  const identity = { email: username };
  const r = await upstream(sbUrl(env) + '/auth/v1/token?grant_type=password', {
    method: 'POST', headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: identity.email || 'unassigned@appointments.example.invalid', password: body.password }),
  });
  const session = await r.json().catch(() => null);
  if (r.status === 429) fail(429, 'LOGIN_RATE_LIMIT', 'Too many sign-in attempts. Please wait and try again.');
  if (r.status >= 500) fail(503, 'AUTH_UNAVAILABLE', 'Sign-in is temporarily unavailable.');
  if (!r.ok || !identity.email || !session?.access_token) fail(401, 'INVALID_CREDENTIALS', 'Invalid email or password.');
  return { access_token: session.access_token, refresh_token: session.refresh_token };
}
function dateRange(url) {
  const from = url.searchParams.get('from'), to = url.searchParams.get('to');
  if (!DATE.test(from || '') || !DATE.test(to || '') || to < from) fail(400, 'INVALID_INPUT', 'Choose a valid date range.');
  if (at(to, '00:00') - at(from, '00:00') > 400 * 86400e3) fail(400, 'INVALID_INPUT', 'Choose a range of up to 400 days.');
  return { from, to };
}
async function adminBookings(env, url) {
  const { from, to } = dateRange(url);
  let path = `appt_bookings?select=*&start_at=gte.${q(new Date(at(from, '00:00')).toISOString())}&start_at=lt.${q(new Date(at(to, '00:00') + 86400e3).toISOString())}&order=start_at&limit=2000`;
  const status = url.searchParams.get('status');
  if (status && ['calendar_pending', 'confirmed', 'completed', 'no_show', 'cancelled'].includes(status)) path += `&status=eq.${status}`;
  const [rows, refs] = await Promise.all([db(env, path), db(env, 'appt_referrers?select=code,full_name')]);
  const byCode = Object.fromEntries(refs.map(e => [e.code, e]));
  return { bookings: rows.map(b => ({ ...b, manage_token_hash: undefined, idempotency_key: undefined,
    referrer_label: b.referrer_source === 'other' ? `Other: ${b.referrer_other}` : b.referrer_code ? (byCode[b.referrer_code]?.full_name || b.referrer_code) : '—' })) };
}
async function adminUpdateBooking(request, env, ctx, admin) {
  const body = await readJson(request);
  if (!UUID.test(body.id || '')) fail(400, 'INVALID_INPUT', 'Unknown booking.');
  const [b] = await db(env, `appt_bookings?id=eq.${body.id}&select=*`);
  if (!b) fail(404, 'NOT_FOUND', 'Booking not found.');
  if (body.internal_note !== undefined) {
    await db(env, `appt_bookings?id=eq.${b.id}`, { method: 'PATCH', body: { internal_note: str(body.internal_note, 2000, { name: 'note' }), updated_at: new Date().toISOString() } });
    await audit(env, admin.id, 'note', b.id);
  }
  if (body.status && body.status !== b.status) {
    if (body.status === 'cancelled') await cancelBooking(env, ctx, b, 'admin', admin.id);
    else if (['completed', 'no_show'].includes(body.status) && ['confirmed', 'calendar_pending', 'completed', 'no_show'].includes(b.status)) {
      await db(env, `appt_bookings?id=eq.${b.id}`, { method: 'PATCH', body: { status: body.status, updated_at: new Date().toISOString() } });
      await audit(env, admin.id, 'status', b.id, { from: b.status, to: body.status });
    } else if (body.status === 'retry_calendar' && b.status === 'calendar_pending') {
      await syncCreate(env, b, await loadSettings(env));
    } else fail(409, 'INVALID_TRANSITION', 'That status change is not allowed. Cancelled bookings cannot be reopened; book a new time instead.');
  }
  const [after] = await db(env, `appt_bookings?id=eq.${b.id}&select=*`);
  return { booking: { ...after, manage_token_hash: undefined, idempotency_key: undefined } };
}
async function adminSettings(env, request) {
  const [settings, services, offDays, google, referrers] = await Promise.all([
    loadSettings(env), db(env, 'appt_services?select=*&order=sort_order,name'), futureOffDays(env, addDays(dhakaDate(Date.now()), -30)),
    googleRow(env), db(env, 'appt_referrers?select=code,full_name,designation,email,phone,notify,active&order=full_name'),
  ]);
  return { settings: { ...settings, open_time: settings.open_time.slice(0, 5), close_time: settings.close_time.slice(0, 5) }, services, off_days: offDays,
    google: { connected: !!google.refresh_token_enc, email: google.google_email, connected_at: google.connected_at, last_ok_at: google.last_ok_at, last_error: google.last_error,
      redirect_uri: new URL(request.url).origin + '/api/google/callback' },
    referrers };
}
async function saveSettings(request, env, admin) {
  const b = await readJson(request);
  const days = Array.isArray(b.working_days) ? [...new Set(b.working_days.map(Number))] : [];
  if (!TIME.test(b.open_time || '') || !TIME.test(b.close_time || '') || b.close_time <= b.open_time) fail(400, 'INVALID_INPUT', 'Check opening and closing times.');
  if (!days.length || days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) fail(400, 'INVALID_INPUT', 'Choose at least one working day.');
  const modes = Array.isArray(b.modes) ? [...new Set(b.modes)].filter(m => MODES[m]) : [];
  if (!modes.length) fail(400, 'INVALID_INPUT', 'Choose at least one meeting type.');
  const int = (v, lo, hi, n) => { const x = Number(v); if (!Number.isInteger(x) || x < lo || x > hi) fail(400, 'INVALID_INPUT', `Check ${n}.`); return x; };
  const notify = str(b.notify_email, 200, { name: 'notification email' });
  if (!EMAIL.test(notify)) fail(400, 'INVALID_INPUT', 'Check the notification email.');
  const row = {
    open_time: b.open_time, close_time: b.close_time, working_days: days, modes,
    slot_step_min: int(b.slot_step_min, 5, 240, 'slot step'), min_notice_min: int(b.min_notice_min, 0, 10080, 'minimum notice'),
    max_days_ahead: int(b.max_days_ahead, 1, 180, 'days ahead'), office_address: str(b.office_address, 200, { min: 3, name: 'office address' }),
    calendar_id: str(b.calendar_id || 'primary', 200, { min: 1, name: 'calendar ID' }), notify_email: notify, updated_at: new Date().toISOString(),
  };
  await db(env, 'appt_settings?id=eq.1', { method: 'PATCH', body: row });
  await audit(env, admin.id, 'settings', null, row);
  return { ok: true };
}
async function saveService(request, env, admin) {
  const b = await readJson(request);
  const row = { name: str(b.name, 120, { min: 1, name: 'service name' }), description: str(b.description, 600, { name: 'description' }),
    duration_min: Number(b.duration_min), sort_order: Number.isInteger(Number(b.sort_order)) ? Number(b.sort_order) : 100, active: b.active !== false };
  if (!Number.isInteger(row.duration_min) || row.duration_min < 15 || row.duration_min > 480) fail(400, 'INVALID_INPUT', 'Duration must be 15–480 minutes.');
  if (b.id) { if (!UUID.test(b.id)) fail(400, 'INVALID_INPUT', 'Unknown service.'); await db(env, `appt_services?id=eq.${b.id}`, { method: 'PATCH', body: row }); }
  else await db(env, 'appt_services', { method: 'POST', body: row, prefer: 'return=minimal' });
  await audit(env, admin.id, 'service', null, row);
  return { ok: true };
}
async function saveOffDay(request, env, admin) {
  const b = await readJson(request);
  if (b.delete) { if (!UUID.test(b.id || '')) fail(400, 'INVALID_INPUT', 'Unknown off day.'); await db(env, `appt_off_days?id=eq.${b.id}`, { method: 'DELETE' }); return { ok: true }; }
  if (!DATE.test(b.from || '') || !DATE.test(b.to || '') || b.to < b.from) fail(400, 'INVALID_INPUT', 'Choose a valid date range.');
  await db(env, 'appt_off_days', { method: 'POST', body: { from_date: b.from, to_date: b.to, reason: str(b.reason, 200, { name: 'reason' }) }, prefer: 'return=minimal' });
  await audit(env, admin.id, 'off_day', null, b);
  return { ok: true };
}
async function saveReferrer(request, env, admin) {
  const b = await readJson(request);
  const code = str(b.code, 30, { min: 2, name: 'employee ID' });
  if (!/^[A-Za-z0-9-]{2,30}$/.test(code)) fail(400, 'INVALID_INPUT', 'Employee ID may use letters, numbers and hyphens.');
  const email = str(b.email, 200, { name: 'email' }).toLowerCase();
  if (email && !EMAIL.test(email)) fail(400, 'INVALID_INPUT', 'Check the email address.');
  const row = { code, full_name: str(b.full_name, 120, { min: 1, name: 'name' }), designation: str(b.designation, 120, { name: 'designation' }),
    email: email || null, phone: str(b.phone, 30, { name: 'phone' }), notify: b.notify !== false, active: b.active !== false };
  await db(env, 'appt_referrers?on_conflict=code', { method: 'POST', body: row, prefer: 'resolution=merge-duplicates,return=minimal' });
  await audit(env, admin.id, 'referrer', null, { code, active: row.active });
  return { ok: true };
}
async function googleStart(request, env, admin) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) fail(503, 'SETUP_REQUIRED', 'Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to the Worker first.');
  const payload = b64url(enc.encode(JSON.stringify({ a: admin.id, e: Date.now() + 10 * 60e3, n: crypto.randomUUID() })));
  const state = payload + '.' + await sign(env, 'oauth:' + payload);
  const p = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: new URL(request.url).origin + '/api/google/callback', response_type: 'code',
    scope: GOOGLE_SCOPES, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state });
  return { url: 'https://accounts.google.com/o/oauth2/v2/auth?' + p };
}
async function googleCallback(request, env) {
  const url = new URL(request.url);
  const back = (msg) => Response.redirect(`${(env.PUBLIC_SITE_URL || '').replace(/\/$/, '')}/admin?google=${q(msg)}`, 302);
  if (url.searchParams.get('error')) return back('denied');
  const [payload, sig] = (url.searchParams.get('state') || '').split('.');
  if (!payload || !sig || !(await verifySig(env, 'oauth:' + payload, sig))) return back('invalid_state');
  let st; try { st = JSON.parse(new TextDecoder().decode(unb64url(payload))); } catch { return back('invalid_state'); }
  if (!(st.e > Date.now())) return back('expired');
  const r = await upstream('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: url.searchParams.get('code') || '', client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: url.origin + '/api/google/callback', grant_type: 'authorization_code' }) }, 'Google');
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.refresh_token) return back(t.refresh_token ? 'failed' : 'no_refresh_token');
  const scopes = (t.scope || '').split(' ');
  if (!scopes.some(s => s.endsWith('/calendar.events')) || !scopes.some(s => s.endsWith('/calendar.freebusy'))) return back('missing_permission');
  let email = null;
  try { email = JSON.parse(new TextDecoder().decode(unb64url(t.id_token.split('.')[1]))).email || null; } catch {}
  await db(env, 'appt_google?id=eq.1', { method: 'PATCH', body: { google_email: email, refresh_token_enc: await encrypt(env, t.refresh_token),
    connected_at: new Date().toISOString(), connected_by: st.a, last_error: null } });
  tokenCache = null;
  // Give bookings made while disconnected a fresh set of automatic attempts.
  await db(env, `appt_bookings?status=eq.calendar_pending&end_at=gt.${q(new Date().toISOString())}`, { method: 'PATCH', body: { calendar_attempts: 0 } });
  await audit(env, st.a, 'google_connect', null, { email });
  return back('connected');
}
async function googleDisconnect(env, admin) {
  const g = await googleRow(env);
  if (g.refresh_token_enc) {
    const token = await decrypt(env, g.refresh_token_enc).catch(() => null);
    if (token) await fetch('https://oauth2.googleapis.com/revoke?token=' + q(token), { method: 'POST' }).catch(() => {});
  }
  await db(env, 'appt_google?id=eq.1', { method: 'PATCH', body: { refresh_token_enc: null, last_error: null } });
  tokenCache = null;
  await audit(env, admin.id, 'google_disconnect', null);
  return { ok: true };
}

// ---------------------------------------------------------------- Cron
async function runCron(env) {
  const settings = await loadSettings(env);
  const connected = !!(await googleRow(env)).refresh_token_enc;
  for (const b of connected ? await rpc(env, 'appt_claim_calendar', { p_limit: 5 }) : []) {
    if (b.status === 'calendar_pending') await syncCreate(env, b, settings).catch(() => {});
    else if (b.status === 'cancelled' && b.google_event_id) await syncDelete(env, b, settings);
  }
  await rpc(env, 'appt_queue_reminders').catch(() => {});
  await processEmails(env);
}

// ---------------------------------------------------------------- router
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const allowed = (env.ALLOWED_ORIGINS || 'http://127.0.0.1:5173,http://localhost:5173').split(',').map(s => s.trim()).filter(Boolean);
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin' };
    if (origin && allowed.includes(origin)) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
      headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
      headers['Access-Control-Max-Age'] = '86400';
    }
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers });
    if (request.method === 'OPTIONS') return new Response(null, { status: origin && allowed.includes(origin) ? 204 : 403, headers });
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const method = request.method;
    const need = (m) => { if (method !== m) fail(405, 'METHOD_NOT_ALLOWED', `Use ${m}.`); };
    try {
      if (p === '/' || p === '/api/health') {
        let configured = true; try { sbUrl(env); await keys(env); } catch { configured = false; }
        return json({ service: 'brilliancy-appointments-api', revision: REVISION, configured,
          google_client: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET), email_enabled: String(env.EMAIL_ENABLED).toLowerCase() === 'true', turnstile: !!env.TURNSTILE_SECRET_KEY });
      }
      if (p === '/api/google/callback') { need('GET'); return await googleCallback(request, env); }
      if (p === '/api/public/config') { need('GET'); return json(await publicConfig(env)); }
      if (p === '/api/public/slots') {
        need('GET');
        const { slots } = await slotsFor(env, url.searchParams.get('date'), url.searchParams.get('service'));
        return json({ date: url.searchParams.get('date'), slots: slots.map(t => ({ start: new Date(t).toISOString(), label: fmtTime(t) })) });
      }
      if (p === '/api/public/bookings') { need('POST'); return json(await createBooking(request, env, ctx), 201); }
      if (p === '/api/public/manage') {
        need('GET');
        const b = await bookingByToken(env, url.searchParams.get('token'));
        return json({ booking: publicBooking(b, await loadSettings(env)) });
      }
      if (p === '/api/public/manage/cancel') {
        need('POST');
        const body = await readJson(request);
        const b = await cancelBooking(env, ctx, await bookingByToken(env, body.token), 'client');
        return json({ booking: publicBooking(b, await loadSettings(env)) });
      }
      if (p === '/api/auth/login') { need('POST'); return json(await usernameLogin(request, env)); }
      if (p.startsWith('/api/admin/')) {
        const admin = await authAdmin(request, env);
        const r = p.slice('/api/admin/'.length);
        if (r === 'me') return json({ admin });
        if (r === 'bookings') { need('GET'); return json(await adminBookings(env, url)); }
        if (r === 'bookings/update') { need('POST'); return json(await adminUpdateBooking(request, env, ctx, admin)); }
        if (r === 'referrals') { need('GET'); const { from, to } = dateRange(url); return json({ rows: await rpc(env, 'appt_referral_report', { p_from: from, p_to: to }) }); }
        if (r === 'settings') { if (method === 'GET') return json(await adminSettings(env, request)); need('POST'); return json(await saveSettings(request, env, admin)); }
        if (r === 'services') { need('POST'); return json(await saveService(request, env, admin)); }
        if (r === 'referrers') { need('POST'); return json(await saveReferrer(request, env, admin)); }
        if (r === 'off-days') { need('POST'); return json(await saveOffDay(request, env, admin)); }
        if (r === 'google/start') { need('POST'); return json(await googleStart(request, env, admin)); }
        if (r === 'google/disconnect') { need('POST'); return json(await googleDisconnect(env, admin)); }
      }
      fail(404, 'NOT_FOUND', 'This endpoint does not exist.');
    } catch (e) {
      if (e instanceof ApiError) return json({ error: { code: e.code, message: e.message } }, e.status);
      console.error(e);
      return json({ error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.' } }, 500);
    }
  },
  async scheduled(_event, env, ctx) { ctx.waitUntil(runCron(env).catch(e => console.error('cron', e))); },
  // Exposed for local tests only; Cloudflare ignores this property.
  _test: { computeSlots, dhakaDate, at, eventId, eventBody, encrypt, decrypt, sign, verifySig },
};

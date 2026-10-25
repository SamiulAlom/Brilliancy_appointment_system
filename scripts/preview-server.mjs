// Local preview: serves dist/ on 5173 and a mock API on 8787 (no Supabase, Google or Brevo needed).
// Usage: npm run build && node scripts/preview-server.mjs
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import worker from '../worker/worker.js';
const { computeSlots, dhakaDate, at } = worker._test;

const settings = { open_time: '10:00', close_time: '19:00', working_days: [6, 0, 1, 2, 3, 4], slot_step_min: 30, min_notice_min: 120, max_days_ahead: 30, modes: ['office', 'meet', 'phone'],
  office_address: '201–202 BUET Market, Polashi, Dhaka-1000', calendar_id: 'primary', notify_email: 'brilliancycomms@gmail.com' };
const services = [
  { id: 'a1111111-1111-4111-8111-111111111111', name: 'General consultation', description: 'Discuss your project, timeline and which service fits.', duration_min: 30, sort_order: 10, active: true },
  { id: 'a2222222-2222-4222-8222-222222222222', name: 'Manuscript writing & correction', description: 'Journal manuscript drafting, editing, correction and formatting.', duration_min: 45, sort_order: 20, active: true },
  { id: 'a3333333-3333-4333-8333-333333333333', name: 'Research proposal / systematic review', description: 'Proposal writing, literature review and SLR planning.', duration_min: 45, sort_order: 30, active: true },
  { id: 'a4444444-4444-4444-8444-444444444444', name: 'Thesis & document formatting', description: 'University template, references, tables and figures.', duration_min: 30, sort_order: 40, active: true },
  { id: 'a5555555-5555-4555-8555-555555555555', name: 'CV preparation', description: 'Academic or professional CV.', duration_min: 30, sort_order: 50, active: true },
  { id: 'a6666666-6666-4666-8666-666666666666', name: 'Scholarship application support', description: 'MEXT, DAAD, Erasmus and other applications: SOP, CV, documents.', duration_min: 45, sort_order: 60, active: true },
  { id: 'a7777777-7777-4777-8777-777777777777', name: 'GIS / spatial analysis consultancy', description: 'Mapping, spatial analysis and GIS-based research.', duration_min: 45, sort_order: 70, active: true },
];
const referrers = [['BR21510926', 'Aziz Ahmed', 'Communication'], ['BR21011024', 'Jannatul Ferdous', 'Consultant'], ['BR21440926', 'Munira Sultana', 'Consultant'], ['BR21360826', 'Pinaki Mondal', 'Communication Officer & Consultant - Intern'], ['BR21050126', 'Shib Biswas', 'Consultant']]
  .map(([code, full_name, designation]) => ({ code, full_name, designation, email: 'x@example.com', phone: '017', notify: true, active: true }));
const today = dhakaDate(Date.now());
const bookings = [];
let day = dhakaDate(Date.now() + 86400e3); while (new Date(day + 'T00:00:00Z').getUTCDay() === 5) day = dhakaDate(at(day, '00:00') + 86400e3);
const seed = (d, hh, mins, svc, name, phone, ref, status = 'confirmed') => bookings.push({ id: crypto.randomUUID(), service_name: services[svc].name, duration_min: mins, mode: ['office', 'meet', 'phone'][bookings.length % 3],
  start_at: new Date(at(d, hh)).toISOString(), end_at: new Date(at(d, hh) + mins * 60e3).toISOString(), status, client_name: name, client_phone: phone, client_email: name.toLowerCase().replace(/ /g, '.') + '@example.com',
  client_institution: 'BUET', client_note: 'Need help before the December deadline.', referrer_code: ref, referrer_label: referrers.find(r => r.code === ref)?.full_name || '—', referrer_source: ref ? 'dropdown' : 'none', meet_link: null, calendar_error: null, internal_note: '', created_at: new Date().toISOString() });
seed(day, '11:00', 45, 1, 'Farhana Hoque', '01711000001', 'BR21510926'); seed(day, '14:30', 30, 4, 'Tanvir Islam', '01811000002', 'BR21011024'); seed(day, '16:00', 45, 6, 'Nusrat Jahan', '01911000003', null);
seed(today, '10:30', 30, 0, 'Rakib Hasan', '01611000004', 'BR21510926', 'completed');
const google = { connected: true, email: 'brilliancycomms@gmail.com', connected_at: new Date().toISOString(), last_ok_at: new Date().toISOString(), last_error: null, redirect_uri: 'http://127.0.0.1:8787/api/google/callback' };
const fmtTime = (ms) => new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Dhaka', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(ms));
const fmtWhen = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso));
const pub = (b) => ({ ...b, mode_label: { office: 'In office', meet: 'Google Meet (online)', phone: 'Phone call' }[b.mode], when_label: fmtWhen(b.start_at), office_address: settings.office_address, can_cancel: b.status === 'confirmed' });
const busy = (d) => bookings.filter(b => b.status === 'confirmed' && b.start_at.startsWith(new Date(at(d, '12:00')).toISOString().slice(0, 10)) || (b.status === 'confirmed' && dhakaDate(Date.parse(b.start_at)) === d)).map(b => ({ start: b.start_at, end: b.end_at }));

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': req.headers.origin || '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
  const send = (d, s = 200) => { res.writeHead(s, headers); res.end(JSON.stringify(d)); };
  if (req.method === 'OPTIONS') { res.writeHead(204, headers); return res.end(); }
  let body = ''; for await (const c of req) body += c; body = body ? JSON.parse(body) : {};
  const p = url.pathname;
  if (p.startsWith('/auth/v1/')) return send({ id: 'demo', aud: 'authenticated', role: 'authenticated', email: 'admin@example.com', user_metadata: {}, app_metadata: {}, access_token: 'x', refresh_token: 'demo', expires_in: 3600, token_type: 'bearer', user: { id: 'demo', aud: 'authenticated', role: 'authenticated', email: 'admin@example.com', user_metadata: {}, app_metadata: {} } });
  if (p === '/api/public/config') return send({ today, timezone: 'Asia/Dhaka', settings, services, referrers: referrers.map(r => ({ code: r.code, name: r.full_name })), off_days: [{ id: '1', from_date: dhakaDate(Date.now() + 5 * 86400e3), to_date: dhakaDate(Date.now() + 5 * 86400e3), reason: 'Office holiday' }], calendar_connected: true });
  if (p === '/api/public/slots') { const svc = services.find(s => s.id === url.searchParams.get('service')); const d = url.searchParams.get('date');
    return send({ date: d, slots: computeSlots({ date: d, settings, duration: svc.duration_min, busy: busy(d) }).map(t => ({ start: new Date(t).toISOString(), label: fmtTime(t) })) }); }
  if (p === '/api/public/bookings') {
    const svc = services.find(s => s.id === body.service_id); const start = Date.parse(body.start);
    if (bookings.some(b => b.status === 'confirmed' && Date.parse(b.start_at) < start + svc.duration_min * 60e3 && Date.parse(b.end_at) > start)) return send({ error: { code: 'SLOT_TAKEN', message: 'Sorry, that time was just booked. Please choose another time.' } }, 409);
    const ref = referrers.find(r => r.code === body.referrer_code);
    const b = { id: crypto.randomUUID(), service_name: svc.name, duration_min: svc.duration_min, mode: body.mode, start_at: new Date(start).toISOString(), end_at: new Date(start + svc.duration_min * 60e3).toISOString(), status: 'confirmed',
      client_name: body.name, client_phone: body.phone, client_email: body.email, client_institution: body.institution, client_note: body.note, referrer_code: ref?.code || null, referrer_label: body.referrer_source === 'other' ? 'Other: ' + body.referrer_other : ref?.full_name || '—',
      referrer_source: body.referrer_source, meet_link: body.mode === 'meet' ? 'https://meet.google.com/abc-defg-hij' : null, calendar_error: null, internal_note: '', created_at: new Date().toISOString(), token: 'tok_' + crypto.randomUUID().replace(/-/g, '') };
    bookings.push(b); return send({ booking: pub(b), manage_token: b.token }, 201);
  }
  if (p === '/api/public/manage') { const b = bookings.find(b => b.token === url.searchParams.get('token')); return b ? send({ booking: pub(b) }) : send({ error: { code: 'NOT_FOUND', message: 'This booking link is invalid.' } }, 404); }
  if (p === '/api/public/manage/cancel') { const b = bookings.find(b => b.token === body.token); b.status = 'cancelled'; return send({ booking: pub(b) }); }
  if (p === '/api/auth/login') { const j = (o) => Buffer.from(JSON.stringify(o)).toString('base64url'); const jwt = `${j({ alg: 'HS256', typ: 'JWT' })}.${j({ sub: 'demo', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 86400 })}.sig`; return send({ access_token: jwt, refresh_token: 'demo' }); }
  if (p === '/api/admin/me') return send({ admin: { id: 'x', full_name: 'Hasanul Banna' } });
  if (p === '/api/admin/bookings') return send({ bookings: bookings.filter(b => b.start_at >= new Date(at(url.searchParams.get('from'), '00:00')).toISOString() && b.start_at < new Date(at(url.searchParams.get('to'), '00:00') + 86400e3).toISOString()) });
  if (p === '/api/admin/bookings/update') { const b = bookings.find(b => b.id === body.id); if (body.status) b.status = body.status; if (body.internal_note !== undefined) b.internal_note = body.internal_note; return send({ booking: b }); }
  if (p === '/api/admin/referrals') { const m = {}; for (const b of bookings) { const k = b.referrer_label; m[k] ||= { referrer_code: b.referrer_code, full_name: b.referrer_label, referrer_label: k === '—' ? 'No referrer' : k, total: 0, upcoming: 0, completed: 0, no_show: 0, cancelled: 0 }; m[k].total++; m[k][b.status === 'confirmed' ? 'upcoming' : b.status]++; } return send({ rows: Object.values(m) }); }
  if (p === '/api/admin/settings') { if (req.method === 'POST') Object.assign(settings, body); return send({ settings, services, off_days: [], google, referrers }); }
  if (p.startsWith('/api/admin/')) return send({ ok: true });
  send({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
}).listen(8787, '127.0.0.1', () => console.log('Mock API on http://127.0.0.1:8787'));

const dist = new URL('../dist/', import.meta.url).pathname;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png' };
createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = join(dist, path);
  if (!existsSync(file) || !extname(file)) file = join(dist, 'index.html');
  res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' }); res.end(readFileSync(file));
}).listen(5173, '127.0.0.1', () => console.log('Site on http://127.0.0.1:5173  (admin: /admin, any username/password)'));

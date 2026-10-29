// Entry point: serves the built website (dist/) and the API from one Node.js process.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { ApiError, createStore, handle, runCron, REVISION } from './app.js';

const env = process.env;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');
const PORT = Number(env.PORT || 3000);
const SERVICES = [
  ['General consultation', 'Discuss your project, timeline and which service fits.', 30, 10],
  ['Manuscript writing & correction', 'Journal manuscript drafting, editing, correction and formatting.', 45, 20],
  ['Research proposal / systematic review', 'Proposal writing, literature review and SLR planning.', 45, 30],
  ['Thesis & document formatting', 'University template, references, tables and figures.', 30, 40],
  ['CV preparation', 'Academic or professional CV.', 30, 50],
  ['Scholarship application support', 'MEXT, DAAD, Erasmus and other applications: SOP, CV, documents.', 45, 60],
  ['GIS / spatial analysis consultancy', 'Mapping, spatial analysis and GIS-based research.', 45, 70],
];

const COLUMNS = [
  ['appt_bookings', 'follow_status', "VARCHAR(20) NOT NULL DEFAULT 'new'"],
  ['appt_bookings', 'follow_up_at', 'DATETIME(3) NULL'],
  ['appt_bookings', 'assigned_to', 'CHAR(36) NULL'],
  ['appt_bookings', 'last_contact_at', 'DATETIME(3) NULL'],
];

export async function openDatabase(url = env.DATABASE_URL) {
  if (!url) throw new Error('DATABASE_URL is not set (mysql://user:password@host:3306/database).');
  const pool = mysql.createPool({ uri: url, timezone: 'Z', connectionLimit: 8, waitForConnections: true, charset: 'utf8mb4' });
  const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  const conn = await pool.getConnection();
  try {
    await conn.query("SET time_zone = '+00:00'");
    for (const sql of schema.split(/;\s*\n/).map(s => s.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean)) await conn.query(sql);
    for (const [table, column, type] of COLUMNS) {   // columns added after the first release
      const [[{ c }]] = await conn.query('SELECT COUNT(*) AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [table, column]);
      if (!Number(c)) await conn.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
    const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM appt_services');
    if (!Number(n)) for (const s of SERVICES) await conn.query('INSERT INTO appt_services (id, name, description, duration_min, sort_order) VALUES (?, ?, ?, ?, ?)', [randomUUID(), ...s]);
  } finally { conn.release(); }
  pool.on('connection', c => c.query("SET time_zone = '+00:00'"));
  return createStore(pool);
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2' };
const SECURITY = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000' };

async function serveStatic(pathname, res) {
  let rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  if (rel.includes('..')) rel = '';
  if (rel === 'privacy') rel = 'privacy.html';
  let file = join(DIST, rel);
  try { if (!(await stat(file)).isFile()) throw 0; } catch { file = join(DIST, 'index.html'); }
  const body = await readFile(file);
  const cache = file.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': cache, ...SECURITY });
  res.end(body);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new ApiError(413, 'TOO_LARGE', 'Request is too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { const v = JSON.parse(text); if (v && typeof v === 'object' && !Array.isArray(v)) return resolve(v); } catch {}
      reject(new ApiError(400, 'INVALID_JSON', 'Invalid request.'));
    });
    req.on('error', reject);
  });
}

export function createApp(db, appEnv = env) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
      return serveStatic(url.pathname, res).catch(() => { res.writeHead(500); res.end('Server error'); });
    }
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY };
    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      // EasyPanel's proxy (Traefik) sets X-Forwarded-For; the first entry is the visitor.
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      const out = await handle(db, appEnv, { method: req.method, url, headers: req.headers, body, ip });
      if (out.redirect) { res.writeHead(302, { Location: out.redirect, ...SECURITY }); return res.end(); }
      res.writeHead(out.status, headers); res.end(JSON.stringify(out.json));
    } catch (e) {
      if (e instanceof ApiError) { res.writeHead(e.status, headers); return res.end(JSON.stringify({ error: { code: e.code, message: e.message } })); }
      console.error(new Date().toISOString(), req.method, url.pathname, e);
      const dbDown = /ECONNREFUSED|PROTOCOL_CONNECTION_LOST|ER_ACCESS_DENIED/.test(String(e.code || e.message));
      res.writeHead(dbDown ? 503 : 500, headers);
      res.end(JSON.stringify({ error: { code: dbDown ? 'DATABASE_UNAVAILABLE' : 'INTERNAL', message: dbDown ? 'The booking database is unavailable. Please try again shortly.' : 'Something went wrong. Please try again.' } }));
    }
  });
}

// Start when run directly (node server/index.js).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let db;
  for (let i = 1; ; i++) {   // the database container may still be starting
    try { db = await openDatabase(); break; }
    catch (e) { console.error(`Database not ready (attempt ${i}): ${e.message}`); if (i >= 30) process.exit(1); await new Promise(r => setTimeout(r, 3000)); }
  }
  createApp(db).listen(PORT, () => console.log(`Brilliancy Appointments ${REVISION} listening on :${PORT}`));
  let busy = false;
  setInterval(async () => {
    if (busy) return; busy = true;
    try { await runCron(db, env); } catch (e) { console.error('cron', e.message); } finally { busy = false; }
  }, 60e3);
}

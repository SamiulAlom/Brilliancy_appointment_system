// Runs the migration on an isolated in-memory Postgres (PGlite) with stub attendance tables.
import { PGlite } from '@electric-sql/pglite';
import { existsSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const db = new PGlite();
await db.exec(`
  create schema auth; create table auth.users (id uuid primary key, email text);
  create role anon; create role authenticated; create role service_role;
  insert into auth.users (id, email) values ('10000000-0000-4000-8000-000000000002','admin@example.com'), ('10000000-0000-4000-8000-000000000003','old@example.com');
`);
const sql = readFileSync(new URL('../supabase/migrations/001_appointments.sql', import.meta.url), 'utf8');
await db.exec(sql);
await db.exec(sql); // must be safe to rerun
// The real staff list is private (gitignored); fall back to a sample when it is absent.
const seedUrl = new URL('../supabase/private/002_seed_referrers.sql', import.meta.url);
const seed = existsSync(seedUrl) ? readFileSync(seedUrl, 'utf8')
  : `insert into public.appt_referrers (code, full_name, email) select 'BR' || (21510926 + g), 'Sample ' || g, 's' || g || '@example.com' from generate_series(0, 18) g
     on conflict do nothing; update public.appt_referrers set full_name = 'Aziz Ahmed' where code = 'BR21510926';`;
await db.exec(seed); await db.exec(seed);
let passed = 0; const ok = (name) => { passed++; console.log('  ✓', name); };

const services = (await db.query('select * from public.appt_services')).rows;
assert.equal(services.length, 7); ok('seeds 7 services once (rerun-safe)');

const refs = (await db.query('select * from public.appt_referrers where active')).rows;
assert.equal(refs.length, 19); assert.ok(refs.every(r => /^BR\d+$/.test(r.code) && r.email)); ok('19 referrers seeded with IDs and emails (rerun-safe)');

await db.exec(`insert into public.appt_admins (auth_user_id, full_name) select id, 'Admin User' from auth.users where email='admin@example.com' on conflict do nothing;
  insert into public.appt_admins (auth_user_id, full_name, active) select id, 'Old Admin', false from auth.users where email='old@example.com' on conflict do nothing;`);
const inactive = (await db.query(`select public.appt_admin_for_user('10000000-0000-4000-8000-000000000003') as a`)).rows[0].a;
assert.deepEqual(inactive, {});
const admin = (await db.query(`select public.appt_admin_for_user('10000000-0000-4000-8000-000000000002') as a`)).rows[0].a;
assert.equal(admin.full_name, 'Admin User');
const notAdmin = (await db.query(`select public.appt_admin_for_user('10000000-0000-4000-8000-000000000009') as a`)).rows[0].a;
assert.deepEqual(notAdmin, {}); ok('admin lookup');

const insert = (start, end, extra = {}) => db.query(
  `insert into public.appt_bookings (idempotency_key, service_name, duration_min, mode, start_at, end_at, status,
     client_name, client_phone, client_email, manage_token_hash, referrer_code, referrer_source, referrer_other)
   values (gen_random_uuid(), 'General consultation', 30, 'office', $1, $2, $3, 'Test Client', '01711111111',
     'client@example.com', gen_random_uuid()::text, $4, $5, $6) returning id`,
  [start, end, extra.status || 'confirmed', extra.ref || null, extra.source || 'none', extra.other || '']);

const b1 = (await insert('2030-01-05T04:00:00Z', '2030-01-05T04:30:00Z', { ref: 'BR21510926', source: 'link' })).rows[0].id;
await assert.rejects(insert('2030-01-05T04:15:00Z', '2030-01-05T04:45:00Z'), /appt_bookings_no_overlap|conflict/i);
ok('overlapping active booking is rejected');
await insert('2030-01-05T04:30:00Z', '2030-01-05T05:00:00Z'); ok('back-to-back booking allowed');
await db.query(`update public.appt_bookings set status='cancelled' where id=$1`, [b1]);
await insert('2030-01-05T04:00:00Z', '2030-01-05T04:30:00Z', { status: 'calendar_pending', source: 'other', other: 'Friend' });
ok('cancelled booking frees the slot');
await assert.rejects(insert('2030-01-06T04:00:00Z', '2030-01-06T04:30:00Z', { source: 'other', other: ' ' }));
ok('"Other" referrer requires a name');

const claimed = (await db.query('select * from public.appt_claim_calendar(5)')).rows;
assert.equal(claimed.length, 1); assert.equal(claimed[0].status, 'calendar_pending');
assert.equal((await db.query('select * from public.appt_claim_calendar(5)')).rows.length, 0); ok('calendar retry claim uses a lease');

const bid = claimed[0].id;
await db.query(`insert into public.appt_email_outbox (booking_id, kind, to_email) values ($1,'confirmation','a@b.co')`, [bid]);
await db.query(`insert into public.appt_email_outbox (booking_id, kind, to_email) values ($1,'confirmation','a@b.co') on conflict do nothing`, [bid]);
const mails = (await db.query('select * from public.appt_claim_emails(10)')).rows;
assert.equal(mails.length, 1); assert.equal(mails[0].status, 'sending');
assert.equal((await db.query('select * from public.appt_claim_emails(10)')).rows.length, 0); ok('email claim is single-use under lease');

const report = (await db.query(`select * from public.appt_referral_report('2030-01-01','2030-01-31')`)).rows;
const aziz = report.find(r => r.referrer_code === 'BR21510926');
assert.equal(aziz.full_name, 'Aziz Ahmed'); assert.equal(Number(aziz.cancelled), 1);
assert.ok(report.some(r => r.referrer_label === 'Other: Friend')); ok('referral report groups by referrer');

const n = (await db.query('select public.appt_queue_reminders() as n')).rows[0].n;
assert.equal(n, 0); ok('reminders queue runs (none due in 2030)');

console.log(`Database tests passed: ${passed}`);

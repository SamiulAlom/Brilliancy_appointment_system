# Brilliancy Research — Appointments

**Live:** https://brilliancy-appointments.pages.dev · Admin: https://brilliancy-appointments.pages.dev/admin · API health: https://brilliancy-appointments-api.brilliancyresearchltd2.workers.dev/api/health

Public appointment booking website for clients, with Google Calendar sync, referral tracking and an administrator portal. React + TypeScript + Vite frontend on Cloudflare Pages, a Cloudflare Worker API, and Supabase PostgreSQL (its own project). Sister apps: [attendance](https://github.com/SamiulAlom/Brilliancy_attendance_system), [classroom](https://github.com/SamiulAlom/Brilliancy_classroom).

## What clients get

1. Choose a service (consultation, manuscript, proposal/SLR, formatting, CV, scholarship, GIS) — or **Something else** and type what they need — and how to meet (office at Level 13, Fareast Tower, 35 Topkhana Road, Dhaka 1000; Google Meet; or phone).
2. Pick a day and a time. Only times that are free on the **office Google Calendar** and not already booked are offered. Fridays, office off days, past times and times less than 2 hours away are closed. Hours: 10:00 AM – 7:00 PM, Saturday–Thursday (editable).
3. Enter name, phone, email, institution, a note, and **who referred them** (a dropdown of communication/consultant employees; a referral link `/?ref=EMPLOYEE_ID` fills it in automatically).
4. Booking is confirmed instantly after the server re-checks the slot. The client gets a confirmation email, a Google Calendar invitation (with a Meet link for online meetings), a reminder about 24 hours before, and a private link to view or cancel.

No client account and no payment.

## What the office gets

- Every booking is written to the office Google Calendar with client details and the referrer in the description.
- An email to the office inbox for each new booking and each client cancellation; an email to the referring employee when their referral books.
- **Client analysis** (Admin → Analytics): appointments per day/week, busiest days and hours heatmap, by service, referrer, meeting type, institution and outcome; show-up and cancellation rates, unique and returning clients, typed "Something else" requests; every chart also available as a table.
- **Booking drawer**: one-tap WhatsApp / call / email and the client's full visit history.
- **Admin portal** (`/admin`, email + password admins listed in `appt_admins`): bookings list with search, filters, details drawer, internal notes, mark completed / no-show / cancel, CSV export; referral report per employee with CSV and copyable referral links; settings for hours, working days, slot step, notice, days ahead, meeting types, services, off days, referring employees and the Google Calendar connection.

## Reliability

- Two active bookings can never overlap: a Postgres exclusion constraint enforces it even for simultaneous requests.
- Google free/busy is checked when listing times **and again** at booking time. If Google is unreachable, the booking is saved as *Calendar pending* and the Worker retries every minute; admins see it and can retry manually.
- The Google refresh token is stored encrypted (AES-GCM); only free/busy status is read from the calendar.
- Public requests never touch tables directly. Row Level Security blocks anonymous and authenticated browser access; only the Worker (service role) reads and writes.
- Idempotent booking requests, deterministic Google event IDs and Brevo idempotency keys mean retries never duplicate bookings, events or emails.
- All times are stored in UTC and shown in Asia/Dhaka.

## Project layout

| Path | Purpose |
| --- | --- |
| `src/Booking.tsx` | Public booking page and confirmation |
| `src/Manage.tsx` | Client view/cancel page (`/manage?token=…`) |
| `src/Admin.tsx` | Administrator portal (`/admin`) |
| `worker/worker.js` | Cloudflare Worker API, Google Calendar, Brevo emails, Cron |
| `supabase/migrations/001_appointments.sql` | Database schema, seed services, helper functions |
| `supabase/private/002_seed_referrers.sql` | Staff referrer list with contacts (**private, not committed**) |
| `scripts/test-database.mjs` | Migration tests on an in-memory Postgres |
| `scripts/test-worker.mjs` | Worker tests with mocked Supabase/Google/Brevo |
| `scripts/preview-server.mjs` | Local preview with a mock API (no accounts needed) |

## Local development

```bash
npm install
npm test                          # database + worker tests
npm run build                     # type-check and build dist/
node scripts/preview-server.mjs   # http://127.0.0.1:5173 with a mock API on :8787
```

For the preview, `.env` should point `VITE_API_URL` and `VITE_SUPABASE_URL` at `http://127.0.0.1:8787` (any admin username/password works). For a real deployment follow [SETUP.md](SETUP.md).

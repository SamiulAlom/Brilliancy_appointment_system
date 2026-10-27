# Brilliancy Research — Appointments (version 3)

**Live:** https://appointment.brilliancy-research.com · Admin: https://appointment.brilliancy-research.com/admin · Health: `/api/health`

Client appointment booking for Brilliancy Research, hosted on the company's **Hostinger VPS (EasyPanel)** with a **MySQL** database. One Node.js process serves both the website and the API. No Supabase or Cloudflare.

> Branches: `main` = version 1 (Cloudflare + Supabase), `version-2` = gradient redesign on Cloudflare + Supabase, `version-3` = this Hostinger/MySQL version.

## What clients get

1. Choose a service (consultation, manuscript, proposal/SLR, formatting, CV, scholarship, GIS) or **Something else** and type what they need, and how to meet (office at Level 13, Fareast Tower, 35 Topkhana Road, Dhaka 1000; Google Meet; or phone).
2. Pick a day and time. Only times free on the **office Google Calendar** (brilliancycomms@gmail.com) and not already booked are offered. Fridays, office off days and times less than 2 hours away are closed. Hours 10:00 AM – 7:00 PM, Saturday–Thursday (editable).
3. Enter name, phone, email, institution, a note and **who referred them** (referral links `/?ref=EMPLOYEE_ID` fill it in).
4. Instant confirmation after the server re-checks the slot; confirmation email, Google Calendar invitation (Meet link for online), a reminder ~24 h before, and a private link to view or cancel.

## What the office gets

- Every booking on the office Google Calendar; emails to the office, the client and the referring employee (Brevo, from brilliancycomms@gmail.com).
- **Admin portal** (`/admin`): bookings with search, filters, notes, WhatsApp/call/email shortcuts and client visit history; **Analytics** (appointments over time, busiest days/hours, by service, referrer, meeting type, institution, outcome); **Referrals** report and links; **Settings** for hours, services, off days, referring employees (with spreadsheet bulk import), administrators and the Google Calendar connection.

## How it works

| Part | Where |
| --- | --- |
| `server/index.js` | HTTP server: serves `dist/` and `/api/*`, runs migrations on start, runs the every-minute job (calendar retries, reminders, emails) |
| `server/app.js` | All API logic: slots, bookings, Google Calendar, Brevo, admin auth (scrypt passwords + signed 12-hour sessions) |
| `server/schema.sql` | MySQL 8 / MariaDB schema, applied automatically (idempotent) |
| `src/` | React + Vite website (booking page, manage page, admin portal) |
| `Dockerfile` | What EasyPanel builds and runs |
| `scripts/test-server.mjs` | End-to-end tests against a real MySQL database (Google and Brevo mocked) |

Reliability: a row lock serialises booking writes so two clients can never get the same slot; Google free/busy is checked when listing and again before saving; deterministic Google event IDs and Brevo idempotency keys prevent duplicates on retry; the Google refresh token is stored AES-GCM-encrypted; times are stored in UTC and shown in Asia/Dhaka.

## Local development

```bash
npm install
# MySQL/MariaDB running locally:
TEST_DATABASE_URL=mysql://user:pass@localhost:3306/appt_test npm test
npm run build
DATABASE_URL=mysql://user:pass@localhost:3306/appointments PUBLIC_SITE_URL=http://127.0.0.1:3000 \
  TOKEN_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))") SETUP_CODE=changeme123 npm start
```

Deployment: see [SETUP.md](SETUP.md). Current live configuration: [DEPLOYMENT.md](DEPLOYMENT.md).

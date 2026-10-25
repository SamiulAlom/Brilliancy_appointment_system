# Live deployment (25 October 2026)

| Part | Where | Account |
| --- | --- | --- |
| Booking website | https://brilliancy-appointments.pages.dev | Cloudflare (brilliancyresearchltd2@gmail.com), Pages project `brilliancy-appointments` |
| Admin portal | https://brilliancy-appointments.pages.dev/admin | Admin: brilliancyresearchltd2@gmail.com (Supabase Auth user) |
| Privacy page | https://brilliancy-appointments.pages.dev/privacy | |
| API (Worker) | https://brilliancy-appointments-api.brilliancyresearchltd2.workers.dev (health: `/api/health`) | Cloudflare Worker `brilliancy-appointments-api`, Cron every minute |
| Database | Supabase project `hgjrdcuflejibgakzojw` (organization "brilliancy research") | brilliancyresearchltd2@gmail.com |
| Google OAuth app | Google Cloud project `brilliancy-appointments`, client "Appointments Worker", status *In production* (unverified, fine for own use) | brilliancyresearchltd2@gmail.com |
| Office calendar | Connected: **brilliancycomms@gmail.com** (primary calendar) | |
| Email | Brevo, sender **brilliancycomms@gmail.com** | |

Worker variables: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `ALLOWED_ORIGINS`, `PUBLIC_SITE_URL`, `GOOGLE_CLIENT_ID`, `BREVO_SENDER_EMAIL`, `BREVO_SENDER_NAME`, `EMAIL_ENABLED=true`.
Worker secrets: `SUPABASE_SECRET_KEY`, `TOKEN_ENCRYPTION_KEY`, `GOOGLE_CLIENT_SECRET`, `BREVO_API_KEY`. Never change `TOKEN_ENCRYPTION_KEY` without reconnecting the calendar afterwards (the stored Google token is encrypted with it).

## Verified end to end
- Slots are checked against the live office calendar.
- Test booking (Mon 26 Oct, 6:30 PM, Google Meet) was confirmed, added to the calendar with a Meet link, and both emails were accepted by Brevo.
- Cancelling via the client link removed the calendar event and sent cancellation emails to the client and the office. The test booking stays in Admin → Bookings as *Cancelled*.

## Updating
- Website: `npm run build` with `.env` pointing at the values above, then Cloudflare → Pages → `brilliancy-appointments` → Create deployment → upload a zip of `dist/` (the `deploy/` folder has the last one).
- API: paste `worker/worker.js` in the Worker editor → Deploy.
- Referral links: Admin → Referrals → copy each employee's link (`/?ref=BR…`).

## Website build settings (`.env`, all public values)
```
VITE_API_URL=https://brilliancy-appointments-api.brilliancyresearchltd2.workers.dev
VITE_SUPABASE_URL=https://hgjrdcuflejibgakzojw.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_WtMkASI-a-YIyl3IkPylBw_289Yn70K
VITE_TURNSTILE_SITE_KEY=
```
Copy these into a file named `.env` before `npm run build`.

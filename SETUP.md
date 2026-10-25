# Deployment guide

Everything runs on free tiers. Allow about an hour. Do the steps in order.

## 1. Database (Supabase, its own project)

1. Open the project's **SQL Editor**.
2. Run all of `supabase/migrations/001_appointments.sql`. The result should show `bookings_table_ready = true`, `services_count = 7`, `overlap_guard_ready = true`. Safe to rerun.
3. Run `supabase/private/002_seed_referrers.sql` (the 19 communication/consultant employees). Keep this file private; it holds staff emails and phone numbers. You can edit the list later in Admin → Settings → Referring employees.
4. Create an admin: **Authentication → Users → Add user → Create new user** (email + password, tick *Auto Confirm User*). Then run:
   ```sql
   insert into public.appt_admins (auth_user_id, full_name)
   select id, 'Your Name' from auth.users where lower(email) = 'admin@example.com';
   ```
   Admins sign in at `/admin` with that email and password. Remove access with `update public.appt_admins set active = false where ...`.

## 2. Google Cloud (one time)

1. Go to <https://console.cloud.google.com/> signed in as the **office Google account** (`brilliancycomms@gmail.com`), create a project "Brilliancy Appointments".
2. **APIs & Services → Library** → enable **Google Calendar API**.
3. **APIs & Services → OAuth consent screen**: External, app name "Brilliancy Appointments", support email and developer email = the office email. Add scopes `…/auth/calendar.events` and `…/auth/calendar.freebusy`. Add the office email as a test user.
4. Fill **Branding**: home page `https://brilliancy-appointments.pages.dev`, privacy policy `https://brilliancy-appointments.pages.dev/privacy`, authorised domains `brilliancy-appointments.pages.dev` and your `workers.dev` subdomain. Then **publish the app** (Audience → *In production*). This matters: in *Testing* mode Google expires the connection every 7 days and bookings would stop reaching the calendar. Google will show an "unverified app" warning when connecting; that is fine for your own account. Verification is optional (needs a privacy-policy page and a domain you own).
5. **Credentials → Create credentials → OAuth client ID → Web application**. Authorized redirect URI: `https://<your-worker>.workers.dev/api/google/callback` (you get the exact Worker URL in step 3; you can come back and add it). Copy the **Client ID** and **Client secret**.

## 3. Worker (Cloudflare)

1. Cloudflare dashboard → **Workers & Pages → Create → Worker**, name `brilliancy-appointments-api`. Replace the code with the whole of `worker/worker.js` and deploy. Note the URL `https://brilliancy-appointments-api.<account>.workers.dev`.
2. **Settings → Variables and Secrets** — add:

| Name | Type | Value |
| --- | --- | --- |
| SUPABASE_URL | Text | `https://<project>.supabase.co` |
| SUPABASE_PUBLISHABLE_KEY | Text | `sb_publishable_…` |
| SUPABASE_SECRET_KEY | **Secret** | `sb_secret_…` |
| ALLOWED_ORIGINS | Text | `https://brilliancy-appointments.pages.dev,http://127.0.0.1:5173,http://localhost:5173` |
| PUBLIC_SITE_URL | Text | `https://brilliancy-appointments.pages.dev` |
| GOOGLE_CLIENT_ID | Text | from step 2 |
| GOOGLE_CLIENT_SECRET | **Secret** | from step 2 |
| TOKEN_ENCRYPTION_KEY | **Secret** | 32 random bytes in base64 — run `openssl rand -base64 32` or `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| BREVO_API_KEY | **Secret** | Brevo API key (not the SMTP key) |
| BREVO_SENDER_EMAIL | Text | `brilliancycomms@gmail.com` (verified in Brevo) |
| BREVO_SENDER_NAME | Text | `Brilliancy Research` |
| EMAIL_ENABLED | Text | `true` |
| TURNSTILE_SECRET_KEY | Secret | optional, see step 6 |

3. **Settings → Trigger Events → Cron Triggers** → add `* * * * *` (every minute). It retries calendar writes, queues reminders and sends emails.
4. Open `https://<worker>/api/health`. Expect `configured: true`, `google_client: true`, `email_enabled: true`.
5. Add the Worker's redirect URI (`https://<worker>/api/google/callback`) to the Google OAuth client if you have not already.

## 4. Website (Cloudflare Pages)

1. Create `.env` from `.env.example` with `VITE_API_URL` = the Worker URL, and the Supabase URL and publishable key. Never put the secret key here.
2. `npm install && npm run build`.
3. Cloudflare → **Workers & Pages → Create → Pages → Upload assets**, project `brilliancy-appointments`, upload the contents of `dist/` (the `_redirects` file inside `dist/` keeps `/admin` and `/manage` working on refresh).
4. Visit `https://brilliancy-appointments.pages.dev/`. The service list should load. If you see "The booking service is not configured yet", `VITE_API_URL` was missing at build time.

## 5. Connect the office calendar

1. Open `https://brilliancy-appointments.pages.dev/admin` and sign in with the admin email and password from step 1.
2. **Settings → Office Google Calendar → Connect**. Choose the office Google account (brilliancycomms@gmail.com), continue past the "unverified app" screen (Advanced → Go to Brilliancy Appointments), and tick **both** calendar permissions.
3. You are returned to Settings showing *Connected as brilliancycomms@gmail.com*.
4. Test: make a booking from the public page with your own email. Within a minute you should have the confirmation email, a Google Calendar invitation, the event on the office calendar, and the booking in Admin → Bookings as *Confirmed*. Cancel it from the link in the email and check the event disappears.

Events added by hand to the office calendar also block those times for clients. Keep the "Google calendar ID" setting as `primary` unless you want a separate calendar.

## 6. Optional: spam protection

Cloudflare → **Turnstile → Add site** (domain `brilliancy-appointments.pages.dev`, Managed). Put the **site key** in `.env` as `VITE_TURNSTILE_SITE_KEY` and rebuild/upload; put the **secret key** on the Worker as `TURNSTILE_SECRET_KEY`.

## Updating later

- Frontend change: `npm run build`, upload `dist/` to Pages again.
- Worker change: paste the new `worker/worker.js` and deploy; keep variables and the Cron trigger.
- Database change: run the new migration file once.

## Checks and troubleshooting

- `/api/health` on the Worker shows configuration state.
- Admin → Bookings marks *Calendar pending* with a "Calendar issue" note when Google rejected or was unreachable; open the booking and press **Retry now**, or wait for the Cron.
- Settings shows a Google error if access was revoked; press Connect again.
- Email status: in Supabase SQL Editor, `select kind, status, attempts, last_error, created_at from public.appt_email_outbox order by id desc limit 30;` `accepted` means Brevo accepted it; check Brevo logs for actual delivery.
- Nothing is emailed or written to Google by running the SQL or deploying; only real bookings trigger those.

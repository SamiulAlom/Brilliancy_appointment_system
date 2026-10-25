# Database files

- `migrations/001_appointments.sql` — run once in the project's SQL Editor (rerun-safe). Creates the `appt_*` tables, seeds services, locks tables down to the service role, and adds the Worker helper functions.
- `private/002_seed_referrers.sql` — the referring-employee list with emails and phones. Private; excluded from git. Rerunning updates names and contacts but keeps the active/notify switches set in Admin.

Tables: `appt_admins`, `appt_settings`, `appt_services`, `appt_off_days`, `appt_referrers`, `appt_google`, `appt_bookings`, `appt_email_outbox`, `appt_audit`.
Admins are Supabase Auth users listed in `appt_admins` (see SETUP.md step 1).

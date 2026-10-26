# Brilliancy Appointments — Application Plan

Planning date: 25 October 2026 (revised after decisions). Timezone: Asia/Dhaka.

## 1. Objective

A public booking website. A client chooses a service, sees only time slots that are **free on the office Google Calendar**, enters their details and the **employee who referred them**, and books. The booking is confirmed instantly (after the free-slot check), written to the office Google Calendar with an invite to the client, and emailed. Administrators manage bookings, services, hours and referral reports.

## 2. Confirmed decisions

| Topic | Decision |
| --- | --- |
| Reference employee | The employee who **referred** the client. Chosen from a dropdown of the 19 communication/consultant employees (from `Communication_and_Consultant_Employee_Contacts.docx`), or pre-filled by a referral link `…/?ref=EMPLOYEE_ID`. "Someone else (type a name)" and "No one" are allowed. The referrer is emailed when their referral books. Admins can add, edit or hide employees in Settings. |
| Calendar | **One office Google Calendar.** An administrator connects the office Google account once in Admin → Settings. |
| Confirmation | **Instant.** The server re-checks the slot (database + Google Calendar) at the moment of booking. If it is free, the booking is confirmed; if not, the client is asked to choose another time. |
| Hours | **10:00 AM – 7:00 PM**, Saturday–Thursday. Friday closed. The last appointment must end by 7:00 PM. Editable in Admin. |
| Payment | None. |
| Capacity | One appointment at a time on the office calendar (any busy event blocks the slot, including events added by hand in Google Calendar). |

Assumptions (change any time in Admin → Settings): 30-minute slot step, 2-hour minimum notice, booking up to 30 days ahead, meeting types In office / Google Meet / Phone.

## 3. Technology (same family as Attendance and Classroom)

- Frontend: React + TypeScript + Vite → Cloudflare Pages (`brilliancy-appointments.pages.dev`).
- API: Cloudflare Worker with a once-per-minute Cron Trigger.
- Database/Auth: its **own Supabase project** (brilliancyresearchltd2@gmail.com account). Tables use the `appt_` prefix; admins are Supabase Auth users listed in `appt_admins`; referrers live in `appt_referrers`.
- Email: Brevo from `brilliancycomms@gmail.com`, outbox with idempotency keys (Classroom pattern).
- Google Calendar API (OAuth 2.0, scopes `calendar.events` + `calendar.freebusy`).
- Optional Cloudflare Turnstile against spam bookings.

## 4. Client flow

1. Choose service (duration shown).
2. Choose meeting type: In office (Level 13, Fareast Tower, 35 Topkhana Road), Google Meet, or Phone.
3. Choose date (Fridays, off days and dates outside the booking window are disabled) and a free time.
4. Enter name, phone/WhatsApp, email, university/institution, short note, **referred by**.
5. Confirm → confirmation screen + email with a private link to view or cancel. Google Calendar also sends its own invite (with a Meet link for online meetings).
6. A reminder email goes out about 24 hours before.

## 5. Admin portal (email + password admins)

- **Bookings:** filter by date range, status, referrer, search; mark Completed / No-show / Cancelled; internal notes; CSV export.
- **Referrals:** per-month count of bookings and completed appointments for each referring employee; CSV; copyable referral links for every employee.
- **Services:** add/edit name, duration, description, active.
- **Settings:** hours, working days, slot step, minimum notice, days ahead, meeting types, office off-day ranges, Google Calendar connection status and connect/disconnect button.

## 6. Reliability

- A Postgres exclusion constraint makes two overlapping active bookings impossible, even if two clients press Book at the same moment.
- Google free/busy is checked when slots are listed **and again** just before saving.
- The Google event uses an ID derived from the booking ID, so retries never create duplicates. If Google is briefly unavailable, the booking is kept as "Calendar pending" and the Cron retries it; admins see the status.
- Refresh token stored encrypted (AES-GCM, key in a Worker secret). Only free/busy is read; no private event details are shown to clients.
- Public endpoints never touch tables directly; the Worker uses the secret key, and RLS blocks browser access.
- Limit: at most 3 upcoming bookings per phone number / email.

## 7. Phases

1. **Done (25 Oct 2026):** database, Worker, booking page, manage link, admin portal, emails, Google Calendar, tests, docs.
2. **Done (25 Oct 2026):** deployed and tested end to end (see DEPLOYMENT.md). Original deploy steps: run SQL, create Google OAuth client, deploy Worker and Pages, connect the office calendar, test end-to-end.
3. Later options: WhatsApp/SMS reminders, Bangla interface, employee self-service referral dashboard, file uploads, custom domain.

# Deploy on the Hostinger VPS (EasyPanel)

The app runs as its own EasyPanel project, separate from every other app on the VPS (for example studio). Nothing else on the server is changed.

## 1. EasyPanel project and database

1. hPanel → VPS → **Manage panel** (opens EasyPanel).
2. **+ Create project** → name `appointments`.
3. In the project: **+ Service → MySQL**, service name `mysql`, database `appointments`. EasyPanel generates the user and password. Copy the **internal connection URL** (looks like `mysql://mysql:…@appointments_mysql:3306/appointments`).

## 2. The app

1. In the same project: **+ Service → App**, name `web`.
2. **Source**: GitHub → repository `SamiulAlom/Brilliancy_appointment_system`, branch `version-3` (connect GitHub once in EasyPanel Settings → GitHub with a token that can read the private repo). **Build**: Dockerfile (the repo has one at the root).
3. **Environment** (copy from `.env.example`):

| Name | Value |
| --- | --- |
| DATABASE_URL | the internal MySQL URL from step 1 |
| PUBLIC_SITE_URL | `https://appointment.brilliancyresearch.net` |
| PORT | `3000` |
| TOKEN_ENCRYPTION_KEY | 32 random bytes in base64 (keep it; changing it means reconnecting Google) |
| SETUP_CODE | any 8+ character code, used once to create the first admin |
| GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET | from Google Cloud → APIs & Services → Credentials → "Appointments Worker" |
| BREVO_API_KEY | Brevo → SMTP & API → API keys |
| BREVO_SENDER_EMAIL | `brilliancycomms@gmail.com` |
| BREVO_SENDER_NAME | `Brilliancy Research` |
| EMAIL_ENABLED | `true` |

4. **Domains**: add `appointment.brilliancyresearch.net`, HTTPS on, port `3000`. EasyPanel issues the Let's Encrypt certificate once DNS points to the VPS.
5. **Deploy**. `https://appointment.brilliancyresearch.net/api/health` should show `"database":true,"configured":true`.

## 3. DNS (Namecheap → Domain List → brilliancyresearch.net → Advanced DNS)

One record only: `A` `appointment` → `187.127.210.231` (TTL 300). Leave every other record as it is.

## 4. Google Cloud (project "Brilliancy Appointments")

APIs & Services → Credentials → OAuth client → **Authorised redirect URIs**: add `https://appointment.brilliancyresearch.net/api/google/callback`. Branding → Authorised domains: add `brilliancyresearch.net`.

## 5. First use

1. Open `/admin` → **Create the first administrator** (enter the SETUP_CODE, your name, email and password).
2. Settings → **Connect office Google Calendar** → choose brilliancycomms@gmail.com → Advanced → Go to Brilliancy Appointments → tick both calendar permissions.
3. Settings → Referring employees → **Bulk add from a spreadsheet** → paste the staff list (ID, name, designation, email, phone).
4. Make a test booking and cancel it from the email link.

## Updating

Push to the `version-3` branch, then EasyPanel → app → **Deploy** (or enable auto-deploy). The database schema updates itself on start. Back up the MySQL service from EasyPanel before big changes.

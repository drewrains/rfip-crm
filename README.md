# RFIP Pipeline (CRM)

RFIP's sales CRM: deal pipeline, go/no-go scoring, accounts, contacts, tasks, a company dashboard for admins, and per-deal sharing. Reps sign in with their RFIP Microsoft 365 account.

**Who sees what** (enforced by the database, not just the screens):

| | Reps | Admins |
|---|---|---|
| Accounts & contacts | Everything | Everything |
| Deals, their notes and tasks | Deals they own or that are shared with them | Everything |
| Share a deal / change its owner | Deals they own | Any deal |
| Go/no-go criteria | Read | Edit |
| Team (roles, turn access off) | — | Yes |

Only `@rfip.com` Microsoft accounts can sign in. `drains@rfip.com` starts as the admin.

## Files

- `index.html`, `styles.css`, `app.js` — the app (plain HTML/JS, no build step)
- `config.js` — your Supabase project URL and public key
- `supabase/schema.sql` — tables and permission rules (run once)
- `supabase/seed.sql` — current pursuits to start with (run once, after your first sign-in)

## Setup

Do these in order. Total time is about an hour, mostly waiting on the Microsoft step.

### 1. Supabase: create the database

1. In Supabase, open the `rfip-crm` project → **SQL Editor** → **New query**.
2. Paste the whole contents of `supabase/schema.sql` and click **Run**. It should finish with "Success. No rows returned".
3. **Authentication → Sign In / Providers → Email**: turn **off** "Enable Email provider" (everyone signs in through Microsoft).

### 2. Microsoft 365 admin: register the app (Entra ID)

Done by whoever administers RFIP's Microsoft 365.

1. Go to [portal.azure.com](https://portal.azure.com) → **Microsoft Entra ID** → **App registrations** → **New registration**.
2. **Name:** `RFIP CRM`.
3. **Supported account types:** *Accounts in this organizational directory only (single tenant)*.
4. **Redirect URI:** platform **Web**, value `https://<project-ref>.supabase.co/auth/v1/callback` (the Supabase Project URL with `/auth/v1/callback` added).
5. Click **Register**. On the overview page, copy the **Application (client) ID** and the **Directory (tenant) ID**.
6. **Certificates & secrets → Client secrets → New client secret.** Pick 24 months and put a reminder on the calendar to renew it. Copy the secret's **Value** (not the Secret ID); it's only shown once.
7. **Manifest**: in `optionalClaims`, add `email` to `idToken`, and `xms_edov` to both `idToken` and `accessToken`. This lets Supabase confirm the email address is verified:
   ```json
   "optionalClaims": {
     "idToken": [
       {"name": "email", "source": null, "essential": false, "additionalProperties": []},
       {"name": "xms_edov", "source": null, "essential": false, "additionalProperties": []}
     ],
     "accessToken": [
       {"name": "xms_edov", "source": null, "essential": false, "additionalProperties": []}
     ],
     "saml2Token": []
   }
   ```
8. Hand the **client ID**, **tenant ID** and **secret value** to whoever is doing step 3. Send the secret privately; don't email it in plain text to a group, and don't paste it into chats.

### 3. Supabase: turn on Microsoft sign-in

1. **Authentication → Sign In / Providers → Azure**: turn it on.
2. **Application (client) ID** and **Secret Value** from step 2.
3. **Azure Tenant URL:** `https://login.microsoftonline.com/<tenant-id>` (the Directory (tenant) ID from step 2). This limits sign-in to RFIP's own Microsoft accounts.
4. Save.

### 4. Vercel: put the app online

1. In Vercel: **Add New → Project** → import the `rfip-crm` GitHub repository.
2. **Framework Preset:** *Other*. Leave the build command and output directory empty.
3. **Deploy.** Copy the address Vercel gives you (like `https://rfip-crm.vercel.app`).

### 5. Supabase: allow the app's address

**Authentication → URL Configuration**:

- **Site URL:** the Vercel address (or `https://crm.rfip.com` once step 7 is done).
- **Redirect URLs:** add the Vercel address and, if you'll use it, `https://crm.rfip.com`.

### 6. First sign-in and starting data

1. Open the app and **Sign in with Microsoft** as `drains@rfip.com`. You're the admin.
2. Back in Supabase **SQL Editor**, run `supabase/seed.sql` to load the current pursuits (all assigned to Drew to start).
3. Have each rep open the app and sign in once. They then appear in the Team tab and in the owner and sharing lists, and you can reassign and share deals with them.

### 7. Optional: crm.rfip.com

In Vercel: **Project → Settings → Domains → Add** `crm.rfip.com`. Vercel shows one DNS record (a CNAME). Whoever manages rfip.com's DNS adds it. Then update the Site URL in step 5.

## Running the business on it

- **Backups:** once the team relies on it, move the Supabase project to a paid plan for daily backups. Export CSVs from *Go/no-go & import* any time.
- **Someone leaves:** turn their access off in **Team** (and disable their Microsoft account as usual). Their deals stay; filter Deals by their name and reassign.
- **Changes:** edits to the code in GitHub redeploy automatically on Vercel.
- **Database changes:** re-running `schema.sql` is safe; it updates functions and permission rules without touching data.

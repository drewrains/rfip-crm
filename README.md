# RFIP (sales and operations)

RFIP's sales CRM and operations platform. The sales side: deal pipeline, go/no-go scoring, accounts, contacts, tasks, a company dashboard for admins, and per-deal sharing. Reps sign in with their RFIP Microsoft 365 account.

**Who sees what** (enforced by the database, not just the screens):

| | Reps | Admins |
|---|---|---|
| Accounts & contacts | Everything | Everything |
| Deals, their notes and tasks | Deals they own or that are shared with them | Everything |
| Share a deal / change its owner | Deals they own | Any deal |
| Go/no-go criteria | Read | Edit |
| Team (roles, turn access off) | — | Yes |

Only `@rfip.com` accounts can sign in. `drains@rfip.com` starts as the admin. People sign in with a password an admin creates for them, or with Microsoft once that's set up.

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
3. **Authentication → Sign In / Providers**: turn **off** "Allow new users to sign up". Leave the **Email** provider on. Nobody can create their own login; an admin creates them (see *Creating logins* below).

### Creating logins (email + password)

For each person, in Supabase: **Authentication → Users → Add user → Create new user**.

- **Email:** their @rfip.com address. **Password:** a temporary one you send them privately.
- Check **Auto Confirm User**.

They sign in, then click **Password** in the top bar to set their own. To reset a forgotten password, open the user in the same list and set a new one. To remove access, turn them off in the app's **Team** tab (or delete the user in Supabase).

Create your own login (`drains@rfip.com`) first. You become the admin.

### 2. Microsoft 365 admin: register the app (Entra ID) — optional, later

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
5. In `config.js`, set `microsoftLogin: true` and push. The **Sign in with Microsoft** button appears. Once everyone uses Microsoft you can set `passwordLogin: false`.

### 4. Vercel: put the app online

1. In Vercel: **Add New → Project** → import the `rfip-crm` GitHub repository.
2. **Framework Preset:** *Other*. Leave the build command and output directory empty.
3. **Deploy.** Copy the address Vercel gives you (like `https://rfip-crm.vercel.app`).

### 5. Supabase: allow the app's address

**Authentication → URL Configuration**:

- **Site URL:** the Vercel address (or `https://crm.rfip.com` once step 7 is done).
- **Redirect URLs:** add the Vercel address and, if you'll use it, `https://crm.rfip.com`.

### 6. First sign-in and starting data

1. Open the app and sign in as `drains@rfip.com`. You're the admin.
2. Back in Supabase **SQL Editor**, run `supabase/seed.sql` to load the current pursuits (all assigned to Drew to start).
3. Create a login for each rep (see *Creating logins*) and have them sign in once. They then appear in the Team tab and in the owner and sharing lists, and you can reassign and share deals with them.

### 7. Optional: crm.rfip.com

In Vercel: **Project → Settings → Domains → Add** `crm.rfip.com`. Vercel shows one DNS record (a CNAME). Whoever manages rfip.com's DNS adds it. Then update the Site URL in step 5.

## Running the business on it

- **Backups:** once the team relies on it, move the Supabase project to a paid plan for daily backups. Export CSVs from *Go/no-go & import* any time.
- **Someone leaves:** turn their access off in **Team** (and disable their Microsoft account as usual). Their deals stay; filter Deals by their name and reassign.
- **Changes:** edits to the code in GitHub redeploy automatically on Vercel.
- **Database changes:** re-running `schema.sql` is safe; it updates functions and permission rules without touching data.

## Customer history and year-end

Nothing is deleted or reset at year-end. Open deals carry into the new year automatically; won, lost and no-bid deals leave the pipeline board but stay in the history.

- **Closing a deal** (dragging it to Won, or setting the stage to Lost or No-bid) asks why. A reason is required for lost and no-bid; for lost deals, also record who won and their price if known.
- **Account → History** shows the customer's track record: deals won, lost and not bid, win rate, loss reasons and recent activity across deals. Reps see the counts for every deal with that account, but only the deals they're on; dollar totals are admin-only.
- **Dashboard → year picker** shows results for any year, compared with the year before: won revenue, win rate, average win, where you win (by rep, vertical, service line, source or account type), why you lose, who beats you, and whether go/no-go scores predict wins.
- **Team → Won-revenue targets**: set the company and per-person targets each January; progress shows on the dashboard.
- **Notes** can be tagged as a call, meeting, site visit or email.


## Operations side (projects, handoff, billing)

The same app has an **Operations** section for delivery: a company overview, projects, the sales-to-ops handoff, and monthly billing. People with both sales and operations access switch between them with the Sales / Operations toggle in the top bar.

**How a won deal becomes a project**

1. A deal is marked **Won** in the CRM. The database opens a **handoff** for it automatically and guesses the department from the deal's service lines.
2. Sales fills in the **handoff packet** (contract, schedule of values, schedule, the estimate it was priced on, customer contacts, site access) and clicks **Submit to operations**. Submitting is blocked until the required items are in.
3. The department lead or assigned PM reviews it and either **kicks it back** with what's missing, or clicks **Accept and create project**. Accepting creates the project with its budget (labor hours, material, subs, equipment), a closeout checklist and a starting billing schedule.
4. From then on operations owns it: percent complete, weekly labor hours, schedule, change orders, materials, daily field logs, crew, closeout and billing. Sales can still see the project's schedule and closeout status (not costs or margin).

**Operations access** (set by an admin on the Team tab):

| Role | Sees | Changes |
|---|---|---|
| Admin | Everything | Everything |
| Sees all projects (execs, accounting) | Every project, costs and billing | Nothing |
| Department lead | Projects in their department, its handoffs, overview | Their department's projects; accepts handoffs |
| Project manager | Projects they manage | Their projects; accepts handoffs assigned to them |
| Field / foreman | Projects they're on the crew roster for (no costs or billing) | Adds daily logs |

"Sales side: No" hides the CRM from ops-only people.

**Manpower schedule** (Operations → Manpower): the field tech roster and who is on which job each day, as a Day board (job cards, who's free, who's out), a Week board (person by day) and a Month board (person by workday, with how booked each person is). "Needs vs scheduled" compares each job's weekly crew plan with who's actually on the board.

- PMs schedule people onto their own jobs and take them off. If someone is already on another job that day, that job's PM has to release them first; the app says who to ask.
- Department leads can do the same for their department, record time off and training, and add techs. Admins can change anything.
- Everyone on the operations side sees the whole board. Field logins with a tech record see their own schedule.
- The project page's "Crew this week" comes from the schedule.

**Materials** (on each project page): import the material list or BOM from Excel or CSV (columns are matched automatically, with a preview), or add lines by hand. Each line tracks part number, manufacturer, quantity needed, unit cost, distributor, PO, quantity ordered, ETA and quantity received. Tick lines and **Order selected** to mark them ordered from one distributor on one PO. **Receive** logs a delivery (quantity, date, packing slip, optional photo saved to the project's field photos); the received total and status follow the deliveries automatically. PMs, leads and admins manage the list and orders; foremen on the job can log deliveries from their phone.

**Installed work and percent complete** (Materials and Schedule on each project page): every material line can say how the crew counts it (an install unit and quantity, so 120 boxes of cable can be 208 drops), the **labor hours each one takes**, and which **milestone** it counts toward. Foremen tap **Log installs** (or **Install** on a line) and enter how many went in, where, and an optional photo; the installed count shows on each line and each milestone's progress bar follows it. Milestones with no material (mobilizing, testing, closeout) carry their own labor hours and the PM's progress. Installed labor hours ÷ planned labor hours gives a **suggested percent complete**, shown as the "Installed work" tile and in Update progress and the weekly update with a "Use" button. It's a suggestion only: the PM's percent complete still drives earned revenue and the margin forecast. A material import can bring a "Labor hours" column.

**Documents** (on each project page): every project has the same folders: Contract and PO, Scope and estimate, Submittals, Drawings, Change orders, Pay apps, Field photos and daily reports, Test results, Closeout, Safety. Files are stored privately in Supabase Storage (bucket `project-files`, 50 MB per file); phone photos over 1 MB are shrunk to 1600 px before upload. Contract, scope and pay apps are only visible to people who see the project's money; foremen can open the rest and upload field photos, test results and safety documents. Uploading to Closeout or Test results can tick off a closeout checklist item.

**Weekly PM updates**: due Friday at noon (change `UPDATE_DUE` in `ops.js`). Each update records percent complete (which updates the project), schedule / cost / safety status, what got done, next week's plan, needs and decisions, and customer notes. The form is pre-filled with that week's daily logs and labor facts. The **Weekly updates** tab rolls every job up for the week, missing ones first, then off track and at risk. Missing updates also show on the project list and in Needs attention.

**Project plan** (on each project page): phases, tasks inside them and sub-tasks below those, each with who it's assigned to, start and due dates and a status, plus a timeline bar against today. "Start from the standard phases" drops in the usual phases for the project's department, spread across its dates. The PM, department lead and admins build the plan; whoever a task is assigned to can tick it off and update its status and notes. Overdue plan tasks show in Needs attention.

**My tasks** (Operations → My tasks): everything assigned to you across all your projects, grouped into overdue, due in the next 7 days, later and no date, with a tick box to mark each done. PMs, leads and admins can switch to everyone's tasks, one person's, or tasks nobody has been assigned yet.

**Expenses** (on each project page, and Operations → Expenses): anyone working a job, foremen included, logs an expense with a photo or PDF of the receipt (required), the amount, category, vendor and how it was paid. It goes to the job's **PM to approve**, then to the **CFO for final approval**. Either can send it back with a reason; the person who logged it fixes it and resubmits. Only fully approved expenses count toward the job's cost, as a "Field expenses" line in Cost to complete and in the margin forecast. The Expenses tab shows what's waiting on you, what you've logged, and totals waiting on PMs and on the CFO. Who gives final approval is set by an admin on the Team tab ("Expense final approval"). Foremen only see their own expenses; receipts are stored in the project's private `expenses` folder.

**Customer view** (on each project page, for the PM, lead and admins): turns on a private link to a live, read-only status page for the customer: percent complete, schedule status, planned completion, the plan's phases with progress, milestones and the weekly update's "done this week" and "next week". It never shows money, needs and decisions, customer notes, documents or crew. Each weekly update has a box to leave it off the customer page. The link can be turned off or replaced (the old one stops working), and the panel shows how many times it's been opened. The customer page is `customer.html`; nobody needs a login.

**SharePoint folder per deal**: when a deal is created, RFIP creates its folder in the SharePoint site under its customer: `Customers/<Customer>/<Deal name>/` (the customer folder and its `Customer Info` folder, for MSAs, COIs and the like, are created as soon as the account is saved, and the account page links to them; deals with no account go under `Customers/No Customer/`), with a **Sales** folder (01 RFP and Bid Docs, 02 Site Walk and Photos, 03 Drawings and Specs, 04 Estimate and Pricing, 05 Proposal, 06 Contract and PO, 07 Correspondence) and an **Operations** folder (01 Handoff Packet, 02 Submittals, 03 Drawings and As-Builts, 04 Change Orders, 05 Field Photos and Daily Reports, 06 Test Results, 07 Pay Apps, 08 Closeout, 09 Safety). The deal shows Open folder / Sales / Operations links; when the deal is won and accepted, the project page links to the same folder, so operations picks up everything sales gathered. Admins can create folders for older deals from the Team tab.

**Files live in SharePoint**: the deal drawer's **Files** tab and the project's **Documents** panel list the files in that folder live, and uploads go straight into it (the deal uploads into its Sales folders; project Documents folders map to Sales › 06 Contract and PO, Sales › 04 Estimate and Pricing and the Operations folders). Files people add in SharePoint or Teams show up in the app, and deletes go to the SharePoint recycle bin. The Edge Function checks each person's rights in the database before listing, uploading or deleting, so the money folders stay limited to people who can see a project's money. Project uploads still get a row in `documents` (for the note, uploader and closeout link) that points at the SharePoint file; older files in the storage bucket keep working. People who open a file in SharePoint need access to the SharePoint site itself. The work is done by the `sharepoint` Edge Function (`supabase/functions/sharepoint`), which needs these secrets in Supabase → Edge Functions → Secrets: `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `SP_SITE_URL` (optional `SP_LIBRARY`, default Documents; `SP_ROOT_FOLDER`, default Customers). Renaming a deal, moving it to another account or renaming an account moves or renames its SharePoint folder to match; files come along). Until they're set, deals wait and get their folder as soon as it's connected. The Microsoft app registration needs the Microsoft Graph application permission **Sites.ReadWrite.All** with admin consent.

**Microsoft sign-in**: the "Sign in with Microsoft" button appears by itself once the Azure provider is switched on in Supabase. Only rfip.com accounts can sign in; someone who already has a password login lands in the same account.

**Database scripts**

- `supabase/ops_schema.sql` adds the operations tables and rules. Run it after `schema.sql`.
- `supabase/manpower_schema.sql` adds the tech roster and daily schedule. Run it after `ops_schema.sql`.
- `supabase/materials_schema.sql` adds purchasing and receiving to materials. Run it after `ops_schema.sql`.
- `supabase/docs_updates_schema.sql` adds project documents (storage bucket and rules) and weekly PM updates. Run it after `ops_schema.sql`.
- `supabase/sharepoint_schema.sql` adds the SharePoint folder link to deals and projects. Run it after `ops_schema.sql`.
- `supabase/sharepoint_files_schema.sql` lets project documents point at SharePoint files. Run it after `sharepoint_schema.sql` and `docs_updates_schema.sql`.
- `supabase/team_access_schema.sql` lets a PM share a project with another PM, and lets admins preset someone's access before their first sign-in.
- `supabase/customer_portal_schema.sql` adds the **customer dashboard**: one private link per customer account (Accounts → open the account → Customer dashboard) that shows the customer every project RFIP runs for them, with progress, schedule, milestones and weekly updates, and a click-through to each project's status page. No money, internal notes or documents. Admins, department leads and the PMs on that customer's projects can turn it on, off or replace it.
- `supabase/outlook_schema.sql` adds **Outlook email and calendar**. Invites and alert emails go out from the person doing the work, through their own Microsoft sign-in. Needs the delegated Microsoft Graph permissions **Mail.Send**, **Calendars.ReadWrite** and **offline_access** on the RFIP app registration (with admin consent), and the `outlook` Edge Function (it uses the same MS_TENANT_ID, MS_CLIENT_ID and MS_CLIENT_SECRET secrets). Each person signs out and back in with Microsoft once to connect. Deals get a **Meetings** tab and projects a **Meetings** panel (site walks, pre-bids, bid due, kickoffs, field visits, with an optional Teams link); changes and cancellations update everyone's calendar. Alert emails go out for tasks assigned to someone, handoffs submitted, kicked back or accepted, and expenses submitted, approved or sent back.
- `supabase/installs_schema.sql` adds install tracking (install unit and quantity, labor hours per unit, milestone link, install log). Run it after `materials_schema.sql`.
- `supabase/plan_expenses_customer_schema.sql` adds project plans and tasks, expenses with PM and CFO approval, and the customer view link. Run it after the scripts above.
- `supabase/plan_shared_edit.sql` lets anyone a project is shared with build and assign its project plan (already folded into `plan_expenses_customer_schema.sql`).
- `supabase/deal_assigner.sql` and `deal_assigner_2.sql` add the **Assigns account managers** access (Team page): enter deals for anyone and change the account manager on any deal without admin rights. Run them after `plan_expenses_customer_schema.sql`. `fix_deal_insert.sql` is already folded into `schema.sql`.
- `supabase/test_seed.sql` (and `test_seed_part6.sql` for plans, expenses and a customer link) loads demo logins and sample data. **Test database only.**

## Test environment

`config.js` points the live address (`rfip-crm.vercel.app`, and `crm.rfip.com` once set up) at the live database. **Every other address, including Vercel preview links, uses the separate test database** (`rfip-crm-test` in Supabase), so testing never touches real data. A yellow **TEST** tag shows next to the logo there.

Demo logins on the test database all use the password `RfipDemo-2026`:

| Login | Who | What they see |
|---|---|---|
| drains@rfip.com | Drew Rains, admin | Sales and Operations, everything |
| demo-mhochwender@rfip.com | Network department lead | Network projects and handoffs |
| demo-dayers@rfip.com | DataComm department lead | DataComm projects and handoffs |
| demo-jpike@rfip.com | Project manager | His two projects |
| demo-cmoran@rfip.com | Project manager | Clinic tower DAS; can accept the Hospital annex handoff |
| demo-rdelgado@rfip.com | Field foreman | Concourse Wi-Fi job, daily log, his tasks and expenses (works on a phone) |
| gkolton@rfip.com | Gabe, admin and CFO | Gives final approval on expenses |
| demo-agrant@rfip.com | Sales rep | His deals and their handoffs |
| demo-accounting@rfip.com | Accounting | All projects and billing, read-only |

Other leads and PMs: demo-mcapps, demo-hseabolt, demo-ddell, demo-mhale, demo-treese, demo-acole, demo-rbanks, demo-swhitfield (all `@rfip.com`).

Going live later: run `ops_schema.sql`, `manpower_schema.sql`, `materials_schema.sql`, `docs_updates_schema.sql`, `plan_expenses_customer_schema.sql`, `installs_schema.sql`, `sharepoint_schema.sql`, `sharepoint_files_schema.sql`, `team_access_schema.sql`, `customer_portal_schema.sql`, `deal_assigner.sql` and `deal_assigner_2.sql` on the live database first, deploy the `sharepoint` Edge Function there with its secrets (the live project needs the Pro plan for file storage), then merge the `ops-test` branch. Don't run `test_seed.sql` on live.

## Parked (decide later)

- **Project numbers.** Today `accept_handoff` makes a placeholder number (YY-NNN). The real number comes from admin and QuickBooks.
  Plan: when sales submits a handoff, the email to newprojects@rfip.com kicks off setup in QuickBooks. Then either admin types the number into RFIP, or the QuickBooks connection pulls it in automatically.
  Either way the SharePoint folder gets renamed to match. Needs Gabe for the QuickBooks side.
- ~~In-app file preview~~: built 10/4. Clicking a file opens it inside RFIP (server checks access, SharePoint preview or the image itself).

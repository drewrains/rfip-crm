-- =====================================================================
-- RFIP test environment — demo logins and sample data.
-- For the TEST database only (rfip-crm-test). Never run on the live CRM.
--
-- Part 1 creates demo logins (all share one temporary password).
-- Part 2 loads sample accounts, deals, projects, billing and field data
-- matching the October 2026 demo dashboards.
-- Run after schema.sql and ops_schema.sql. Re-running part 2 replaces it.
-- =====================================================================

-- ---------- part 1: demo logins ---------------------------------------
do $$
declare
  u record; uid uuid; pw text := 'RfipDemo-2026';
begin
  for u in select * from (values
    ('drains@rfip.com',            'Drew Rains',      'admin', null,     null,       true),
    ('demo-agrant@rfip.com',       'Alex Grant',      'rep',   null,     null,       true),
    ('demo-jortiz@rfip.com',       'Jamie Ortiz',     'rep',   null,     null,       true),
    ('demo-mcapps@rfip.com',       'Mike Capps',      'rep',   'lead',   'Tower',    false),
    ('demo-hseabolt@rfip.com',     'Harley Seabolt',  'rep',   'lead',   'DAS',      false),
    ('demo-mhochwender@rfip.com',  'Matt Hochwender', 'rep',   'lead',   'Network',  false),
    ('demo-dayers@rfip.com',       'David Ayers',     'rep',   'lead',   'DataComm', false),
    ('demo-ddell@rfip.com',        'Darren Dell',     'rep',   'lead',   'Security', false),
    ('demo-jpike@rfip.com',        'Jordan Pike',     'rep',   'pm',     'Network',  false),
    ('demo-mhale@rfip.com',        'Morgan Hale',     'rep',   'pm',     'Network',  false),
    ('demo-cmoran@rfip.com',       'Casey Moran',     'rep',   'pm',     'DAS',      false),
    ('demo-treese@rfip.com',       'Taylor Reese',    'rep',   'pm',     'DataComm', false),
    ('demo-acole@rfip.com',        'Avery Cole',      'rep',   'pm',     'DataComm', false),
    ('demo-rbanks@rfip.com',       'Riley Banks',     'rep',   'pm',     'Tower',    false),
    ('demo-swhitfield@rfip.com',   'Sam Whitfield',   'rep',   'pm',     'Security', false),
    ('demo-rdelgado@rfip.com',     'Ray Delgado',     'rep',   'field',  'Network',  false),
    ('demo-accounting@rfip.com',   'Pat Billings',    'rep',   'viewer', null,       false)
  ) as t(email, name, role, ops_role, dept, sales)
  loop
    select id into uid from auth.users where email = u.email;
    if uid is null then
      uid := gen_random_uuid();
      insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
        raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, email_change, email_change_token_new, recovery_token)
      values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', u.email,
        extensions.crypt(pw, extensions.gen_salt('bf')), now(),
        '{"provider":"email","providers":["email"]}', jsonb_build_object('full_name', u.name), now(), now(), '', '', '', '');
      insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
      values (gen_random_uuid(), uid, uid::text, jsonb_build_object('sub', uid::text, 'email', u.email, 'email_verified', true), 'email', now(), now(), now());
    end if;
    -- profile changes are admin-only, so act as Drew (made admin on his first insert) while seeding
    perform set_config('request.jwt.claims', json_build_object('sub', (select id from public.profiles where email = 'drains@rfip.com'), 'role', 'authenticated')::text, true);
    update public.profiles set full_name = u.name, role = u.role, ops_role = u.ops_role, department = u.dept, sales_access = u.sales where id = uid;
  end loop;
end $$;

-- department leads, crews and monthly capacity
update public.departments d set lead_id = p.id, techs = v.techs, monthly_capacity = v.cap
from (values ('Tower','demo-mcapps@rfip.com',6,120000), ('DAS','demo-hseabolt@rfip.com',8,260000),
             ('Network','demo-mhochwender@rfip.com',9,420000), ('DataComm','demo-dayers@rfip.com',22,520000),
             ('Security','demo-ddell@rfip.com',5,110000)) v(dept, email, techs, cap)
join public.profiles p on p.email = v.email
where d.key = v.dept;

-- ---------- part 2a: accounts, deals and handoffs -----------------------
do $$
declare
  drew uuid := (select id from public.profiles where email = 'drains@rfip.com');
  alex uuid := (select id from public.profiles where email = 'demo-agrant@rfip.com');
  jamie uuid := (select id from public.profiles where email = 'demo-jortiz@rfip.com');
  r record; did uuid;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', drew, 'role', 'authenticated')::text, true);
  if exists (select 1 from public.deals) then raise exception 'Sample data is already loaded. This script is for an empty test database.'; end if;

  insert into public.accounts (name, type, vertical, city, state) values
    ('Big Sky Arena','Owner / end user','Stadiums & venues','Billings','MT'),
    ('Red River Medical Center','Owner / end user','Healthcare','Wichita Falls','TX'),
    ('Cimarron Energy','Owner / end user','Oil & energy','Oklahoma City','OK'),
    ('Prairie Data Center','Owner / end user','Data centers','Tulsa','OK'),
    ('Sandhill Public Schools','Owner / end user','Government','Shawnee','OK'),
    ('Midwest Wireless Carrier','Carrier / neutral host','Enterprise','Kansas City','MO'),
    ('Cherokee County','Owner / end user','Government','Tahlequah','OK'),
    ('Regional Children''s Hospital','Owner / end user','Healthcare','Birmingham','AL'),
    ('State University Athletics','Owner / end user','Collegiate athletics','Stillwater','OK'),
    ('Summit Electrical Contractors','Electrical contractor','Data centers','Dallas','TX'),
    ('South Plains Convention Center','Owner / end user','Stadiums & venues','Lubbock','TX'),
    ('Midstream Logistics','Owner / end user','Enterprise','Cushing','OK'),
    ('Green Country Health Clinics','Owner / end user','Healthcare','Muskogee','OK'),
    ('Riverfront Soccer Stadium','Owner / end user','Stadiums & venues','Tulsa','OK'),
    ('Metro County','Owner / end user','Government','Norman','OK'),
    ('University of the Plains','Owner / end user','Collegiate athletics','Lubbock','TX'),
    ('Downtown Arena Partners','General contractor','Stadiums & venues','Oklahoma City','OK'),
    ('Mercy Plains Hospital','Owner / end user','Healthcare','Amarillo','TX'),
    ('Capitol Office Tower','Owner / end user','Enterprise','Oklahoma City','OK'),
    ('Prairie Retail Group','Owner / end user','Retail & auto','Wichita','KS');

  -- won deals behind the active projects
  for r in select * from (values
    ('Concourse Wi-Fi refresh','Big Sky Arena',842000,'2026-06-18','{Wi-Fi,Network}','agrant'),
    ('Clinic tower DAS','Red River Medical Center',1265000,'2026-05-28','{DAS}','jortiz'),
    ('Admin campus structured cabling','Cimarron Energy',618000,'2026-07-08','{Structured cabling}','agrant'),
    ('Data hall fiber backbone','Prairie Data Center',934000,'2026-09-02','{Fiber,Structured cabling}','drew'),
    ('Elementary schools cabling, phase 2','Sandhill Public Schools',388000,'2026-04-20','{Structured cabling}','jortiz'),
    ('Monopole antenna swap, 6 sites','Midwest Wireless Carrier',214000,'2026-08-21','{Tower}','agrant'),
    ('Courthouse access control and cameras','Cherokee County',276000,'2026-09-15','{Security}','jortiz'),
    ('Core switch stack replacement','Regional Children''s Hospital',356000,'2026-07-10','{Network}','drew'),
    ('Stadium bowl Wi-Fi validation survey','State University Athletics',68000,'2026-09-10','{Wi-Fi}','agrant'),
    ('Temporary site network','Summit Electrical Contractors',1480000,'2026-06-12','{Network,Wi-Fi}','drew'),
    ('Convention center Wi-Fi design/build','South Plains Convention Center',742000,'2026-09-18','{Wi-Fi,Network}','agrant'),
    ('Hospital annex DAS','Red River Medical Center',488000,'2026-09-24','{DAS}','jortiz'),
    ('Warehouse cabling, 3 buildings','Midstream Logistics',212000,'2026-09-09','{Structured cabling}','agrant'),
    ('Perimeter camera upgrade','Green Country Health Clinics',154000,'2026-09-29','{Security}','jortiz')
  ) v(name, acct, val, won, svc, own) loop
    insert into public.deals (name, account_id, owner_id, stage, value, close_date, services, outcome_reason, source, vertical, gng)
    values (r.name, (select id from public.accounts where name = r.acct),
            case r.own when 'agrant' then alex when 'jortiz' then jamie else drew end,
            'won', r.val, r.won::date, r.svc::text[], 'Relationship', 'Invited bid',
            (select vertical from public.accounts where name = r.acct), '{"scores":{},"decision":"go"}'::jsonb);
  end loop;

  -- open pipeline and recent losses
  insert into public.deals (name, account_id, owner_id, stage, value, bid_due, close_date, services, vertical, source, gng, outcome_reason, winning_competitor)
  select v.name, (select id from public.accounts where name = v.acct), case v.own when 'agrant' then alex when 'jortiz' then jamie else drew end,
         v.stage, v.val, v.due::date, v.closed::date, v.svc::text[], (select vertical from public.accounts where name = v.acct), 'Public RFP',
         case when v.dec is null then '{"scores":{}}'::jsonb else jsonb_build_object('scores','{}'::jsonb,'decision',v.dec) end, v.reason, v.comp
  from (values
    ('Stadium neutral-host DAS','Riverfront Soccer Stadium','proposal',3200000,'2026-10-06',null,'{DAS}','agrant','go',null,null),
    ('County network infrastructure bid','Metro County','proposal',1450000,'2026-10-09',null,'{Network}','jortiz','go',null,null),
    ('University stadium firewall','University of the Plains','qualifying',410000,'2026-10-12',null,'{Network}','agrant',null,null,null),
    ('Arena structured cabling (GC sub)','Downtown Arena Partners','proposal',2100000,'2026-10-15',null,'{Structured cabling}','drew','hold',null,null),
    ('Hospital campus Wi-Fi refresh','Mercy Plains Hospital','qualifying',640000,'2026-10-15',null,'{Wi-Fi}','jortiz',null,null,null),
    ('Downtown office tower DAS','Capitol Office Tower','lost',1150000,null,'2026-09-16','{DAS}','agrant',null,'Price','National integrator'),
    ('Retail chain Wi-Fi surveys','Prairie Retail Group','nobid',96000,null,'2026-09-22','{Wi-Fi}','jortiz',null,'Margin too low',null)
  ) v(name, acct, stage, val, due, closed, svc, own, dec, reason, comp);

  -- the four won deals still waiting on ops (handoffs were opened by the win trigger)
  update public.handoffs h set status = 'packet', department = 'Network', packet = '{"contract_value":742000,"start_date":"2026-11-30","end_date":"2027-05-28","labor_hours":4300,"material":168000,"subcontract":22000,"equipment":9000,"retainage_pct":10,"pay_app_day":25,"contract_signed":false,"sov_attached":false,"customer_pm":"Dana Ruiz, facilities director","site_contact":"Dana Ruiz","billing_contact":"","site_access":"Badging through venue security; no work during events","scope":"Design and install ~210 APs, MDF/IDF switching, wireless controller","exclusions":"Electrical, lifts over 40 ft","billing_terms":"Monthly progress billing against SOV, 10% retainage"}'
  from public.deals d where d.id = h.deal_id and d.name = 'Convention center Wi-Fi design/build';

  update public.handoffs h set department = 'DAS', pm_id = (select id from public.profiles where email = 'demo-cmoran@rfip.com'),
    packet = '{"contract_value":488000,"start_date":"2026-11-02","end_date":"2027-03-26","labor_hours":2600,"material":128000,"subcontract":18000,"equipment":6000,"retainage_pct":10,"pay_app_day":25,"contract_signed":true,"sov_attached":true,"customer_pm":"Lee Harmon, construction manager","site_contact":"Lee Harmon","billing_contact":"Accounts payable, Red River Medical Center","site_access":"ICRA permits required above ceilings; hospital badging","safety_reqs":"Infection control class III","scope":"Passive DAS, 3 carriers, annex floors 1–5","exclusions":"Carrier head-end equipment","billing_terms":"Monthly progress billing, 10% retainage"}'
  from public.deals d where d.id = h.deal_id and d.name = 'Hospital annex DAS';
  update public.handoffs h set status = 'review' from public.deals d where d.id = h.deal_id and d.name = 'Hospital annex DAS';

  update public.handoffs h set department = 'DataComm',
    packet = '{"contract_value":212000,"start_date":"2026-10-26","end_date":"2027-01-15","material":61000,"retainage_pct":5,"contract_signed":true,"sov_attached":true,"customer_pm":"Chris Vance","site_contact":"Chris Vance","billing_contact":"ap@midstream.example","scope":"Category 6 and fiber backbone, three warehouse buildings","billing_terms":"Net 30, 5% retainage"}'
  from public.deals d where d.id = h.deal_id and d.name = 'Warehouse cabling, 3 buildings';
  update public.handoffs h set status = 'review' from public.deals d where d.id = h.deal_id and d.name = 'Warehouse cabling, 3 buildings';
  update public.handoffs h set status = 'kicked_back', kickback_reason = 'Need the labor estimate broken out by building, and the site access requirements.'
  from public.deals d where d.id = h.deal_id and d.name = 'Warehouse cabling, 3 buildings';

  update public.handoffs h set department = 'Security', pm_id = (select id from public.profiles where email = 'demo-swhitfield@rfip.com'),
    packet = '{"contract_value":154000,"start_date":"2026-12-07","end_date":"2027-02-26","labor_hours":900,"material":52000,"subcontract":6000,"equipment":3000,"retainage_pct":5,"contract_signed":true,"sov_attached":true,"customer_pm":"Renee Walker","billing_contact":"Finance office","site_access":"Clinic hours only","scope":"Replace 46 exterior cameras across 4 clinics","billing_terms":"Monthly, 5% retainage"}'
  from public.deals d where d.id = h.deal_id and d.name = 'Perimeter camera upgrade';
end $$;

-- ---------- part 2b: projects, budgets, labor, billing, change orders ----
do $$
declare
  drew uuid := (select id from public.profiles where email = 'drains@rfip.com');
  r record; pid uuid; did uuid; total numeric; nonlabor numeric; n int; wsum numeric; i int; wk date;
  months date[] := array['2026-05-01','2026-06-01','2026-07-01','2026-08-01','2026-09-01','2026-10-01','2026-11-01','2026-12-01','2027-01-01','2027-02-01','2027-03-01']::date[];
  today date := '2026-10-02';
begin
  perform set_config('request.jwt.claims', json_build_object('sub', drew, 'role', 'authenticated')::text, true);
  if exists (select 1 from public.projects) then raise exception 'Projects are already loaded.'; end if;
  for r in select * from (values
    ('26-118','Concourse Wi-Fi refresh','Network','demo-jpike@rfip.com','in_progress',842000,10,5200,4480,62,29,'2026-07-13','2026-11-20',25, 36500, array[0,0,85,175,210,150,180,78.5,0,0,0]::numeric[]),
    ('26-121','Clinic tower DAS','DAS','demo-cmoran@rfip.com','in_progress',1265000,10,7400,3410,48,31,'2026-06-22','2027-01-29',25, 0, array[0,60,140,170,190,170,180,160,195,0,0]::numeric[]),
    ('26-124','Admin campus structured cabling','DataComm','demo-treese@rfip.com','in_progress',618000,5,6100,4720,71,27,'2026-07-27','2026-11-06',20, 22000, array[0,0,0,140,255,150,95,0,0,0,0]::numeric[]),
    ('26-127','Data hall fiber backbone','DataComm','demo-treese@rfip.com','mobilizing',934000,10,8200,180,3,26,'2026-10-12','2027-02-26',30, 0, array[0,0,0,0,93.4,60,180,200,210,190.6,0]::numeric[]),
    ('26-109','Elementary schools cabling, phase 2','DataComm','demo-acole@rfip.com','closeout',388000,5,3900,4010,98,24,'2026-05-18','2026-09-25',15, 14200, array[40,95,110,97,0,60.2,0,0,0,0,0]::numeric[]),
    ('26-130','Monopole antenna swap, 6 sites','Tower','demo-rbanks@rfip.com','in_progress',214000,0,1300,760,40,34,'2026-09-08','2026-11-13',31, 0, array[0,0,0,0,64,90,60,0,0,0,0]::numeric[]),
    ('26-133','Courthouse access control and cameras','Security','demo-swhitfield@rfip.com','mobilizing',276000,5,1650,0,0,30,'2026-10-14','2026-12-18',31, 0, array[0,0,0,0,0,40,110,126,0,0,0]::numeric[]),
    ('26-115','Core switch stack replacement','Network','demo-jpike@rfip.com','closeout',356000,10,900,870,100,22,'2026-08-03','2026-09-18',15, 0, array[0,0,0,180,122.6,53.4,0,0,0,0,0]::numeric[]),
    ('26-136','Stadium bowl Wi-Fi validation survey','Network','demo-mhale@rfip.com','in_progress',68000,0,420,205,55,41,'2026-09-21','2026-10-23',23, 0, array[0,0,0,0,34,34,0,0,0,0,0]::numeric[]),
    ('26-112','Temporary site network','Network','demo-mhale@rfip.com','in_progress',1480000,10,9800,4150,36,25,'2026-07-06','2027-03-31',25, 118000, array[0,0,90,190,240,170,160,150,170,180,248]::numeric[])
  ) v(num, name, dept, pm, phase, contract, ret, hb, hu, pct, est, s, e, payday, co_appr, bill) loop
    select id into did from public.deals where name = r.name;
    insert into public.projects (number, name, deal_id, account_id, department, pm_id, phase, contract_value, retainage_pct, labor_rate,
      hours_budget, pct_complete, start_date, end_date, pay_app_day, sold_by, sold_margin, accepted_at)
    select r.num, r.name, d.id, d.account_id, r.dept, (select id from public.profiles where email = r.pm), r.phase, r.contract, r.ret, 68,
      r.hb, r.pct, r.s::date, r.e::date, r.payday, d.owner_id, r.est, (r.s::date - 21)::timestamptz
    from public.deals d where d.id = did
    returning id into pid;
    update public.handoffs set status = 'accepted', project_id = pid, pm_id = (select id from public.profiles where email = r.pm),
      accepted_at = (r.s::date - 21)::timestamptz, submitted_at = (r.s::date - 25)::timestamptz where deal_id = did;

    -- budget: everything the sold margin leaves after labor, split material / subs / equipment
    total := r.contract + r.co_appr;
    nonlabor := total * (1 - r.est / 100.0) - r.hb * 68;
    if r.num <> '26-118' then
      insert into public.cost_lines (project_id, code, label, budget, committed, actual, forecast, sort) values
        (pid, 'material', 'Material', round(nonlabor * .75), case when r.phase = 'mobilizing' or r.pct > 0 then round(nonlabor * .75 * .97) end, round(nonlabor * .75 * least(1, r.pct / 100.0 * 1.05)), round(nonlabor * .75), 1),
        (pid, 'subcontract', 'Subcontract', round(nonlabor * .15), case when r.pct > 0 then round(nonlabor * .15) end, round(nonlabor * .15 * r.pct / 100.0), round(nonlabor * .15), 2),
        (pid, 'equipment', 'Equipment and lifts', round(nonlabor * .10), case when r.pct > 0 then round(nonlabor * .08) end, round(nonlabor * .10 * r.pct / 100.0), round(nonlabor * .10), 3);
    end if;

    -- billing by month: before October = billed, October on = scheduled
    for i in 1..11 loop
      if r.bill[i] > 0 then
        insert into public.billings (project_id, month, kind, amount, invoice_no)
        values (pid, months[i], case when months[i] < '2026-10-01' then 'billed' else 'scheduled' end, r.bill[i] * 1000,
                case when months[i] < '2026-10-01' then 'INV-' || replace(r.num, '-', '') || '-' || to_char(months[i], 'MM') end);
      end if;
    end loop;

    -- weekly labor (stands in for job-coded timecards): ramp up over 3 weeks, then steady
    if r.num <> '26-118' and r.hu > 0 then
      n := ((date '2026-09-28' - date_trunc('week', r.s::date)::date) / 7) + 1;
      wsum := 0; for i in 1..n loop wsum := wsum + least(i, 3); end loop;
      for i in 1..n loop
        wk := date_trunc('week', r.s::date)::date + (i - 1) * 7;
        insert into public.labor_weeks (project_id, week_start, hours, pct_complete)
        values (pid, wk, round(r.hu * least(i, 3) / wsum, 1),
                round(r.pct * (select sum(least(j, 3)) from generate_series(1, i) j) / wsum, 1));
      end loop;
    end if;

    -- generic milestones at 0 / 30 / 70 / 100 % of the schedule
    if r.num <> '26-118' then
      insert into public.milestones (project_id, name, planned, actual, progress, sort)
      select pid, m.name, m.planned,
             case when r.pct >= m.f * 100 and m.planned <= today then m.planned end,
             case when r.pct < m.f * 100 and r.pct >= m.prev * 100 and r.pct > 0 then round((r.pct - m.prev * 100) / ((m.f - m.prev) * 100) * 100) end,
             m.sort
      from (select v2.name, v2.f, v2.prev, v2.sort, (r.s::date + round((r.e::date - r.s::date) * v2.f)::int) as planned
            from (values ('Mobilize', 0.0, 0.0, 1), ('Rough-in and pathways', 0.3, 0.0, 2), ('Install and terminate', 0.7, 0.3, 3), ('Test, punch and closeout', 1.0, 0.7, 4)) v2(name, f, prev, sort)) m;
    end if;
  end loop;

  -- change orders
  insert into public.change_orders (project_id, number, description, amount, status, submitted_on, decided_on, note)
  select p.id, v.no, v.d, v.amt, v.st, v.sub::date, v.dec::date, v.note from (values
    ('26-118','CO-01','Add 12 APs, club level',22000,'approved','2026-08-06','2026-08-14',null),
    ('26-118','CO-02','Relocate IDF 3 fiber run',14500,'approved','2026-08-25','2026-09-02',null),
    ('26-118','CO-03','Additional drops, suite level (38)',18400,'pending','2026-09-24',null,'Customer asked during Sep 29 walk'),
    ('26-118','CO-04','Lift standby, concessions blocking access',null,'not_priced',null,null,'Logged from the field Oct 1'),
    ('26-124','CO-01','Add 24 drops, 2nd floor training rooms',22000,'approved','2026-08-18','2026-08-27',null),
    ('26-109','CO-01','Library annex drops',14200,'approved','2026-07-01','2026-07-09',null),
    ('26-112','CO-01','Phase 2 laydown yard network',118000,'approved','2026-08-10','2026-08-21',null),
    ('26-112','CO-02','Additional COW connectivity',46000,'pending','2026-09-21',null,'With GC for owner approval'),
    ('26-130','CO-01','Additional site: tower 7 antenna swap',9600,'pending','2026-09-25',null,null)
  ) v(num, no, d, amt, st, sub, dec, note) join public.projects p on p.number = v.num;

  -- crew plan, weeks of Oct 5 to Nov 23
  insert into public.crew_plan (project_id, week_start, techs)
  select p.id, date '2026-10-05' + (w - 1) * 7, (v.techs)[w]
  from (values
    ('26-130', array[5,5,6,6,3,2,2,2]),
    ('26-121', array[7,7,8,9,9,8,6,5]),
    ('26-118', array[5,5,5,4,3,2,0,0]),
    ('26-136', array[1,1,1,0,0,0,0,0]),
    ('26-112', array[3,4,3,4,3,4,5,5]),
    ('26-124', array[15,17,15,12,9,5,0,0]),
    ('26-127', array[0,7,10,11,12,13,14,12]),
    ('26-109', array[2,0,0,0,0,0,0,0]),
    ('26-133', array[1,4,5,5,5,4,3,2])
  ) v(num, techs) join public.projects p on p.number = v.num cross join generate_series(1, 8) w
  where (v.techs)[w] > 0;
end $$;

-- ---------- part 2c: field detail ----------------------------------------
do $$
declare
  drew uuid := (select id from public.profiles where email = 'drains@rfip.com');
  ray uuid := (select id from public.profiles where email = 'demo-rdelgado@rfip.com');
  p118 uuid := (select id from public.projects where number = '26-118');
  i int; wk date;
  hrs numeric[] := array[180,260,340,400,420,440,430,420,410,400,390,390];
  pc numeric[] := array[3,7,12,18,24,30,36,42,47,52,57,62];
begin
  perform set_config('request.jwt.claims', json_build_object('sub', drew, 'role', 'authenticated')::text, true);
  if exists (select 1 from public.daily_logs) then raise exception 'Field detail is already loaded.'; end if;

  -- the Concourse Wi-Fi job used in the demo
  for i in 1..12 loop
    insert into public.labor_weeks (project_id, week_start, hours, pct_complete) values (p118, date '2026-07-13' + (i - 1) * 7, hrs[i], pc[i]);
  end loop;
  insert into public.cost_lines (project_id, code, label, budget, committed, actual, forecast, sort) values
    (p118, 'material', 'Material', 228000, 224800, 184000, 226500, 1),
    (p118, 'subcontract', 'Subcontract (core drilling)', 28000, 27000, 16200, 27000, 2),
    (p118, 'equipment', 'Equipment (lifts)', 14135, 12000, 9100, 13500, 3);
  insert into public.milestones (project_id, name, planned, actual, progress, note, sort) values
    (p118, 'Mobilize', '2026-07-13', '2026-07-13', null, null, 1),
    (p118, 'Pathways and backboxes', '2026-08-21', '2026-08-20', null, null, 2),
    (p118, 'Cable pull complete', '2026-09-25', '2026-09-30', null, 'Finished 5 days late', 3),
    (p118, 'AP install', '2026-10-23', null, 70, '130 of 186 mounted', 4),
    (p118, 'Switch config and cutover', '2026-11-03', null, null, null, 5),
    (p118, 'Validation survey', '2026-11-10', null, null, null, 6),
    (p118, 'Punch list and closeout', '2026-11-20', null, null, null, 7);
  insert into public.materials (project_id, item, qty, received, status, eta, note) values
    (p118, 'Wireless APs', 186, 186, 'received', null, null),
    (p118, 'AP mounts and enclosures', 186, 186, 'received', null, null),
    (p118, 'Cat6A plenum (1,000 ft boxes)', 120, 112, 'partial', '2026-10-06', '8 boxes due Oct 6'),
    (p118, 'SFP+ optics', 48, 0, 'backordered', '2026-10-16', 'Needed for cutover Nov 3; checking alternate distributor'),
    (p118, 'Club-level APs (CO-01)', 12, 0, 'ordered', '2026-10-08', null);
  insert into public.daily_logs (project_id, log_date, author_id, crew_count, hours, work, issues) values
    (p118, '2026-10-01', ray, 6, 48, 'Mounted 22 APs, sections 120–128. Labeled and patched IDF 4.', 'Lift access blocked 2 hrs by concessions delivery. Logged as CO-04.'),
    (p118, '2026-09-30', ray, 7, 56, 'Cable pull complete. Certified 96 runs on upper concourse.', null),
    (p118, '2026-09-29', ray, 7, 58, 'Pulled final suite-level runs. Customer walk with arena IT on club level.', 'Customer asked for 38 more suite drops. Priced as CO-03.'),
    (p118, '2026-09-28', ray, 6, 47, 'Safety tailgate on lift use. Pulled 140 runs, sections 300–310.', null);
  insert into public.crew_roster (project_id, name, role, profile_id, days, sort) values
    (p118, 'Ray Delgado', 'Foreman', ray, 'MTWRF', 1),
    (p118, 'T. Nguyen', 'Lead tech', null, 'MTWRF', 2),
    (p118, 'K. Brooks', 'Tech', null, 'MTWRF', 3),
    (p118, 'L. Ramirez', 'Tech', null, 'MTWR', 4),
    (p118, 'J. Whitaker', 'Tech', null, 'MTRF', 5),
    (p118, 'M. Osei', 'Apprentice', null, 'TWRF', 6);
  insert into public.closeout_items (project_id, item, status, note, sort) values
    (p118, 'Cable certification results', 'in_progress', '1,240 of 1,312 runs certified', 1),
    (p118, 'As-built drawings', 'in_progress', 'Upper concourse done', 2),
    (p118, 'AP heat map validation report', 'todo', null, 3),
    (p118, 'Warranty and O&M documents', 'todo', null, 4),
    (p118, 'Customer punch walk and sign-off', 'todo', null, 5),
    (p118, 'Final lien waivers', 'todo', null, 6),
    (p118, 'Retainage release request', 'todo', null, 7);

  -- a few things other jobs need for the demo story
  insert into public.labor_weeks (project_id, week_start, hours, pct_complete)
  select id, '2026-09-28', 180, 3 from public.projects where number = '26-127';
  insert into public.milestones (project_id, name, planned, actual, progress, note, sort)
  select id, 'Ceiling access, floors 4–6', '2026-09-23', null, 40, 'Waiting on hospital infection-control permits', 3 from public.projects where number = '26-121';
  update public.milestones set note = 'Final documents still open' where name = 'Test, punch and closeout' and project_id = (select id from public.projects where number = '26-109');

  insert into public.materials (project_id, item, qty, received, status, eta, note)
  select p.id, v.item, v.qty, v.rec, v.st, v.eta::date, v.note from (values
    ('26-127','Single-mode fiber trunks (144 strand)',48,0,'ordered','2026-10-09',null),
    ('26-127','Rack-mount fiber enclosures',24,0,'ordered','2026-10-14',null),
    ('26-127','Ladder rack (ft)',600,0,'ordered','2026-10-12',null),
    ('26-127','Fiber patch panels',60,0,'to_order',null,'Waiting on final row layout'),
    ('26-133','Card readers and controllers',18,0,'ordered','2026-10-13',null),
    ('26-133','IP cameras',42,20,'partial','2026-10-16',null),
    ('26-121','Coax, connectors and splitters',1,1,'received',null,null),
    ('26-121','Antennas',96,64,'partial','2026-10-09','Floors 4–6 antennas on hand when access opens'),
    ('26-124','Category 6A cable and connectivity',1,1,'received',null,null),
    ('26-112','Outdoor APs and mounts',40,40,'received',null,null),
    ('26-130','Antennas and RRU brackets',18,18,'received',null,null)
  ) v(num, item, qty, rec, st, eta, note) join public.projects p on p.number = v.num;

  insert into public.daily_logs (project_id, log_date, author_id, crew_count, hours, work, issues)
  select p.id, v.d::date, drew, v.c, v.h, v.w, v.i from (values
    ('26-121','2026-10-01',7,56,'Floors 2–3 antenna install complete. Coax home runs to IDF 2.','Ceiling access on floors 4–6 still blocked pending infection-control permits.'),
    ('26-124','2026-10-01',15,120,'Terminated 120 drops in building B. Started testing building A.',null),
    ('26-112','2026-09-30',4,32,'Connected two new site trailers. Moved COW uplink to new pole.',null),
    ('26-130','2026-09-30',5,40,'Completed site 3 antenna swap. Site 4 scheduled Monday.',null)
  ) v(num, d, c, h, w, i) join public.projects p on p.number = v.num;

  insert into public.crew_roster (project_id, name, role, days, sort)
  select p.id, v.n, v.r, 'MTWRF', v.s from (values
    ('26-121','S. Patel','Foreman',1),('26-121','D. King','Tech',2),('26-121','A. Flores','Tech',3),
    ('26-124','B. Howard','Foreman',1),('26-124','C. Lin','Lead tech',2),('26-124','E. Grant','Tech',3),
    ('26-112','H. Ross','Lead tech',1),('26-112','J. Moss','Tech',2),
    ('26-130','W. Teague','Climber / foreman',1),('26-130','G. Byrd','Climber',2),
    ('26-133','P. Nash','Lead tech',1),('26-133','O. Reyes','Tech',2),
    ('26-136','N. Parks','RF engineer',1)
  ) v(num, n, r, s) join public.projects p on p.number = v.num;

  -- closeout lists: the two closeout jobs are missing documents
  insert into public.closeout_items (project_id, item, status, note, sort)
  select p.id, v.item, v.st, v.note, v.s from (values
    ('26-109','Cable certification results','done',null,1),('26-109','As-built drawings','todo','Holding final invoice',2),
    ('26-109','Warranty and O&M documents','todo','Holding final invoice',3),('26-109','Customer punch walk and sign-off','done',null,4),
    ('26-109','Final lien waivers','done',null,5),('26-109','Retainage release request','done','Submitted Sep 30',6),
    ('26-115','Configuration backups and test results','done',null,1),('26-115','As-built drawings','done',null,2),
    ('26-115','Warranty and support contract documents','todo',null,3),('26-115','Customer sign-off','done',null,4),
    ('26-115','Retainage release request','done','Submitted Sep 28',5)
  ) v(num, item, st, note, s) join public.projects p on p.number = v.num;
  insert into public.closeout_items (project_id, item, sort)
  select p.id, v.item, v.s from public.projects p cross join (values
    ('Test and certification results',1),('As-built drawings',2),('Warranty and O&M documents',3),
    ('Customer punch walk and sign-off',4),('Final lien waivers',5),('Retainage release request',6)) v(item, s)
  where p.number not in ('26-118','26-109','26-115');

  -- safety: last recordable per department, plus September near-misses
  insert into public.safety_events (department, event_date, kind, note, reported_by) values
    ('Tower','2026-03-05','recordable','Strained shoulder during antenna lift',drew),
    ('DAS','2026-05-13','recordable','Laceration from ceiling grid',drew),
    ('Network','2025-11-28','recordable','Ladder slip, sprained ankle',drew),
    ('DataComm','2026-06-28','recordable','Eye injury, cable-cutting debris',drew),
    ('Security','2025-10-02','recordable','Back strain lifting camera pole',drew),
    ('DataComm','2026-09-08','near_miss','Unsecured ladder in IDF',drew),
    ('DataComm','2026-09-17','near_miss','Open floor box in walkway',drew),
    ('Network','2026-09-12','near_miss','Lift outrigger near trench',drew),
    ('DAS','2026-09-15','near_miss','Ceiling tile dropped near walkway',drew),
    ('Tower','2026-09-22','near_miss','Tag line not attached during hoist',drew),
    ('Network','2026-09-29','near_miss','Concessions cart under lift',drew);
end $$;

-- ---------- part 2d: who submitted the waiting handoffs --------------------
update public.handoffs h set submitted_by = d.owner_id from public.deals d where d.id = h.deal_id and h.submitted_by is not null;
update public.handoffs h set submitted_at = '2026-09-26 15:00-05' from public.deals d where d.id = h.deal_id and d.name = 'Hospital annex DAS';
update public.handoffs h set submitted_at = '2026-09-14 10:00-05', reviewed_by = (select id from public.profiles where email = 'demo-dayers@rfip.com')
from public.deals d where d.id = h.deal_id and d.name = 'Warehouse cabling, 3 buildings';

-- ---------- part 3: manpower schedule (run after manpower_schema.sql) --------
-- 50 field techs and their day-by-day assignments from Sep 28 to Nov 27, built
-- from each project's weekly crew plan. Data hall fiber (26-127) is left
-- unstaffed on purpose so the board shows a real shortage.
do $$
declare
  drew uuid := (select id from public.profiles where email = 'drains@rfip.com');
  w date; d date; r record; t record; need int; i int;
  holidays date[] := array['2026-11-26','2026-11-27']::date[];
begin
  perform set_config('request.jwt.claims', json_build_object('sub', drew, 'role', 'authenticated')::text, true);
  if exists (select 1 from public.techs) then raise exception 'Techs are already loaded.'; end if;

  create temp table seed_home (tech_id uuid, home text) on commit drop;
  with v(name, dept, trade, home, s) as (values
    ('W. Teague','Tower','Climber / foreman','26-130',1),('G. Byrd','Tower','Climber','26-130',2),('R. Fields','Tower','Climber','26-130',3),
    ('C. Dunn','Tower','Climber','26-130',4),('T. Avery','Tower','Tech','26-130',5),('B. Lowe','Tower','Tech','26-130',6),
    ('S. Patel','DAS','Foreman','26-121',1),('M. Ochoa','DAS','Lead tech','26-121',2),('D. King','DAS','Tech','26-121',3),('A. Flores','DAS','Tech','26-121',4),
    ('J. Hale','DAS','Tech','26-121',5),('R. Price','DAS','Tech','26-121',6),('K. Young','DAS','Tech','26-121',7),('L. Vance','DAS','Apprentice','26-121',8),
    ('Ray Delgado','Network','Foreman','26-118',1),('T. Nguyen','Network','Lead tech','26-118',2),('K. Brooks','Network','Tech','26-118',3),
    ('L. Ramirez','Network','Tech','26-118',4),('J. Whitaker','Network','Tech','26-118',5),('M. Osei','Network','Apprentice','26-118',6),
    ('H. Ross','Network','Lead tech','26-112',7),('J. Moss','Network','Tech','26-112',8),('N. Parks','Network','RF engineer','26-136',9),
    ('B. Howard','DataComm','Foreman','26-124',1),('C. Lin','DataComm','Lead tech','26-124',2),('E. Grant','DataComm','Tech','26-124',3),
    ('A. Diaz','DataComm','Tech','26-124',4),('J. Ellis','DataComm','Tech','26-124',5),('M. Ford','DataComm','Tech','26-124',6),
    ('S. Bell','DataComm','Tech','26-124',7),('T. Cruz','DataComm','Tech','26-124',8),('R. Webb','DataComm','Tech','26-124',9),
    ('D. Lane','DataComm','Tech','26-124',10),('K. Hayes','DataComm','Tech','26-124',11),('P. Wade','DataComm','Tech','26-124',12),
    ('G. Ortiz','DataComm','Apprentice','26-124',13),('N. Reed','DataComm','Apprentice','26-124',14),('C. Moss','DataComm','Tech','26-124',15),
    ('F. Nunez','DataComm','Foreman','26-109',16),('P. Shaw','DataComm','Tech','26-109',17),
    ('V. Long','DataComm','Lead tech',null,18),('H. Kerr','DataComm','Tech',null,19),('J. Pruitt','DataComm','Tech',null,20),
    ('E. Sloan','DataComm','Apprentice',null,21),('M. Tate','DataComm','Apprentice',null,22),
    ('P. Nash','Security','Lead tech','26-133',1),('O. Reyes','Security','Tech','26-133',2),('D. Carter','Security','Tech','26-133',3),
    ('S. Kim','Security','Tech','26-133',4),('V. Ruiz','Security','Apprentice','26-133',5)
  ), ins as (
    insert into public.techs (name, department, trade, sort, profile_id)
    select v.name, v.dept, v.trade, v.s, case when v.name = 'Ray Delgado' then (select id from public.profiles where email = 'demo-rdelgado@rfip.com') end from v
    returning id, name
  )
  insert into seed_home select ins.id, v.home from ins join v on v.name = ins.name;

  -- time off first, so jobs fill around it
  insert into public.assignments (tech_id, work_date, kind, note, created_by)
  select te.id, v.d::date, v.k, v.note, drew from (values
    ('L. Ramirez','2026-10-09','pto','Family'),('K. Young','2026-10-19','pto',null),('K. Young','2026-10-20','pto',null),
    ('J. Ellis','2026-10-15','training','Fiber splicing certification'),('J. Ellis','2026-10-16','training','Fiber splicing certification'),
    ('G. Byrd','2026-10-23','pto',null),('S. Patel','2026-11-02','training','OSHA 30')
  ) v(name, d, k, note) join public.techs te on te.name = v.name;

  -- weekly crew plan → daily assignments, home crews first
  for i in 0..8 loop
    w := date '2026-09-28' + i * 7;
    for r in select p.id, p.number, p.department, cp.techs from public.projects p
             join public.crew_plan cp on cp.project_id = p.id and cp.week_start = greatest(w, date '2026-10-05')
             where p.number <> '26-127' and cp.techs > 0 order by p.number loop
      for t in select te.id from public.techs te join seed_home sh on sh.tech_id = te.id
               where te.department = r.department
                 and not exists (select 1 from public.assignments a where a.tech_id = te.id and a.kind = 'job' and a.work_date between w and w + 4)
               order by (sh.home = r.number) desc, te.sort limit r.techs loop
        for d in select generate_series(w, w + 4, interval '1 day')::date loop
          if not d = any(holidays) then
            insert into public.assignments (tech_id, work_date, kind, project_id, created_by)
            values (t.id, d, 'job', r.id, drew) on conflict (tech_id, work_date) do nothing;
          end if;
        end loop;
      end loop;
    end loop;
  end loop;
end $$;

-- ---------- part 3b: keep home crews on their own jobs ------------------------
-- Same people working each week; reassigns which job each is on, home crews first.
do $$
declare
  drew uuid := (select id from public.profiles where email = 'drains@rfip.com');
  i int; w date; dp text; t record; pick uuid;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', drew, 'role', 'authenticated')::text, true);
  create temp table home on commit drop as
    select te.id tech_id, te.department,
      case te.department when 'Tower' then '26-130' when 'DAS' then '26-121' when 'Security' then '26-133'
        when 'Network' then case when te.sort <= 6 then '26-118' when te.sort <= 8 then '26-112' else '26-136' end
        when 'DataComm' then case when te.sort <= 15 then '26-124' when te.sort <= 17 then '26-109' end end as home, te.sort
    from public.techs te;
  create temp table need on commit drop as
    select g::date as wk, p.id, p.number, p.department, cp.techs as left_n
    from generate_series(date '2026-09-28', date '2026-11-23', interval '7 days') g
    join public.crew_plan cp on cp.week_start = greatest(g::date, date '2026-10-05')
    join public.projects p on p.id = cp.project_id
    where p.number <> '26-127' and cp.techs > 0;
  for i in 0..8 loop
    w := date '2026-09-28' + i * 7;
    for dp in select key from public.departments loop
      for t in select h.tech_id, h.home, h.sort from home h
               where h.department = dp and exists (select 1 from public.assignments a where a.tech_id = h.tech_id and a.kind = 'job' and a.work_date between w and w + 4)
               order by (exists (select 1 from need n where n.wk = w and n.number = h.home and n.left_n > 0)) desc, h.sort loop
        pick := null;
        select n.id into pick from need n where n.wk = w and n.number = t.home and n.left_n > 0;
        if pick is null then select n.id into pick from need n where n.wk = w and n.department = dp and n.left_n > 0 order by n.number limit 1; end if;
        if pick is not null then
          update need n set left_n = n.left_n - 1 where n.wk = w and n.id = pick;
          update public.assignments set project_id = pick where tech_id = t.tech_id and kind = 'job' and work_date between w and w + 4;
        end if;
      end loop;
    end loop;
  end loop;
end $$;

-- ---------- part 3c: this week's crew needs match next week's -----------------
insert into public.crew_plan (project_id, week_start, techs)
select project_id, date '2026-09-28', techs from public.crew_plan cp
where week_start = '2026-10-05' and (select number from public.projects where id = cp.project_id) <> '26-127'
on conflict (project_id, week_start) do nothing;

-- ---------- part 4: weekly PM updates (run after docs_updates_schema.sql) -----
-- Three weeks of updates. This week's is missing for 26-121 and 26-130 on purpose.
do $$
declare drew uuid := (select id from public.profiles where email = 'drains@rfip.com');
begin
  perform set_config('request.jwt.claims', json_build_object('sub', drew, 'role', 'authenticated')::text, true);
  if exists (select 1 from public.weekly_updates) then raise exception 'Weekly updates are already loaded.'; end if;
  insert into public.weekly_updates (project_id, week_start, author_id, pct_complete, schedule_status, cost_status, safety_status, accomplished, next_week, needs, customer_notes, submitted_at)
  select p.id, v.wk::date, p.pm_id, v.pct, v.sch, v.cst, v.sfy, v.acc, v.nxt, v.need, v.cust, (v.wk::date + 4 + time '10:30')::timestamptz
  from (values
    ('26-118','2026-09-14',47,'on_track','at_risk','on_track','Cable pull 80% complete on upper concourse. IDF 3 fiber relocated (CO-02).','Finish cable pull, start AP mounting in sections 100–120.','SFP+ optics order confirmed?','Arena IT happy with progress.'),
    ('26-118','2026-09-21',57,'at_risk','at_risk','on_track','Cable pull nearly done; lost two days to concessions deliveries blocking lifts.','Finish cable pull Wednesday, start AP install.','Need lift access windows from venue ops.','Customer asked about adding suite-level drops.'),
    ('26-118','2026-09-28',62,'at_risk','off_track','on_track','Cable pull complete Sep 30 (5 days late). 22 APs mounted. Suite drops priced as CO-03.','Mount 60 APs, sections 120–150. Start certification on lower bowl.','SFP+ optics backordered to Oct 16 — need alternate source for Nov 3 cutover. Labor running 2,000 hrs over at current rate; want to discuss crew plan with Matt.','Waiting on CO-03 signature. Lift standby (CO-04) not priced yet.'),
    ('26-112','2026-09-21',33,'on_track','on_track','on_track','Phase 2 laydown yard network live (CO-01).','Connect new site trailers; move COW uplink.',null,'GC reviewing COW change order.'),
    ('26-112','2026-09-28',36,'on_track','at_risk','on_track','Connected two new trailers, moved COW uplink to new pole.','Trailer 3 and 4 connections; access point survey for laydown yard.','CO-02 ($46K) still with GC for owner approval.','GC asked for weekly network uptime report.'),
    ('26-124','2026-09-21',64,'on_track','on_track','on_track','Building B rough-in complete. Training room drops added (CO-01).','Terminate building B, start testing building A.',null,null),
    ('26-124','2026-09-28',71,'on_track','at_risk','on_track','Terminated 120 drops in building B; testing building A underway.','Finish testing, start labeling and as-builts.','Labor a little ahead of progress; crew drops to 12 after Oct 16.','Owner walkthrough set for Oct 9.'),
    ('26-127','2026-09-28',3,'at_risk','on_track','on_track','Kickoff meeting held; submittals sent for fiber enclosures and ladder rack.','Mobilize Oct 12. Receive trunks Oct 9.','No crew scheduled yet — need 7 techs starting Oct 12. Patch panel layout waiting on owner row plan.','Owner wants daily progress photos.'),
    ('26-109','2026-09-28',98,'at_risk','on_track','on_track','Punch walk complete; lien waivers in.','Finish as-builts and O&M binders.','As-builts and O&M docs holding the final invoice ($52K).','District signed punch list.'),
    ('26-115','2026-09-28',100,'on_track','on_track','on_track','Cutover complete; customer signed off.','Send warranty and support contract documents.',null,'Very happy; asked about Wi-Fi refresh next year.'),
    ('26-133','2026-09-28',0,'on_track','on_track','on_track','Submittals approved; card readers on order.','Mobilize Oct 14.','Camera shipment split — 22 arriving Oct 16.',null),
    ('26-136','2026-09-28',55,'on_track','on_track','on_track','Lower bowl survey complete, 140 points.','Upper bowl survey; draft report.',null,null),
    ('26-121','2026-09-14',40,'on_track','on_track','on_track','Floors 1–2 antenna install complete.','Floors 3–4.',null,null),
    ('26-121','2026-09-21',45,'at_risk','on_track','on_track','Floor 3 complete; floors 4–6 ceiling access delayed by infection-control permits.','Floor 2–3 home runs while waiting on permits.','Need hospital to approve ICRA permits for floors 4–6.',null),
    ('26-130','2026-09-21',30,'on_track','on_track','on_track','Sites 1 and 2 complete.','Sites 3 and 4.',null,null)
  ) v(num, wk, pct, sch, cst, sfy, acc, nxt, need, cust)
  join public.projects p on p.number = v.num;
end $$;

-- ---------- part 5: material purchasing detail (run after materials_schema.sql) --
do $$
declare drew uuid := (select id from public.profiles where email = 'drains@rfip.com');
        ray uuid := (select id from public.profiles where email = 'demo-rdelgado@rfip.com');
begin
  perform set_config('request.jwt.claims', json_build_object('sub', drew, 'role', 'authenticated')::text, true);
  if exists (select 1 from public.material_receipts) then raise exception 'Material receipts are already loaded.'; end if;
  update public.materials m set part_no = v.part, manufacturer = v.mfr, uom = v.uom, unit_cost = v.cost, distributor = v.disti, po_number = v.po,
    qty_ordered = case when m.status = 'to_order' then 0 else m.qty end, ordered_on = v.ordered::date, sort = v.s
  from (values
    ('Wireless APs','AP-635-US','HPE Aruba','ea',612.00,'CDW','PO-26118-01','2026-07-02',1),
    ('AP mounts and enclosures','AP-MNT-ENC2','Oberon','ea',148.00,'Graybar','PO-26118-02','2026-07-02',2),
    ('Cat6A plenum (1,000 ft boxes)','6A-P-BL-1000','CommScope','box',642.00,'Graybar','PO-26118-03','2026-07-08',3),
    ('SFP+ optics','J9150D','HPE Aruba','ea',245.00,'CDW','PO-26118-04','2026-09-10',4),
    ('Club-level APs (CO-01)','AP-635-US','HPE Aruba','ea',612.00,'CDW','PO-26118-05','2026-09-24',5),
    ('Single-mode fiber trunks (144 strand)','FX144-SM-MTP','Corning','ea',1180.00,'Anixter (Wesco)','PO-26127-01','2026-09-18',1),
    ('Rack-mount fiber enclosures','CCH-04U','Corning','ea',890.00,'Anixter (Wesco)','PO-26127-02','2026-09-18',2),
    ('Ladder rack (ft)','LR-12-10','Chatsworth','ft',14.50,'Accu-Tech','PO-26127-03','2026-09-22',3),
    ('Fiber patch panels','CCH-CP24-A9','Corning','ea',310.00,null,null,null,4),
    ('Card readers and controllers','MR52-OSDP','Mercury / HID','ea',540.00,'ADI Global','PO-26133-01','2026-09-25',1),
    ('IP cameras','P3268-LVE','Axis','ea',815.00,'ADI Global','PO-26133-02','2026-09-25',2),
    ('Coax, connectors and splitters','LDF4-50A kit','CommScope','lot',38600.00,'Graybar','PO-26121-01','2026-06-15',1),
    ('Antennas','CMAX-DM-CEU','CommScope','ea',265.00,'Graybar','PO-26121-02','2026-06-15',2),
    ('Category 6A cable and connectivity','6A-P-BL-1000 + jacks','Panduit','lot',61500.00,'Graybar','PO-26124-01','2026-07-20',1),
    ('Outdoor APs and mounts','AP-575-US','HPE Aruba','ea',1040.00,'CDW','PO-26112-01','2026-07-01',1),
    ('Antennas and RRU brackets','MBA-RRU-KIT','Site Pro 1','ea',420.00,'Power & Telephone Supply','PO-26130-01','2026-09-01',1)
  ) v(item, part, mfr, uom, cost, disti, po, ordered, s)
  where m.item = v.item;

  -- deliveries so far, logged as receipts (received quantities follow from these)
  insert into public.material_receipts (material_id, project_id, qty, received_on, received_by, packing_slip, note)
  select m.id, m.project_id, v.qty, v.d::date, case when v.who = 'ray' then ray else drew end, v.slip, v.note
  from (values
    ('Wireless APs', 120, '2026-07-21', 'ray', 'CDW 88412907', null),
    ('Wireless APs', 66, '2026-07-28', 'ray', 'CDW 88431150', 'Balance of order'),
    ('AP mounts and enclosures', 186, '2026-07-16', 'ray', 'GB 4471-2219', null),
    ('Cat6A plenum (1,000 ft boxes)', 80, '2026-07-14', 'ray', 'GB 4469-0012', null),
    ('Cat6A plenum (1,000 ft boxes)', 32, '2026-08-19', 'ray', 'GB 4490-7731', '8 boxes still due'),
    ('IP cameras', 20, '2026-09-30', 'drew', 'ADI 7712093', 'Split shipment; 22 due Oct 16'),
    ('Coax, connectors and splitters', 1, '2026-06-26', 'drew', 'GB 4402-1188', null),
    ('Antennas', 64, '2026-07-02', 'drew', 'GB 4410-3320', 'Floors 1–3'),
    ('Category 6A cable and connectivity', 1, '2026-07-31', 'drew', 'GB 4480-5512', null),
    ('Outdoor APs and mounts', 40, '2026-07-10', 'drew', 'CDW 88397771', null),
    ('Antennas and RRU brackets', 18, '2026-09-04', 'drew', 'PTS 22091', null)
  ) v(item, qty, d, who, slip, note)
  join public.materials m on m.item = v.item;
end $$;

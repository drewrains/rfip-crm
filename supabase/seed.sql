-- =====================================================================
-- RFIP CRM — starting data (current pursuits)
--
-- Run this AFTER you have signed in to the CRM once with drains@rfip.com
-- (that sign-in creates your admin profile, which these deals are assigned to).
-- Supabase: SQL Editor → New query → paste → Run. Safe to re-run; it skips
-- anything that already exists. Reassign deals to reps later in the app.
-- =====================================================================
do $$
declare
  drew uuid := (select id from public.profiles where email = 'drains@rfip.com');
  a_orl uuid; a_lub uuid; a_peg uuid; a_uga uuid; a_cnh uuid; a_div uuid; a_okc uuid; a_cty uuid; a_dcfc uuid; a_pdi uuid;
  c_hladik uuid; c_raymond uuid; c_wylie uuid; d_cws uuid; d_lub uuid; d_fleet uuid;
begin
  if drew is null then
    raise exception 'Sign in to the CRM once as drains@rfip.com first, then run this again.';
  end if;

  -- accounts (whole team sees these)
  create temp table _acc(name text, type text, vertical text, city text, state text, notes text) on commit drop;
  insert into _acc values
    ('City of Orlando – Orlando Venues','Owner / end user','Stadiums & venues','Orlando','FL','Owner''s rep Legends Global; LV design Henderson; CM Barton Malow/AECOM.'),
    ('Lubbock EXPO Center','Owner / end user','Stadiums & venues','Lubbock','TX','Repeat client from Buddy Holly Hall.'),
    ('Pegasus Development / FusionTECH','Developer','Stadiums & venues','Sacramento','CA','Republic Stadium at the Railyards (Sacramento Republic FC).'),
    ('University of Georgia','Owner / end user','Collegiate athletics','Athens','GA',null),
    ('Cherokee Nation Health Services','Owner / end user','Healthcare',null,'OK',null),
    ('Diversified','Integrator / partner','Stadiums & venues',null,null,null),
    ('OKC Thunder New Arena','Owner / end user','Stadiums & venues','Oklahoma City','OK',null),
    ('County (Bid #2027-03)','Owner / end user','Government',null,null,'Rename to the county''s actual name.'),
    ('Detroit City FC','Owner / end user','Stadiums & venues','Detroit','MI',null),
    ('Power Design, Inc.','Electrical contractor','Data centers',null,null,null);
  insert into public.accounts(name, type, vertical, city, state, notes, created_by)
  select x.name, x.type, x.vertical, x.city, x.state, x.notes, drew from _acc x
  where not exists (select 1 from public.accounts a where lower(trim(a.name)) = lower(trim(x.name)));

  select id into a_orl  from public.accounts where name = 'City of Orlando – Orlando Venues';
  select id into a_lub  from public.accounts where name = 'Lubbock EXPO Center';
  select id into a_peg  from public.accounts where name = 'Pegasus Development / FusionTECH';
  select id into a_uga  from public.accounts where name = 'University of Georgia';
  select id into a_cnh  from public.accounts where name = 'Cherokee Nation Health Services';
  select id into a_div  from public.accounts where name = 'Diversified';
  select id into a_okc  from public.accounts where name = 'OKC Thunder New Arena';
  select id into a_cty  from public.accounts where name = 'County (Bid #2027-03)';
  select id into a_dcfc from public.accounts where name = 'Detroit City FC';
  select id into a_pdi  from public.accounts where name = 'Power Design, Inc.';

  -- contacts
  insert into public.contacts(name, title, account_id, created_by)
  select v.name, v.title, v.acc, drew from (values
    ('Lindsey Hladik','Procurement contact', a_orl),
    ('Graham Raymond','Customer POC', a_cnh),
    ('Trevor Wylie', null, a_pdi)) v(name, title, acc)
  where not exists (select 1 from public.contacts c where c.name = v.name and c.account_id = v.acc);
  select id into c_hladik  from public.contacts where name = 'Lindsey Hladik' limit 1;
  select id into c_raymond from public.contacts where name = 'Graham Raymond' limit 1;
  select id into c_wylie   from public.contacts where name = 'Trevor Wylie' limit 1;

  -- deals (all start owned by Drew; reassign or share in the app)
  create temp table _deal(name text, acc uuid, con uuid, stage text, value numeric, bid_due date, close_date date, rfp text, source text, vertical text, services text[], descr text, gng jsonb) on commit drop;
  insert into _deal values
    ('Camping World Stadium CNS', a_orl, c_hladik, 'proposal', null, '2026-10-20', null, 'RFP26-0578', 'Public RFP', 'Stadiums & venues', array['Network','Wi-Fi','Structured cabling'],
      'Turnkey wired + Wi-Fi 7 converged network for the ~66,000-seat stadium; Cisco Catalyst and Cisco wireless preferred. Proposal due 2:00 PM ET via OpenGov. Must be 100% operational by July 2027.', '{"scores":{}}'),
    ('Lubbock EXPO Center Wi-Fi', a_lub, null, 'qualifying', null, null, null, null, 'Repeat client', 'Stadiums & venues', array['Wi-Fi'],
      'Budgetary Wi-Fi design and install estimate. Need DD set and T-drawings for drop counts.', '{"scores":{}}'),
    ('Republic Stadium neutral-host DAS', a_peg, null, 'proposal', null, null, null, 'SRFC Commercial Wireless DAS RFP', 'Public RFP', 'Stadiums & venues', array['DAS'],
      'Commercial wireless neutral-host DAS for Republic Stadium at the Railyards.', '{"scores":{}}'),
    ('UGA stadium firewall', a_uga, null, 'qualifying', null, null, null, null, 'Repeat client', 'Collegiate athletics', array['Network'],
      'Cisco firewall sized for 100G ISP links and ~100k fans.', '{"scores":{}}'),
    ('CN Health WAP replacement (3 clinics)', a_cnh, c_raymond, 'submitted', 8870.64, null, null, 'RFIP-Q-2026-0831-CNH', 'Repeat client', 'Healthcare', array['Wi-Fi'],
      'Labor to replace 131 indoor WAPs at Sallisaw (66), Nowata (24), Jay (41). After hours; document MAC and cable ID per WAP. Net 30.', '{"scores":{}}'),
    ('OKC Thunder arena – BP 5.10 structured cabling', a_okc, null, 'won', 11227136.29, null, '2026-09-30', 'BP 5.10', null, 'Stadiums & venues', array['Structured cabling'],
      '~37 TRs, ~9,850 CAT6A drops, Belden. Bid value shown; update to the final award amount (willing to meet $10,817,103). Pursuit led by Ryan and David.', '{"scores":{},"decision":"go"}'),
    ('OKC Thunder arena – Diversified AV sub-bids', a_div, null, 'proposal', null, null, null, null, 'GC / partner', 'Stadiums & venues', array['AV','Structured cabling'],
      'Labor-only LV: video control room, displays & mounts, bowl sound (EAW base / D&B alt), BOH AV.', '{"scores":{}}'),
    ('County network infrastructure (Bid #2027-03)', a_cty, null, 'proposal', null, null, null, '2027-03', 'Public RFP', 'Government', array['Network'],
      'Responding with a recommendation for an independent network audit before the implementation RFP. Addenda 1–2 issued.', '{"scores":{}}'),
    ('AlumniFi Field DAS / Wi-Fi 7 / managed network', a_dcfc, null, 'submitted', 9000000, null, null, null, 'Public RFP', 'Stadiums & venues', array['DAS','Wi-Fi','Network','Managed services'],
      '15,000-seat stadium. ~$9M across three scopes; Extreme Wi-Fi, SOLiD ALLIANCE DAS, private 5G/CBRS option.', '{"scores":{}}'),
    ('Fleet South Valley – Phase 2 building interior', a_pdi, c_wylie, 'negotiation', 869125, null, null, null, 'GC / partner', 'Data centers', array['Network','Wi-Fi'],
      'Subcontract under Power Design. Combined Phase 1 + 2 SOW; two COWs at $550K each as an alternate. Exhibit B comments pending.', '{"scores":{},"decision":"go"}'),
    ('Peru Ridge temp site network', a_pdi, c_wylie, 'proposal', null, null, null, null, 'GC / partner', 'Data centers', array['Network','Wi-Fi','DAS'],
      '2220 Peru Drive, McCarran, NV. SOW modeled on South Valley; outdoor cell coverage (COWs) in the base bid.', '{"scores":{}}');
  insert into public.deals(name, account_id, contact_id, owner_id, stage, value, bid_due, close_date, rfp_no, source, vertical, services, description, gng, created_by)
  select x.name, x.acc, x.con, drew, x.stage, x.value, x.bid_due, x.close_date, x.rfp, x.source, x.vertical, x.services, x.descr, x.gng, drew
  from _deal x where not exists (select 1 from public.deals d where d.name = x.name);

  select id into d_cws   from public.deals where name = 'Camping World Stadium CNS' limit 1;
  select id into d_lub   from public.deals where name = 'Lubbock EXPO Center Wi-Fi' limit 1;
  select id into d_fleet from public.deals where name = 'Fleet South Valley – Phase 2 building interior' limit 1;

  -- tasks
  insert into public.tasks(title, due, deal_id, assignee_id, created_by, notes)
  select v.title, v.due::date, v.deal, drew, drew, v.notes from (values
    ('Submit Camping World Stadium proposal on OpenGov (2:00 PM ET)', '2026-10-20', d_cws, null),
    ('Get DD set and T-drawings for Lubbock EXPO budgetary', null, d_lub, null),
    ('Send Exhibit B comments to Power Design', null, d_fleet, null),
    ('Go/no-go process session with sales + delivery (1 hr)', '2026-10-13', null, 'Use the starter criteria in Go/no-go & import as the strawman.')
  ) v(title, due, deal, notes)
  where not exists (select 1 from public.tasks t where t.title = v.title);
end $$;

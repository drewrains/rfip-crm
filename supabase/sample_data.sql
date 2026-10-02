-- =====================================================================
-- RFIP CRM — SAMPLE DATA for testing (safe to remove later)
--
-- Every sample record is labeled [SAMPLE] so it can't be mistaken for real
-- data. Remove everything with supabase/remove_sample_data.sql.
--
-- Run AFTER schema.sql. Supabase: SQL Editor → New query → paste → Run.
-- Sample deals are assigned to real logins by email; anyone missing falls
-- back to drains@rfip.com.
-- =====================================================================
do $$
declare
  drew  uuid := (select id from public.profiles where email = 'drains@rfip.com');
  am1   uuid; am2 uuid; se uuid; mgr uuid;
  a1 uuid; a2 uuid; a3 uuid; a4 uuid; c1 uuid; c2 uuid;
  d uuid;
begin
  if drew is null then raise exception 'Sign in once as drains@rfip.com before loading sample data.'; end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='deal_members' and column_name='role') then
    raise exception 'Run the latest schema.sql first, then this script.';
  end if;
  if exists (select 1 from public.deals where name like '[SAMPLE]%') then
    raise exception 'Sample data is already loaded. Run remove_sample_data.sql first if you want to reload it.';
  end if;

  am1 := coalesce((select id from public.profiles where email = 'kakers@rfip.com'), drew);
  mgr := coalesce((select id from public.profiles where email = 'mparsons@rfip.com'), drew);
  se  := coalesce((select id from public.profiles where email = 'mcapps@rfip.com'), drew);
  am2 := drew;

  insert into public.accounts(name, type, vertical, city, state, notes, created_by) values
    ('[SAMPLE] City Venues',        'Owner / end user',      'Stadiums & venues', 'Orlando', 'FL', 'Sample account for testing.', drew) returning id into a1;
  insert into public.accounts(name, type, vertical, notes, created_by) values
    ('[SAMPLE] Electrical Contractor', 'Electrical contractor', 'Data centers', 'Sample account for testing.', drew) returning id into a2;
  insert into public.accounts(name, type, vertical, notes, created_by) values
    ('[SAMPLE] Soccer Club', 'Owner / end user', 'Stadiums & venues', 'Sample account for testing.', drew) returning id into a3;
  insert into public.accounts(name, type, vertical, notes, created_by) values
    ('[SAMPLE] Energy Co.', 'Owner / end user', 'Oil & energy', 'Sample account for testing.', drew) returning id into a4;

  insert into public.contacts(name, title, account_id, created_by) values ('[SAMPLE] Pat Procurement', 'Procurement', a1, drew) returning id into c1;
  insert into public.contacts(name, title, account_id, created_by) values ('[SAMPLE] Jordan PM', 'Project Manager', a2, drew) returning id into c2;

  -- open deals
  insert into public.deals(name, account_id, contact_id, owner_id, stage, value, bid_due, rfp_no, vertical, source, services, gng, created_by, created_at)
  values ('[SAMPLE] Stadium converged network', a1, c1, am2, 'proposal', 4200000, current_date + 18, 'RFP-0001', 'Stadiums & venues', 'Public RFP', array['Network','Wi-Fi'],
          '{"scores":{"fit":5,"relationship":3,"win":3,"margin":3,"capacity":4,"risk":3,"strategic":5}}', drew, now() - interval '60 days') returning id into d;
  insert into public.deal_members(deal_id, user_id, role, added_by) select d, se, 'sales_engineer', drew where se <> am2;
  insert into public.deal_notes(deal_id, author_id, body, kind) values (d, am2, '[SAMPLE] Walked the site with the owner''s rep.', 'site_visit');
  insert into public.tasks(title, due, deal_id, assignee_id, created_by) values ('[SAMPLE] Submit stadium proposal', current_date + 18, d, am2, drew);

  insert into public.deals(name, account_id, contact_id, owner_id, stage, value, vertical, source, services, gng, created_by, created_at)
  values ('[SAMPLE] Data center temp network – Phase 2', a2, c2, am1, 'negotiation', 869125, 'Data centers', 'GC / partner', array['Network','Wi-Fi'],
          '{"scores":{},"decision":"go"}', drew, now() - interval '90 days') returning id into d;
  insert into public.deal_members(deal_id, user_id, role, added_by) select d, se, 'sales_engineer', drew where se <> am1;
  insert into public.deal_notes(deal_id, author_id, body, kind) values
    (d, am1, '[SAMPLE] Called the GC PM about Phase 2 scope.', 'call'),
    (d, am1, '[SAMPLE] Met to review exhibit comments.', 'meeting');
  insert into public.tasks(title, due, deal_id, assignee_id, created_by) values ('[SAMPLE] Send contract comments', current_date - 3, d, am1, drew);

  insert into public.deals(name, account_id, owner_id, stage, value, vertical, source, services, created_by, created_at)
  values ('[SAMPLE] Soccer stadium DAS / Wi-Fi 7', a3, mgr, 'submitted', 9000000, 'Stadiums & venues', 'Public RFP', array['DAS','Wi-Fi'], drew, now() - interval '120 days');

  insert into public.deals(name, owner_id, stage, bid_due, vertical, services, created_by, created_at)
  values ('[SAMPLE] Expo center Wi-Fi', am1, 'qualifying', current_date + 7, 'Stadiums & venues', array['Wi-Fi'], drew, now() - interval '12 days');

  -- closed this year
  insert into public.deals(name, account_id, owner_id, stage, value, close_date, vertical, source, services, outcome_reason, gng, created_by, created_at)
  values ('[SAMPLE] Arena structured cabling', a2, am2, 'won', 11227136, make_date(extract(year from current_date)::int, 9, 30), 'Stadiums & venues', 'Invited bid', array['Structured cabling'],
          'Local or diversity preference', '{"scores":{"fit":5,"relationship":4,"win":4,"margin":4,"capacity":4,"risk":4,"strategic":5},"decision":"go"}', drew, now() - interval '200 days') returning id into d;
  insert into public.deal_members(deal_id, user_id, role, added_by) select d, se, 'sales_engineer', drew where se <> am2;

  insert into public.deals(name, account_id, owner_id, stage, value, close_date, vertical, source, services, outcome_reason, winning_competitor, winning_price, outcome_notes, gng, created_by, created_at)
  values ('[SAMPLE] Arena Wi-Fi refresh', a2, am1, 'lost', 2100000, make_date(extract(year from current_date)::int, 6, 12), 'Stadiums & venues', 'Public RFP', array['Wi-Fi'],
          'Price', 'Competitor A', 1950000, 'We were about 7% high; sharpen labor rates on Wi-Fi refreshes.',
          '{"scores":{"fit":4,"relationship":2,"win":2,"margin":3,"capacity":3,"risk":3,"strategic":3}}', drew, now() - interval '240 days') returning id into d;
  insert into public.deal_members(deal_id, user_id, role, added_by) select d, se, 'sales_engineer', drew where se <> am1;

  insert into public.deals(name, account_id, owner_id, stage, value, close_date, vertical, source, services, outcome_reason, gng, created_by, created_at)
  values ('[SAMPLE] Campus DAS', a4, mgr, 'won', 780000, make_date(extract(year from current_date)::int, 4, 2), 'Oil & energy', 'Repeat client', array['DAS'],
          'Relationship', '{"scores":{"fit":5,"relationship":5,"win":4,"margin":4,"capacity":4,"risk":4,"strategic":4}}', drew, now() - interval '270 days');

  insert into public.deals(name, owner_id, stage, close_date, vertical, services, outcome_reason, created_by, created_at)
  values ('[SAMPLE] County camera refresh', am1, 'nobid', make_date(extract(year from current_date)::int, 3, 10), 'Government', array['Security'], 'Margin too low', drew, now() - interval '230 days');

  -- closed last year (for year-over-year comparison)
  insert into public.deals(name, owner_id, stage, value, close_date, vertical, services, outcome_reason, created_by, created_at)
  values ('[SAMPLE] University stadium DAS', am2, 'won', 3100000, make_date(extract(year from current_date)::int - 1, 8, 1), 'Collegiate athletics', array['DAS'], 'Technical solution', drew, now() - interval '580 days');
  insert into public.deals(name, account_id, owner_id, stage, value, close_date, vertical, services, outcome_reason, winning_competitor, created_by, created_at)
  values ('[SAMPLE] Yard Wi-Fi', a4, am1, 'lost', 400000, make_date(extract(year from current_date)::int - 1, 5, 1), 'Oil & energy', array['Wi-Fi'], 'Relationship / incumbent', 'Competitor B', drew, now() - interval '620 days');
end $$;

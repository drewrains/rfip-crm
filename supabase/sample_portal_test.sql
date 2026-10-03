-- =====================================================================
-- TEST database only: a sample multi-site customer for the customer
-- dashboard demo ("Summit Auto Group (sample)", six dealership Wi-Fi jobs).
-- Safe to re-run; remove it with:
--   delete from projects where number like '26-2__' and account_id = (select id from accounts where name = 'Summit Auto Group (sample)');
--   delete from accounts where name = 'Summit Auto Group (sample)';
-- Don't run on live.
-- =====================================================================
do $$
declare
  acct uuid; pm uuid; pid uuid; r record;
  mon date := date_trunc('week', current_date)::date;
begin
  select id into acct from accounts where name = 'Summit Auto Group (sample)';
  if acct is null then
    insert into accounts (name, type, vertical, city, state, notes)
    values ('Summit Auto Group (sample)', 'Owner / end user', 'Retail & auto', 'Dallas', 'TX', 'Sample customer for the customer dashboard demo.')
    returning id into acct;
  end if;
  select id into pm from profiles where email = 'chris@rfip.com';

  for r in select * from (values
    ('26-201', 'Summit Honda Plano – Wi-Fi refresh',        'closed',      100, -70, -20, 'on_track'),
    ('26-202', 'Summit Toyota Frisco – Wi-Fi refresh',      'closeout',     95, -45,   6, 'on_track'),
    ('26-203', 'Summit Ford Arlington – Wi-Fi + cabling',   'in_progress',  60, -30,  21, 'on_track'),
    ('26-204', 'Summit Chevrolet Irving – Wi-Fi refresh',   'in_progress',  35, -18,  28, 'at_risk'),
    ('26-205', 'Summit Nissan Garland – Wi-Fi refresh',     'mobilizing',   5,   -3,  45, 'on_track'),
    ('26-206', 'Summit Kia McKinney – Wi-Fi survey + design','mobilizing',  0,    7,  40, 'on_track')
  ) v(num, nm, ph, pct, s, e, sched) loop
    select id into pid from projects where number = r.num;
    if pid is null then
      insert into projects (number, name, account_id, department, pm_id, phase, pct_complete, start_date, end_date, contract_value, hours_budget)
      values (r.num, r.nm, acct, 'Network', pm, r.ph, r.pct, current_date + r.s, current_date + r.e, 48000, 320)
      returning id into pid;
      insert into milestones (project_id, name, planned, actual, sort) values
        (pid, 'Site survey',            current_date + r.s,      case when r.pct >= 5  then current_date + r.s end, 1),
        (pid, 'Cabling complete',       current_date + r.s + 14, case when r.pct >= 50 then current_date + r.s + 14 end, 2),
        (pid, 'Access points live',     current_date + r.e - 7,  case when r.pct >= 90 then current_date + r.e - 7 end, 3),
        (pid, 'Validation survey + handover', current_date + r.e, case when r.pct >= 100 then current_date + r.e end, 4);
      if r.pct > 0 then
        insert into weekly_updates (project_id, week_start, author_id, pct_complete, schedule_status, accomplished, next_week)
        values (pid, mon - 7, pm, greatest(r.pct - 10, 0), 'on_track',
                'Crew on site Mon–Thu. Pulled and terminated drops in the showroom and service drive.',
                'Finish service-bay drops and mount APs on the sales floor.'),
               (pid, mon, pm, r.pct, r.sched,
                case when r.sched = 'at_risk' then 'Ceiling access in the service bays was limited; finished the showroom and offices.'
                     else 'Mounted and configured access points; tested coverage in the showroom and service drive.' end,
                case when r.sched = 'at_risk' then 'Working with the store GM on after-hours access to the service bays.'
                     else 'Validation survey and walkthrough with the store manager.' end);
      end if;
    end if;
  end loop;
end $$;

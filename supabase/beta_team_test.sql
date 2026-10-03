-- =====================================================================
-- RFIP — beta team on the TEST database only. Run after team_access_schema.sql.
-- Don't run on live.
--
--   * Admins: Drew, Gabe, Dustin, Mitchell. Everyone else loses admin.
--   * Department leads: Mike (Tower), Matt (Network), David (DataComm),
--     Harley (DAS), Darren (Security). PMs: Chris, Kevin, Shon, Ryan,
--     Roger, Tony. Sales reps: Kevan, Alethea, Bryan, Rob, Brandon.
--   * The made-up demo people (demo-…@rfip.com) are turned off; the sample
--     deals and projects they own stay so there's something to click on.
--   * People who haven't signed in yet get their access on first sign-in.
-- =====================================================================

-- role and access changes are admin-only, so act as Drew for this script
select set_config('request.jwt.claims',
  json_build_object('sub', (select id from public.profiles where email = 'drains@rfip.com'), 'role', 'authenticated')::text, false);

-- people already signed in
update public.profiles set role = 'admin', ops_role = null                          where email in ('drains@rfip.com', 'gkolton@rfip.com');
update public.profiles set role = 'admin', ops_role = 'viewer'                      where email = 'dbradshaw@rfip.com';
update public.profiles set role = 'admin', ops_role = null, department = 'Network'  where email = 'mparsons@rfip.com';
update public.profiles set role = 'rep',   ops_role = null                          where email = 'kakers@rfip.com';
update public.profiles set role = 'rep',   ops_role = 'lead', department = 'Tower'    where email = 'mcapps@rfip.com';
update public.profiles set role = 'rep',   ops_role = 'lead', department = 'Network'  where email = 'matt@rfip.com';
update public.profiles set role = 'rep',   ops_role = 'lead', department = 'DataComm' where email = 'dayers@rfip.com';
update public.profiles set role = 'rep',   ops_role = 'pm',   department = 'Network'  where email = 'chris@rfip.com';

-- demo people off
update public.profiles set active = false where email like 'demo-%@rfip.com';

-- everyone else, applied the first time they sign in with Microsoft
insert into public.profile_presets (email, full_name, role, ops_role, department) values
  ('apeyrin@rfip.com',     'Alethea Peyrin',   'rep', null,   null),
  ('bgannon@rfip.com',     'Bryan Gannon',     'rep', null,   null),
  ('rob@rfip.com',         'Rob Jones',        'rep', null,   null),
  ('bwackerly@rfip.com',   'Brandon Wackerly', 'rep', null,   null),
  ('hseabolt@rfip.com',    'Harley Seabolt',   'rep', 'lead', 'DAS'),
  ('ddell@rfip.com',       'Darren Dell',      'rep', 'lead', 'Security'),
  ('kharris@rfip.com',     'Kevin Harris',     'rep', 'pm',   'DAS'),
  ('slogsdon@rfip.com',    'Shon Logsdon',     'rep', 'pm',   'DataComm'),
  ('rmclaughlin@rfip.com', 'Ryan McLaughlin',  'rep', 'pm',   'DataComm'),
  ('rayers@rfip.com',      'Roger Ayers',      'rep', 'pm',   'DataComm'),
  ('teremita@rfip.com',    'Tony Eremita',     'rep', 'pm',   'DataComm')
on conflict (email) do update set full_name = excluded.full_name, role = excluded.role, ops_role = excluded.ops_role, department = excluded.department;

-- stop acting as Drew
select set_config('request.jwt.claims', '', false);

-- what it looks like now
select full_name, email, role, ops_role, department, active from public.profiles where active order by role, ops_role nulls first, full_name;

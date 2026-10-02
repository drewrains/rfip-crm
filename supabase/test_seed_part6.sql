-- TEST DATABASE ONLY — sample project plans, tasks, expenses and a customer link.
select set_config('request.jwt.claims', json_build_object('sub','c50189cd-6f2b-46ba-8594-9b7e27fbdf05','role','authenticated')::text, true);
select set_config('rfip.expense_decision', 'on', true);

do $$
declare
  pid uuid; ph uuid; t uuid;
  u_pike uuid := (select id from profiles where email = 'demo-jpike@rfip.com');
  u_ray  uuid := (select id from profiles where email = 'demo-rdelgado@rfip.com');
  u_reese uuid := (select id from profiles where email = 'demo-treese@rfip.com');
  u_banks uuid := (select id from profiles where email = 'demo-rbanks@rfip.com');
  u_moran uuid := (select id from profiles where email = 'demo-cmoran@rfip.com');
  u_ortiz uuid := (select id from profiles where email = 'demo-jortiz@rfip.com');
  u_drew uuid := 'c50189cd-6f2b-46ba-8594-9b7e27fbdf05';
  u_gabe uuid := (select id from profiles where email = 'gkolton@rfip.com');
  d date := current_date;
begin
  if exists (select 1 from plan_items) then return; end if;

  -- 26-118 Concourse Wi-Fi refresh (Jordan Pike PM, Ray Delgado foreman)
  select id into pid from projects where number = '26-118';
  insert into plan_items (project_id, title, sort, status, start_date, due_date, assignee_id) values
    (pid, 'Mobilize and survey', 1, 'done', '2026-07-13', '2026-07-24', u_pike) returning id into ph;
  insert into plan_items (project_id, parent_id, title, sort, status, start_date, due_date, assignee_id) values
    (pid, ph, 'Pre-install site survey, all levels', 1, 'done', '2026-07-13', '2026-07-17', u_ray),
    (pid, ph, 'Submit AP placement drawings for approval', 2, 'done', '2026-07-17', '2026-07-22', u_pike),
    (pid, ph, 'Stage APs and mounts at the venue', 3, 'done', '2026-07-20', '2026-07-24', u_ray);
  insert into plan_items (project_id, title, sort, status, start_date, due_date, assignee_id) values
    (pid, 'Lower concourse', 2, 'done', '2026-07-27', '2026-08-28', u_ray) returning id into ph;
  insert into plan_items (project_id, parent_id, title, sort, status, start_date, due_date, assignee_id) values
    (pid, ph, 'Pull and terminate 96 drops', 1, 'done', '2026-07-27', '2026-08-14', u_ray),
    (pid, ph, 'Hang and connect 96 APs', 2, 'done', '2026-08-10', '2026-08-26', u_ray),
    (pid, ph, 'Section walk with the customer', 3, 'done', '2026-08-27', '2026-08-28', u_pike);
  insert into plan_items (project_id, title, sort, status, start_date, due_date, assignee_id) values
    (pid, 'Upper concourse', 3, 'in_progress', '2026-08-31', '2026-10-16', u_ray) returning id into ph;
  insert into plan_items (project_id, parent_id, title, sort, status, start_date, due_date, assignee_id) values
    (pid, ph, 'Pull and terminate 112 drops', 1, 'in_progress', '2026-08-31', d + 5, u_ray) returning id into t;
  insert into plan_items (project_id, parent_id, title, sort, status, start_date, due_date, assignee_id) values
    (pid, t, 'Sections 301–318', 1, 'done', '2026-08-31', '2026-09-18', u_ray),
    (pid, t, 'Sections 319–336', 2, 'in_progress', '2026-09-21', d + 5, u_ray),
    (pid, ph, 'Lift rental for the 300 level', 2, 'not_started', d - 3, d - 1, u_pike),
    (pid, ph, 'Hang and connect 112 APs', 3, 'not_started', d + 3, '2026-10-14', u_ray),
    (pid, ph, 'Section walk with the customer', 4, 'not_started', '2026-10-15', '2026-10-16', u_pike);
  insert into plan_items (project_id, title, sort, status, start_date, due_date, assignee_id) values
    (pid, 'Test, tune and turn over', 4, 'not_started', '2026-10-19', '2026-11-20', u_pike) returning id into ph;
  insert into plan_items (project_id, parent_id, title, sort, status, start_date, due_date, assignee_id) values
    (pid, ph, 'Post-install validation survey', 1, 'not_started', '2026-10-19', '2026-10-30', u_ortiz),
    (pid, ph, 'Event-day load test', 2, 'not_started', '2026-11-02', '2026-11-08', u_pike),
    (pid, ph, 'As-builts and closeout package', 3, 'not_started', '2026-11-09', '2026-11-20', u_pike);

  -- 26-124 Admin campus structured cabling (T. Reese PM)
  select id into pid from projects where number = '26-124';
  insert into plan_items (project_id, title, sort, status, start_date, due_date, assignee_id) values
    (pid, 'Mobilize and site walk', 1, 'done', '2026-07-27', '2026-07-31', u_reese),
    (pid, 'Rough-in and pathway', 2, 'done', '2026-08-03', '2026-08-28', u_reese);
  insert into plan_items (project_id, title, sort, status, start_date, due_date, assignee_id) values
    (pid, 'Pull cable', 3, 'in_progress', '2026-08-24', '2026-10-09', u_reese) returning id into ph;
  insert into plan_items (project_id, parent_id, title, sort, status, start_date, due_date, assignee_id) values
    (pid, ph, 'Building A (412 drops)', 1, 'done', '2026-08-24', '2026-09-11', u_reese),
    (pid, ph, 'Building B (380 drops)', 2, 'in_progress', '2026-09-14', d - 2, u_reese),
    (pid, ph, 'Building C (296 drops)', 3, 'not_started', d + 1, '2026-10-09', u_reese);
  insert into plan_items (project_id, title, sort, status, start_date, due_date, assignee_id) values
    (pid, 'Terminate and dress', 4, 'not_started', '2026-09-28', '2026-10-23', u_reese),
    (pid, 'Test and certify', 5, 'not_started', '2026-10-19', '2026-10-30', u_reese),
    (pid, 'Closeout', 6, 'not_started', '2026-11-02', '2026-11-06', u_reese);

  -- 26-130 Monopole antenna swap (R. Banks PM)
  select id into pid from projects where number = '26-130';
  insert into plan_items (project_id, title, sort, status, start_date, due_date, assignee_id) values
    (pid, 'Permits and structural analysis', 1, 'done', '2026-09-08', '2026-09-18', u_banks);
  insert into plan_items (project_id, title, sort, status, start_date, due_date, assignee_id) values
    (pid, 'Sites 1–3', 2, 'in_progress', '2026-09-21', '2026-10-09', u_banks) returning id into ph;
  insert into plan_items (project_id, parent_id, title, sort, status, start_date, due_date, assignee_id) values
    (pid, ph, 'Site 1 swap and sweep', 1, 'done', '2026-09-21', '2026-09-25', u_banks),
    (pid, ph, 'Site 2 swap and sweep', 2, 'blocked', '2026-09-28', d - 4, u_banks),
    (pid, ph, 'Site 3 swap and sweep', 3, 'not_started', d + 2, '2026-10-09', u_banks);
  insert into plan_items (project_id, title, sort, status, start_date, due_date, assignee_id) values
    (pid, 'Sites 4–6', 3, 'not_started', '2026-10-12', '2026-11-06', u_banks),
    (pid, 'Closeout package to carrier', 4, 'not_started', '2026-11-09', '2026-11-13', u_banks);

  -- expenses (in every state)
  insert into expenses (project_id, spent_on, category, vendor, description, amount, paid_with, status, submitted_by, submitted_at, pm_by, pm_at, cfo_by, cfo_at) values
    ((select id from projects where number = '26-118'), d - 20, 'equipment', 'Sunbelt Rentals', '40 ft scissor lift, 1 week, lower concourse', 1840.00, 'invoice', 'approved', u_pike, now() - interval '20 days', u_pike, now() - interval '19 days', u_gabe, now() - interval '18 days'),
    ((select id from projects where number = '26-118'), d - 9, 'materials', 'Home Depot', 'Unistrut, anchors and hardware for AP mounts', 386.42, 'company_card', 'approved', u_ray, now() - interval '9 days', u_pike, now() - interval '8 days', u_gabe, now() - interval '7 days'),
    ((select id from projects where number = '26-118'), d - 4, 'fuel', 'QuikTrip', 'Crew truck fuel', 92.18, 'company_card', 'pm_approved', u_ray, now() - interval '4 days', u_pike, now() - interval '3 days', null, null),
    ((select id from projects where number = '26-118'), d - 1, 'meals', 'Jimmy''s Egg', 'Crew breakfast before the 5 am start', 74.60, 'reimburse', 'submitted', u_ray, now() - interval '1 day', null, null, null, null),
    ((select id from projects where number = '26-118'), d - 2, 'tools', 'Klein Tools via Graybar', 'Replacement punch-down tool', 58.00, 'company_card', 'rejected', u_ray, now() - interval '2 days', null, null, null, null),
    ((select id from projects where number = '26-124'), d - 6, 'lodging', 'Hampton Inn', '2 rooms × 3 nights, Building B push', 714.00, 'company_card', 'pm_approved', u_reese, now() - interval '6 days', u_reese, now() - interval '5 days', null, null),
    ((select id from projects where number = '26-124'), d - 2, 'shipping', 'FedEx', 'Return of damaged patch panels', 61.25, 'company_card', 'submitted', u_reese, now() - interval '2 days', null, null, null, null),
    ((select id from projects where number = '26-130'), d - 12, 'permits', 'City of Edmond', 'Right-of-way permit, sites 1–3', 450.00, 'invoice', 'approved', u_banks, now() - interval '12 days', u_banks, now() - interval '11 days', u_gabe, now() - interval '10 days'),
    ((select id from projects where number = '26-130'), d - 3, 'travel', 'Hertz', 'Truck rental for second crew', 535.80, 'company_card', 'submitted', u_banks, now() - interval '3 days', null, null, null, null),
    ((select id from projects where number = '26-121'), d - 5, 'materials', 'Graybar', 'Plenum innerduct, rush order', 1210.00, 'invoice', 'pm_approved', u_moran, now() - interval '5 days', u_moran, now() - interval '4 days', null, null);
  update expenses set rejected_by = u_pike, reject_reason = 'Receipt photo is blurry. Retake it and resubmit.' where status = 'rejected';

  -- a live customer link for the concourse job
  insert into customer_links (project_id, token, created_by, views, last_viewed_at)
  values ((select id from projects where number = '26-118'), 'c0ffee' || substr(md5('rfip-demo-concourse'), 1, 32) || '0a1b2c3d4e', u_pike, 3, now() - interval '1 day');
end $$;

-- =====================================================================
-- RFIP — everyone can log expenses. Run after plan_expenses_customer_schema.sql. Safe to re-run.
--
-- Anyone with an active RFIP login (sales, ops, office) can log an expense:
--   * on any active project  → the project's PM approves, then the CFO (as before)
--   * not tied to a project  → "General / overhead" (sales travel, office, training…).
--     Step-one approval goes to their manager (Team page); if no manager is set, the
--     lead of their department; if neither, it goes straight to the CFO.
-- Receipts for general expenses are stored under general/<user>/expenses/…, and anyone
-- who can see an expense can open its receipt.
-- =====================================================================

alter table public.expenses alter column project_id drop not null;
alter table public.expenses add column if not exists approver_id uuid references public.profiles(id) on delete set null;
create index if not exists expenses_approver_idx on public.expenses(approver_id) where status = 'submitted';

-- who approves step one of a general (no-project) expense for this person
create or replace function public.expense_approver_for(u uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select m.id from profiles p join profiles m on m.id = p.manager_id where p.id = u and m.active and m.id <> u),
    (select l.id from profiles p join profiles l on l.department = p.department and l.ops_role = 'lead' and l.active
       where p.id = u and p.department is not null and l.id <> u order by l.created_at limit 1));
$$;

create or replace function public.guard_expense() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('rfip.expense_decision', true), '') = 'on' then
    new.updated_at := now(); return new;
  end if;
  if tg_op = 'INSERT' then
    new.status := 'submitted'; new.submitted_by := auth.uid(); new.submitted_at := now();
    new.pm_by := null; new.pm_at := null; new.cfo_by := null; new.cfo_at := null; new.rejected_by := null; new.reject_reason := null;
    new.approver_id := null;
    if new.project_id is null then
      new.approver_id := public.expense_approver_for(auth.uid());
      if new.approver_id is null then new.status := 'pm_approved'; end if;   -- nobody above them but the CFO
    end if;
    return new;
  end if;
  if old.submitted_by is distinct from auth.uid() or old.status not in ('submitted','rejected') then
    raise exception 'Only the person who logged this expense can change it, and only before it''s approved.';
  end if;
  if new.project_id is distinct from old.project_id then raise exception 'An expense can''t move to another project.'; end if;
  new.submitted_by := old.submitted_by; new.status := 'submitted'; new.submitted_at := now();
  new.pm_by := null; new.pm_at := null; new.cfo_by := null; new.cfo_at := null; new.rejected_by := null; new.reject_reason := null;
  new.approver_id := old.approver_id;
  if new.project_id is null then
    new.approver_id := public.expense_approver_for(old.submitted_by);
    if new.approver_id is null then new.status := 'pm_approved'; end if;
  end if;
  new.updated_at := now();
  return new;
end $$;

-- step one: the project's PM (or lead/admin on it), or for a general expense the approver above
create or replace function public.expense_step_one(e public.expenses) returns boolean
language sql stable security definer set search_path = public as $$
  select case when e.project_id is not null then public.ops_can_edit(e.project_id)
              else e.approver_id = auth.uid() or public.is_admin() end;
$$;

create or replace function public.expense_decide(eid uuid, decision text, reason text default null)
returns public.expenses
language plpgsql security definer set search_path = public as $$
declare e expenses;
begin
  select * into e from expenses where id = eid for update;
  if not found then raise exception 'That expense isn''t available.'; end if;
  perform set_config('rfip.expense_decision', 'on', true);
  if decision = 'approve' then
    if e.status = 'submitted' and public.expense_step_one(e) then
      update expenses set status = 'pm_approved', pm_by = auth.uid(), pm_at = now() where id = eid returning * into e;
    elsif e.status = 'pm_approved' and public.is_finance() then
      update expenses set status = 'approved', cfo_by = auth.uid(), cfo_at = now() where id = eid returning * into e;
    elsif e.status = 'pm_approved' then
      raise exception 'This has its first approval. Final approval comes from the CFO.';
    else
      raise exception 'You can''t approve this expense.';
    end if;
  elsif decision = 'reject' then
    if coalesce(trim(reason), '') = '' then raise exception 'Say why it''s being sent back.'; end if;
    if (e.status = 'submitted' and (public.expense_step_one(e) or public.is_finance()))
       or (e.status = 'pm_approved' and public.is_finance()) then
      update expenses set status = 'rejected', rejected_by = auth.uid(), reject_reason = trim(reason),
                          pm_by = null, pm_at = null where id = eid returning * into e;
    else
      raise exception 'You can''t send this expense back.';
    end if;
  else
    raise exception 'Unknown decision.';
  end if;
  perform set_config('rfip.expense_decision', '', true);
  return e;
end $$;

drop policy if exists exp_read on public.expenses;
create policy exp_read on public.expenses for select to authenticated
  using (submitted_by = auth.uid() or approver_id = auth.uid() or public.is_finance()
         or (project_id is not null and public.ops_can_see_money(project_id))
         or (project_id is null and public.is_admin()));
drop policy if exists exp_insert on public.expenses;
create policy exp_insert on public.expenses for insert to authenticated
  with check (public.is_active_user() and (project_id is null
    or exists (select 1 from projects p where p.id = project_id and p.phase <> 'closed')));

-- a short list of active jobs anyone can log an expense against (no money, no details)
create or replace function public.expense_projects()
returns table (id uuid, number text, name text, pm_id uuid)
language sql stable security definer set search_path = public as $$
  select p.id, p.number, p.name, p.pm_id from projects p where public.is_active_user() and p.phase <> 'closed' order by p.number;
$$;
revoke execute on function public.expense_projects() from public, anon;
grant execute on function public.expense_projects() to authenticated;
revoke execute on function public.expense_approver_for(uuid), public.expense_step_one(public.expenses) from public, anon;
grant execute on function public.expense_step_one(public.expenses) to authenticated;

-- receipts: anyone logging an expense can upload into a project's or their own general expenses folder;
-- anyone who can see the expense can open its receipt
drop policy if exists rfip_files_insert on storage.objects;
create policy rfip_files_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'project-files' and (
    public.doc_can(public.doc_path_project(name), split_part(name, '/', 2), 'write')
    or (split_part(name, '/', 2) = 'expenses' and public.is_active_user() and public.doc_path_project(name) is not null)
    or (split_part(name, '/', 1) = 'general' and split_part(name, '/', 2) = auth.uid()::text and split_part(name, '/', 3) = 'expenses' and public.is_active_user())));
drop policy if exists rfip_files_read on storage.objects;
create policy rfip_files_read on storage.objects for select to authenticated using (
  bucket_id = 'project-files' and (owner_id = auth.uid()::text
    or public.doc_can(public.doc_path_project(name), split_part(name, '/', 2), 'read')
    or exists (select 1 from public.expenses x where x.receipt_path = name)));

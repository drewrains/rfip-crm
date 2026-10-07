-- RFIP — "Assigns account managers": lets a non-admin (e.g. Alethea) enter deals for anyone
-- and change the account manager on any deal, without admin rights.
-- What it gives: sees every deal; can create a deal in anyone's name; can change the account
-- manager on any deal. On deals she doesn't own (and isn't on the team for) she can change
-- ONLY the account manager. No Team page, settings, feedback or other admin powers.
-- Turn it on/off per person on the Team page (admins only). Safe to run more than once.

alter table public.profiles add column if not exists deal_assigner boolean not null default false;

create or replace function public.is_deal_assigner() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select deal_assigner from profiles where id = auth.uid() and active), false);
$$;

-- only admins can grant it (same guard as the other access settings)
create or replace function public.guard_profile_ops() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() and (new.ops_role is distinct from old.ops_role or new.department is distinct from old.department
     or new.sales_access is distinct from old.sales_access or new.finance_approver is distinct from old.finance_approver
     or new.deal_assigner is distinct from old.deal_assigner) then
    raise exception 'Only an admin can change operations access.';
  end if;
  return new;
end $$;

drop policy if exists deals_read on public.deals;
create policy deals_read on public.deals for select to authenticated using (
  public.is_admin() or public.is_deal_assigner() or (public.is_active_user() and (owner_id = auth.uid() or public.reports_to_me(owner_id)
    or exists (select 1 from public.deal_members m where m.deal_id = deals.id and (m.user_id = auth.uid() or public.reports_to_me(m.user_id))))));

drop policy if exists deals_insert on public.deals;
create policy deals_insert on public.deals for insert to authenticated
  with check (public.is_admin() or public.is_deal_assigner() or (public.is_active_user() and (owner_id = auth.uid() or public.reports_to_me(owner_id))));

drop policy if exists deals_update on public.deals;
create policy deals_update on public.deals for update to authenticated
  using (public.can_see_deal(id) or public.is_deal_assigner())
  with check (public.is_admin() or public.is_deal_assigner() or (public.is_active_user() and ((owner_id = auth.uid()) or public.reports_to_me(owner_id)
    or exists (select 1 from public.deal_members m where m.deal_id = deals.id and ((m.user_id = auth.uid()) or public.reports_to_me(m.user_id))))));

-- on someone else's deal, an assigner may change the account manager and nothing else
create or replace function public.guard_deal_assigner() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.is_admin() or not public.is_deal_assigner() then return new; end if;
  if old.owner_id = auth.uid() or public.reports_to_me(old.owner_id)
     or exists (select 1 from deal_members m where m.deal_id = old.id and (m.user_id = auth.uid() or public.reports_to_me(m.user_id))) then
    return new;
  end if;
  if (to_jsonb(new) - 'owner_id' - 'updated_at') is distinct from (to_jsonb(old) - 'owner_id' - 'updated_at') then
    raise exception 'On deals you don''t own you can only change the account manager.';
  end if;
  return new;
end $$;
drop trigger if exists deals_guard_assigner on public.deals;
create trigger deals_guard_assigner before update on public.deals for each row execute function public.guard_deal_assigner();

-- turn it on for Alethea
update public.profiles set deal_assigner = true where lower(email) = 'apeyrin@rfip.com';

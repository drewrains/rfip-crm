-- RFIP — part 2 of "Assigns account managers": the existing reassign guard only allowed the
-- deal owner or an admin to change the account manager. Let deal assigners through too.
create or replace function public.guard_deal_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.owner_id is distinct from old.owner_id and not public.can_manage_deal(old.id) and not public.is_deal_assigner() then
    raise exception 'Only the deal owner or an admin can reassign a deal.';
  end if;
  new.updated_at := now();
  return new;
end $$;

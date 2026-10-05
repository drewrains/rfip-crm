-- RFIP — fix: sales reps couldn't add a deal ("new row violates row-level security policy").
-- The read rule looked the deal up by id, and a brand-new deal isn't visible to that lookup yet,
-- so the app's "save and show me the deal" step was refused. Same access as before, checked on the row itself.
drop policy if exists deals_read on public.deals;
create policy deals_read on public.deals for select to authenticated using (
  public.is_admin() or (public.is_active_user() and (owner_id = auth.uid() or public.reports_to_me(owner_id)
    or exists (select 1 from public.deal_members m where m.deal_id = deals.id and (m.user_id = auth.uid() or public.reports_to_me(m.user_id))))));

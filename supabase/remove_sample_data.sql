-- =====================================================================
-- RFIP CRM — remove all [SAMPLE] test data loaded by sample_data.sql.
-- Real deals, accounts, contacts and tasks are not touched.
-- Supabase: SQL Editor → New query → paste → Run.
-- =====================================================================
delete from public.tasks    where title like '[SAMPLE]%'
                               or deal_id in (select id from public.deals where name like '[SAMPLE]%');
delete from public.deals    where name like '[SAMPLE]%';   -- also removes their notes and deal-team rows
delete from public.contacts where name like '[SAMPLE]%';
delete from public.accounts where name like '[SAMPLE]%'
  and not exists (select 1 from public.deals d where d.account_id = accounts.id);

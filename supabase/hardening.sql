-- RFIP — small security tidy-up flagged by Supabase's checker. Safe to re-run.
-- Trigger and helper functions don't need to be callable by signed-out visitors.
do $$ declare f text; begin
  foreach f in array array['public.guard_customer_request()', 'public.guard_deal_assigner()', 'public.guard_project_parent()',
                           'public.is_deal_assigner()', 'public.ops_can_plan(uuid)'] loop
    if to_regprocedure(f) is not null then execute format('revoke execute on function %s from public, anon', f); end if;
  end loop;
  foreach f in array array['public.guard_customer_request()', 'public.guard_deal_assigner()', 'public.guard_project_parent()', 'public.expense_approver_for(uuid)'] loop
    if to_regprocedure(f) is not null then execute format('revoke execute on function %s from authenticated', f); end if;
  end loop;
  foreach f in array array['public.is_deal_assigner()', 'public.ops_can_plan(uuid)'] loop
    if to_regprocedure(f) is not null then execute format('grant execute on function %s to authenticated', f); end if;
  end loop;
end $$;

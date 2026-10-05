-- =====================================================================
-- RFIP — keep email + password sign-in only for Drew (backup if Microsoft is down).
-- Everyone else signs in with Microsoft (and Microsoft's MFA). Safe to re-run.
-- Their old passwords are cleared, so the password form won't work for them.
-- =====================================================================
update auth.users set encrypted_password = null
where lower(email) <> 'drains@rfip.com' and encrypted_password is not null;

select email, encrypted_password is not null as has_password
from auth.users order by has_password desc, email;

// Supabase project settings — both values are safe to publish.
// Find them in Supabase: Project Settings → API (Project URL and the anon / publishable key).
// Never put the service_role / secret key here.
window.RFIP_CONFIG = {
  supabaseUrl: "https://oosqohwuryvxoxgwylyb.supabase.co",
  supabaseAnonKey: "sb_publishable_Rrt3iLTlvmcakBsuPTTDow_RKj0pf6g",
  // Turn on once Microsoft sign-in is set up in Entra ID and Supabase (README step 2–3).
  microsoftLogin: false,
  // Allow email + password sign-in for accounts an admin creates in Supabase.
  passwordLogin: true,
};

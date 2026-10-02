// Supabase project settings — both values are safe to publish.
// Find them in Supabase: Project Settings → API (Project URL and the anon / publishable key).
// Never put the service_role / secret key here.
//
// The live address uses the live database. Every other address (Vercel
// preview links, local testing) uses the separate TEST database, so trying
// things out never touches real data.
(function () {
  const LIVE_HOSTS = ["rfip-crm.vercel.app", "crm.rfip.com"];
  const live = {
    supabaseUrl: "https://oosqohwuryvxoxgwylyb.supabase.co",
    supabaseAnonKey: "sb_publishable_Rrt3iLTlvmcakBsuPTTDow_RKj0pf6g",
  };
  const test = {
    supabaseUrl: "https://iopzykvnaurhykbvvyth.supabase.co",
    supabaseAnonKey: "sb_publishable_lUmS6p9M8g8xbZj0HVgKcg_y9R7QTn8",
  };
  const isLive = LIVE_HOSTS.includes(location.hostname);
  window.RFIP_CONFIG = Object.assign({}, isLive ? live : test, {
    environment: isLive ? "live" : "test",
    // Turn on once Microsoft sign-in is set up in Entra ID and Supabase (README step 2–3).
    microsoftLogin: false,
    // Allow email + password sign-in for accounts an admin creates in Supabase.
    passwordLogin: true,
  });
})();

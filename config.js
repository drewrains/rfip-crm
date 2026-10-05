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
    // Everyone signs in with their RFIP Microsoft account, so Microsoft's two-factor protects RFIP too.
    microsoftLogin: true,
    // Email + password sign-in is off. To turn it back on (e.g. if Microsoft is down), set this to true
    // and turn the Email provider back on in Supabase → Authentication → Sign In / Providers.
    passwordLogin: false,
    // Who gets the "Feedback" button's emails during the beta.
    feedbackTo: ["drains@rfip.com"],
  });
})();

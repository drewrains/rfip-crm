// RFIP — SharePoint folders and files for deals and projects.
//
// Layout: Customers/<Customer>/Customer Info, and Customers/<Customer>/<Deal>/Sales + Operations.
// Every deal gets a folder under its customer; its project shares it. Files live only in SharePoint: the app lists them live and uploads straight into
// them, so anything added in SharePoint or Teams shows up in the app and vice versa.
//
// Secrets (Supabase → Edge Functions → Secrets):
//   MS_TENANT_ID      Directory (tenant) ID of the RFIP Microsoft 365 tenant
//   MS_CLIENT_ID      Application (client) ID of the "RFIP" app registration
//   MS_CLIENT_SECRET  A client secret value for that app
//   SP_SITE_URL       e.g. https://rfip.sharepoint.com/sites/SalesCRM
//   SP_LIBRARY        document library name (optional, default "Documents")
//   SP_ROOT_FOLDER    top folder inside the library (optional, default "Customers")
//
// Calls (POST, signed-in user's token). Every call checks the caller's rights in the database first;
// the app's Microsoft identity can reach the whole site, so nothing here trusts the browser.
//   {action:"status"}                                  is SharePoint connected?
//   {action:"create", deal_id}                         create (or re-link) one deal's folder
//   {action:"backfill"}                                admins: folders for every deal without one, and move any
//                                                      existing folders into the Customer/Deal layout
//   {action:"rename_customer", account_id, old_name}   rename a customer's folder after the account is renamed
//   {action:"files", deal_id | project_id}             list the files, folder by folder
//   {action:"upload_start", deal_id | project_id, folder, name, size}
//                                                      returns a SharePoint upload address the browser sends the file to
//   {action:"upload_finish", deal_id | project_id, folder, item_id, note?, closeout_item_id?}
//                                                      checks the file landed in the right folder; projects get a documents row
//   raw body + header x-rfip-upload: {deal_id|project_id, folder, name, note?, closeout_item_id?}
//                                                      fallback: the file goes through this function
//   {action:"delete", deal_id | project_id, item_id}   moves the file to the SharePoint recycle bin
import { createClient } from "jsr:@supabase/supabase-js@2";

const SALES = ["01 RFP and Bid Docs", "02 Site Walk and Photos", "03 Drawings and Specs", "04 Estimate and Pricing", "05 Proposal",
  "06 Contract and PO", "07 Correspondence"];
const OPS = ["01 Handoff Packet", "02 Submittals", "03 Drawings and As-Builts", "04 Change Orders", "05 Field Photos and Daily Reports",
  "06 Test Results", "07 Pay Apps", "08 Closeout", "09 Safety"];
// the project Documents folders (documents.folder) and where each one lives in SharePoint
const PROJECT_FOLDERS: Record<string, [string, string]> = {
  contract: ["Sales", "06 Contract and PO"], scope: ["Sales", "04 Estimate and Pricing"],
  submittals: ["Operations", "02 Submittals"], drawings: ["Operations", "03 Drawings and As-Builts"],
  change_orders: ["Operations", "04 Change Orders"], pay_apps: ["Operations", "07 Pay Apps"],
  field: ["Operations", "05 Field Photos and Daily Reports"], tests: ["Operations", "06 Test Results"],
  closeout: ["Operations", "08 Closeout"], safety: ["Operations", "09 Safety"],
};
const MAX_BYTES = 52428800; // 50 MB, same as the old storage bucket

const env = (k: string) => (Deno.env.get(k) || "").trim();
const cors = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-rfip-upload",
  "Access-Control-Allow-Methods": "POST, OPTIONS"};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {...cors, "Content-Type": "application/json"}});
const configured = () => !!(env("MS_TENANT_ID") && env("MS_CLIENT_ID") && env("MS_CLIENT_SECRET") && env("SP_SITE_URL"));
// SharePoint won't take " * : < > ? / \ | or names ending in a dot or space
const safe = (s: string) => s.replace(/["*:<>?/\\|#%]+/g, "-").replace(/\s+/g, " ").replace(/[. ]+$/, "").trim().slice(0, 120) || "Untitled";
const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");
class Refused extends Error { constructor(msg: string, public status = 403) { super(msg); } }

let token: {v: string, exp: number} | null = null;
async function graphToken() {
  if (token && token.exp > Date.now() + 60_000) return token.v;
  const r = await fetch(`https://login.microsoftonline.com/${env("MS_TENANT_ID")}/oauth2/v2.0/token`, {method: "POST",
    body: new URLSearchParams({client_id: env("MS_CLIENT_ID"), client_secret: env("MS_CLIENT_SECRET"), grant_type: "client_credentials",
      scope: "https://graph.microsoft.com/.default"})});
  const j = await r.json();
  if (!r.ok) throw new Error("Microsoft sign-in for the app failed: " + (j.error_description || j.error || r.status));
  token = {v: j.access_token, exp: Date.now() + (j.expires_in || 3000) * 1000};
  return token.v;
}
async function graph(path: string, init: RequestInit = {}) {
  const r = await fetch("https://graph.microsoft.com/v1.0" + path, {...init,
    headers: {Authorization: "Bearer " + await graphToken(), "Content-Type": "application/json", ...(init.headers || {})}});
  const text = await r.text(); let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = {raw: text}; }
  return {ok: r.ok, status: r.status, body};
}
let driveCache: string | null = null;
async function driveId() {
  if (driveCache) return driveCache;
  const u = new URL(env("SP_SITE_URL"));
  const site = await graph(`/sites/${u.hostname}:${u.pathname.replace(/\/$/, "")}`);
  if (!site.ok) throw new Error("Couldn't find the SharePoint site " + env("SP_SITE_URL") + " (" + (site.body.error?.message || site.status) + ")");
  const drives = await graph(`/sites/${site.body.id}/drives`);
  if (!drives.ok) throw new Error("Couldn't read the site's document libraries (" + (drives.body.error?.message || drives.status) + ")");
  const want = (env("SP_LIBRARY") || "Documents").toLowerCase();
  const d = drives.body.value.find((x: any) => x.name.toLowerCase() === want) || drives.body.value.find((x: any) => /^(documents|shared documents)$/i.test(x.name));
  if (!d) throw new Error("No document library named " + (env("SP_LIBRARY") || "Documents") + " on that site");
  return (driveCache = d.id);
}
async function child(drive: string, parent: string, name: string) {
  const made = await graph(`/drives/${drive}/items/${parent}/children`, {method: "POST",
    body: JSON.stringify({name, folder: {}, "@microsoft.graph.conflictBehavior": "fail"})});
  if (made.ok) return made.body;
  if (made.status === 409) {
    const got = await graph(`/drives/${drive}/items/${parent}:/${encodeURIComponent(name)}`);
    if (got.ok) return got.body;
  }
  throw new Error(`Couldn't create folder "${name}" (${made.body.error?.message || made.status})`);
}
// the standard Sales + Operations tree under a deal or project folder
async function makeTree(drive: string, folderId: string) {
  const sales = await child(drive, folderId, "Sales");
  for (const n of SALES) await child(drive, sales.id, n);
  const ops = await child(drive, folderId, "Operations");
  for (const n of OPS) await child(drive, ops.id, n);
}
// a sub-folder like "Sales/05 Proposal" under a deal folder, made if someone deleted it in SharePoint
async function sub(drive: string, rootId: string, parent: string, name: string) {
  const got = await graph(`/drives/${drive}/items/${rootId}:/${enc(parent + "/" + name)}`);
  if (got.ok && got.body.folder) return got.body;
  const p = await child(drive, rootId, parent);
  return await child(drive, p.id, name);
}

const NO_CUSTOMER = "No Customer";
async function rootFolder(drive: string) {
  const root = (await graph(`/drives/${drive}/root`)).body;
  return await child(drive, root.id, safe(env("SP_ROOT_FOLDER") || "Customers"));
}
// Customers/<Customer>/ with its Customer Info folder
async function customerFolder(drive: string, name: string | null) {
  const base = await rootFolder(drive);
  const cust = await child(drive, base.id, safe(name || NO_CUSTOMER));
  if (name) await child(drive, cust.id, "Customer Info");
  return cust;
}
// moves (and renames) an existing folder so it sits where it should; files and history come along
async function place(drive: string, itemId: string, parentId: string, name: string) {
  const cur = await graph(`/drives/${drive}/items/${itemId}`);
  if (!cur.ok) return null;                                   // gone from SharePoint; make a new one
  if (cur.body.parentReference?.id === parentId && cur.body.name === name) return cur.body;
  let target = name;
  for (let i = 2; i < 20; i++) {
    const r = await graph(`/drives/${drive}/items/${itemId}`, {method: "PATCH",
      body: JSON.stringify({name: target, parentReference: {id: parentId}})});
    if (r.ok) return r.body;
    if (r.status !== 409) throw new Error(`Couldn't move folder "${cur.body.name}" (${r.body.error?.message || r.status})`);
    target = `${name} (${i})`;
  }
  throw new Error(`Couldn't move folder "${cur.body.name}"`);
}

async function createFor(admin: any, dealId: string) {
  const {data: d, error} = await admin.from("deals").select("id, name, created_at, account_id, sharepoint_item_id, accounts(name)").eq("id", dealId).single();
  if (error || !d) throw new Error("Deal not found");
  if (!configured()) {
    await admin.from("deals").update({sharepoint_status: "waiting", sharepoint_error: null}).eq("id", dealId);
    return {status: "waiting"};
  }
  try {
    const drive = await driveId();
    const cust = await customerFolder(drive, d.accounts?.name || null);
    const name = safe(d.name);
    let folder = d.sharepoint_item_id ? await place(drive, d.sharepoint_item_id, cust.id, name) : null;
    if (!folder) folder = await child(drive, cust.id, name);
    await makeTree(drive, folder.id);
    await admin.from("deals").update({sharepoint_url: folder.webUrl, sharepoint_item_id: folder.id, sharepoint_status: "ready", sharepoint_error: null}).eq("id", dealId);
    await admin.from("projects").update({sharepoint_url: folder.webUrl, sharepoint_item_id: folder.id}).eq("deal_id", dealId);
    return {status: "ready", url: folder.webUrl, item_id: folder.id};
  } catch (e) {
    const msg = String((e as Error).message || e).slice(0, 500);
    await admin.from("deals").update({sharepoint_status: "error", sharepoint_error: msg}).eq("id", dealId);
    return {status: "error", error: msg};
  }
}
// a project that didn't come from a deal gets its own folder under its customer
async function standaloneProject(admin: any, p: any) {
  const drive = await driveId();
  const {data: acct} = p.account_id ? await admin.from("accounts").select("name").eq("id", p.account_id).maybeSingle() : {data: null};
  const cust = await customerFolder(drive, acct?.name || null);
  const name = safe((p.number ? p.number + " – " : "") + (p.name || "Project"));
  let folder = p.sharepoint_item_id ? await place(drive, p.sharepoint_item_id, cust.id, name) : null;
  if (!folder) folder = await child(drive, cust.id, name);
  await makeTree(drive, folder.id);
  await admin.from("projects").update({sharepoint_item_id: folder.id, sharepoint_url: folder.webUrl}).eq("id", p.id);
  return folder;
}

// ---------- whose folder, and may this person use it ----------
type Target = {kind: "deal" | "project", id: string, rootId: string, rootUrl: string};
async function dealRoot(admin: any, dealId: string): Promise<Target> {
  const {data: d} = await admin.from("deals").select("id, sharepoint_item_id, sharepoint_url, sharepoint_status").eq("id", dealId).single();
  if (!d) throw new Refused("Deal not found", 404);
  if (d.sharepoint_item_id && d.sharepoint_status === "ready") return {kind: "deal", id: dealId, rootId: d.sharepoint_item_id, rootUrl: d.sharepoint_url};
  const r: any = await createFor(admin, dealId);
  if (r.status !== "ready") throw new Error(r.error || "The deal's SharePoint folder isn't ready yet");
  return {kind: "deal", id: dealId, rootId: r.item_id, rootUrl: r.url};
}
async function projectRoot(admin: any, projectId: string): Promise<Target> {
  const {data: p} = await admin.from("projects").select("id, number, name, deal_id, account_id, created_at, sharepoint_item_id, sharepoint_url").eq("id", projectId).single();
  if (!p) throw new Refused("Project not found", 404);
  if (p.sharepoint_item_id) return {kind: "project", id: projectId, rootId: p.sharepoint_item_id, rootUrl: p.sharepoint_url};
  if (p.deal_id) {
    const d = await dealRoot(admin, p.deal_id);
    await admin.from("projects").update({sharepoint_item_id: d.rootId, sharepoint_url: d.rootUrl}).eq("id", projectId);
    return {kind: "project", id: projectId, rootId: d.rootId, rootUrl: d.rootUrl};
  }
  const folder = await standaloneProject(admin, p);
  return {kind: "project", id: projectId, rootId: folder.id, rootUrl: folder.webUrl};
}
// the folders this person may read (or write) for this deal or project: [key, label, parent, sub-folder]
async function allowedFolders(asUser: any, t: {kind: string, id: string}, action: "read" | "write") {
  if (t.kind === "deal") {
    const {data: ok} = await asUser.rpc("can_see_deal", {d: t.id});
    if (!ok) throw new Refused("That deal isn't available to you");
    return SALES.map(n => [n, n.replace(/^\d+ /, ""), "Sales", n]);
  }
  const checks = await Promise.all(Object.entries(PROJECT_FOLDERS).map(async ([key, [parent, name]]) => {
    const {data: ok} = await asUser.rpc("doc_can", {p: t.id, folder: key, action});
    return ok ? [key, name.replace(/^\d+ /, ""), parent, name] : null;
  }));
  const out = checks.filter(Boolean) as string[][];
  if (!out.length) throw new Refused(action === "read" ? "That project isn't available to you" : "You can't upload to this project");
  return out;
}
const fileOut = (f: any) => ({id: f.id, name: f.name, size: f.size ?? null, url: f.webUrl, folder: !!f.folder,
  mime: f.file?.mimeType || null, modified: f.lastModifiedDateTime, created: f.createdDateTime,
  by: f.createdBy?.user?.displayName || f.lastModifiedBy?.user?.displayName || null,
  thumb: f.thumbnails?.[0]?.medium?.url || f.thumbnails?.[0]?.small?.url || null});

async function listFiles(admin: any, asUser: any, t: Target) {
  const folders = await allowedFolders(asUser, t, "read");
  const drive = await driveId();
  const out = await Promise.all(folders.map(async ([key, label, parent, name]) => {
    const s = await sub(drive, t.rootId, parent, name);
    const files: any[] = [];
    let next: string | null = `/drives/${drive}/items/${s.id}/children?$expand=thumbnails&$top=200`;
    for (let i = 0; next && i < 5; i++) {
      const r = await graph(next);
      if (!r.ok) throw new Error(`Couldn't read "${name}" (${r.body.error?.message || r.status})`);
      files.push(...r.body.value.map(fileOut));
      next = r.body["@odata.nextLink"] ? r.body["@odata.nextLink"].replace("https://graph.microsoft.com/v1.0", "") : null;
    }
    return {key, label, path: parent + "/" + name, url: s.webUrl, files};
  }));
  return {connected: true, url: t.rootUrl, folders: out};
}
// checks the person may write to that folder before anything is created, then finds (or makes) it
async function writeTarget(admin: any, asUser: any, b: any) {
  const kind = b.project_id ? "project" : "deal", id = b.project_id || b.deal_id;
  if (!id) throw new Refused("deal_id or project_id is required", 400);
  const f = (await allowedFolders(asUser, {kind, id}, "write")).find(x => x[0] === b.folder);
  if (!f) throw new Refused("You can't upload to that folder");
  const t = kind === "project" ? await projectRoot(admin, id) : await dealRoot(admin, id);
  return {t, folder: await sub(await driveId(), t.rootId, f[2], f[3])};
}
async function uploadSession(drive: string, folderId: string, name: string) {
  const r = await graph(`/drives/${drive}/items/${folderId}:/${encodeURIComponent(safe(name))}:/createUploadSession`, {method: "POST",
    body: JSON.stringify({item: {"@microsoft.graph.conflictBehavior": "rename"}})});
  if (!r.ok) throw new Error("SharePoint wouldn't take the upload (" + (r.body.error?.message || r.status) + ")");
  return r.body.uploadUrl as string;
}
// a project upload gets a documents row so notes, uploader and closeout links work
async function finish(admin: any, user: any, t: Target, folderKey: string, folderId: string, itemId: string, note?: string, closeoutId?: string) {
  const drive = await driveId();
  const got = await graph(`/drives/${drive}/items/${itemId}?$expand=thumbnails`);
  if (!got.ok || got.body.parentReference?.id !== folderId) throw new Refused("That file isn't in this folder", 400);
  const f = fileOut(got.body);
  if (t.kind !== "project") return {file: f};
  const row = {project_id: t.id, folder: folderKey, name: f.name, path: "sp:" + f.id, sp_item_id: f.id, sp_url: f.url, size_bytes: f.size,
    mime_type: f.mime, note: (note || "").trim() || null, closeout_item_id: closeoutId || null, uploaded_by: user.id};
  const {data, error} = await admin.from("documents").upsert(row, {onConflict: "path"}).select().single();
  if (error) throw new Error("The file is in SharePoint but the app couldn't record it (" + error.message + ")");
  return {file: f, document: data};
}

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", {headers: cors});
  if (req.method !== "POST") return json({error: "POST only"}, 405);
  const auth = req.headers.get("Authorization") || "";
  const anon = Deno.env.get("SUPABASE_ANON_KEY") || req.headers.get("apikey") || "";
  const asUser = createClient(env("SUPABASE_URL"), anon, {global: {headers: {Authorization: auth}}, auth: {persistSession: false}});
  const {data: u} = await asUser.auth.getUser(auth.replace(/^Bearer\s+/i, ""));
  if (!u?.user) return json({error: "Sign in first"}, 401);
  const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {auth: {persistSession: false}});
  const target = (b: any) => b.project_id ? projectRoot(admin, b.project_id) : b.deal_id ? dealRoot(admin, b.deal_id) : Promise.reject(new Refused("deal_id or project_id is required", 400));

  try {
    // fallback upload: the file itself is the body, the details ride in a header
    const meta = req.headers.get("x-rfip-upload");
    if (meta) {
      if (!configured()) return json({connected: false});
      const b = JSON.parse(decodeURIComponent(meta));
      const bytes = new Uint8Array(await req.arrayBuffer());
      if (!bytes.length) throw new Refused("The file is empty", 400);
      if (bytes.length > MAX_BYTES) throw new Refused("Files can be up to 50 MB", 400);
      const {t, folder} = await writeTarget(admin, asUser, b);
      const up = await fetch(await uploadSession(await driveId(), folder.id, b.name || "file"), {method: "PUT",
        headers: {"Content-Range": `bytes 0-${bytes.length - 1}/${bytes.length}`}, body: bytes});
      const item = await up.json().catch(() => ({}));
      if (!up.ok || !item.id) throw new Error("SharePoint didn't accept the file (" + (item.error?.message || up.status) + ")");
      return json(await finish(admin, u.user, t, b.folder, folder.id, item.id, b.note, b.closeout_item_id));
    }

    let body: any = {}; try { body = await req.json(); } catch { /* empty */ }

    if (body.action === "status") return json({connected: configured(), site: configured() ? env("SP_SITE_URL") : null});

    if (body.action === "create") {
      if (!body.deal_id) return json({error: "deal_id is required"}, 400);
      const {data: ok} = await asUser.rpc("can_see_deal", {d: body.deal_id});
      if (!ok) return json({error: "That deal isn't available to you"}, 403);
      return json(await createFor(admin, body.deal_id));
    }

    if (body.action === "backfill") {
      const {data: isAdmin} = await asUser.rpc("is_admin");
      if (!isAdmin) return json({error: "Admins only"}, 403);
      if (!configured()) return json({error: "SharePoint isn't connected yet"}, 400);
      const {data: deals} = await admin.from("deals").select("id").limit(1000);
      const out = {ready: 0, error: 0, errors: [] as string[]};
      for (const d of deals || []) { const r: any = await createFor(admin, d.id); if (r.status === "ready") out.ready++; else { out.error++; if (r.error) out.errors.push(r.error); } }
      const {data: lone} = await admin.from("projects").select("id, number, name, account_id, sharepoint_item_id").is("deal_id", null).not("sharepoint_item_id", "is", null);
      for (const p of lone || []) { try { await standaloneProject(admin, p); } catch (e) { out.error++; out.errors.push(String((e as Error).message || e)); } }
      return json(out);
    }

    // an account was renamed in the CRM: rename its customer folder and refresh its deals' links
    if (body.action === "rename_customer") {
      if (!configured()) return json({connected: false});
      const {data: acct} = await asUser.from("accounts").select("id, name").eq("id", body.account_id).maybeSingle();
      if (!acct || !body.old_name || safe(body.old_name) === safe(acct.name)) return json({renamed: false});
      const drive = await driveId();
      const base = await rootFolder(drive);
      const old = await graph(`/drives/${drive}/items/${base.id}:/${encodeURIComponent(safe(body.old_name))}`);
      if (old.ok && old.body.folder) await place(drive, old.body.id, base.id, safe(acct.name));
      const {data: deals} = await admin.from("deals").select("id").eq("account_id", acct.id).not("sharepoint_item_id", "is", null);
      for (const d of deals || []) await createFor(admin, d.id);
      return json({renamed: true});
    }

    if (["files", "upload_start", "upload_finish", "delete"].includes(body.action) && !configured()) return json({connected: false});

    if (body.action === "files") {
      if (body.project_id) await allowedFolders(asUser, {kind: "project", id: body.project_id}, "read"); // check before creating anything
      else if (body.deal_id) await allowedFolders(asUser, {kind: "deal", id: body.deal_id}, "read");
      return json(await listFiles(admin, asUser, await target(body)));
    }

    if (body.action === "upload_start") {
      if (body.size > MAX_BYTES) throw new Refused("Files can be up to 50 MB", 400);
      const {folder} = await writeTarget(admin, asUser, body);
      return json({connected: true, upload_url: await uploadSession(await driveId(), folder.id, body.name || "file"), max_chunk: 60 * 1024 * 1024});
    }

    if (body.action === "upload_finish") {
      const {t, folder} = await writeTarget(admin, asUser, body);
      return json(await finish(admin, u.user, t, body.folder, folder.id, body.item_id, body.note, body.closeout_item_id));
    }

    if (body.action === "delete") {
      if (!body.item_id) throw new Refused("item_id is required", 400);
      const folders = await allowedFolders(asUser, {kind: body.project_id ? "project" : "deal", id: body.project_id || body.deal_id}, "read");
      const t = await target(body);
      const drive = await driveId();
      const got = await graph(`/drives/${drive}/items/${body.item_id}`);
      if (!got.ok) throw new Refused("That file is already gone from SharePoint", 404);
      // it has to sit in one of this deal's or project's folders
      const subs = await Promise.all(folders.map(f => sub(drive, t.rootId, f[2], f[3])));
      const inFolder = subs.some(x => x.id === got.body.parentReference?.id);
      if (!inFolder) throw new Refused("That file isn't in one of this record's folders");
      if (t.kind === "deal") {
        const {data: ok} = await asUser.rpc("can_manage_deal", {d: t.id});
        if (!ok) throw new Refused("Only the deal's account manager or an admin can delete its files");
      } else {
        const {data: doc} = await admin.from("documents").select("id, uploaded_by").eq("sp_item_id", body.item_id).maybeSingle();
        const {data: canEdit} = await asUser.rpc("ops_can_edit", {p: t.id});
        if (!canEdit && !(doc && doc.uploaded_by === u.user.id)) throw new Refused("Only the uploader, the PM, the department lead or an admin can delete this file");
      }
      const del = await graph(`/drives/${drive}/items/${body.item_id}`, {method: "DELETE"});
      if (!del.ok && del.status !== 404) throw new Error("SharePoint wouldn't delete it (" + (del.body.error?.message || del.status) + ")");
      if (t.kind === "project") await admin.from("documents").delete().eq("sp_item_id", body.item_id);
      return json({deleted: true});
    }

    return json({error: "Unknown action"}, 400);
  } catch (e) {
    if (e instanceof Refused) return json({error: e.message}, e.status);
    return json({error: String((e as Error).message || e).slice(0, 500)}, 500);
  }
});

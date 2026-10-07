// Staff: interoperability — SIP2 accounts, copy-cataloguing targets and protocol endpoint reference.
import { $, $$, BOOT, api, badge, confirmDialog, datetime, empty, esc, html, icon, modal, raw, skeleton, toast, withBusy } from "/static/js/core.js";

const isAdmin = BOOT.user?.role === "admin";
const state = { branches: [], sip: [], targets: [] };
const panel = () => $("#io-panel");
const attr = (name, v) => (v === undefined || v === null || v === false ? "" : v === true ? raw(` ${name}`) : raw(` ${name}="${esc(v)}"`));
const deniedBox = (what) => html`<div class="alert warn" role="note">${icon("shield")}<div><strong>Administrator access required.</strong>
  Only administrators can change ${what}. You can still read the configuration below.</div></div>`;

// ------------------------------------------------------------------ tabs

function setupTabs(root, onSelect) {
  const tabs = $$('[role="tab"]', root);
  const select = (tab, focus = false) => {
    tabs.forEach((t) => { const on = t === tab; t.setAttribute("aria-selected", on); t.tabIndex = on ? 0 : -1; });
    panel().setAttribute("aria-labelledby", tab.id);
    if (focus) tab.focus();
    history.replaceState(null, "", `#${tab.dataset.tab}`);
    onSelect(tab.dataset.tab);
  };
  root.addEventListener("click", (e) => { const t = e.target.closest('[role="tab"]'); if (t) select(t); });
  root.addEventListener("keydown", (e) => {
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    select(tabs[(next + tabs.length) % tabs.length], true);
  });
  return (key) => { const t = tabs.find((x) => x.dataset.tab === key) || tabs[0]; select(t); };
}

/** Modal form that stays open until `action(FormData)` succeeds. Resolves to the result or null. */
function formModal(opts, action) {
  let result = null;
  const done = modal(opts);
  const dlg = $$("dialog").at(-1);
  const form = $("form", dlg);
  const ok = $('button[value="ok"]', dlg);
  form.addEventListener("submit", async (e) => {
    if (e.submitter !== ok) return;
    e.preventDefault();
    if (!form.checkValidity()) { form.reportValidity(); return; }
    try {
      result = await withBusy(ok, () => action(new FormData(form)));
      dlg.close("ok");
    } catch { /* withBusy already showed the error */ }
  });
  return done.then(() => result);
}

// ------------------------------------------------------------------ SIP2 accounts

const SERVICES = [
  ["allow_checkout", "Checkout"], ["allow_checkin", "Check-in"], ["allow_renew", "Renewals"],
  ["allow_patron_info", "Patron information"], ["allow_holds", "Holds"], ["allow_fee_paid", "Fee payment"],
  ["allow_block_patron", "Block patron (card retention)"],
];
const ENCODINGS = ["utf-8", "ascii", "latin-1", "cp850", "cp1252", "iso-8859-15"];

function sipTable(rows) {
  if (!rows.length) return empty("No SIP2 accounts yet. Create one for each self-check kiosk, gate or e-book platform.", "inbox");
  return html`<div class="table-wrap"><table class="table">
    <caption class="sr-only">SIP2 accounts</caption>
    <thead><tr><th scope="col">Login</th><th scope="col">Terminal</th><th scope="col">Branch</th><th scope="col">Institution</th>
      <th scope="col">Services</th><th scope="col">Last login</th><th scope="col">Status</th>${isAdmin ? html`<th scope="col"><span class="sr-only">Actions</span></th>` : ""}</tr></thead>
    <tbody>${rows.map((a) => html`<tr>
      <td class="mono"><strong>${a.login}</strong></td>
      <td>${a.name || "—"}${a.allowed_networks ? html`<div class="tiny muted mono">${a.allowed_networks}</div>` : ""}</td>
      <td>${a.branch.name}</td><td class="mono small">${a.institution_id}</td>
      <td><div class="row tight">${SERVICES.filter(([k]) => a[k]).map(([, label]) => html`<span class="badge">${label}</span>`)}
        ${a.require_patron_password ? badge("info", "PIN required") : ""}${a.error_detection ? badge("info", "Checksums") : ""}</div></td>
      <td class="small">${a.last_login_at ? html`${datetime(a.last_login_at)}<div class="tiny muted mono">${a.last_login_ip || ""}</div>` : html`<span class="muted">Never</span>`}</td>
      <td>${a.is_active ? badge("ok", "Active") : badge("bad", "Disabled")}</td>
      ${isAdmin ? html`<td class="right nowrap">
        <button class="btn sm ghost" data-sip-edit="${a.id}" aria-label="Edit ${a.login}">${icon("edit")}Edit</button>
        <button class="btn sm ghost danger" data-sip-delete="${a.id}" aria-label="Delete ${a.login}">${icon("trash")}</button></td>` : ""}
    </tr>`)}</tbody></table></div>`;
}

async function sipTab() {
  if (!isAdmin) {
    panel().innerHTML = html`${deniedBox("SIP2 accounts")}${sipHelp()}`;
    return;
  }
  panel().innerHTML = `<div class="card pad">${skeleton(4)}</div>`;
  const [{ results }, lk] = await Promise.all([api("/sip/accounts"), api("/lookups")]);
  state.sip = results;
  state.branches = lk.branches;
  panel().innerHTML = html`<div class="stack">
    <div class="card flush">
      <div class="card-head" style="padding-bottom:var(--pad);flex-wrap:wrap">
        <div><h2>SIP2 accounts</h2><div class="small muted">Each self-check kiosk, security gate, sorter or e-book platform logs in with its own account (SIP message 93).</div></div>
        <button class="btn primary" data-sip-add>${icon("plus")}New SIP account</button>
      </div>${sipTable(results)}</div>
    ${sipHelp()}</div>`;
}

function sipHelp() {
  return html`<div class="card pad stack tight">
    <h3>Running the SIP2 server</h3>
    <p class="small muted">The SIP2 server is a separate process. Run it next to the web server and point terminals at its host and port.</p>
    <pre class="io-code">python -m librowise sip2 --host 0.0.0.0 --port 6001</pre>
    <p class="small muted">SIP2 sends card numbers and PINs in clear text: keep it on the library network or VPN, or start it with <code>--certfile</code>/<code>--keyfile</code> for TLS. See <code>docs/INTEROP.md</code> for a sample kiosk configuration.</p>
  </div>`;
}

function sipForm(a) {
  const v = (k, d) => (a ? a[k] : d);
  const bins = a?.sort_bins || {};
  return html`<div class="grid cols-2">
    <div class="field"><label for="s-login">Login (CN)</label><input id="s-login" name="login" class="mono" required maxlength="64" pattern="[A-Za-z0-9_.@\\-]+" autocomplete="off" spellcheck="false" value="${v("login", "")}"></div>
    <div class="field"><label for="s-password">Password (CO)</label><input id="s-password" name="password" type="password" autocomplete="new-password" ${a ? "" : "required"} minlength="10" maxlength="256">
      <span class="hint">${a ? "Leave blank to keep the current password." : "At least 10 characters mixing letters, digits and symbols."}</span></div>
    <div class="field"><label for="s-name">Terminal name</label><input id="s-name" name="name" maxlength="120" placeholder="Kiosk 1, ground floor" value="${v("name", "") || ""}"></div>
    <div class="field"><label for="s-branch">Branch</label><select id="s-branch" name="branch_id" required>
      ${state.branches.map((b) => html`<option value="${b.id}"${attr("selected", b.id === v("branch_id", BOOT.user?.home_branch_id))}>${b.name}</option>`)}</select>
      <span class="hint">Loans and returns are recorded at this branch.</span></div>
    <div class="field"><label for="s-inst">Institution ID (AO)</label><input id="s-inst" name="institution_id" class="mono" required maxlength="64" value="${v("institution_id", "LIBROWISE")}"></div>
    <div class="field"><label for="s-nets">Allowed networks</label><input id="s-nets" name="allowed_networks" class="mono" maxlength="500" placeholder="10.0.0.0/8, 192.168.1.20" value="${v("allowed_networks", "") || ""}">
      <span class="hint">Comma-separated IPs or CIDR ranges. Empty allows any address.</span></div>
    <div class="field"><label for="s-delim">Field delimiter</label><input id="s-delim" name="delimiter" class="mono" required maxlength="1" value="${v("delimiter", "|")}"></div>
    <div class="field"><label for="s-enc">Character set</label><select id="s-enc" name="encoding">
      ${ENCODINGS.map((e) => html`<option${attr("selected", e === v("encoding", "utf-8"))}>${e}</option>`)}</select></div>
    <div class="field"><label for="s-idle">Idle timeout (seconds)</label><input id="s-idle" name="idle_timeout" type="number" min="30" max="86400" required value="${v("idle_timeout", 600)}"></div>
    <div class="field"><span class="hint" aria-hidden="true">&nbsp;</span>
      <label class="checkbox"><input type="checkbox" name="error_detection"${attr("checked", v("error_detection", false))}> Require checksums (AY/AZ error detection)</label></div>
    <fieldset class="io-fieldset" style="grid-column:1/-1"><legend>Services this terminal may use</legend>
      <div class="grid cols-2">${SERVICES.map(([k, label]) => html`<label class="checkbox"><input type="checkbox" name="${k}"${attr("checked", v(k, !["allow_holds", "allow_fee_paid"].includes(k)))}> ${label}</label>`)}</div>
    </fieldset>
    <fieldset class="io-fieldset" style="grid-column:1/-1"><legend>Behaviour</legend>
      <div class="stack tight">
        <label class="checkbox"><input type="checkbox" name="require_patron_password"${attr("checked", v("require_patron_password", false))}> Require the patron's PIN/password for transactions and account details</label>
        <label class="checkbox"><input type="checkbox" name="checked_in_ok"${attr("checked", v("checked_in_ok", true))}> Accept returns of items that were not on loan</label>
        <label class="checkbox"><input type="checkbox" name="is_active"${attr("checked", v("is_active", true))}> Account enabled</label>
      </div>
    </fieldset>
    <fieldset class="io-fieldset" style="grid-column:1/-1"><legend>Sorting bins (automated returns, field CL)</legend>
      <div class="grid cols-3">
        <div class="field"><label for="s-bin-hold">Holds</label><input id="s-bin-hold" name="bin_hold" maxlength="16" value="${bins.hold || ""}"></div>
        <div class="field"><label for="s-bin-transfer">Transfers</label><input id="s-bin-transfer" name="bin_transfer" maxlength="16" value="${bins.transfer || ""}"></div>
        <div class="field"><label for="s-bin-default">Everything else</label><input id="s-bin-default" name="bin_default" maxlength="16" value="${bins.default || ""}"></div>
      </div>
    </fieldset>
    <div class="field" style="grid-column:1/-1"><label for="s-notes">Notes</label><textarea id="s-notes" name="notes" maxlength="2000">${v("notes", "") || ""}</textarea></div>
  </div>`;
}

function sipPayload(fd, editing) {
  const body = {
    login: String(fd.get("login")).trim(), name: String(fd.get("name") || "").trim() || null,
    institution_id: String(fd.get("institution_id")).trim(), branch_id: Number(fd.get("branch_id")),
    delimiter: String(fd.get("delimiter")), encoding: String(fd.get("encoding")),
    idle_timeout: Number(fd.get("idle_timeout")), allowed_networks: String(fd.get("allowed_networks") || "").trim() || null,
    error_detection: fd.has("error_detection"), require_patron_password: fd.has("require_patron_password"),
    checked_in_ok: fd.has("checked_in_ok"), is_active: fd.has("is_active"),
    notes: String(fd.get("notes") || "").trim() || null,
    sort_bins: Object.fromEntries(["hold", "transfer", "default"].map((k) => [k, String(fd.get(`bin_${k}`) || "").trim()]).filter(([, x]) => x)),
  };
  for (const [k] of SERVICES) body[k] = fd.has(k);
  const pw = String(fd.get("password") || "");
  if (pw || !editing) body.password = pw;
  return body;
}

async function editSip(id) {
  const a = id ? state.sip.find((x) => String(x.id) === String(id)) : null;
  if (id && !a) return;
  const saved = await formModal({ title: a ? `Edit SIP account ${a.login}` : "New SIP account", body: sipForm(a), submit: a ? "Save changes" : "Create account", wide: true },
    (fd) => api(a ? `/sip/accounts/${a.id}` : "/sip/accounts", { method: a ? "PATCH" : "POST", body: sipPayload(fd, !!a) }));
  if (saved) { toast(a ? "SIP account updated" : "SIP account created", "success"); await sipTab(); }
}

async function deleteSip(id) {
  const a = state.sip.find((x) => String(x.id) === String(id));
  if (!a || !(await confirmDialog(`Delete SIP account ${a.login}?`, "Terminals using this login will no longer be able to connect. Consider disabling the account instead."))) return;
  try {
    await api(`/sip/accounts/${a.id}`, { method: "DELETE" });
    toast("SIP account deleted", "success");
    await sipTab();
  } catch (e) { toast(e.message, "error"); }
}

// ------------------------------------------------------------------ copy-cataloguing targets

function targetForm(t) {
  const v = (k, d) => (t ? t[k] : d);
  return html`<div class="grid cols-2">
    <div class="field"><label for="t-name">Name</label><input id="t-name" name="name" required maxlength="120" value="${v("name", "")}"></div>
    <div class="field"><label for="t-url">SRU base URL</label><input id="t-url" name="url" type="url" required maxlength="500" placeholder="http://lx2.loc.gov:210/LCDB" value="${v("url", "")}"></div>
    <div class="field"><label for="t-version">SRU version</label><select id="t-version" name="sru_version">
      ${["1.1", "1.2", "2.0"].map((x) => html`<option${attr("selected", x === v("sru_version", "1.1"))}>${x}</option>`)}</select></div>
    <div class="field"><label for="t-schema">Record schema</label><input id="t-schema" name="record_schema" required maxlength="64" value="${v("record_schema", "marcxml")}"></div>
    <div class="field"><label for="t-title">Title index</label><input id="t-title" name="title_index" class="mono" required maxlength="40" value="${v("title_index", "dc.title")}"></div>
    <div class="field"><label for="t-author">Author index</label><input id="t-author" name="author_index" class="mono" required maxlength="40" value="${v("author_index", "dc.creator")}"></div>
    <div class="field"><label for="t-isbn">ISBN index</label><input id="t-isbn" name="isbn_index" class="mono" required maxlength="40" value="${v("isbn_index", "bath.isbn")}"></div>
    <div class="field"><label for="t-timeout">Timeout (seconds)</label><input id="t-timeout" name="timeout_seconds" type="number" min="1" max="60" required value="${v("timeout_seconds", 10)}"></div>
    <div class="field"><label for="t-pos">Display order</label><input id="t-pos" name="position" type="number" min="0" max="1000" required value="${v("position", 0)}"></div>
    <div class="field"><span class="hint" aria-hidden="true">&nbsp;</span><label class="checkbox"><input type="checkbox" name="enabled"${attr("checked", v("enabled", true))}> Enabled</label></div>
  </div>`;
}

const targetPayload = (fd) => ({
  name: String(fd.get("name")).trim(), url: String(fd.get("url")).trim(), sru_version: String(fd.get("sru_version")),
  record_schema: String(fd.get("record_schema")).trim(), title_index: String(fd.get("title_index")).trim(),
  author_index: String(fd.get("author_index")).trim(), isbn_index: String(fd.get("isbn_index")).trim(),
  timeout_seconds: Number(fd.get("timeout_seconds")), position: Number(fd.get("position")), enabled: fd.has("enabled"),
});

async function targetsTab() {
  panel().innerHTML = `<div class="card pad">${skeleton(4)}</div>`;
  let results = [];
  try {
    ({ results } = await api("/copycat/targets"));
  } catch (e) {
    panel().innerHTML = empty(e.status === 403 ? "Copy-cataloguing targets are visible to cataloguers only." : e.message, "alert");
    return;
  }
  state.targets = results;
  const builtIn = results.length === 1 && results[0].id === 0;
  panel().innerHTML = html`<div class="stack">${isAdmin ? "" : deniedBox("copy-cataloguing targets")}
    <div class="card flush">
      <div class="card-head" style="padding-bottom:var(--pad);flex-wrap:wrap">
        <div><h2>Copy-cataloguing targets</h2><div class="small muted">Remote SRU catalogues searched from <a href="/staff/copycat">Copy cataloguing</a>. Records are fetched as MARCXML.</div></div>
        ${isAdmin ? html`<button class="btn primary" data-target-add>${icon("plus")}Add target</button>` : ""}
      </div>
      ${builtIn ? html`<div class="alert info" style="margin:0 var(--pad) var(--pad)">${icon("info")}<div>The built-in Library of Congress target is in use. Add a target to customise the list; once you do, only configured targets are offered.</div></div>` : ""}
      <div class="table-wrap"><table class="table"><caption class="sr-only">Copy-cataloguing targets</caption>
        <thead><tr><th scope="col">Name</th><th scope="col">URL</th><th scope="col">SRU</th><th scope="col">Indexes (title / author / ISBN)</th><th scope="col">Timeout</th><th scope="col">Status</th>${isAdmin ? html`<th scope="col"><span class="sr-only">Actions</span></th>` : ""}</tr></thead>
        <tbody>${results.map((t) => html`<tr>
          <td><strong>${t.name}</strong></td><td class="mono small" style="word-break:break-all">${t.url}</td><td>${t.sru_version}</td>
          <td class="mono small">${t.title_index} / ${t.author_index} / ${t.isbn_index}</td><td>${t.timeout_seconds}s</td>
          <td>${t.enabled ? badge("ok", "Enabled") : badge("", "Disabled")}</td>
          ${isAdmin ? html`<td class="right nowrap">${t.id ? html`
            <button class="btn sm ghost" data-target-edit="${t.id}" aria-label="Edit ${t.name}">${icon("edit")}Edit</button>
            <button class="btn sm ghost danger" data-target-delete="${t.id}" aria-label="Delete ${t.name}">${icon("trash")}</button>` : html`<span class="tiny muted">Built in</span>`}</td>` : ""}
        </tr>`)}</tbody></table></div>
    </div></div>`;
}

async function editTarget(id) {
  const t = id ? state.targets.find((x) => String(x.id) === String(id)) : null;
  const saved = await formModal({ title: t ? `Edit ${t.name}` : "Add copy-cataloguing target", body: targetForm(t), submit: t ? "Save changes" : "Add target", wide: true },
    (fd) => api(t ? `/copycat/targets/${t.id}` : "/copycat/targets", { method: t ? "PATCH" : "POST", body: targetPayload(fd) }));
  if (saved) { toast("Target saved", "success"); await targetsTab(); }
}

async function deleteTarget(id) {
  const t = state.targets.find((x) => String(x.id) === String(id));
  if (!t || !(await confirmDialog(`Delete ${t.name}?`, "Cataloguers will no longer be able to search this catalogue."))) return;
  try {
    await api(`/copycat/targets/${t.id}`, { method: "DELETE" });
    toast("Target deleted", "success");
    await targetsTab();
  } catch (e) { toast(e.message, "error"); }
}

// ------------------------------------------------------------------ endpoint reference

function endpointsTab() {
  const o = location.origin;
  const link = (path, label) => html`<li><a href="${o}${path}" target="_blank" rel="noopener" class="mono small">${label || path}</a></li>`;
  panel().innerHTML = html`<div class="grid cols-2 io-endpoints">
    <section class="card pad stack tight" aria-labelledby="ep-sru">
      <h2 id="ep-sru">SRU 1.2 / 2.0</h2>
      <p class="small muted">Search/Retrieve via URL with CQL queries. Record schemas: <code>marcxml</code> and <code>dc</code>. Used by other libraries' copy cataloguing, discovery layers and reference managers.</p>
      <pre class="io-code">${o}/sru</pre>
      <ul class="io-links">${link("/sru?operation=explain&version=1.2", "Explain")}
        ${link("/sru?version=1.2&operation=searchRetrieve&query=dc.title%3Dhistory&maximumRecords=5", "dc.title=history")}
        ${link("/sru?version=2.0&query=dc.creator%20all%20%22tolkien%22&recordSchema=dc", "SRU 2.0 · Dublin Core")}</ul>
      <p class="tiny muted">Indexes: cql.serverChoice, dc.title, dc.creator, dc.subject, dc.publisher, dc.date, dc.identifier, bath.isbn, bath.issn, dc.language, dc.type, rec.id.</p>
    </section>
    <section class="card pad stack tight" aria-labelledby="ep-oai">
      <h2 id="ep-oai">OAI-PMH 2.0</h2>
      <p class="small muted">Metadata harvesting for union catalogues, aggregators and discovery services. Formats <code>oai_dc</code> and <code>marc21</code>; one set per material type; deleted records are reported.</p>
      <pre class="io-code">${o}/oai</pre>
      <ul class="io-links">${link("/oai?verb=Identify", "Identify")}${link("/oai?verb=ListMetadataFormats", "ListMetadataFormats")}
        ${link("/oai?verb=ListSets", "ListSets")}${link("/oai?verb=ListRecords&metadataPrefix=oai_dc", "ListRecords (oai_dc)")}</ul>
    </section>
    <section class="card pad stack tight" aria-labelledby="ep-sip">
      <h2 id="ep-sip">SIP2</h2>
      <p class="small muted">3M Standard Interchange Protocol 2.00 over TCP for self-check kiosks, security gates, sorters and e-book platforms. Default port 6001, field delimiter <code>|</code>, CR-terminated messages.</p>
      <pre class="io-code">python -m librowise sip2 --host 0.0.0.0 --port 6001</pre>
      <p class="small muted">Supported: 93/94 login, 99/98 status, 23/24, 63/64, 11/12, 09/10, 29/30, 65/66, 17/18, 35/36, 97 resend, 01 block, 25/26, 15/16 holds, 37/38 fee paid.</p>
    </section>
    <section class="card pad stack tight" aria-labelledby="ep-ld">
      <h2 id="ep-ld">Linked data &amp; SEO</h2>
      <p class="small muted">Every public record page embeds schema.org JSON-LD (Book, author, ISBN, publication date, language and per-branch availability offers) and Open Graph tags, rendered on the server so search engines and link previews see them.</p>
      <ul class="io-links">${link("/record/1", "Sample record page")}</ul>
    </section>
  </div>`;
}

// ------------------------------------------------------------------ init

export default async function init() {
  const show = async (tab) => {
    try {
      if (tab === "sip") await sipTab();
      else if (tab === "targets") await targetsTab();
      else endpointsTab();
    } catch (e) {
      panel().innerHTML = empty(e.message, "alert");
    }
  };
  const select = setupTabs($("#io-tabs"), show);
  panel().addEventListener("click", (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if ("sipAdd" in t.dataset) editSip(null);
    else if (t.dataset.sipEdit) editSip(t.dataset.sipEdit);
    else if (t.dataset.sipDelete) deleteSip(t.dataset.sipDelete);
    else if ("targetAdd" in t.dataset) editTarget(null);
    else if (t.dataset.targetEdit) editTarget(t.dataset.targetEdit);
    else if (t.dataset.targetDelete) deleteTarget(t.dataset.targetDelete);
  });
  select(location.hash.slice(1) || "sip");
}

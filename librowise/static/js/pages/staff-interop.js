// Staff › Administration › Interoperability — SIP2 accounts, copy-cataloguing targets (with a connection test)
// and the protocol endpoints other systems use (SRU, OAI-PMH, schema.org, SIP2). Hashes: #sip #targets #endpoints.
// Editing needs interop:manage (administrators); everyone else gets a read-only view.
import { $, BOOT, api, datetime, html, icon, num, relative, toast, withBusy } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";
import { dataTable } from "/static/js/ui/data-table.js";
import { confirmDestructive } from "/static/js/ui/dialog.js";
import { emptyState, errorState } from "/static/js/ui/empty.js";
import { field } from "/static/js/ui/form.js";
import { wireTabsPanel } from "/static/js/ui/tabs.js";
import { copyButton, pill, rowMenu, wireKit } from "/static/js/pages/lib/admin-kit.js";
import { editDialog, numField, switchField } from "/static/js/pages/lib/settings-ui.js";

const canManage = () => $("#io-tabs")?.dataset.canManage === "true";
const state = { tab: "sip", branches: [], sip: [], targets: [] };

const SERVICES = ["allow_checkout", "allow_checkin", "allow_renew", "allow_patron_info", "allow_holds", "allow_fee_paid", "allow_block_patron"];
const DEFAULT_OFF = ["allow_holds", "allow_fee_paid"];
const ENCODINGS = [["utf-8", "UTF-8"], ["ascii", "ASCII"], ["latin-1", "Latin-1 (ISO-8859-1)"], ["cp850", "DOS (CP850)"], ["cp1252", "Windows (CP1252)"], ["iso-8859-15", "ISO-8859-15"]];
const serviceLabel = (k) => t(`admin.interop.service.${k}`);

function codeBlock(text, label) {
  return html`<div class="io-code"><pre tabindex="0" aria-label="${label}"><code>${text}</code></pre>${copyButton(text, { label: t("admin.interop.copy_named", { name: label }) })}</div>`;
}

// ------------------------------------------------------------------ SIP2 accounts

function sipHelp() {
  return html`<section class="card as-group" aria-labelledby="io-sip-run">
    <header class="as-group-head"><h3 id="io-sip-run">${icon("monitor")}${t("admin.interop.sip.run_title")}</h3><p>${t("admin.interop.sip.run_desc")}</p></header>
    <div class="as-group-body stack">${codeBlock("python -m librowise sip2 --host 0.0.0.0 --port 6001", t("admin.interop.sip.command"))}
      <p class="small muted as-note">${icon("shield")}<span>${t("admin.interop.sip.tls_note")}</span></p></div></section>`;
}

function sipForm(a) {
  const v = (k, d) => (a ? a[k] ?? d : d);
  const bins = a?.sort_bins || {};
  const branches = state.branches.map((b) => [b.id, b.name]);
  return html`<div class="stack">
    <fieldset class="as-fieldset"><legend>${t("admin.interop.sip.g_connection")}</legend><div class="form-grid">
      ${field({ name: "login", label: t("admin.interop.sip.f.login"), value: v("login", ""), required: true, help: t("admin.interop.sip.f.login_help"),
        attrs: 'class="mono" maxlength="64" pattern="[A-Za-z0-9_.@\\-]+" autocomplete="off" spellcheck="false"' })}
      ${field({ name: "password", label: t("admin.interop.sip.f.password"), type: "password", required: !a, optional: !!a,
        help: a ? t("admin.interop.sip.f.password_keep") : t("admin.interop.sip.f.password_help"), attrs: 'minlength="10" maxlength="256" autocomplete="new-password"' })}
      ${field({ name: "name", label: t("admin.interop.sip.f.name"), value: v("name", "") || "", optional: true, placeholder: t("admin.interop.sip.f.name_ph"), attrs: 'maxlength="120"' })}
      ${field({ name: "branch_id", label: t("admin.interop.sip.f.branch"), as: "select", value: v("branch_id", BOOT.user?.home_branch_id), options: branches, required: true, help: t("admin.interop.sip.f.branch_help") })}
      ${field({ name: "institution_id", label: t("admin.interop.sip.f.institution"), value: v("institution_id", "LIBROWISE"), required: true, attrs: 'class="mono" maxlength="64"' })}
      ${field({ name: "allowed_networks", label: t("admin.interop.sip.f.networks"), value: v("allowed_networks", "") || "", optional: true, help: t("admin.interop.sip.f.networks_help"),
        placeholder: "10.0.0.0/8, 192.168.1.20", attrs: 'class="mono" maxlength="500"' })}</div></fieldset>
    <fieldset class="as-fieldset"><legend>${t("admin.interop.sip.g_services")}</legend><div class="form-grid">
      ${SERVICES.map((k) => switchField({ name: k, label: serviceLabel(k), checked: v(k, !DEFAULT_OFF.includes(k)), span: 1 }))}</div></fieldset>
    <fieldset class="as-fieldset"><legend>${t("admin.interop.sip.g_behaviour")}</legend><div class="form-grid">
      ${switchField({ name: "require_patron_password", label: t("admin.interop.sip.f.require_pin"), checked: v("require_patron_password", false), help: t("admin.interop.sip.f.require_pin_help"), span: 1 })}
      ${switchField({ name: "checked_in_ok", label: t("admin.interop.sip.f.checked_in_ok"), checked: v("checked_in_ok", true), help: t("admin.interop.sip.f.checked_in_ok_help"), span: 1 })}
      ${switchField({ name: "is_active", label: t("admin.interop.sip.f.active"), checked: v("is_active", true), span: 1 })}
      ${switchField({ name: "error_detection", label: t("admin.interop.sip.f.checksums"), checked: v("error_detection", false), help: t("admin.interop.sip.f.checksums_help"), span: 1 })}</div></fieldset>
    <fieldset class="as-fieldset"><legend>${t("admin.interop.sip.g_protocol")}</legend><div class="form-grid">
      ${field({ name: "delimiter", label: t("admin.interop.sip.f.delimiter"), value: v("delimiter", "|"), required: true, attrs: 'class="mono" maxlength="1" minlength="1"' })}
      ${field({ name: "encoding", label: t("admin.interop.sip.f.encoding"), as: "select", value: v("encoding", "utf-8"), options: ENCODINGS })}
      ${numField({ name: "idle_timeout", label: t("admin.interop.sip.f.idle"), unit: t("admin.common.unit_word.seconds"), min: 30, max: 86400, value: v("idle_timeout", 600), help: t("admin.interop.sip.f.idle_help") })}</div></fieldset>
    <fieldset class="as-fieldset"><legend>${t("admin.interop.sip.g_bins")}</legend><p class="small muted">${t("admin.interop.sip.bins_help")}</p><div class="form-grid">
      ${field({ name: "bin_hold", label: t("admin.interop.sip.f.bin_hold"), value: bins.hold || "", optional: true, attrs: 'class="mono" maxlength="16"' })}
      ${field({ name: "bin_transfer", label: t("admin.interop.sip.f.bin_transfer"), value: bins.transfer || "", optional: true, attrs: 'class="mono" maxlength="16"' })}
      ${field({ name: "bin_default", label: t("admin.interop.sip.f.bin_default"), value: bins.default || "", optional: true, attrs: 'class="mono" maxlength="16"' })}</div></fieldset>
    ${field({ name: "notes", label: t("admin.interop.sip.f.notes"), as: "textarea", value: v("notes", "") || "", optional: true, attrs: 'maxlength="2000" rows="3"' })}</div>`;
}

function sipPayload(d, editing) {
  const body = {
    login: d.login.trim(), name: d.name.trim() || null, institution_id: d.institution_id.trim(), branch_id: Number(d.branch_id),
    delimiter: d.delimiter, encoding: d.encoding, idle_timeout: Number(d.idle_timeout), allowed_networks: d.allowed_networks.trim() || null,
    error_detection: d.error_detection === "on", require_patron_password: d.require_patron_password === "on", checked_in_ok: d.checked_in_ok === "on",
    is_active: d.is_active === "on", notes: d.notes.trim() || null,
    sort_bins: Object.fromEntries(["hold", "transfer", "default"].map((k) => [k, (d[`bin_${k}`] || "").trim()]).filter(([, x]) => x)),
  };
  for (const k of SERVICES) body[k] = d[k] === "on";
  if (d.password || !editing) body.password = d.password;
  return body;
}

async function editSip(a) {
  const saved = await editDialog({
    title: a ? t("admin.interop.sip.edit_title", { name: a.login }) : t("admin.interop.sip.add_title"), size: "lg",
    submit: a ? t("admin.common.save_changes") : t("admin.interop.sip.create"), body: sipForm(a),
    validate: { login: (val) => (state.sip.some((x) => x.login === val.trim() && x.id !== a?.id) ? t("admin.interop.sip.login_taken") : true),
      delimiter: (val) => (/^[A-Za-z0-9\s]$/.test(val) ? t("admin.interop.sip.delimiter_rule") : true) },
    onSubmit: (d) => api(a ? `/sip/accounts/${a.id}` : "/sip/accounts", { method: a ? "PATCH" : "POST", body: sipPayload(d, !!a) }),
  });
  if (!saved) return;
  toast(a ? t("admin.common.saved_named", { name: saved.login }) : t("admin.common.added_named", { name: saved.login }), "success");
  await show("sip");
}

async function renderSip(panel) {
  if (!canManage()) { panel.innerHTML = html`<div class="card">${emptyState({ art: "inbox", title: t("admin.interop.sip.readonly_title"), body: t("admin.interop.sip.readonly_body") })}</div>${sipHelp()}`; return; }
  const [{ results }, lk] = await Promise.all([api("/sip/accounts"), api("/lookups")]);
  state.sip = results;
  state.branches = lk.branches || [];
  panel.innerHTML = html`<div class="as-tab-head"><p class="muted">${t("admin.interop.sip.intro")}</p>
      <button type="button" class="btn primary" data-sip-add>${icon("plus")}${t("admin.interop.sip.add")}</button></div>
    <div id="io-sip-table"></div>${sipHelp()}`;
  const table = dataTable($("#io-sip-table", panel), {
    id: "interop-sip", caption: t("admin.interop.tab.sip"), rowKey: (a) => a.id, rowLabel: (a) => a.login,
    columns: [
      { key: "login", label: t("admin.interop.sip.col.login"), primary: true, hideable: false, csv: (a) => a.login,
        render: (a) => html`<div class="dt-cell-stack"><button type="button" class="link-btn as-row-title mono" data-sip-edit>${a.login}</button><span class="sub">${a.name || t("admin.interop.sip.unnamed")}</span></div>` },
      { key: "branch", label: t("admin.interop.sip.col.branch"), csv: (a) => a.branch.name, render: (a) => a.branch.name },
      { key: "services", label: t("admin.interop.sip.col.services"), csv: (a) => SERVICES.filter((k) => a[k]).map(serviceLabel).join("; "),
        render: (a) => {
          const on = SERVICES.filter((k) => a[k]);
          return html`<div class="as-chips">${on.map((k) => html`<span class="as-chip">${serviceLabel(k)}</span>`)}${a.require_patron_password ? pill("info", t("admin.interop.sip.pin_required"), { dot: false }) : ""}</div>`;
        } },
      { key: "last_login", label: t("admin.interop.sip.col.last_login"), csv: (a) => a.last_login_at || "",
        render: (a) => (a.last_login_at ? html`<div class="dt-cell-stack"><span title="${datetime(a.last_login_at)}">${relative(a.last_login_at)}</span><span class="sub mono">${a.last_login_ip || ""}</span></div>` : html`<span class="muted">${t("admin.common.never")}</span>`) },
      { key: "status", label: t("admin.interop.col.status"), csv: (a) => (a.is_active ? "active" : "disabled"),
        render: (a) => (a.is_active ? pill("success", t("admin.interop.active")) : pill("neutral", t("admin.interop.disabled"))) },
      { key: "networks", label: t("admin.interop.sip.col.networks"), hidden: true, csv: (a) => a.allowed_networks || "", render: (a) => (a.allowed_networks ? html`<span class="mono small">${a.allowed_networks}</span>` : t("admin.interop.sip.any_network")) },
      { key: "actions", label: t("admin.common.actions"), labelHidden: true, hideable: false, csv: false, cellClass: "as-cell-actions", headClass: "as-cell-actions",
        render: (a) => rowMenu({ label: a.login, items: [
          { id: "edit", label: t("admin.common.edit"), icon: "edit" },
          { id: "toggle", label: a.is_active ? t("admin.interop.sip.disable") : t("admin.interop.sip.enable"), icon: a.is_active ? "x-circle" : "check-circle" },
          { id: "delete", label: t("admin.common.delete"), icon: "trash", danger: true }] }) },
    ],
    exportName: "librowise-sip-accounts",
    empty: { art: "inbox", title: t("admin.interop.sip.empty_title"), body: t("admin.interop.sip.empty_body"),
      actions: html`<button type="button" class="btn" data-sip-add>${icon("plus")}${t("admin.interop.sip.add")}</button>` },
  });
  table.setRows(results);
}

async function sipAction(a, action) {
  if (action === "edit") return editSip(a);
  if (action === "toggle") {
    try {
      await api(`/sip/accounts/${a.id}`, { method: "PATCH", body: { is_active: !a.is_active } });
      toast(a.is_active ? t("admin.interop.sip.disabled_named", { name: a.login }) : t("admin.interop.sip.enabled_named", { name: a.login }), "success");
      await show("sip");
    } catch (err) { toast(err.message, "error"); }
    return undefined;
  }
  if (action === "delete") {
    const ok = await confirmDestructive({ title: t("admin.interop.sip.delete_title", { name: a.login }), text: t("admin.interop.sip.delete_text"), word: a.login, submit: t("admin.common.delete") });
    if (!ok) return undefined;
    try {
      await api(`/sip/accounts/${a.id}`, { method: "DELETE" });
      toast(t("admin.common.deleted_named", { name: a.login }), "success");
      await show("sip");
    } catch (err) { toast(err.message, "error"); }
  }
  return undefined;
}

// ------------------------------------------------------------------ copy-cataloguing targets

function targetForm(x) {
  const v = (k, d) => (x ? x[k] ?? d : d);
  return html`<div class="stack"><div class="form-grid">
    ${field({ name: "name", label: t("admin.interop.targets.f.name"), value: v("name", ""), required: true, attrs: 'maxlength="120" autocomplete="off"' })}
    ${field({ name: "url", label: t("admin.interop.targets.f.url"), type: "url", value: v("url", ""), required: true, placeholder: "https://lx2.loc.gov/LCDB",
      help: t("admin.interop.targets.f.url_help"), attrs: 'maxlength="500" spellcheck="false"' })}
    ${field({ name: "sru_version", label: t("admin.interop.targets.f.version"), as: "select", value: v("sru_version", "1.1"), options: [["1.1", "SRU 1.1"], ["1.2", "SRU 1.2"], ["2.0", "SRU 2.0"]] })}
    ${field({ name: "record_schema", label: t("admin.interop.targets.f.schema"), value: v("record_schema", "marcxml"), required: true, attrs: 'class="mono" maxlength="64"', help: t("admin.interop.targets.f.schema_help") })}
    ${numField({ name: "timeout_seconds", label: t("admin.interop.targets.f.timeout"), unit: t("admin.common.unit_word.seconds"), min: 1, max: 60, value: v("timeout_seconds", 10) })}
    ${numField({ name: "position", label: t("admin.interop.targets.f.position"), min: 0, max: 1000, value: v("position", 0), help: t("admin.interop.targets.f.position_help") })}</div>
    <fieldset class="as-fieldset"><legend>${t("admin.interop.targets.g_indexes")}</legend><p class="small muted">${t("admin.interop.targets.indexes_help")}</p><div class="form-grid">
      ${["title_index", "author_index", "isbn_index"].map((k) => field({ name: k, label: t(`admin.interop.targets.f.${k}`), value: v(k, { title_index: "dc.title", author_index: "dc.creator", isbn_index: "bath.isbn" }[k]),
        required: true, attrs: 'class="mono" maxlength="40" pattern="[A-Za-z][\\w.\\-]{0,39}" spellcheck="false"' }))}</div></fieldset>
    ${switchField({ name: "enabled", label: t("admin.interop.targets.f.enabled"), checked: v("enabled", true), help: t("admin.interop.targets.f.enabled_help") })}</div>`;
}

const targetPayload = (d) => ({
  name: d.name.trim(), url: d.url.trim(), sru_version: d.sru_version, record_schema: d.record_schema.trim(), title_index: d.title_index.trim(),
  author_index: d.author_index.trim(), isbn_index: d.isbn_index.trim(), timeout_seconds: Number(d.timeout_seconds), position: Number(d.position), enabled: d.enabled === "on",
});

async function editTarget(x) {
  const saved = await editDialog({
    title: x ? t("admin.interop.targets.edit_title", { name: x.name }) : t("admin.interop.targets.add_title"), size: "lg",
    submit: x ? t("admin.common.save_changes") : t("admin.interop.targets.add"), body: targetForm(x),
    onSubmit: (d) => api(x ? `/copycat/targets/${x.id}` : "/copycat/targets", { method: x ? "PATCH" : "POST", body: targetPayload(d) }),
  });
  if (!saved) return;
  toast(x ? t("admin.common.saved_named", { name: saved.name }) : t("admin.common.added_named", { name: saved.name }), "success");
  await show("targets");
}

async function testTarget(x, btn) {
  try {
    const r = await withBusy(btn, () => api(`/copycat/targets/${x.id}/test`, { method: "POST" }));
    if (r.ok) toast(t("admin.interop.targets.test_ok", { name: x.name, ms: num(r.latency_ms), count: r.total ?? 0 }), "success", 6000);
    else toast(t("admin.interop.targets.test_failed", { name: x.name, message: r.message || "" }), "error", 8000);
  } catch { /* toasted */ }
}

async function renderTargets(panel) {
  let results;
  try { ({ results } = await api("/copycat/targets")); } catch (e) {
    panel.innerHTML = html`<div class="card">${e.status === 403 ? emptyState({ art: "error", title: t("admin.interop.targets.denied_title"), body: t("admin.interop.targets.denied_body") }) : errorState(e)}</div>`;
    return;
  }
  state.targets = results;
  const manage = canManage();
  const builtIn = results.length === 1 && results[0].id === 0;
  panel.innerHTML = html`<div class="as-tab-head"><p class="muted">${t("admin.interop.targets.intro")} <a href="/staff/copycat">${t("admin.interop.targets.open_copycat")}</a></p>
      ${manage ? html`<button type="button" class="btn primary" data-target-add>${icon("plus")}${t("admin.interop.targets.add")}</button>` : ""}</div>
    ${builtIn ? html`<div class="alert info io-alert">${icon("info")}<div>${t("admin.interop.targets.builtin_note")}</div></div>` : ""}
    <div id="io-target-table"></div>`;
  const table = dataTable($("#io-target-table", panel), {
    id: "interop-targets", caption: t("admin.interop.tab.targets"), rowKey: (x) => x.id, rowLabel: (x) => x.name,
    columns: [
      { key: "name", label: t("admin.interop.targets.f.name"), primary: true, hideable: false, csv: (x) => x.name,
        render: (x) => html`<div class="dt-cell-stack">${manage && x.id ? html`<button type="button" class="link-btn as-row-title" data-target-edit>${x.name}</button>` : html`<strong>${x.name}</strong>`}
          <span class="sub mono io-url">${x.url}</span></div>` },
      { key: "version", label: t("admin.interop.targets.col.protocol"), csv: (x) => `SRU ${x.sru_version}`, render: (x) => html`SRU ${x.sru_version} <span class="muted small">· ${x.record_schema}</span>` },
      { key: "indexes", label: t("admin.interop.targets.col.indexes"), hidden: true, csv: (x) => `${x.title_index} ${x.author_index} ${x.isbn_index}`,
        render: (x) => html`<span class="mono small">${x.title_index} · ${x.author_index} · ${x.isbn_index}</span>` },
      { key: "timeout", label: t("admin.interop.targets.f.timeout"), align: "num", csv: (x) => x.timeout_seconds, render: (x) => t("admin.common.unit.seconds", { count: x.timeout_seconds }) },
      { key: "status", label: t("admin.interop.col.status"), csv: (x) => (x.enabled ? "enabled" : "disabled"),
        render: (x) => html`${x.enabled ? pill("success", t("admin.interop.enabled")) : pill("neutral", t("admin.interop.disabled"))}${x.id ? "" : html` ${pill("info", t("admin.interop.targets.builtin"), { dot: false })}`}` },
      ...(manage ? [{ key: "actions", label: t("admin.common.actions"), labelHidden: true, hideable: false, csv: false, cellClass: "as-cell-actions io-target-actions", headClass: "as-cell-actions",
        render: (x) => html`<button type="button" class="btn sm" data-target-test>${icon("activity")}${t("admin.interop.targets.test")}</button>${x.id ? rowMenu({ label: x.name, items: [
          { id: "edit", label: t("admin.common.edit"), icon: "edit" }, { id: "delete", label: t("admin.common.delete"), icon: "trash", danger: true }] }) : ""}` }] : []),
    ],
    exportName: "librowise-copycat-targets",
    empty: { art: "inbox", title: t("admin.interop.targets.empty_title"), body: t("admin.interop.targets.empty_body") },
  });
  table.setRows(results);
}

// ------------------------------------------------------------------ protocol endpoints

function endpointCard({ id, icon: ic, title, badge, desc, base, examples = [], extra = "" }) {
  return html`<section class="card io-endpoint" aria-labelledby="ep-${id}">
    <header class="as-group-head"><h2 id="ep-${id}">${icon(ic)}${title} ${badge ? pill("info", badge, { dot: false }) : ""}</h2><p>${desc}</p></header>
    <div class="as-group-body stack">
      ${base ? html`<div><div class="io-label">${t("admin.interop.ep.base_url")}</div><div class="as-copyline"><code class="as-url">${base}</code>${copyButton(base, { label: t("admin.interop.copy_named", { name: title }) })}</div></div>` : ""}
      ${examples.length ? html`<div><div class="io-label">${t("admin.interop.ep.examples")}</div><ul class="io-examples">${examples.map(([label, url]) => html`<li>
        <span class="io-ex-label">${label}</span>
        <div class="io-ex-row"><code class="as-url">${url}</code>${copyButton(url, { label: t("admin.interop.copy_named", { name: label }) })}
          <a class="btn sm ghost icon-only" href="${url}" target="_blank" rel="noopener" aria-label="${t("admin.interop.ep.open_named", { name: label })}" data-tip="${t("admin.interop.ep.open")}">${icon("external")}</a></div></li>`)}</ul></div>` : ""}
      ${extra}</div></section>`;
}

function renderEndpoints(panel) {
  const o = location.origin;
  panel.innerHTML = html`<div class="as-tab-head"><p class="muted">${t("admin.interop.ep.intro")}</p></div><div class="io-endpoints">
    ${endpointCard({ id: "sru", icon: "search", title: "SRU", badge: "1.2 · 2.0", desc: t("admin.interop.ep.sru_desc"), base: `${o}/sru`,
      examples: [[t("admin.interop.ep.sru_explain"), `${o}/sru?operation=explain&version=1.2`],
        [t("admin.interop.ep.sru_title"), `${o}/sru?version=1.2&operation=searchRetrieve&query=dc.title%3Dhistory&maximumRecords=5`],
        [t("admin.interop.ep.sru_dc"), `${o}/sru?version=2.0&query=dc.creator%20all%20%22tolkien%22&recordSchema=dc`]],
      extra: html`<p class="small muted">${t("admin.interop.ep.sru_indexes")} <code class="as-wrap-code">dc.title, dc.creator, dc.subject, dc.publisher, dc.date, dc.identifier, bath.isbn, bath.issn, dc.language, dc.type, rec.id, cql.serverChoice</code></p>` })}
    ${endpointCard({ id: "oai", icon: "layers", title: "OAI-PMH", badge: "2.0", desc: t("admin.interop.ep.oai_desc"), base: `${o}/oai`,
      examples: [[t("admin.interop.ep.oai_identify"), `${o}/oai?verb=Identify`], [t("admin.interop.ep.oai_formats"), `${o}/oai?verb=ListMetadataFormats`],
        [t("admin.interop.ep.oai_sets"), `${o}/oai?verb=ListSets`], [t("admin.interop.ep.oai_records"), `${o}/oai?verb=ListRecords&metadataPrefix=oai_dc`]] })}
    ${endpointCard({ id: "ld", icon: "globe", title: t("admin.interop.ep.ld_title"), badge: "schema.org", desc: t("admin.interop.ep.ld_desc"),
      examples: [[t("admin.interop.ep.ld_sample"), `${o}/record/1`]] })}
    ${endpointCard({ id: "sip2", icon: "monitor", title: "SIP2", badge: "2.00", desc: t("admin.interop.ep.sip_desc"),
      extra: html`${codeBlock("python -m librowise sip2 --host 0.0.0.0 --port 6001", t("admin.interop.sip.command"))}
        <div><div class="io-label">${t("admin.interop.ep.sip_messages")}</div><ul class="io-msgs">${[["93/94", "login"], ["99/98", "status"], ["23/24", "patron_status"], ["63/64", "patron_info"],
          ["11/12", "checkout"], ["09/10", "checkin"], ["29/30", "renew"], ["65/66", "renew_all"], ["17/18", "item_info"], ["35/36", "end_session"],
          ["15/16", "hold"], ["37/38", "fee_paid"], ["01", "block"], ["25/26", "enable"], ["97", "resend"]].map(([c, k]) => html`<li><code>${c}</code><span>${t(`admin.interop.msg.${k}`)}</span></li>`)}</ul></div>` })}
  </div>`;
}

// ------------------------------------------------------------------ wiring

const RENDER = { sip: renderSip, targets: renderTargets, endpoints: async (p) => renderEndpoints(p) };

async function show(tab) {
  state.tab = tab;
  const panel = $("#io-panel");
  panel.setAttribute("aria-busy", "true");
  try { await RENDER[tab](panel); } catch (e) { panel.innerHTML = html`<div class="card">${errorState(e)}</div>`; } finally { panel.removeAttribute("aria-busy"); }
}

export default async function init() {
  const root = $("#io-tabs");
  if (!root) return;
  wireKit();
  const panel = $("#io-panel");
  const row = (el, list) => list.find((x) => String(x.id) === el.closest("tr[data-key]")?.dataset.key);
  panel.addEventListener("click", (e) => {
    if (e.target.closest("[data-retry]") && !e.target.closest(".dt")) { show(state.tab); return; }
    if (e.target.closest("[data-sip-add]")) { editSip(null); return; }
    if (e.target.closest("[data-sip-edit]")) { const a = row(e.target, state.sip); if (a) editSip(a); return; }
    if (e.target.closest("[data-target-add]")) { editTarget(null); return; }
    if (e.target.closest("[data-target-edit]")) { const x = row(e.target, state.targets); if (x) editTarget(x); return; }
    const test = e.target.closest("[data-target-test]");
    if (test) { const x = row(test, state.targets); if (x) testTarget(x, test); }
  });
  panel.addEventListener("rowmenu", async (e) => {
    if (state.tab === "sip") { const a = row(e.target, state.sip); if (a) sipAction(a, e.detail.action); return; }
    if (state.tab === "targets") {
      const x = row(e.target, state.targets);
      if (!x) return;
      if (e.detail.action === "edit") editTarget(x);
      else if (e.detail.action === "delete") {
        const ok = await confirmDestructive({ title: t("admin.interop.targets.delete_title", { name: x.name }), text: t("admin.interop.targets.delete_text"), word: x.name, submit: t("admin.common.delete") });
        if (!ok) return;
        try { await api(`/copycat/targets/${x.id}`, { method: "DELETE" }); toast(t("admin.common.deleted_named", { name: x.name }), "success"); show("targets"); } catch (err) { toast(err.message, "error"); }
      }
    }
  });
  wireTabsPanel(root, (tab) => show(tab), { hash: true });
}

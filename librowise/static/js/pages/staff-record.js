// Staff › Catalogue › Record — DETAIL PAGE (docs/DESIGN_SYSTEM.md §6).
// Header: cover, title, status pills, actions (primary last; destructive actions only in the "⋯" menu).
// Tabs (hash-linked): Overview · Items (inline editing + bulk actions) · Holds · MARC · History · Similar & duplicates.
import { $, BOOT, api, authors, confirmDialog, cover, date, datetime, html, icon, modal, money, num, qs, raw, relative, toast, withBusy } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";
import { combobox } from "/static/js/ui/combobox.js";
import { mountCoverEditor } from "/static/js/ui/cover-upload.js";
import { dataTable } from "/static/js/ui/data-table.js";
import { emptyState, errorState } from "/static/js/ui/empty.js";
import { setCrumb } from "/static/js/ui/page-header.js";
import { sidePanel } from "/static/js/ui/panel.js";
import { statusPill } from "/static/js/ui/status.js";
import { tabs, wireTabsPanel } from "/static/js/ui/tabs.js";
import {
  actionMenu, alertBox, audienceLabel, count, facts, fmtLabel, formModal, langName, recNo, wireMenus,
} from "/static/js/pages/lib/collection.js";

const S = { b: null, lk: null, holds: null, can: {}, itemsTable: null, editing: null, tab: "overview" };
const id = () => +BOOT.path_params.biblio_id;
const root = () => $("#record");
const EDITABLE_STATUS = ["available", "processing", "damaged", "lost", "withdrawn"];
const PROTECTED = new Set(["on_loan", "in_transit", "on_hold_shelf"]);

// ------------------------------------------------------------------ header

function availabilityPill(a) {
  if (!a || !a.total) return statusPill("item", "withdrawn", t("availability.none"));
  return a.available ? statusPill("item", "available", t("availability.some", { available: a.available, total: a.total, count: a.total }))
    : statusPill("item", "on_loan", t("availability.all_out"));
}

function header(b) {
  const meta = [b.publisher, b.edition, b.pub_year].filter(Boolean).join(" · ");
  const menu = actionMenu({
    label: t("coll.rec.more_actions"),
    items: [
      { href: `/record/${b.id}`, label: t("coll.rec.view_opac"), icon: "globe", newTab: true },
      { href: `/api/v1/cataloging/export?fmt=xml&ids=${b.id}`, label: t("coll.rec.export_marcxml"), icon: "download", download: true },
      { href: `/api/v1/cataloging/export?fmt=mrc&ids=${b.id}`, label: t("coll.rec.export_mrc"), icon: "download", download: true },
      { href: `/staff/labels?${qs({ kind: "spine", source: "biblio", biblio_id: b.id })}`, label: t("coll.rec.print_spine"), icon: "printer" },
      { href: `/staff/labels?${qs({ kind: "item", source: "biblio", biblio_id: b.id })}`, label: t("coll.rec.print_barcodes"), icon: "barcode" },
      S.can.holds ? { id: "place-hold", label: t("coll.rec.place_hold"), icon: "bookmark-plus" } : null,
      S.can.delete ? { separator: true } : null,
      S.can.delete ? { id: "delete", label: t("coll.rec.delete"), icon: "trash", danger: true } : null,
    ],
  });
  return html`<header class="detail-head">
    <div class="dh-cover">${cover(b)}</div>
    <div class="dh-main">
      <div class="dh-eyebrow"><span>${fmtLabel(b.material_type)}</span>${b.pub_year ? html`<span>${b.pub_year}</span>` : ""}<span class="mono">${recNo(b.id)}</span></div>
      <h1 id="page-title">${b.title}${b.subtitle ? html`<span class="dh-subtitle">${b.subtitle}</span>` : ""}</h1>
      <p class="dh-meta">${b.authors?.length ? html`<span class="dh-authors">${authors(b.authors)}</span>` : html`<span class="muted">${t("coll.rec.no_author")}</span>`}${meta ? html`<span class="muted">${meta}</span>` : ""}</p>
      <div class="dh-pills">${availabilityPill(b.availability)}
        ${b.holds_queued ? statusPill("hold", "queued", count("hold_waiting", b.holds_queued)) : ""}
        ${b.ai_enriched ? html`<span class="badge pill ai">${icon("sparkle")}${t("coll.rec.ai_enriched")}</span>` : ""}
        ${b.has_marc ? html`<span class="badge pill info">${icon("code")}${t("coll.rec.marc_stored")}</span>` : ""}
        <span class="dh-updated" title="${datetime(b.updated_at)}">${t("coll.rec.updated", { when: relative(b.updated_at) })}</span></div>
    </div>
    <div class="dh-actions">
      ${menu}
      <a class="btn" href="/staff/catalog/${b.id}/marc">${icon("code")}<span>${t("coll.rec.marc_editor")}</span></a>
      ${S.can.write ? html`<a class="btn primary" href="/staff/catalog/${b.id}/edit" aria-keyshortcuts="E">${icon("edit")}<span>${t("coll.rec.edit")}</span></a>` : ""}
    </div>
  </header>`;
}

// ------------------------------------------------------------------ overview

function overview(b) {
  const details = facts([
    [t("coll.field.isbn"), b.isbn ? html`<span class="mono">${b.isbn}</span>` : ""],
    [t("coll.field.issn"), b.issn ? html`<span class="mono">${b.issn}</span>` : ""],
    [t("coll.field.publisher"), b.publisher],
    [t("coll.field.edition"), b.edition],
    [t("coll.field.year"), b.pub_year],
    [t("coll.field.pages"), b.pages ? num(b.pages) : ""],
    [t("coll.field.language"), langName(b.language)],
    [t("coll.field.format"), fmtLabel(b.material_type)],
    [t("coll.field.audience"), b.audience ? audienceLabel(b.audience) : ""],
    [t("coll.field.classification"), b.classification ? html`<span class="mono">${b.classification}</span>` : ""],
    [t("coll.field.series"), b.series],
    [t("coll.field.added"), html`<time datetime="${b.created_at}">${date(b.created_at)}</time>`],
  ]);
  const byStatus = {};
  for (const i of b.items) byStatus[i.status] = (byStatus[i.status] || 0) + 1;
  const branches = {};
  for (const i of b.items) {
    const k = i.branch.name;
    branches[k] ||= { total: 0, available: 0 };
    branches[k].total++;
    if (i.status === "available") branches[k].available++;
  }
  return html`<div class="coll-split">
    <div class="stack">
      <section class="card" aria-labelledby="ov-about"><div class="card-head"><h2 id="ov-about">${t("coll.rec.about")}</h2></div>
        <div class="card-body stack">
          ${b.description ? html`<p class="rec-desc">${b.description}</p>` : html`<p class="muted">${t("coll.rec.no_description")}</p>`}
          <div><h3 class="coll-label">${t("coll.field.subjects")}</h3>
            ${b.subjects?.length ? html`<ul class="tag-list" role="list">${b.subjects.map((s) => html`<li><a class="tag" href="/staff/catalog?${qs({ q: s })}">${s}</a></li>`)}</ul>`
              : html`<p class="small muted">${t("coll.rec.no_subjects")}</p>`}</div>
          <div id="ov-headings"></div>
        </div></section>
      <section class="card" aria-labelledby="ov-copies"><div class="card-head"><h2 id="ov-copies">${t("coll.rec.copies")}</h2>
          <button type="button" class="btn sm" data-goto-tab="items">${t("coll.rec.manage_items")}</button></div>
        <div class="card-body">${b.items.length ? html`<div class="copy-summary">
            <ul class="status-counts" role="list">${Object.entries(byStatus).map(([s, n]) => html`<li>${statusPill("item", s)}<span class="num">${num(n)}</span></li>`)}</ul>
            <table class="table compact"><caption class="sr-only">${t("coll.rec.copies_by_branch")}</caption>
              <thead><tr><th scope="col">${t("common.branch")}</th><th scope="col" class="num">${t("coll.rec.available")}</th><th scope="col" class="num">${t("coll.rec.total")}</th></tr></thead>
              <tbody>${Object.entries(branches).map(([n, c]) => html`<tr><td>${n}</td><td class="num">${num(c.available)}</td><td class="num">${num(c.total)}</td></tr>`)}</tbody></table></div>`
          : emptyState({ art: "books", compact: true, title: t("coll.rec.no_items_title"), body: t("coll.rec.no_items_body"),
            actions: S.can.write ? html`<button type="button" class="btn primary" data-add-item>${icon("plus")}${t("coll.items.add")}</button>` : "" })}</div></section>
      <section class="card" aria-labelledby="ov-related"><div class="card-head"><h2 id="ov-related">${t("coll.rec.also_borrowed")}</h2>
          <button type="button" class="btn sm ghost" data-goto-tab="similar">${t("coll.rec.see_more")}</button></div>
        <div class="card-body" id="related"><div class="cover-strip">${raw(Array.from({ length: 6 }, () => '<div class="skeleton sk-cover"></div>').join(""))}</div></div></section>
    </div>
    <aside class="stack" aria-label="${t("coll.rec.side")}">
      <section class="card" aria-labelledby="ov-details"><div class="card-head"><h2 id="ov-details">${t("coll.rec.details")}</h2></div>
        <div class="card-body">${details}</div></section>
      <section class="card" aria-labelledby="ov-cover"><div class="card-head"><h2 id="ov-cover">${t("ui.cover.title")}</h2></div>
        <div class="card-body" id="cover-slot"></div></section>
      ${S.can.write ? html`<section class="card panel-ai" aria-labelledby="ov-ai"><div class="card-head"><h2 id="ov-ai">${icon("sparkle")} ${t("coll.ai.title")}</h2></div>
        <div class="card-body stack"><p class="small muted">${t("coll.ai.intro_record")}</p>
          <div><button type="button" class="btn ai" id="ai-suggest">${icon("sparkle")}${t("coll.ai.suggest")}</button></div>
          <div id="ai-out" aria-live="polite"></div></div></section>` : ""}
    </aside></div>`;
}

function wireOverview(panel) {
  mountCoverEditor($("#cover-slot", panel), S.b, { onChange: (nb) => { S.b = { ...S.b, cover: nb.cover }; $(".dh-cover").innerHTML = cover(S.b); } });
  api(`/biblios/${S.b.id}/related`).then((r) => {
    const list = r.results.slice(0, 6);
    $("#related", panel).innerHTML = list.length ? html`<ol class="cover-strip" role="list">${list.map((x) => html`<li><a class="cover-card" href="/staff/catalog/${x.id}">${cover(x)}
        <span class="t">${x.title}</span><span class="a">${authors(x.authors)}</span></a></li>`)}</ol>`
      : html`<p class="small muted">${t("coll.rec.related_empty")}</p>`;
  }).catch(() => { $("#related", panel).innerHTML = html`<p class="small muted">${t("coll.rec.related_empty")}</p>`; });
  api(`/biblios/${S.b.id}/authorities`).then((r) => {
    const links = r.results || [];
    if (!links.length) return;
    $("#ov-headings", panel).innerHTML = html`<h3 class="coll-label">${t("coll.rec.controlled_headings")}</h3>
      <ul class="heading-links" role="list">${links.map((l) => html`<li>${icon("check-circle")}<a href="/staff/authorities?${qs({ id: l.authority_id })}">${l.heading}</a>
        <span class="muted small">${t(`coll.role.${l.role}`, {}, l.role)}</span></li>`)}</ul>`;
  }).catch(() => {});
}

// --- AI suggestions with accept / dismiss per suggestion
async function aiSuggest(btn) {
  const b = S.b;
  const s = await withBusy(btn, () => api("/ai/catalog-assist", { method: "POST", body: {
    id: b.id, title: b.title, subtitle: b.subtitle, authors: b.authors, description: b.description, subjects: b.subjects,
    publisher: b.publisher, pub_year: b.pub_year, isbn: b.isbn } }));
  const have = (b.subjects || []).map((x) => x.toLowerCase());
  const rows = [
    ...(s.subjects || []).filter((x) => !have.includes(x.toLowerCase())).map((x) => ({ field: "subject", value: x, label: t("coll.field.subject"), shown: x })),
    s.classification && s.classification !== b.classification ? { field: "classification", value: s.classification, label: t("coll.field.classification"),
      shown: `${s.classification}${s.classification_label ? ` · ${s.classification_label}` : ""}`, current: b.classification } : null,
    s.audience && s.audience !== b.audience ? { field: "audience", value: s.audience, label: t("coll.field.audience"), shown: audienceLabel(s.audience), current: b.audience ? audienceLabel(b.audience) : "" } : null,
    s.summary && !b.description ? { field: "description", value: s.summary, label: t("coll.field.description"), shown: s.summary } : null,
  ].filter(Boolean);
  S.ai = rows;
  $("#ai-out").innerHTML = rows.length ? html`<ul class="suggest-list" role="list">${rows.map((r, i) => html`<li class="suggest" data-sug="${i}">
      <div class="sug-body"><span class="sug-label">${r.label}</span><span class="sug-value">${r.shown}</span>
        ${r.current ? html`<span class="sug-current">${t("coll.ai.replaces", { value: r.current })}</span>` : ""}</div>
      <div class="sug-actions"><button type="button" class="btn sm" data-sug-accept="${i}" aria-label="${t("coll.ai.accept_named", { value: r.shown })}">${icon("check")}<span>${t("coll.ai.accept")}</span></button>
        <button type="button" class="btn sm ghost icon-only" data-sug-reject="${i}" aria-label="${t("coll.ai.dismiss_named", { value: r.shown })}" data-tip="${t("coll.ai.dismiss")}">${icon("x")}</button></div></li>`)}</ul>
    <div class="row between"><span class="tiny muted">${t("coll.ai.engine", { engine: s.engine === "claude" ? "Claude" : t("coll.ai.local_engine") })}</span>
      <button type="button" class="btn sm" data-sug-all>${icon("check")}${t("coll.ai.accept_all")}</button></div>`
    : html`<p class="small muted">${t("coll.ai.nothing")}</p>`;
}

async function acceptSuggestions(indexes) {
  const rows = indexes.map((i) => S.ai[i]).filter((r) => r && !r.done);
  if (!rows.length) return;
  const b = S.b;
  const patch = { ai_enriched: true };
  const subjects = rows.filter((r) => r.field === "subject").map((r) => r.value);
  if (subjects.length) patch.subjects = [...(b.subjects || []), ...subjects];
  for (const r of rows) if (r.field !== "subject") patch[r.field] = r.value;
  const nb = await api(`/biblios/${b.id}`, { method: "PATCH", body: patch });
  S.b = { ...S.b, ...nb };
  rows.forEach((r) => { r.done = true; });
  for (const i of indexes) {
    const li = $(`[data-sug="${i}"]`);
    if (li) { li.classList.add("accepted"); $(".sug-actions", li).innerHTML = html`<span class="badge pill success">${icon("check")}${t("coll.ai.applied")}</span>`; }
  }
  toast(t("coll.ai.applied_n", { count: rows.length }), "success");
}

// ------------------------------------------------------------------ items (inline editing + bulk)

const opt = (list, sel) => list.map((x) => html`<option value="${x.id}" ${x.id === sel ? "selected" : ""}>${x.name}</option>`);

function itemColumns() {
  const editing = (r) => S.editing === r.id;
  return [
    { key: "barcode", label: t("coll.items.barcode"), primary: true, hideable: false, csv: (r) => r.barcode,
      render: (r) => html`<span class="mono item-barcode">${r.barcode}</span>` },
    { key: "location", label: t("coll.items.location"), csv: (r) => [r.branch.name, r.shelf_location].filter(Boolean).join(" · "),
      render: (r) => (editing(r) ? html`<div class="inline-edit">
          <label class="sr-only" for="ie-branch">${t("coll.items.branch")}</label><select id="ie-branch" name="branch_id">${opt(S.lk.branches, r.branch.id)}</select>
          <label class="sr-only" for="ie-loc">${t("coll.items.shelf_location")}</label><input id="ie-loc" name="shelf_location" value="${r.shelf_location || ""}" placeholder="${t("coll.items.shelf_location")}" maxlength="64"></div>`
        : html`<div class="dt-cell-stack"><span>${r.branch.name}</span>${r.shelf_location ? html`<span class="sub">${r.shelf_location}</span>` : ""}</div>`) },
    { key: "type", label: t("coll.items.type"), csv: (r) => r.item_type.name,
      render: (r) => (editing(r) ? html`<label class="sr-only" for="ie-type">${t("coll.items.type")}</label><select id="ie-type" name="item_type_id">${opt(S.lk.item_types, r.item_type.id)}</select>` : r.item_type.name) },
    { key: "call", label: t("coll.items.call_number"), csv: (r) => r.call_number || "",
      render: (r) => (editing(r) ? html`<label class="sr-only" for="ie-call">${t("coll.items.call_number")}</label><input id="ie-call" name="call_number" class="mono" value="${r.call_number || ""}" maxlength="64">`
        : html`<span class="mono small">${r.call_number || "—"}</span>`) },
    { key: "status", label: t("coll.items.status"), csv: (r) => r.status,
      render: (r) => (editing(r) && !PROTECTED.has(r.status) ? html`<label class="sr-only" for="ie-status">${t("coll.items.status")}</label><select id="ie-status" name="status">${EDITABLE_STATUS.map((s) => html`<option value="${s}" ${s === r.status ? "selected" : ""}>${t(`status.${s}`)}</option>`)}</select>`
        : html`<div class="dt-cell-stack">${statusPill("item", r.status)}${r.due_at ? html`<span class="sub">${t("coll.items.due", { date: date(r.due_at) })}</span>` : ""}</div>`) },
    { key: "loans", label: t("coll.items.loans"), align: "num", csv: (r) => r.times_borrowed, render: (r) => num(r.times_borrowed) },
    { key: "price", label: t("coll.items.price"), align: "num", hidden: true, csv: (r) => r.price ?? "",
      render: (r) => (editing(r) ? html`<label class="sr-only" for="ie-price">${t("coll.items.price")}</label><input id="ie-price" name="price" type="number" min="0" step="0.01" value="${r.price ?? ""}" class="num-input">`
        : (r.price ? money(r.price) : "—")) },
    { key: "acquired", label: t("coll.items.acquired"), hidden: true, csv: (r) => r.acquired_on || "", render: (r) => (r.acquired_on ? date(r.acquired_on) : "—") },
    { key: "notes", label: t("coll.items.notes"), hidden: true, csv: (r) => r.notes || "",
      render: (r) => (editing(r) ? html`<label class="sr-only" for="ie-notes">${t("coll.items.notes")}</label><input id="ie-notes" name="notes" value="${r.notes || ""}" maxlength="2000">` : html`<span class="small">${r.notes || "—"}</span>`) },
    { key: "actions", label: t("coll.common.actions"), labelHidden: true, hideable: false, csv: false, cellClass: "dt-actions",
      render: (r) => (editing(r) ? html`<div class="row-actions"><button type="button" class="btn sm primary" data-ie-save="${r.id}">${icon("check")}<span>${t("common.save")}</span></button>
          <button type="button" class="btn sm ghost" data-ie-cancel>${t("common.cancel")}</button></div>`
        : S.can.write ? html`<div class="row-actions"><button type="button" class="btn sm ghost" data-ie-edit="${r.id}" aria-label="${t("coll.items.edit_named", { barcode: r.barcode })}">${icon("edit")}<span>${t("coll.common.edit")}</span></button>
          ${actionMenu({ label: t("coll.items.more_named", { barcode: r.barcode }), size: "sm", data: String(r.id), items: [
            { href: `/staff/labels?${qs({ kind: "spine", source: "barcodes", barcodes: r.barcode })}`, label: t("coll.rec.print_spine"), icon: "printer" },
            { href: `/staff/labels?${qs({ kind: "item", source: "barcodes", barcodes: r.barcode })}`, label: t("coll.rec.print_barcodes"), icon: "barcode" },
            S.can.delete ? { separator: true } : null,
            S.can.delete ? { id: "delete-item", label: t("coll.items.delete"), icon: "trash", danger: true, disabled: r.status === "on_loan" } : null,
          ] })}</div>` : "") },
  ];
}

async function batchModify(rows, changes, { message } = {}) {
  const r = await api("/batch/items/modify", { method: "POST", body: { selection: { barcodes: rows.map((x) => x.barcode) }, changes, dry_run: false } });
  const changed = r.summary.changed || 0, skipped = (r.summary.skipped || 0);
  toast(message ? message(changed) : t("coll.items.bulk_done", { count: changed }) + (skipped ? ` · ${t("coll.items.bulk_skipped", { count: skipped })}` : ""), skipped && !changed ? "warn" : "success");
  return r;
}

function itemBulkActions() {
  if (!S.can.write) return [];
  const pick = (title, body, submit) => modal({ title, body, submit, size: "sm" });
  return [
    { id: "status", label: t("coll.items.bulk_status"), icon: "check-circle", run: async (rows, { clear }) => {
      const fd = await pick(t("coll.items.bulk_status_title", { count: rows.length }), html`<div class="field"><label for="bs">${t("coll.items.new_status")}</label>
        <select id="bs" name="status">${EDITABLE_STATUS.map((s) => html`<option value="${s}">${t(`status.${s}`)}</option>`)}</select>
        <p class="field-help">${t("coll.items.protected_hint")}</p></div>`, t("coll.items.apply"));
      if (!fd) return;
      await batchModify(rows, { status: fd.get("status") }).catch((e) => toast(e.message, "error"));
      clear(); await reload("items");
    } },
    { id: "branch", label: t("coll.items.bulk_branch"), icon: "map", run: async (rows, { clear }) => {
      const fd = await pick(t("coll.items.bulk_branch_title", { count: rows.length }), html`<div class="field"><label for="bb">${t("coll.items.branch")}</label>
        <select id="bb" name="branch_id">${opt(S.lk.branches, BOOT.user?.home_branch_id)}</select></div>`, t("coll.items.apply"));
      if (!fd) return;
      await batchModify(rows, { branch_id: +fd.get("branch_id") }).catch((e) => toast(e.message, "error"));
      clear(); await reload("items");
    } },
    { id: "type", label: t("coll.items.bulk_type"), icon: "layers", run: async (rows, { clear }) => {
      const fd = await pick(t("coll.items.bulk_type_title", { count: rows.length }), html`<div class="field"><label for="bt">${t("coll.items.type")}</label>
        <select id="bt" name="item_type_id">${opt(S.lk.item_types)}</select></div>`, t("coll.items.apply"));
      if (!fd) return;
      await batchModify(rows, { item_type_id: +fd.get("item_type_id") }).catch((e) => toast(e.message, "error"));
      clear(); await reload("items");
    } },
    { id: "location", label: t("coll.items.bulk_location"), icon: "shelf", run: async (rows, { clear }) => {
      const fd = await pick(t("coll.items.bulk_location_title", { count: rows.length }), html`<div class="field"><label for="bl">${t("coll.items.shelf_location")}</label>
        <input id="bl" name="shelf_location" maxlength="64"><p class="field-help">${t("coll.items.location_clear_hint")}</p></div>`, t("coll.items.apply"));
      if (!fd) return;
      await batchModify(rows, { shelf_location: String(fd.get("shelf_location") || "").trim() }).catch((e) => toast(e.message, "error"));
      clear(); await reload("items");
    } },
    { id: "labels", label: t("coll.items.bulk_labels"), icon: "printer", run: (rows) => {
      location.href = `/staff/labels?${qs({ kind: "spine", source: "barcodes", barcodes: rows.map((r) => r.barcode).join("\n") })}`;
    } },
    ...(S.can.delete ? [{ id: "delete", label: t("coll.items.bulk_delete"), icon: "trash", danger: true, run: async (rows, { clear }) => {
      const loaned = rows.filter((r) => PROTECTED.has(r.status));
      if (!(await confirmDialog(t("coll.items.bulk_delete_title", { count: rows.length }),
        `${t("coll.items.bulk_delete_text", { count: rows.length })}${loaned.length ? ` ${t("coll.items.bulk_delete_protected", { count: loaned.length })}` : ""}`,
        t("coll.items.delete_confirm")))) return;
      try {
        const r = await api("/batch/items/delete", { method: "POST", body: { selection: { barcodes: rows.map((x) => x.barcode) }, action: "delete", dry_run: false } });
        toast(t("coll.items.deleted_n", { count: r.summary.deleted || 0 }), "success");
      } catch (e) { toast(e.message, "error"); }
      clear(); await reload("items");
    } }] : []),
  ];
}

function itemsPanel(panel) {
  panel.innerHTML = html`<div class="tab-toolbar"><div><h2 class="tab-title">${t("coll.items.title")}</h2>
      <p class="small muted">${t("coll.items.subtitle")}</p></div>
    ${S.can.write ? html`<button type="button" class="btn primary" data-add-item>${icon("plus")}${t("coll.items.add")}</button>` : ""}</div>
    <div id="items-table"></div>`;
  S.editing = null;
  S.itemsTable = dataTable($("#items-table", panel), {
    id: "record-items", caption: t("coll.items.title"), columns: itemColumns(), selectable: S.can.write,
    rowLabel: (r) => r.barcode, exportName: `items-${S.b.id}`, bulkActions: itemBulkActions(),
    empty: { art: "books", title: t("coll.rec.no_items_title"), body: t("coll.rec.no_items_body"),
      actions: S.can.write ? html`<button type="button" class="btn primary" data-add-item>${icon("plus")}${t("coll.items.add")}</button>` : "" },
  });
  S.itemsTable.setRows(S.b.items);
  wireMenus(panel, onMenu);
}

function refreshItems(focusId) {
  S.itemsTable.setRows(S.b.items);
  wireMenus($("#items-table"), onMenu);
  if (S.editing) {
    const tr = $(`#items-table tr[data-key="${S.editing}"]`);
    $("select, input:not([type=checkbox])", tr)?.focus();
  } else if (focusId) {
    $(`#items-table [data-ie-edit="${focusId}"]`)?.focus();
  }
}

async function saveInline(itemId, btn) {
  const tr = $(`#items-table tr[data-key="${itemId}"]`);
  const item = S.b.items.find((i) => i.id === itemId);
  const v = (name) => $(`[name="${name}"]`, tr);
  const body = { branch_id: +v("branch_id").value, item_type_id: +v("item_type_id").value, call_number: v("call_number").value.trim() || null,
    shelf_location: v("shelf_location").value.trim() || null };
  if (v("status")) body.status = v("status").value;
  if (v("notes")) body.notes = v("notes").value.trim() || null;
  if (v("price")) body.price = v("price").value === "" ? null : Math.round(Number(v("price").value) * 100);
  try {
    const nu = await withBusy(btn, () => api(`/items/${itemId}`, { method: "PATCH", body }));
    Object.assign(item, nu);
    S.editing = null;
    refreshItems(itemId);
    toast(t("coll.items.saved", { barcode: item.barcode }), "success");
  } catch { /* toasted */ }
}

function itemForm(i = {}) {
  return html`<form id="item-form" class="stack" novalidate>
    <div class="form-grid">
      <div class="field span-2"><label for="nf-bc">${t("coll.items.barcode")}<span class="optional">${t("ui.form.optional")}</span></label>
        <input id="nf-bc" name="barcode" class="mono" pattern="[A-Za-z0-9._\\-]*" maxlength="32" autocomplete="off" aria-describedby="nf-bc-h" value="${i.barcode || ""}">
        <div class="field-help" id="nf-bc-h">${t("coll.items.barcode_hint")}</div></div>
      <div class="field"><label for="nf-br">${t("coll.items.branch")}</label><select id="nf-br" name="branch_id" required>${opt(S.lk.branches, i.branch_id ?? BOOT.user?.home_branch_id)}</select></div>
      <div class="field"><label for="nf-it">${t("coll.items.type")}</label><select id="nf-it" name="item_type_id" required>${opt(S.lk.item_types, i.item_type_id)}</select></div>
      <div class="field"><label for="nf-cn">${t("coll.items.call_number")}</label><input id="nf-cn" name="call_number" class="mono" maxlength="64" value="${i.call_number ?? S.b.classification ?? ""}"></div>
      <div class="field"><label for="nf-sl">${t("coll.items.shelf_location")}</label><input id="nf-sl" name="shelf_location" maxlength="64" value="${i.shelf_location || ""}"></div>
      <div class="field"><label for="nf-pr">${t("coll.items.price")}<span class="optional">${t("ui.form.optional")}</span></label><input id="nf-pr" name="price" type="number" min="0" step="0.01" inputmode="decimal" value="${i.price ?? ""}"></div>
      <div class="field"><label for="nf-st">${t("coll.items.status")}</label><select id="nf-st" name="status">${["available", "processing"].map((s) => html`<option value="${s}" ${s === (i.status || "available") ? "selected" : ""}>${t(`status.${s}`)}</option>`)}</select></div>
      <div class="field span-2"><label for="nf-no">${t("coll.items.notes")}<span class="optional">${t("ui.form.optional")}</span></label><input id="nf-no" name="notes" maxlength="2000" value="${i.notes || ""}"></div>
    </div>
    <div id="item-added" aria-live="polite" class="stack tight"></div>
  </form>`;
}

function addItem() {
  const p = sidePanel({ title: t("coll.items.add_title"), subtitle: S.b.title, body: itemForm(),
    footer: html`<button type="button" class="btn" data-close>${t("common.close")}</button>
      <button type="button" class="btn" data-save-another>${icon("plus")}${t("coll.items.save_another")}</button>
      <button type="button" class="btn primary" data-save>${icon("check")}${t("coll.items.save")}</button>` });
  const form = $("#item-form", p.el);
  let added = 0;
  const save = async (btn, again) => {
    if (!form.checkValidity()) { form.reportValidity(); return; }
    const fd = new FormData(form);
    const body = { branch_id: +fd.get("branch_id"), item_type_id: +fd.get("item_type_id"), call_number: fd.get("call_number").trim() || null,
      shelf_location: fd.get("shelf_location").trim() || null, notes: fd.get("notes").trim() || null, status: fd.get("status"),
      price: fd.get("price") ? Math.round(Number(fd.get("price")) * 100) : null };
    if (fd.get("barcode").trim()) body.barcode = fd.get("barcode").trim();
    try {
      const item = await withBusy(btn, () => api(`/biblios/${S.b.id}/items`, { method: "POST", body }));
      added++;
      S.b.items.push(item);
      toast(t("coll.items.added", { barcode: item.barcode }), "success");
      if (again) {
        form.elements.barcode.value = "";
        $("#item-added", form).insertAdjacentHTML("afterbegin", html`<div class="alert ok small">${icon("check")}<div>${t("coll.items.added", { barcode: item.barcode })}</div></div>`);
        form.elements.barcode.focus();
      } else p.close();
    } catch { /* toasted */ }
  };
  p.el.addEventListener("click", (e) => {
    if (e.target.closest("[data-save]")) save(e.target.closest("[data-save]"), false);
    if (e.target.closest("[data-save-another]")) save(e.target.closest("[data-save-another]"), true);
  });
  form.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.tagName === "INPUT") { e.preventDefault(); save($("[data-save-another]", p.el), true); } });
  form.elements.barcode.focus();
  p.closed.then(() => { if (added) reload(S.tab); });
}

// ------------------------------------------------------------------ holds

function holdsPanel(panel) {
  panel.innerHTML = html`<div class="tab-toolbar"><div><h2 class="tab-title">${t("coll.holds.title")}</h2>
      <p class="small muted">${t("coll.holds.subtitle")}</p></div>
    ${S.can.holds ? html`<button type="button" class="btn primary" data-place-hold>${icon("bookmark-plus")}${t("coll.rec.place_hold")}</button>` : ""}</div>
    <div id="holds-table"></div>`;
  if (!S.can.holds) { $("#holds-table", panel).innerHTML = alertBox(t("coll.holds.no_permission"), "info"); return; }
  const table = dataTable($("#holds-table", panel), {
    id: "record-holds", caption: t("coll.holds.title"), exportName: `holds-${S.b.id}`,
    columns: [
      { key: "pos", label: t("coll.holds.position"), align: "num", width: "4rem", csv: (h) => h.queue_position ?? "", render: (h) => (h.queue_position ? num(h.queue_position) : "—") },
      { key: "patron", label: t("coll.holds.patron"), primary: true, hideable: false, csv: (h) => h.patron.full_name,
        render: (h) => html`<div class="dt-cell-stack"><a href="/staff/patrons/${h.patron.id}">${h.patron.full_name}</a><span class="sub mono">${h.patron.card_number}</span></div>` },
      { key: "pickup", label: t("coll.holds.pickup"), csv: (h) => h.pickup_branch.name, render: (h) => h.pickup_branch.name },
      { key: "status", label: t("coll.items.status"), csv: (h) => (h.suspended ? "suspended" : h.status),
        render: (h) => html`<div class="dt-cell-stack">${h.suspended ? statusPill("hold", "suspended") : statusPill("hold", h.status)}
          ${h.item_level && h.requested_item ? html`<span class="sub">${t("coll.holds.item_level", { barcode: h.requested_item.barcode })}</span>` : ""}</div>` },
      { key: "placed", label: t("coll.holds.placed"), csv: (h) => h.created_at, render: (h) => html`<span title="${datetime(h.created_at)}">${relative(h.created_at)}</span>` },
      { key: "nna", label: t("coll.holds.not_needed_after"), hidden: true, csv: (h) => h.not_needed_after || "", render: (h) => (h.not_needed_after ? date(h.not_needed_after) : "—") },
      { key: "actions", label: t("coll.common.actions"), labelHidden: true, hideable: false, csv: false, cellClass: "dt-actions",
        render: (h) => actionMenu({ label: t("coll.holds.actions_named", { name: h.patron.full_name }), size: "sm", data: `hold:${h.id}`, items: [
          h.suspended ? { id: "resume", label: t("coll.holds.resume"), icon: "refresh" } : { id: "suspend", label: t("coll.holds.suspend"), icon: "clock" },
          { separator: true }, { id: "cancel-hold", label: t("coll.holds.cancel"), icon: "x", danger: true }] }) },
    ],
    empty: { art: "inbox", title: t("coll.holds.empty_title"), body: t("coll.holds.empty_body") },
  });
  S.holdsTable = table;
  table.setLoading();
  api(`/holds?${qs({ biblio_id: S.b.id })}`).then((r) => {
    S.holds = r.results;
    table.setRows(r.results);
    wireMenus(panel, onMenu);
  }).catch((e) => table.setError(e, () => holdsPanel(panel)));
}

async function placeHold() {
  let card = "";
  const fd = await formModal({ title: t("coll.rec.place_hold"), submit: t("coll.holds.place"), body: html`<div class="stack">
    <p class="small muted">${S.b.title}</p>
    <div class="field"><label for="h-patron">${t("coll.holds.patron")}</label><input id="h-patron" name="patron" required autocomplete="off" placeholder="${t("coll.holds.patron_placeholder")}" aria-describedby="h-patron-h">
      <div class="field-help" id="h-patron-h">${t("coll.holds.patron_hint")}</div></div>
    <div class="field"><label for="h-br">${t("coll.holds.pickup")}</label><select id="h-br" name="branch">${opt(S.lk.branches, BOOT.user?.home_branch_id)}</select></div>
    <div class="field"><label for="h-item">${t("coll.holds.copy")}</label><select id="h-item" name="item_id"><option value="">${t("coll.holds.any_copy")}</option>
      ${S.b.items.filter((i) => !["withdrawn", "lost"].includes(i.status)).map((i) => html`<option value="${i.id}">${i.barcode} · ${i.branch.name} · ${t(`status.${i.status}`)}</option>`)}</select></div>
    <div class="field"><label for="h-nna">${t("coll.holds.not_needed_after")}<span class="optional">${t("ui.form.optional")}</span></label><input id="h-nna" name="not_needed_after" type="date"></div></div>` },
  (data) => api("/holds", { method: "POST", body: { biblio_id: S.b.id, patron_card: card || String(data.get("patron")).trim(), pickup_branch_id: +data.get("branch"),
    item_id: data.get("item_id") ? Number(data.get("item_id")) : null, not_needed_after: data.get("not_needed_after") || null } }),
  (dlg) => {
    combobox($("#h-patron", dlg), {
      minChars: 2,
      source: async (q, signal) => (await api(`/patrons?${qs({ q, per_page: 8 })}`, { signal })).results,
      render: (p) => html`<span>${p.full_name}</span> <span class="sub mono">${p.card_number}</span>`,
      value: (p) => `${p.full_name} (${p.card_number})`,
      onSelect: (p) => { card = p.card_number; },
    });
    $("#h-patron", dlg).addEventListener("input", () => { card = ""; });
  });
  if (!fd) return;
  toast(t("coll.holds.placed_toast", { position: fd.queue_position ?? "—" }), "success");
  await reload("holds");
}

// ------------------------------------------------------------------ MARC (read-only)

async function marcPanel(panel) {
  panel.innerHTML = html`<div class="tab-toolbar"><div><h2 class="tab-title">${t("coll.marc.view_title")}</h2><p class="small muted" id="marc-origin">&nbsp;</p></div>
    <div class="row tight"><a class="btn" href="/api/v1/cataloging/export?fmt=xml&ids=${S.b.id}" download>${icon("download")}${t("coll.rec.export_marcxml")}</a>
    <a class="btn primary" href="/staff/catalog/${S.b.id}/marc">${icon("code")}${t("coll.rec.marc_editor")}</a></div></div>
    <div class="card flush"><div id="marc-view">${raw(Array.from({ length: 8 }, () => '<div class="skeleton sk-line" style="margin:.75rem 1rem"></div>').join(""))}</div></div>`;
  try {
    const m = await api(`/biblios/${S.b.id}/marc`);
    $("#marc-origin", panel).textContent = m.origin === "stored" ? t("coll.marc.origin_stored") : t("coll.marc.origin_generated");
    const sub = (f) => (f.subfields || []).map((s) => html`<span class="sf"><b>$${s.code}</b>${s.value}</span>`);
    $("#marc-view", panel).innerHTML = html`<div class="table-wrap" tabindex="0" role="region" aria-label="${t("coll.marc.view_title")}"><table class="table marc-ro">
      <caption class="sr-only">${t("coll.marc.view_title")}</caption>
      <thead><tr><th scope="col">${t("coll.marc.tag")}</th><th scope="col">${t("coll.marc.ind")}</th><th scope="col">${t("coll.marc.content")}</th></tr></thead>
      <tbody><tr><td class="mono"><strong>LDR</strong></td><td></td><td class="mono">${m.grid.leader}</td></tr>
      ${m.grid.fields.map((f) => html`<tr><td class="mono"><strong>${f.tag}</strong></td><td class="mono">${f.subfields ? `${(f.ind1 || " ").replace(" ", "_")}${(f.ind2 || " ").replace(" ", "_")}` : ""}</td>
        <td class="mono marc-content">${f.subfields ? sub(f) : f.value}</td></tr>`)}</tbody></table></div>`;
  } catch (e) { $("#marc-view", panel).innerHTML = errorState(e, { retry: false }); }
}

// ------------------------------------------------------------------ history

const HIST_ICON = { create: "plus", update: "edit", delete: "trash", marc_edit: "code", cover_upload: "image", cover_delete: "image",
  copycat_import: "download", checkin: "arrow-down", mark_lost: "alert", transfer_received: "truck", batch_modify: "layers", batch_withdraw: "layers", batch_delete: "trash" };

function historyText(h) {
  const who = h.actor || t("coll.history.system");
  const fields = (h.details?.fields || h.details?.changes || []).map((f) => t(`coll.field.${f}`, {}, f.replace(/_/g, " "))).join(", ");
  const key = `coll.history.${h.entity}_${h.action}`;
  return t(key, { who, fields, barcode: h.barcode || "", count: h.count || 0, n: num(h.count || 0) }, t("coll.history.generic", { who, action: h.action.replace(/_/g, " ") }));
}

async function historyPanel(panel) {
  panel.innerHTML = html`<div class="tab-toolbar"><div><h2 class="tab-title">${t("coll.history.title")}</h2><p class="small muted">${t("coll.history.subtitle")}</p></div></div>
    <div class="card"><div class="card-body" id="hist">${raw(Array.from({ length: 5 }, () => '<div class="skeleton sk-line" style="margin:.9rem 0"></div>').join(""))}</div></div>`;
  try {
    const r = await api(`/biblios/${S.b.id}/history`);
    $("#hist", panel).innerHTML = r.results.length ? html`<ol class="timeline" role="list">${r.results.map((h) => html`<li class="tl-item tl-${h.action}">
        <span class="tl-icon" aria-hidden="true">${icon(HIST_ICON[h.action] || "clock")}</span>
        <div class="tl-body"><p>${historyText(h)}</p>
          ${h.barcodes?.length ? html`<p class="small muted mono">${h.barcodes.join(", ")}</p>` : ""}
          <time class="small muted" datetime="${h.at}" title="${datetime(h.at)}">${relative(h.at)}</time></div></li>`)}</ol>`
      : emptyState({ art: "inbox", compact: true, title: t("coll.history.empty_title"), body: t("coll.history.empty_body") });
  } catch (e) { $("#hist", panel).innerHTML = errorState(e, { retry: false }); }
}

// ------------------------------------------------------------------ similar & duplicates

const REASON = (r) => t(`coll.dupes.reason_${r}`, {}, r);

async function similarPanel(panel) {
  panel.innerHTML = html`<section aria-labelledby="dup-h" class="stack">
      <div class="tab-toolbar"><div><h2 class="tab-title" id="dup-h">${t("coll.dupes.title")}</h2><p class="small muted">${t("coll.dupes.subtitle")}</p></div></div>
      <div id="dupes" class="stack">${raw('<div class="skeleton" style="height:5.5rem;border-radius:10px"></div>')}</div></section>
    <section aria-labelledby="sim-h" class="stack" style="margin-top:2rem">
      <h2 class="tab-title" id="sim-h">${t("coll.dupes.similar_title")}</h2>
      <div id="similar" class="cover-grid">${raw(Array.from({ length: 6 }, () => '<div class="skeleton sk-cover"></div>').join(""))}</div></section>`;
  api(`/biblios/${S.b.id}/duplicates`).then((r) => {
    S.dupes = r.results;
    $("#dupes", panel).innerHTML = r.results.length ? html`<ul class="dupe-list" role="list">${r.results.map((d, i) => html`<li class="card dupe">
        <div class="dupe-main"><a class="dupe-title" href="/staff/catalog/${d.id}">${d.title}${d.subtitle ? `: ${d.subtitle}` : ""}</a>
          <span class="small muted">${[authors(d.authors), d.publisher, d.edition, d.pub_year].filter(Boolean).join(" · ")} · <span class="mono">${recNo(d.id)}</span></span>
          <span class="dupe-reasons">${d.reasons.map((r) => html`<span class="badge pill ${r === "isbn" ? "warning" : "info"}">${REASON(r)}</span>`)}
            ${d.availability ? html`<span class="small muted">${count("copy", d.availability.total)}</span>` : ""}</span></div>
        <div class="row tight"><button type="button" class="btn sm" data-compare="${i}">${icon("columns")}${t("coll.dupes.compare")}</button>
          <a class="btn sm ghost" href="/staff/catalog/${d.id}">${t("coll.dupes.open")}</a></div></li>`)}</ul>`
      : emptyState({ art: "done", compact: true, title: t("coll.dupes.none_title"), body: t("coll.dupes.none_body") });
  }).catch((e) => { $("#dupes", panel).innerHTML = errorState(e, { retry: false }); });
  api(`/biblios/${S.b.id}/related`).then((r) => {
    $("#similar", panel).innerHTML = r.results.length ? html`${r.results.map((x) => html`<a class="cover-card" href="/staff/catalog/${x.id}">${cover(x)}
        <span class="t">${x.title}</span><span class="a">${authors(x.authors)}</span></a>`)}`
      : html`<p class="small muted">${t("coll.rec.related_empty")}</p>`;
    $("#similar", panel).classList.toggle("cover-grid", !!r.results.length);
  }).catch(() => { $("#similar", panel).innerHTML = html`<p class="small muted">${t("coll.rec.related_empty")}</p>`; });
}

async function compare(d) {
  const p = sidePanel({ title: t("coll.dupes.compare_title"), subtitle: d.title, wide: true, body: html`<div class="skeleton" style="height:16rem"></div>`,
    footer: html`<a class="btn" href="/staff/catalog/${d.id}">${t("coll.dupes.open_other")}</a>` });
  try {
    const o = await api(`/biblios/${d.id}`);
    const a = S.b;
    const rows = [["title", "title"], ["subtitle", "subtitle"], ["authors", "authors"], ["isbn", "isbn"], ["publisher", "publisher"], ["pub_year", "year"],
      ["edition", "edition"], ["pages", "pages"], ["language", "language"], ["material_type", "format"], ["classification", "classification"], ["series", "series"]];
    const show = (k, v) => (k === "authors" ? authors(v) : k === "language" ? langName(v) : k === "material_type" ? fmtLabel(v) : v ?? "");
    p.setBody(html`<div class="table-wrap" tabindex="0" role="region" aria-label="${t("coll.dupes.compare_title")}"><table class="table compare">
      <caption class="sr-only">${t("coll.dupes.compare_title")}</caption>
      <thead><tr><th scope="col">${t("coll.dupes.field")}</th><th scope="col">${t("coll.dupes.this_record")} <span class="mono">${recNo(a.id)}</span></th>
        <th scope="col">${t("coll.dupes.other_record")} <span class="mono">${recNo(o.id)}</span></th></tr></thead>
      <tbody>${rows.map(([k, l]) => {
        const x = String(show(k, a[k]) || ""), y = String(show(k, o[k]) || "");
        return html`<tr class="${x === y ? "same" : "diff"}"><th scope="row">${t(`coll.field.${l}`)}</th><td>${x || "—"}</td><td>${y || "—"}${x !== y ? html` <span class="sr-only">${t("coll.dupes.differs")}</span>` : ""}</td></tr>`;
      })}
      <tr><th scope="row">${t("coll.rec.copies")}</th><td>${count("copy", a.items.length)}</td><td>${count("copy", o.items.length)}</td></tr></tbody></table></div>
      <p class="small muted">${t("coll.dupes.merge_hint")}</p>`);
  } catch (e) { p.setBody(errorState(e, { retry: false })); }
}

// ------------------------------------------------------------------ menus & actions

async function onMenu(action, btn, forKey) {
  try {
    if (action === "place-hold") await placeHold();
    else if (action === "delete") await deleteRecord();
    else if (action === "delete-item") {
      const item = S.b.items.find((i) => String(i.id) === forKey);
      if (!item || !(await confirmDialog(t("coll.items.delete_title", { barcode: item.barcode }), t("coll.items.delete_text"), t("coll.items.delete_confirm")))) return;
      await api(`/items/${item.id}`, { method: "DELETE" });
      S.b.items = S.b.items.filter((i) => i.id !== item.id);
      toast(t("coll.items.deleted", { barcode: item.barcode }), "success");
      refreshItems();
      updateTabCounts();
    } else if (["suspend", "resume", "cancel-hold"].includes(action)) {
      const hid = forKey.split(":")[1];
      if (action === "cancel-hold") {
        const h = S.holds.find((x) => String(x.id) === hid);
        if (!(await confirmDialog(t("coll.holds.cancel_title"), t("coll.holds.cancel_text", { name: h?.patron.full_name || "" }), t("coll.holds.cancel")))) return;
        await api(`/holds/${hid}`, { method: "DELETE" });
        toast(t("coll.holds.cancelled"), "success");
      } else {
        await api(`/holds/${hid}/${action}`, { method: "POST", body: action === "suspend" ? {} : undefined });
        toast(t(action === "suspend" ? "coll.holds.suspended" : "coll.holds.resumed"), "success");
      }
      await reload("holds");
    }
  } catch (e) { if (!e.toasted) toast(e.message, "error"); }
}

async function deleteRecord() {
  const b = S.b;
  const onLoan = b.items.filter((i) => i.status === "on_loan").length;
  if (onLoan) { toast(t("coll.rec.delete_blocked", { count: onLoan }), "error"); return; }
  if (!(await confirmDialog(t("coll.rec.delete_title"), t("coll.rec.delete_text", { title: b.title, count: b.items.length }), t("coll.rec.delete_confirm")))) return;
  await api(`/biblios/${b.id}`, { method: "DELETE" });
  toast(t("coll.rec.deleted"), "success");
  location.href = "/staff/catalog";
}

// ------------------------------------------------------------------ page

const PANELS = { overview: (p) => { p.innerHTML = overview(S.b); wireOverview(p); }, items: itemsPanel, holds: holdsPanel, marc: marcPanel, history: historyPanel, similar: similarPanel };

function tabItems() {
  return [
    { id: "overview", label: t("coll.rec.tab_overview") },
    { id: "items", label: t("coll.rec.tab_items"), count: num(S.b.items.length) },
    { id: "holds", label: t("coll.rec.tab_holds"), count: num(S.b.holds_queued || 0) },
    { id: "marc", label: t("coll.rec.tab_marc") },
    { id: "history", label: t("coll.rec.tab_history") },
    { id: "similar", label: t("coll.rec.tab_similar") },
  ];
}

function updateTabCounts() {
  const c = $("#rec-tab-items .count");
  if (c) c.textContent = num(S.b.items.length);
}

function render() {
  const b = S.b;
  document.title = `${b.title} · ${t("nav.detail.record")}`;
  setCrumb(b.title);
  const el = root();
  el.removeAttribute("aria-busy");
  const initial = ["overview", "items", "holds", "marc", "history", "similar"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "overview";
  el.innerHTML = html`${header(b)}<div class="rec-tabs">${tabs({ id: "rec", label: t("coll.rec.sections"), items: tabItems(), selected: initial })}</div>`;
  wireMenus($(".detail-head", el), onMenu);
  wireTabsPanel($(".rec-tabs", el), (tab, panel) => { S.tab = tab; PANELS[tab](panel); }, { hash: true });
}

async function reload(tab = S.tab) {
  const nb = await api(`/biblios/${id()}`);
  S.b = nb;
  if (location.hash.slice(1) !== tab) history.replaceState(null, "", `#${tab}`);
  render();
}

export default async function init() {
  const el = root();
  S.can = { write: el.dataset.canWrite === "1", delete: el.dataset.canDelete === "1", holds: el.dataset.canHolds === "1" };
  try {
    [S.lk, S.b] = await Promise.all([api("/lookups"), api(`/biblios/${id()}`)]);
  } catch (e) {
    el.removeAttribute("aria-busy");
    el.innerHTML = e.status === 404 ? emptyState({ art: "search", title: t("coll.rec.not_found_title"), body: t("coll.rec.not_found_body"),
      actions: html`<a class="btn primary" href="/staff/catalog">${t("coll.rec.back_to_catalogue")}</a>` }) : errorState(e, { retry: true });
    $("[data-retry]", el)?.addEventListener("click", () => location.reload());
    return;
  }
  render();
  if (new URLSearchParams(location.search).get("add") && S.can.write) {
    history.replaceState(null, "", `${location.pathname}#items`);
    $("#rec-tab-items")?.click();
    addItem();
  }
  el.addEventListener("click", async (e) => {
    const go = e.target.closest("[data-goto-tab]");
    if (go) { $(`#rec-tab-${go.dataset.gotoTab}`)?.click(); $(`#rec-tab-${go.dataset.gotoTab}`)?.focus(); return; }
    if (e.target.closest("[data-add-item]")) { addItem(); return; }
    if (e.target.closest("[data-place-hold]")) { placeHold().catch((err) => toast(err.message, "error")); return; }
    const ai = e.target.closest("#ai-suggest");
    if (ai) { aiSuggest(ai).catch(() => {}); return; }
    const acc = e.target.closest("[data-sug-accept]");
    if (acc) { withBusy(acc, () => acceptSuggestions([+acc.dataset.sugAccept])).catch(() => {}); return; }
    if (e.target.closest("[data-sug-all]")) { withBusy(e.target.closest("[data-sug-all]"), () => acceptSuggestions(S.ai.map((_, i) => i))).catch(() => {}); return; }
    const rej = e.target.closest("[data-sug-reject]");
    if (rej) { const li = rej.closest("[data-sug]"); const next = li.nextElementSibling || li.previousElementSibling; li.remove(); $("button", next)?.focus(); return; }
    const cmp = e.target.closest("[data-compare]");
    if (cmp) { compare(S.dupes[+cmp.dataset.compare]); return; }
    const ed = e.target.closest("[data-ie-edit]");
    if (ed) { S.editing = +ed.dataset.ieEdit; refreshItems(); return; }
    if (e.target.closest("[data-ie-cancel]")) { const was = S.editing; S.editing = null; refreshItems(was); return; }
    const sv = e.target.closest("[data-ie-save]");
    if (sv) saveInline(+sv.dataset.ieSave, sv);
  });
  el.addEventListener("keydown", (e) => {
    const tr = e.target.closest?.("#items-table tr[data-key]");
    if (tr && S.editing && e.target !== tr) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); const was = S.editing; S.editing = null; refreshItems(was); }
      else if (e.key === "Enter" && e.target.tagName !== "BUTTON") { e.preventDefault(); saveInline(S.editing, $("[data-ie-save]", tr)); }
    } else if (tr && e.target === tr && !S.editing && (e.key === "e" || e.key === "F2") && S.can.write) {
      e.preventDefault(); S.editing = +tr.dataset.key; refreshItems();
    }
  });
  // "E" anywhere (outside fields) opens the editor; "N" adds an item.
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.querySelector("dialog[open]")) return;
    if (document.activeElement?.closest?.("#items-table tbody")) return;
    if (e.key === "e" && S.can.write) { location.href = `/staff/catalog/${S.b.id}/edit`; }
  });
}

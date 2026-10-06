import { $, BOOT, api, authors, availabilityBadge, badge, confirmDialog, cover, date, empty, html, icon, modal, relative, toast, withBusy } from "/static/js/core.js";

let lk, b;
const id = () => +BOOT.path_params.biblio_id;

function itemForm(i = {}) {
  const opt = (list, sel) => list.map((x) => html`<option value="${x.id}" ${x.id === sel ? "selected" : ""}>${x.name}</option>`);
  const statuses = ["available", "processing", "damaged", "lost", "withdrawn"];
  return html`<div class="grid cols-2">
    <div class="field"><label for="f-bc">Barcode</label><input id="f-bc" name="barcode" value="${i.barcode || ""}" ${i.id ? "disabled" : ""} placeholder="Leave blank to auto-generate" pattern="[A-Za-z0-9._-]*"></div>
    <div class="field"><label for="f-br">Home branch</label><select id="f-br" name="branch_id" required>${opt(lk.branches, i.branch?.id ?? BOOT.user.home_branch_id)}</select></div>
    <div class="field"><label for="f-it">Item type</label><select id="f-it" name="item_type_id" required>${opt(lk.item_types, i.item_type?.id)}</select></div>
    <div class="field"><label for="f-cn">Call number</label><input id="f-cn" name="call_number" value="${i.call_number || b.classification || ""}"></div>
    <div class="field"><label for="f-sl">Shelf location</label><input id="f-sl" name="shelf_location" value="${i.shelf_location || ""}"></div>
    <div class="field"><label for="f-pr">Price (₹)</label><input id="f-pr" name="price" type="number" min="0" step="0.01" value="${i.price ?? ""}"></div>
    ${i.id && i.status !== "on_loan" ? html`<div class="field"><label for="f-st">Status</label><select id="f-st" name="status">${statuses.map((s) => html`<option value="${s}" ${s === i.status ? "selected" : ""}>${s}</option>`)}</select></div>` : ""}
    <div class="field" style="grid-column:1/-1"><label for="f-no">Notes</label><input id="f-no" name="notes" value="${i.notes || ""}"></div></div>`;
}

function itemPayload(fd, isNew) {
  const out = {
    branch_id: +fd.get("branch_id"), item_type_id: +fd.get("item_type_id"),
    call_number: fd.get("call_number") || null, shelf_location: fd.get("shelf_location") || null,
    price: fd.get("price") ? Math.round(+fd.get("price") * 100) : null, notes: fd.get("notes") || null,
  };
  if (isNew && fd.get("barcode")) out.barcode = fd.get("barcode");
  if (!isNew && fd.get("status")) out.status = fd.get("status");
  return out;
}

async function render() {
  b = await api(`/biblios/${id()}`);
  const { results: holds } = await api("/holds");
  const mine = holds.filter((h) => h.biblio.id === b.id);
  document.title = `${b.title} · Staff`;
  $("#crumb").textContent = b.title;
  $("#record").innerHTML = html`<div class="page-head">
      <div class="row" style="align-items:flex-start">${cover(b, "sm")}
        <div><h1>${b.title}</h1><div class="sub">${authors(b.authors)}${b.pub_year ? ` · ${b.pub_year}` : ""} · #${b.id}</div>
        <div class="row tight" style="margin-top:.4rem">${availabilityBadge(b.availability)}${b.ai_enriched ? html`<span class="badge ai">${icon("sparkle")}AI-enriched</span>` : ""}
          ${b.has_marc ? badge("info", "MARC preserved") : ""}<span class="tiny muted">updated ${relative(b.updated_at)}</span></div></div></div>
      <div class="row tight">
        <a class="btn ghost" href="/record/${b.id}" target="_blank">${icon("globe")}OPAC</a>
        <a class="btn ghost" href="/api/v1/cataloging/export?fmt=xml&ids=${b.id}">${icon("download")}MARCXML</a>
        <button class="btn danger" id="del">${icon("trash")}Delete</button>
        <a class="btn primary" href="/staff/catalog/${b.id}/edit">${icon("edit")}Edit record</a></div></div>
    <div class="grid split">
      <div class="stack">
        <div class="card"><div class="card-head"><h3>Items (${b.items.length})</h3><button class="btn sm primary" id="add-item">${icon("plus")}Add item</button></div>
          <div class="card-body">${b.items.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Barcode</th><th>Branch</th><th>Type</th><th>Call no.</th><th>Status</th><th class="num">Loans</th><th></th></tr></thead><tbody>
          ${b.items.map((i) => html`<tr><td class="mono">${i.barcode}</td><td>${i.branch.name}<div class="tiny muted">${i.shelf_location || ""}</div></td><td>${i.item_type.name}</td>
            <td class="mono small">${i.call_number || "—"}</td><td>${badge(i.status)}</td><td class="num">${i.times_borrowed}</td>
            <td class="right nowrap"><button class="btn sm ghost" data-edit-item="${i.id}" aria-label="Edit item ${i.barcode}">${icon("edit")}</button>
              <button class="btn sm ghost danger" data-del-item="${i.id}" aria-label="Delete item ${i.barcode}">${icon("trash")}</button></td></tr>`)}</tbody></table></div>`
            : empty("No items yet — add one so patrons can borrow this title.")}</div></div>
        <div class="card"><div class="card-head"><h3>Description</h3></div><div class="card-body">${b.description ? html`<p>${b.description}</p>` : html`<p class="muted">No description. Use AI enrich to draft one.</p>`}
          <div class="row tight">${(b.subjects || []).map((s) => html`<span class="chip">${s}</span>`)}</div></div></div>
        <div class="card"><div class="card-head"><h3>Holds queue (${mine.length})</h3><button class="btn sm" id="place-hold">${icon("bookmark")}Place hold for patron</button></div>
          <div class="card-body">${mine.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>#</th><th>Patron</th><th>Pickup</th><th>Status</th><th>Placed</th></tr></thead><tbody>
          ${mine.map((h) => html`<tr><td>${h.queue_position ?? "—"}</td><td><a href="/staff/patrons/${h.patron.id}">${h.patron.full_name}</a></td><td>${h.pickup_branch.name}</td><td>${badge(h.status)}</td><td>${relative(h.created_at)}</td></tr>`)}</tbody></table></div>` : empty("No one is waiting for this title.")}</div></div>
      </div>
      <div class="stack">
        <div class="card pad"><dl class="dl">
          ${[["ISBN", b.isbn], ["Publisher", b.publisher], ["Edition", b.edition], ["Pages", b.pages], ["Language", b.language], ["Format", b.material_type],
             ["Audience", b.audience], ["Classification", b.classification], ["Series", b.series], ["Added", date(b.created_at)]]
             .filter(([, v]) => v).map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl></div>
        <div class="card panel-ai"><div class="card-head"><h3>${icon("sparkle")} AI cataloguing</h3></div>
          <div class="card-body stack"><p class="small muted">Suggest subject headings, Dewey class, audience and a summary from the record and similar titles.</p>
            <button class="btn ai" id="enrich">${icon("sparkle")}Suggest enrichments</button><div id="enrich-out"></div></div></div>
        <div class="card"><div class="card-head"><h3>Readers also borrowed</h3></div><div class="card-body" id="related">${empty("…")}</div></div>
      </div></div>`;
  api(`/biblios/${b.id}/related`).then((r) => {
    $("#related").innerHTML = r.results.length ? html`<div class="stack tight">${r.results.map((x) => html`<a class="row tight" href="/staff/catalog/${x.id}">${cover(x, "sm")}<span class="small">${x.title}</span></a>`)}</div>` : empty("Not enough data yet");
  }).catch(() => {});
}

export default async function init() {
  lk = await api("/lookups");
  try { await render(); } catch (e) { $("#record").innerHTML = empty(e.message, "alert"); return; }
  $("#record").addEventListener("click", async (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    try {
      if (t.id === "del") {
        if (!(await confirmDialog("Delete record?", `“${b.title}” and its ${b.items.length} item(s) will be withdrawn from the catalogue.`, "Delete"))) return;
        await api(`/biblios/${b.id}`, { method: "DELETE" });
        toast("Record deleted", "success");
        location.href = "/staff/catalog";
      } else if (t.id === "add-item") {
        const fd = await modal({ title: "Add item", body: itemForm(), submit: "Add item", wide: true });
        if (!fd) return;
        const item = await api(`/biblios/${b.id}/items`, { method: "POST", body: itemPayload(fd, true) });
        toast(`Item ${item.barcode} added`, "success");
        await render();
      } else if (t.dataset.editItem) {
        const item = b.items.find((i) => i.id === +t.dataset.editItem);
        const fd = await modal({ title: `Edit item ${item.barcode}`, body: itemForm(item), wide: true });
        if (!fd) return;
        await api(`/items/${item.id}`, { method: "PATCH", body: itemPayload(fd, false) });
        toast("Item updated", "success");
        await render();
      } else if (t.dataset.delItem) {
        if (!(await confirmDialog("Delete item?", "The item will be withdrawn.", "Delete"))) return;
        await api(`/items/${t.dataset.delItem}`, { method: "DELETE" });
        await render();
      } else if (t.id === "place-hold") {
        const fd = await modal({ title: "Place hold for a patron", submit: "Place hold", body: html`<div class="stack">
          <div class="field"><label for="h-card">Patron card number</label><input id="h-card" name="card" required></div>
          <div class="field"><label for="h-br">Pickup branch</label><select id="h-br" name="branch">${lk.branches.map((x) => html`<option value="${x.id}">${x.name}</option>`)}</select></div></div>` });
        if (!fd) return;
        await api("/holds", { method: "POST", body: { biblio_id: b.id, patron_card: fd.get("card"), pickup_branch_id: +fd.get("branch") } });
        toast("Hold placed", "success");
        await render();
      } else if (t.id === "enrich") {
        const s = await withBusy(t, () => api("/ai/catalog-assist", { method: "POST", body: {
          id: b.id, title: b.title, subtitle: b.subtitle, authors: b.authors, description: b.description, subjects: b.subjects,
          publisher: b.publisher, pub_year: b.pub_year, isbn: b.isbn } }));
        const newSubjects = (s.subjects || []).filter((x) => !(b.subjects || []).some((y) => y.toLowerCase() === x.toLowerCase()));
        $("#enrich-out").innerHTML = html`<div class="stack tight">
          <div class="tiny muted">Engine: ${s.engine === "claude" ? "Claude" : "Local AI (similar records + rules)"}</div>
          ${newSubjects.length ? html`<div><strong class="small">Subjects</strong><div class="row tight">${newSubjects.map((x) => html`<label class="chip"><input type="checkbox" checked data-subj="${x}"> ${x}</label>`)}</div></div>` : ""}
          ${s.classification ? html`<div class="small"><strong>Dewey:</strong> <span class="mono">${s.classification}</span> ${s.classification_label || ""}</div>` : ""}
          ${s.audience ? html`<div class="small"><strong>Audience:</strong> ${s.audience.replace("_", " ")}</div>` : ""}
          ${s.summary && !b.description ? html`<div class="small"><strong>Summary:</strong> ${s.summary}</div>` : ""}
          <button class="btn sm primary" id="apply-enrich">${icon("check")}Apply selected</button></div>`;
        $("#apply-enrich").addEventListener("click", async () => {
          const chosen = [...document.querySelectorAll("[data-subj]:checked")].map((c) => c.dataset.subj);
          const patch = { subjects: [...(b.subjects || []), ...chosen], ai_enriched: true };
          if (s.classification && !b.classification) patch.classification = s.classification;
          if (s.audience && !b.audience) patch.audience = s.audience;
          if (s.summary && !b.description) patch.description = s.summary;
          await api(`/biblios/${b.id}`, { method: "PATCH", body: patch });
          toast("Record enriched", "success");
          await render();
        });
      }
    } catch (err) { if (!err.toasted) toast(err.message, "error"); }
  });
}

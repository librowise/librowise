import { $, $$, BOOT, api, badge, confirmDialog, date, empty, html, icon, initials, money, toast, parseDate } from "/static/js/core.js";

let mode = "checkout";
let patron = null;
const session = [];

const LABELS = {
  checkout: ["Item barcode", "Check out"],
  checkin: ["Item barcode to return", "Check in"],
  transfer: ["Barcode of item arriving", "Receive"],
};

function setMode(m) {
  mode = m;
  $$("[data-mode]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.mode === m));
  $("#patron-form").hidden = m !== "checkout";
  $("#patron-panel").hidden = m !== "checkout";
  $("#loans-card").hidden = m !== "checkout" || !patron;
  [$("#barcode-label").textContent, $("#item-submit").textContent] = LABELS[m];
  history.replaceState(null, "", `#${m}`);
  (m === "checkout" && !patron ? $("#patron-card") : $("#barcode")).focus();
}

const branchId = () => +$("#desk-branch").value;

function feed(kind, title, detail, extra = "") {
  session.unshift({ kind, title, detail, at: new Date(), patronId: patron?.id ?? null });
  const cls = { out: "out", in: "in", err: "err", info: "out" }[kind];
  const ic = { out: "arrow-up", in: "arrow-down", err: "alert", info: "info" }[kind];
  const item = html`<div class="feed-item"><span class="feed-icon ${cls}">${icon(ic)}</span>
    <div class="grow"><strong>${title}</strong><div class="small muted">${detail}</div>${extra}</div>
    <span class="tiny muted">${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></div>`;
  const box = $("#feed");
  if (box.querySelector(".empty")) box.innerHTML = "";
  box.insertAdjacentHTML("afterbegin", item);
}

async function loadPatron(term) {
  term = term.trim();
  if (!term) return;
  try {
    let p;
    try {
      p = await api(`/patrons/by-card/${encodeURIComponent(term)}`);
    } catch (e) {
      if (e.status !== 404) throw e;
      const found = await api(`/patrons?q=${encodeURIComponent(term)}&per_page=1`);
      if (!found.results.length) throw new Error(`No patron matches “${term}”`);
      p = await api(`/patrons/${found.results[0].id}`);
    }
    patron = p;
    renderPatron();
    $("#barcode").focus();
  } catch (e) {
    toast(e.message, "error");
    $("#patron-card").select();
  }
}

function renderPatron() {
  const p = patron;
  if (!p) { $("#patron-panel").innerHTML = ""; $("#loans-card").hidden = true; return; }
  $("#patron-panel").innerHTML = html`<div class="card pad" style="background:var(--surface-2)">
    <div class="patron-card"><div class="avatar">${initials(p.full_name)}</div>
      <div class="grow"><a href="/staff/patrons/${p.id}"><strong>${p.full_name}</strong></a>
        <div class="small muted">${p.card_number} · ${p.category.name} · ${p.home_branch.name}</div>
        <div class="row tight" style="margin-top:.3rem">${badge(p.balance > 0 ? "warn" : "ok", `Balance ${money(p.balance)}`)}
          ${badge("info", `${p.loans.length} on loan`)}${p.holds.some((h) => h.status === "ready") ? badge("ready", "Hold ready for pickup") : ""}
          ${p.expires_on ? badge(parseDate(p.expires_on) < new Date() ? "bad" : "", `Expires ${date(p.expires_on)}`) : ""}</div></div>
      <button class="btn ghost icon-only" id="clear-patron" aria-label="Clear patron">${icon("x")}</button></div>
    ${p.blocks.length ? html`<div class="alert bad" style="margin-top:.75rem">${icon("alert")}<div><strong>Blocked:</strong> ${p.blocks.join("; ")}<div class="tiny">You can still override with confirmation.</div></div></div>` : ""}
    ${p.notes ? html`<div class="alert info" style="margin-top:.75rem">${icon("info")}<div>${p.notes}</div></div>` : ""}</div>`;
  $("#loans-card").hidden = mode !== "checkout";
  $("#patron-loans").innerHTML = p.loans.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Title</th><th>Due</th><th></th></tr></thead><tbody>
    ${p.loans.map((l) => html`<tr><td>${l.item.biblio.title}<div class="tiny muted mono">${l.item.barcode}</div></td>
      <td>${l.overdue ? badge("overdue", `${l.days_overdue}d overdue`) : date(l.due_at)}<div class="tiny muted">renewed ${l.renewals}×</div></td>
      <td class="right"><button class="btn sm" data-renew="${l.id}">Renew</button></td></tr>`)}</tbody></table></div>` : empty("No current loans");
  $("#clear-patron").addEventListener("click", () => { patron = null; renderPatron(); $("#patron-card").value = ""; $("#patron-card").focus(); });
}

async function refreshPatron() {
  if (patron) { patron = await api(`/patrons/${patron.id}`); renderPatron(); }
}

async function checkout(barcode, override = false) {
  if (!patron) { toast("Load a patron first", "error"); $("#patron-card").focus(); return; }
  try {
    const r = await api("/circulation/checkout", { method: "POST", body: { patron_card: patron.card_number, barcode, branch_id: branchId(), override } });
    const b = r.loan.item.biblio;
    feed("out", b.title, `${barcode} → ${patron.full_name} · due ${date(r.loan.due_at)}`,
      r.warnings.length ? html`<div class="row tight" style="margin-top:.3rem">${r.warnings.map((w) => badge("warn", w))}</div>` : "");
    await refreshPatron();
  } catch (e) {
    if (e.status === 422 && e.data?.reasons && !override) {
      const ok = await confirmDialog("Checkout blocked", `${e.data.reasons.join(". ")}. Override and check out anyway?`, "Override & check out");
      if (ok) return checkout(barcode, true);
    } else if (e.data?.code === "on_loan") {
      const ok = await confirmDialog("Item is on loan", "This item is checked out to another patron. Check it in first, then lend it?", "Check in & lend", false);
      if (ok) { await checkin(barcode); return checkout(barcode, override); }
    }
    feed("err", "Checkout failed", `${barcode}: ${e.message}`);
  }
}

async function checkin(barcode) {
  try {
    const r = await api("/circulation/checkin", { method: "POST", body: { barcode, branch_id: branchId() } });
    const msgs = r.messages || [];
    const holdMsg = r.hold ? html`<div class="alert info" style="margin-top:.4rem">${icon("bookmark")}<div><strong>${msgs.find((m) => m.startsWith("Hold")) || "Hold"}</strong></div></div>` : "";
    const other = msgs.filter((m) => !m.startsWith("Hold"));
    feed("in", r.item.biblio.title, `${barcode}${r.loan?.patron ? ` ← ${r.loan.patron.full_name}` : ""}${r.fine ? ` · fine ${money(r.fine)}` : ""}`,
      html`${holdMsg}${other.length ? html`<div class="row tight" style="margin-top:.3rem">${other.map((m) => badge("warn", m))}</div>` : ""}`);
    if (r.hold) toast(msgs.find((m) => m.startsWith("Hold")) || "Item routed to a hold", "info", 8000);
    if (patron && r.loan?.patron?.id === patron.id) await refreshPatron();
  } catch (e) {
    feed("err", "Check-in failed", `${barcode}: ${e.message}`);
  }
}

async function receive(barcode) {
  try {
    const r = await api("/circulation/transfer/receive", { method: "POST", body: { barcode, branch_id: branchId() } });
    feed("info", r.item.biblio.title, `${barcode} received · ${r.messages.join("; ")}`);
  } catch (e) {
    feed("err", "Receive failed", `${barcode}: ${e.message}`);
  }
}

// Camera scanning with the native BarcodeDetector API where supported (Chrome/Edge/Android).
async function scanWithCamera(targetId) {
  const dlg = document.createElement("dialog");
  dlg.className = "scanner";
  dlg.innerHTML = html`<div class="dialog-head"><h2>Scan barcode</h2><button class="btn ghost icon-only" data-close aria-label="Close">${icon("x")}</button></div>
    <div class="dialog-body"><video autoplay playsinline muted></video><p class="small muted">Hold the barcode steady in view.</p></div>`.toString();
  document.body.append(dlg);
  dlg.showModal();
  let stream, active = true;
  const stop = () => { active = false; stream?.getTracks().forEach((t) => t.stop()); dlg.close(); dlg.remove(); };
  dlg.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) stop(); });
  dlg.addEventListener("cancel", stop);
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    const video = $("video", dlg);
    video.srcObject = stream;
    const detector = new window.BarcodeDetector();
    while (active) {
      const codes = await detector.detect(video).catch(() => []);
      if (codes.length) {
        const input = $(`#${targetId}`);
        input.value = codes[0].rawValue;
        stop();
        input.form.requestSubmit();
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  } catch (e) {
    toast(`Camera unavailable: ${e.message}`, "error");
    stop();
  }
}

function printReceipt() {
  // Only the loaded patron's checkouts: the session feed spans every patron served at this desk,
  // and one patron's slip must never list another patron's loans.
  if (!patron) { toast("Load a patron to print their receipt", "error"); $("#patron-card").focus(); return; }
  const mine = session.filter((s) => s.kind === "out" && s.patronId === patron.id);
  if (!mine.length) { toast("Nothing to print yet for this patron"); return; }
  const w = window.open("", "_blank", "width=420,height=600");
  if (!w) return;
  const lines = mine.map((s) => html`<li><strong>${s.title}</strong><br><small>${s.detail}</small></li>`);
  w.document.write(html`<!doctype html><title>Receipt</title><body style="font-family:system-ui;padding:1rem">
    <h2>Loan receipt</h2><p>${patron ? patron.full_name : ""} · ${new Date().toLocaleString()}</p><ol>${lines}</ol>
    <p><small>Thank you for using the library.</small></p></body>`.toString());
  w.document.close();
  w.print();
}

export default async function init() {
  const { branches } = await api("/lookups");
  $("#desk-branch").innerHTML = html`${branches.map((b) => html`<option value="${b.id}" ${b.id === BOOT.user.home_branch_id ? "selected" : ""}>${b.name}</option>`)}`;
  if ("BarcodeDetector" in window && navigator.mediaDevices) $$("[data-camera]").forEach((b) => { b.hidden = false; });
  document.addEventListener("click", (e) => {
    const m = e.target.closest("[data-mode]");
    if (m) setMode(m.dataset.mode);
    const cam = e.target.closest("[data-camera]");
    if (cam) scanWithCamera(cam.dataset.camera);
  });
  $("#patron-form").addEventListener("submit", (e) => { e.preventDefault(); loadPatron($("#patron-card").value); });
  $("#item-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("#barcode");
    const barcode = input.value.trim();
    if (!barcode) return;
    input.value = "";
    input.disabled = true;
    try {
      if (mode === "checkout") await checkout(barcode);
      else if (mode === "checkin") await checkin(barcode);
      else await receive(barcode);
    } finally {
      input.disabled = false;
      input.focus();
    }
  });
  $("#patron-loans").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-renew]");
    if (!b) return;
    try {
      const l = await api(`/loans/${b.dataset.renew}/renew`, { method: "POST", body: { override: false } });
      feed("out", l.item.biblio.title, `Renewed · now due ${date(l.due_at)}`);
      await refreshPatron();
    } catch (err) {
      if (err.status === 422 && (await confirmDialog("Renewal blocked", `${err.message}. Override?`, "Override & renew"))) {
        const l = await api(`/loans/${b.dataset.renew}/renew`, { method: "POST", body: { override: true } });
        feed("out", l.item.biblio.title, `Renewed (override) · now due ${date(l.due_at)}`);
        await refreshPatron();
      } else if (err.status !== 422) toast(err.message, "error");
    }
  });
  $("#renew-all").addEventListener("click", async () => {
    if (!patron) return;
    let ok = 0, fail = 0;
    for (const l of patron.loans) {
      try { await api(`/loans/${l.id}/renew`, { method: "POST", body: { override: false } }); ok++; } catch { fail++; }
    }
    toast(`${ok} renewed${fail ? `, ${fail} blocked` : ""}`, fail ? "info" : "success");
    await refreshPatron();
  });
  $("#print-slip").addEventListener("click", printReceipt);
  document.addEventListener("keydown", (e) => {
    if (e.key === "F2") { e.preventDefault(); setMode("checkout"); }
    if (e.key === "F3") { e.preventDefault(); setMode("checkin"); }
    if (e.key === "F4") { e.preventDefault(); setMode("transfer"); }
  });
  const start = location.hash.slice(1);
  setMode(LABELS[start] ? start : "checkout");
  const card = new URLSearchParams(location.search).get("patron");
  if (card) { $("#patron-card").value = card; loadPatron(card); }
}

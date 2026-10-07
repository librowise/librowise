// Command palette / global search (Ctrl+K, the top-bar search). Scoped results:
//   Records (catalogue search) · Patrons (name, card, email) · Items (exact barcode) · Commands (navigation
//   from the permission-filtered sidebar + actions). Prefixes jump to a scope: ">" commands, "@" patrons,
//   "#" items. Tab / Shift+Tab cycles scopes. Results stream in per scope; stale responses are ignored.
import { $, $$, api, debounce, esc, html, icon, qs, raw } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";

const go = (href) => () => (location.href = href);

function navCommands() {
  const out = [];
  for (const hub of $$(".hub-item")) {
    const link = $(".hub-link", hub);
    const hubLabel = $(".hub-label", hub)?.textContent.trim() || "";
    const icn = $(".hub-link use", hub)?.getAttribute("href")?.replace("#i-", "") || "chevron";
    const subs = $$(".hub-sub a", hub);
    if (!subs.length) out.push({ group: "goto", label: hubLabel, run: go(link.href), icon: icn, hint: link.dataset.hubIndex ? `Alt+${link.dataset.hubIndex}` : "" });
    subs.forEach((a, i) => out.push({ group: "goto", label: `${hubLabel} › ${a.textContent.trim()}`, run: go(a.href), icon: icn,
      hint: i === 0 && link.dataset.hubIndex ? `Alt+${link.dataset.hubIndex}` : "" }));
  }
  return out;
}

const matches = (c, words) => words.every((w) => `${c.label} ${c.keywords || ""}`.toLowerCase().includes(w));

export function openPalette({ commands = [], staff = false, initial = "" } = {}) {
  if ($("dialog.palette[open]")) return;
  const scopes = staff ? ["all", "records", "patrons", "items", "commands"] : ["all", "records", "commands"];
  const prefixes = { ">": "commands", "@": "patrons", "#": "items" };
  const allCommands = [...(staff ? navCommands() : []), ...commands];
  const opener = document.activeElement;
  const d = document.createElement("dialog");
  d.className = "palette";
  d.setAttribute("aria-label", t("ui.palette.title"));
  d.innerHTML = html`<div class="pal-search">${icon("search")}
      <input type="text" role="combobox" aria-expanded="true" aria-controls="pal-list" aria-autocomplete="list" autocomplete="off" spellcheck="false"
        placeholder="${staff ? t("ui.palette.placeholder_staff") : t("ui.palette.placeholder")}" aria-label="${t("ui.palette.title")}">
      <kbd>Esc</kbd></div>
    <div class="pal-scopes" role="radiogroup" aria-label="${t("ui.palette.scope")}">${scopes.map((s, i) => html`<button type="button" role="radio" data-scope="${s}" aria-checked="${i === 0}" tabindex="-1">${t(`ui.palette.scope_${s}`)}</button>`)}</div>
    <ul role="listbox" id="pal-list" aria-label="${t("ui.palette.results")}"></ul>
    <div class="foot"><span><kbd>↑</kbd><kbd>↓</kbd> ${t("ui.palette.navigate")}</span><span><kbd>Enter</kbd> ${t("ui.palette.open")}</span>
      <span><kbd>Tab</kbd> ${t("ui.palette.switch_scope")}</span>${staff ? html`<span class="pal-prefix">${raw(t("ui.palette.prefix_hint"))}</span>` : ""}</div>
    <div class="sr-only" aria-live="polite" data-live></div>`;
  document.body.append(d);
  const input = $("input", d), list = $("ul", d), live = $("[data-live]", d);
  let scope = "all", items = [], sel = 0, seq = 0;
  const remote = { records: [], patrons: [], items: [] };
  const loading = { records: false, patrons: false, items: false };

  const parse = () => {
    const raw0 = input.value;
    const p = prefixes[raw0.trim()[0]];
    return { q: (p ? raw0.trim().slice(1) : raw0).trim(), scope: p && scopes.includes(p) ? p : scope };
  };
  const want = (s, sc) => sc === "all" || sc === s;

  function render() {
    const { q, scope: sc } = parse();
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const out = [];
    if (want("records", sc) && q) {
      out.push(...remote.records);
      out.push({ group: "records", label: t("ui.palette.search_catalogue", { q }), icon: "search",
        run: go(staff ? `/staff/catalog?${qs({ q })}` : `/search?${qs({ q })}`) });
    }
    if (staff && want("patrons", sc) && q) {
      out.push(...remote.patrons);
      out.push({ group: "patrons", label: t("ui.palette.find_patron", { q }), icon: "users", run: go(`/staff/patrons?${qs({ q })}`) });
    }
    if (staff && want("items", sc)) out.push(...remote.items);
    if (want("commands", sc)) {
      const cmds = allCommands.filter((c) => !words.length || matches(c, words));
      out.push(...(sc === "all" && !q ? cmds : cmds.slice(0, sc === "commands" ? 50 : 8)));
      if (staff && q) out.push({ group: "actions", label: t("ui.palette.ask_copilot", { q }), icon: "sparkle", run: () => import("/static/js/core.js").then((m) => m.openCopilot(q)) });
    }
    items = out;
    sel = Math.min(sel, Math.max(items.length - 1, 0));
    let last = "";
    const busy = Object.entries(loading).some(([k, v]) => v && want(k, sc));
    list.innerHTML = items.map((c, i) => {
      const head = c.group !== last ? `<li class="group" role="presentation">${esc(t(`ui.palette.group_${c.group}`))}</li>` : "";
      last = c.group;
      return `${head}<li role="option" id="pal-o${i}" data-i="${i}" aria-selected="${i === sel}">${icon(c.icon || "chevron").__raw}
        <span class="pal-label"><span class="truncate">${esc(c.label)}</span>${c.sub ? `<span class="pal-sub truncate">${esc(c.sub)}</span>` : ""}</span>
        ${c.hint ? `<span class="hint">${esc(c.hint)}</span>` : ""}</li>`;
    }).join("") + (busy ? `<li class="group pal-loading" role="presentation"><span class="spinner" aria-hidden="true"></span> ${esc(t("common.loading"))}</li>` : "")
      || `<li class="group" role="presentation">${esc(t("ui.palette.no_matches"))}</li>`;
    input.setAttribute("aria-activedescendant", items.length ? `pal-o${sel}` : "");
    $(`[aria-selected="true"]`, list)?.scrollIntoView({ block: "nearest" });
    $$("[data-scope]", d).forEach((b) => b.setAttribute("aria-checked", String(b.dataset.scope === sc)));
  }

  const fetchRemote = debounce(async () => {
    const { q, scope: sc } = parse();
    const mine = ++seq;
    remote.records = []; remote.patrons = []; remote.items = [];
    if (!q || q.length < 2) { render(); return; }
    const jobs = [];
    if (want("records", sc)) {
      loading.records = true;
      jobs.push(api(`/search?${qs({ q, per_page: 5 })}`).then((r) => {
        if (mine !== seq) return;
        remote.records = r.results.map((b) => ({ group: "records", label: b.title, icon: "book",
          sub: [(b.authors || [])[0], b.pub_year].filter(Boolean).join(" · "), run: go(staff ? `/staff/catalog/${b.id}` : `/record/${b.id}`) }));
      }).catch(() => {}).finally(() => { loading.records = false; }));
    }
    if (staff && want("patrons", sc)) {
      loading.patrons = true;
      jobs.push(api(`/patrons?${qs({ q, per_page: 5 })}`).then((r) => {
        if (mine !== seq) return;
        remote.patrons = r.results.map((p) => ({ group: "patrons", label: p.full_name, icon: "user",
          sub: [p.card_number, p.category?.name, p.home_branch?.name].filter(Boolean).join(" · "), run: go(`/staff/patrons/${p.id}`) }));
      }).catch(() => {}).finally(() => { loading.patrons = false; }));
    }
    if (staff && want("items", sc) && /^[A-Za-z0-9._-]{3,32}$/.test(q)) {
      loading.items = true;
      jobs.push(api(`/items/${encodeURIComponent(q)}`).then((it) => {
        if (mine !== seq) return;
        remote.items = [{ group: "items", label: `${it.barcode} — ${it.biblio?.title || ""}`, icon: "barcode",
          sub: [it.status?.replace(/_/g, " "), it.branch?.name, it.call_number].filter(Boolean).join(" · "), run: go(`/staff/catalog/${it.biblio_id}`) }];
      }).catch(() => {}).finally(() => { loading.items = false; }));
    }
    render();
    await Promise.all(jobs);
    if (mine === seq) {
      render();
      live.textContent = t("ui.palette.result_count", { count: items.length });
    }
  }, 180);

  const run = (i) => { const c = items[i]; if (!c) return; d.close(); c.run(); };
  const setScope = (s) => { scope = s; sel = 0; render(); fetchRemote(); };
  input.addEventListener("input", () => { sel = 0; render(); fetchRemote(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { sel = (sel + 1) % Math.max(items.length, 1); render(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { sel = (sel - 1 + items.length) % Math.max(items.length, 1); render(); e.preventDefault(); }
    else if (e.key === "Enter") { run(sel); e.preventDefault(); }
    else if (e.key === "Tab") {
      e.preventDefault();
      const i = scopes.indexOf(scope);
      setScope(scopes[(i + (e.shiftKey ? -1 : 1) + scopes.length) % scopes.length]);
    }
  });
  d.addEventListener("click", (e) => {
    const s = e.target.closest("[data-scope]");
    if (s) { setScope(s.dataset.scope); input.focus(); return; }
    const li = e.target.closest("[data-i]");
    if (li) run(+li.dataset.i);
    else if (e.target === d) d.close();
  });
  d.addEventListener("close", () => { d.remove(); if (opener?.isConnected && document.activeElement === document.body) opener.focus?.(); });
  input.value = initial;
  render();
  d.showModal();
  input.focus();
  if (initial) fetchRemote();
}

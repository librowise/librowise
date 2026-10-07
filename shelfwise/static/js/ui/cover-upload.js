// Staff cover editor: shows a record's cover with "Upload / Replace" and "Remove" actions, plus drag &
// drop. Client-side checks (type, 5 MB) give fast feedback; the server re-validates by magic bytes.
//
//   mountCoverEditor($("#cover-slot"), biblio, { onChange: (b) => … });
import { api, confirmDialog, cover, html, icon, toast } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";

const TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX = 5 * 1024 * 1024;

export function mountCoverEditor(el, biblio, { onChange } = {}) {
  let b = { ...biblio };
  const uploaded = () => !!b.cover && b.cover.includes("?v=");
  const paint = () => {
    el.innerHTML = html`<div class="cover-edit" data-drop>
      ${cover(b, "")}
      <div class="cover-actions">
        <label class="btn sm" data-tip="${t("ui.cover.hint")}">${icon("upload")}${uploaded() ? t("ui.cover.replace") : t("ui.cover.upload")}
          <input type="file" accept="${TYPES.join(",")}" class="sr-only" data-cover-file></label>
        ${uploaded() ? html`<button type="button" class="btn sm ghost danger" data-cover-remove>${icon("trash")}<span class="sr-only">${t("ui.cover.remove")}</span></button>` : ""}
      </div><div class="sr-only" aria-live="polite" data-cover-live></div></div>`;
  };
  const upload = async (file) => {
    if (!file) return;
    if (!TYPES.includes(file.type)) { toast(t("ui.cover.bad_type"), "error"); return; }
    if (file.size > MAX) { toast(t("ui.cover.too_big"), "error"); return; }
    const form = new FormData();
    form.append("file", file);
    el.querySelector(".cover")?.classList.add("skeleton");
    try {
      const r = await api(`/biblios/${b.id}/cover`, { method: "POST", form });
      b = { ...b, cover: r.cover };
      paint();
      toast(t("ui.cover.saved"), "success");
      onChange?.(b);
    } catch (e) {
      paint();
      toast(e.message, "error");
    }
  };
  el.addEventListener("change", (e) => { if (e.target.matches("[data-cover-file]")) upload(e.target.files[0]); });
  el.addEventListener("click", async (e) => {
    if (!e.target.closest("[data-cover-remove]")) return;
    if (!await confirmDialog(t("ui.cover.remove_title"), t("ui.cover.remove_text"), t("ui.cover.remove"))) return;
    try {
      await api(`/biblios/${b.id}/cover`, { method: "DELETE" });
      b = { ...b, cover: b.isbn ? `/covers/${b.id}.jpg` : null };
      paint();
      toast(t("ui.cover.removed"), "success");
      onChange?.(b);
    } catch (err) { toast(err.message, "error"); }
  });
  el.addEventListener("dragover", (e) => { if (e.dataTransfer?.types.includes("Files")) { e.preventDefault(); el.querySelector("[data-drop]")?.classList.add("over"); } });
  el.addEventListener("dragleave", () => el.querySelector("[data-drop]")?.classList.remove("over"));
  el.addEventListener("drop", (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    el.querySelector("[data-drop]")?.classList.remove("over");
    upload(e.dataTransfer.files[0]);
  });
  paint();
  return { get biblio() { return b; } };
}

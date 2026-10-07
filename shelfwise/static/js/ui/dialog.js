// Dialogs. `modal()` and `confirmDialog()` live in core.js (every page already imports them); this module
// re-exports them and adds `confirmDestructive()` — type-to-confirm for irreversible bulk actions.
//
//   const fd = await modal({ title, body: html`…fields…`, submit: "Save", size: "sm" | "md" | "lg" | "xl" });
//   if (await confirmDialog("Delete record?", "This cannot be undone.", "Delete")) …
//
// Behaviour (all variants): Enter in a single-line field submits the primary action, Esc / Cancel / ✕ /
// backdrop-free close resolves null, focus is trapped and restored to the opener, invalid fields block
// submission and are announced, on phones the dialog becomes a bottom sheet.
import { confirmDialog, html, modal } from "/static/js/core.js";
import { t } from "/static/js/i18n.js";

export { confirmDialog, modal };

export async function confirmDestructive({ title, text, word, submit }) {
  const fd = await modal({ title, danger: true, size: "sm", submit: submit || t("common.confirm"),
    body: html`<p>${text}</p><div class="field"><label for="confirm-word">${t("ui.dialog.type_to_confirm", { word })}</label>
      <input id="confirm-word" name="word" autocomplete="off" required pattern="${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" title="${t("ui.dialog.type_to_confirm", { word })}"></div>` });
  return !!fd && fd.get("word") === word;
}

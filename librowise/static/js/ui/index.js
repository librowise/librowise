// Librowise design system — one import for page modules:
//   import { dataTable, pageHeader, statusPill, emptyState } from "/static/js/ui/index.js";
// Each module is also importable on its own (smaller dependency graph for simple pages).
// Docs: docs/DESIGN_SYSTEM.md · live examples: /staff/styleguide
export { avatar, hue } from "/static/js/ui/avatar.js";
export { combobox, highlight } from "/static/js/ui/combobox.js";
export { mountCoverEditor } from "/static/js/ui/cover-upload.js";
export { dataTable, downloadCSV, toCSV } from "/static/js/ui/data-table.js";
export { datePicker, dateRange, presetRange, wireDateRange } from "/static/js/ui/date-range.js";
export { confirmDestructive, confirmDialog, modal } from "/static/js/ui/dialog.js";
export { emptyState, errorState, illustration, skeletonList, skeletonRows } from "/static/js/ui/empty.js";
export { activeFilters, savedViews, searchField, selectChip, urlState, wireFilterBar } from "/static/js/ui/filters.js";
export { enhanceForm, field, formSection, saveBar, setFieldError } from "/static/js/ui/form.js";
export { popover } from "/static/js/ui/menu.js";
export { pageHeader, setCount, setCrumb } from "/static/js/ui/page-header.js";
export { pageRange, pagination, wirePagination } from "/static/js/ui/pagination.js";
export { sidePanel } from "/static/js/ui/panel.js";
export { progress, statTile } from "/static/js/ui/stat.js";
export { STATUS, statusPill, statusText, toneOf } from "/static/js/ui/status.js";
export { segmented, tabs, wireSegmented, wireTabsPanel } from "/static/js/ui/tabs.js";
export { hideTip, initTooltips, showTip } from "/static/js/ui/tooltip.js";

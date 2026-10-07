// Staff: My account & security — password, two-factor authentication, sessions, API tokens, linked accounts.
import { $ } from "/static/js/core.js";
import { mountSecurity } from "/static/js/security-panel.js";

export default async function init() {
  const enroll = new URLSearchParams(location.search).get("enroll") === "1";
  await mountSecurity($("#security-root"), { enroll, password: true });
}

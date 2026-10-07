# Security policy

Please report vulnerabilities **privately** through GitHub's "Report a vulnerability" (Security → Advisories) on this repository. Do not open a public issue. We aim to acknowledge reports within 3 working days.

## Built-in protections
- Argon2id password hashing with transparent re-hashing, a password strength policy, and login rate limiting
- Signed, expiring session tokens bound to a password fingerprint: a password change revokes all sessions
- Double-submit CSRF tokens enforced on every unsafe cookie-authenticated request
- Strict Content-Security-Policy (`script-src 'self'`, no inline scripts or handlers), `X-Frame-Options: DENY`, `nosniff`, HSTS behind HTTPS
- Jinja2 auto-escaping on the server and an escaping `html` tagged template in the browser
- Role-based access control checked on every endpoint, plus an audit log of privileged actions
- No user-supplied SQL. FTS queries are tokenised and quoted. CSV exports neutralise spreadsheet formulas.
- Privacy: soft deletes, GDPR-style erasure, loan-history anonymisation and a per-patron opt-out
- AI copilot tools are read-only and never generate SQL

## Production checklist
Set `LIBROWISE_SECRET_KEY`, `LIBROWISE_COOKIE_SECURE=true` and `LIBROWISE_ALLOWED_HOSTS`, run behind HTTPS, use PostgreSQL, and remove the demo accounts. Never run `seed` against production.

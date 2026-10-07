"""Notices: sandboxed templates, messaging preferences, outbox delivery with retries, backends."""

from datetime import timedelta

import pytest
from conftest import login

from librowise.config import Settings
from librowise.models import Notification, Patron, utcnow
from librowise.services import circulation, notices


def _patron(db, lib, key="patron"):
    return db.get(Patron, lib[key].id)


# ------------------------------------------------------------------ sandbox


@pytest.mark.parametrize("src", [
    "{{ ''.__class__.__mro__ }}",
    "{{ ''.__class__ }}",
    "{{ patron.__class__.__init__.__globals__ }}",
    "{{ cycler.__init__.__globals__.os }}",
    "{{ lipsum.__globals__['os'] }}",
    "{{ joiner.__init__.__globals__ }}",
    "{% for c in ''.__class__.__base__.__subclasses__() %}{{ c }}{% endfor %}",
    "{{ patron.update({'x': 1}) }}",  # immutable sandbox: no mutating methods
    "{{ 'x' * 100000000 }}",
    "{{ 9 ** 9 ** 9 }}",
    "{{ self.__init__.__globals__ }}",
    "{{ request }}{{ config.__class__ }}",
])
def test_sandbox_blocks_dangerous_templates(db, lib, src):
    with pytest.raises(notices.TemplateProblem):
        notices.render_string(src, {"patron": {"first_name": "A"}})


def test_sandbox_renders_plain_context(db, lib):
    out = notices.render_string("Hi {{ patron.first_name|upper }} — {{ items|length }} item{{ 's' if items|length != 1 }}",
                                {"patron": {"first_name": "ana"}, "items": [1, 2]})
    assert out == "Hi ANA — 2 items"
    with pytest.raises(notices.TemplateProblem) as ex:
        notices.render_string("{% if %}", {})
    assert "line 1" in ex.value.message


def test_context_is_plain_data(db, lib, make_book):
    biblio, (item,) = make_book()
    h = circulation.place_hold(db, lib["patron"], biblio, pickup_branch_id=item.branch_id)
    circulation.checkin(db, item, branch_id=item.branch_id)
    ctx = notices.hold_ready_context(h, item)

    def plain(v):
        if isinstance(v, dict):
            return all(isinstance(k, str) and plain(x) for k, x in v.items())
        return isinstance(v, str | int | float | bool | type(None))

    assert plain(ctx) and plain(notices.patron_ctx(lib["patron"]))


# ------------------------------------------------------------------ templates & preferences


def test_hold_ready_uses_template_and_preferences(db, lib, make_book):
    biblio, (item,) = make_book("Dune")
    p = _patron(db, lib, "patron2")
    p.phone = "+91 90000 00000"
    notices.save_template(db, "HOLD_READY", "email", subject="Ready: {{ biblio.title }}",
                          body="Hi {{ patron.first_name }}, collect by {{ hold.pickup_by }} at {{ hold.pickup_branch }}")
    circulation.place_hold(db, p, biblio, pickup_branch_id=item.branch_id)
    circulation.checkin(db, item, branch_id=item.branch_id)
    n = db.query(Notification).filter_by(patron_id=p.id).one()
    assert n.code == "HOLD_READY" and n.subject == "Ready: Dune" and n.channel == "email"
    assert n.body.startswith("Hi Reader2, collect by ") and "Central Library" in n.body and n.to_address == p.email
    # SMS preference → SMS to the phone number, using the SMS template
    notices.set_preferences(db, p, {"HOLD_READY": "sms"})
    out = notices.queue(db, p, "HOLD_READY", notices.hold_ready_context(n_hold := db.query(circulation.Hold).one(), item))
    assert out[0].channel == "sms" and out[0].to_address == p.phone and "Dune" in out[0].body
    assert n_hold.status.value == "ready"
    # Opt out
    notices.set_preferences(db, p, {"HOLD_READY": "none"})
    assert notices.queue(db, p, "HOLD_READY", {}) == []


def test_preference_validation(db, lib):
    p = _patron(db, lib)
    p.phone = None
    with pytest.raises(notices.PolicyBlocked):
        notices.set_preferences(db, p, {"HOLD_READY": "sms"})
    with pytest.raises(notices.PolicyBlocked):
        notices.set_preferences(db, p, {"WELCOME": "none"})  # transactional notices can't be disabled
    with pytest.raises(notices.PolicyBlocked):
        notices.set_preferences(db, p, {"OVERDUE": "pigeon"})


def test_broken_custom_template_falls_back_to_default(db, lib):
    p = _patron(db, lib)
    from librowise.models import NoticeTemplate

    db.add(NoticeTemplate(code="OVERDUE", channel="email", subject="x", body="{{ ''.__class__ }}"))
    db.flush()
    (n,) = notices.queue(db, p, "OVERDUE", {"biblio": {"title": "Emma"}, "loan": {"due_date": "1 Jan", "days_overdue": 3}})
    assert "Emma" in n.body and "3 days overdue" in n.body


def test_disabled_template_sends_nothing(db, lib):
    p = _patron(db, lib)
    notices.save_template(db, "DUE_SOON", "email", subject="s", body="b", is_active=False)
    assert notices.queue(db, p, "DUE_SOON", {}) == []


def test_notify_without_code_is_backwards_compatible(db, lib):
    p = _patron(db, lib)
    circulation.notify(db, p, "Plain subject", "Plain body")
    db.flush()
    n = db.query(Notification).filter_by(patron_id=p.id).one()
    assert (n.subject, n.body, n.status, n.code) == ("Plain subject", "Plain body", "pending", None)


def test_nightly_notices_use_codes(db, lib, make_book):
    _, (a, b) = make_book(copies=2)
    loan = circulation.checkout(db, lib["patron"], a, branch_id=a.branch_id).loan
    loan.due_at = utcnow() + timedelta(days=1)
    late = circulation.checkout(db, lib["patron2"], b, branch_id=b.branch_id).loan
    late.due_at = utcnow() - timedelta(days=7)
    circulation.run_nightly(db)
    codes = {n.code for n in db.query(Notification)}
    assert codes == {"DUE_SOON", "OVERDUE"}
    od = db.query(Notification).filter_by(code="OVERDUE").one()
    assert "7 days overdue" in od.body


# ------------------------------------------------------------------ delivery


class FlakyBackend:
    name = "flaky"

    def __init__(self, fail_times=0, permanent=False):
        self.fail_times, self.permanent, self.sent, self.closed = fail_times, permanent, [], 0

    def send(self, msg):
        if self.fail_times:
            self.fail_times -= 1
            raise notices.DeliveryError("relay down", permanent=self.permanent)
        self.sent.append(msg)

    def close(self):
        self.closed += 1


def _queue_one(db, lib):
    (n,) = notices.queue(db, _patron(db, lib), "WELCOME")
    db.commit()
    return n


def test_outbox_retries_with_backoff_then_fails(db, lib):
    from librowise.services import settings as settings_svc

    settings_svc.set_value(db, "notice_max_attempts", 3)
    n = _queue_one(db, lib)
    flaky = FlakyBackend(fail_times=10)
    t0 = utcnow()
    assert notices.deliver_pending(db, 10, now=t0, backends={"email": flaky}) == {"sent": 0, "retry": 1, "failed": 0}
    assert n.status == "pending" and n.attempts == 1 and n.last_error == "relay down"
    assert n.next_attempt_at == t0 + timedelta(minutes=1)
    # Not due yet → untouched
    assert notices.deliver_pending(db, 10, now=t0 + timedelta(seconds=30), backends={"email": flaky})["retry"] == 0
    assert notices.deliver_pending(db, 10, now=t0 + timedelta(minutes=1), backends={"email": flaky})["retry"] == 1
    assert n.next_attempt_at == t0 + timedelta(minutes=1) + timedelta(minutes=2)
    assert notices.deliver_pending(db, 10, now=t0 + timedelta(hours=1), backends={"email": flaky})["failed"] == 1
    assert n.status == "failed" and n.attempts == 3 and flaky.closed == 4
    # Resend resets it, and a healthy backend delivers it
    notices.resend(db, n.id)
    db.commit()
    ok = FlakyBackend()
    assert notices.deliver_pending(db, 10, now=t0 + timedelta(hours=2), backends={"email": ok})["sent"] == 1
    assert n.status == "sent" and n.sent_at and ok.sent[0].to == n.to_address and ok.sent[0].code == "WELCOME"


def test_permanent_failure_and_success(db, lib):
    n = _queue_one(db, lib)
    assert notices.deliver_pending(db, 10, backends={"email": FlakyBackend(1, permanent=True)})["failed"] == 1
    assert n.status == "failed" and n.attempts == 1
    m = _queue_one(db, lib)
    assert notices.deliver_pending(db, 10, backends={"email": FlakyBackend()}) == {"sent": 1, "retry": 0, "failed": 0}
    assert m.status == "sent"


def test_console_backend_is_default(db, lib, caplog):
    _queue_one(db, lib)
    with caplog.at_level("INFO", logger="librowise.notices"):
        assert notices.deliver_pending(db, 10)["sent"] == 1
    assert "Welcome to" in caplog.text


class FakeSMTP:
    instances: list = []
    refuse = False

    def __init__(self, host, port, timeout=None):
        self.host, self.port, self.timeout = host, port, timeout
        self.calls, self.messages = [], []
        FakeSMTP.instances.append(self)

    def starttls(self, context=None):
        self.calls.append("starttls")

    def login(self, user, password):
        self.calls.append(("login", user, password))

    def send_message(self, msg):
        import smtplib

        if FakeSMTP.refuse:
            raise smtplib.SMTPRecipientsRefused({msg["To"]: (550, b"no such user")})
        self.messages.append(msg)

    def quit(self):
        self.calls.append("quit")


def test_smtp_backend_with_fake_smtplib(db, lib, monkeypatch):
    FakeSMTP.instances, FakeSMTP.refuse = [], False
    monkeypatch.setattr(notices.smtplib, "SMTP", FakeSMTP)
    s = Settings(email_backend="smtp", smtp_host="mail.example.org", smtp_port=2525, smtp_username="relay",
                 smtp_password="s3cret", smtp_from="Library <library@example.org>", smtp_starttls=True)
    a, b = _queue_one(db, lib), _queue_one(db, lib)
    stats = notices.deliver_pending(db, 10, backends=notices.default_backends(s))
    assert stats == {"sent": 2, "retry": 0, "failed": 0}
    (conn,) = FakeSMTP.instances  # one connection reused for the batch
    assert (conn.host, conn.port) == ("mail.example.org", 2525)
    assert conn.calls == ["starttls", ("login", "relay", "s3cret"), "quit"]
    msg = conn.messages[0]
    assert msg["To"] == a.to_address and msg["From"] == "Library <library@example.org>"
    assert msg["Subject"].startswith("Welcome to") and msg["X-Librowise-Notice"] == "WELCOME"
    assert "Reader1" in msg.get_content()
    assert a.status == b.status == "sent"
    # A refused recipient is a permanent failure
    FakeSMTP.refuse = True
    c = _queue_one(db, lib)
    assert notices.deliver_pending(db, 10, backends=notices.default_backends(s))["failed"] == 1
    assert c.status == "failed" and "Recipient refused" in c.last_error


def test_smtp_connection_error_is_retried(db, lib, monkeypatch):
    def boom(*a, **k):
        raise ConnectionRefusedError("connection refused")

    monkeypatch.setattr(notices.smtplib, "SMTP", boom)
    n = _queue_one(db, lib)
    stats = notices.deliver_pending(db, 10, backends=notices.default_backends(Settings(email_backend="smtp")))
    assert stats["retry"] == 1 and n.status == "pending" and "connection refused" in n.last_error


def test_sms_webhook_backend(db, lib, monkeypatch):
    import httpx

    posted = []

    def fake_post(url, json=None, headers=None, timeout=None):
        posted.append((url, json, headers))
        return httpx.Response(202 if len(posted) == 1 else 503)

    monkeypatch.setattr(notices.httpx, "post", fake_post)
    p = _patron(db, lib)
    p.phone = "+919000000001"
    notices.set_preferences(db, p, {"OVERDUE": "sms"})
    (n,) = notices.queue(db, p, "OVERDUE", {"biblio": {"title": "Emma"}, "loan": {"due_date": "1 Jan"}})
    (m,) = notices.queue(db, p, "OVERDUE", {"biblio": {"title": "Persuasion"}, "loan": {"due_date": "2 Jan"}})
    db.commit()
    s = Settings(sms_backend="webhook", sms_webhook_url="https://sms.example.org/send", sms_webhook_token="tok")
    stats = notices.deliver_pending(db, 10, backends=notices.default_backends(s))
    assert stats == {"sent": 1, "retry": 1, "failed": 0}
    url, payload, headers = posted[0]
    assert url == "https://sms.example.org/send" and headers == {"Authorization": "Bearer tok"}
    assert payload["to"] == "+919000000001" and "Emma" in payload["body"] and payload["notice_id"] == n.id
    assert n.status == "sent" and m.status == "pending" and "503" in m.last_error
    # Unconfigured webhook → transient error, never sent
    (o,) = notices.queue(db, p, "OVERDUE", {"biblio": {"title": "X"}, "loan": {}})
    db.commit()
    notices.deliver_pending(db, 10, now=utcnow() + timedelta(hours=1),
                            backends=notices.default_backends(Settings(sms_backend="webhook")))
    assert o.status == "pending" and "not configured" in o.last_error


def test_cli_send_notices(db, lib, capsys):
    from librowise.__main__ import main

    _queue_one(db, lib)
    assert main(["send-notices", "--limit", "5"]) == 0
    assert '"sent": 1' in capsys.readouterr().out


# ------------------------------------------------------------------ API


def test_notices_api_templates_preview_and_permissions(client, staff, admin, lib):
    r = client.get("/api/v1/notices/templates", headers=staff)
    assert r.status_code == 200
    codes = {t["code"] for t in r.json()["results"]}
    assert {"HOLD_READY", "DUE_SOON", "OVERDUE", "WELCOME", "PURCHASE_SUGGESTION_UPDATE",
            "REGISTRATION_APPROVED"} <= codes
    body = {"subject": "Hi {{ patron.first_name }}", "body": "Card {{ patron.card_number }}"}
    assert client.put("/api/v1/notices/templates/WELCOME/email", json=body, headers=staff).status_code == 403
    r = client.put("/api/v1/notices/templates/WELCOME/email", json=body, headers=admin)
    assert r.status_code == 200 and r.json()["customized"]
    bad = client.put("/api/v1/notices/templates/WELCOME/email", headers=admin,
                     json={"subject": "x", "body": "{{ ''.__class__.__mro__ }}"})
    assert bad.status_code == 422 and "sandbox" in bad.json()["detail"]
    assert client.put("/api/v1/notices/templates/NOPE/email", json=body, headers=admin).status_code == 404
    pv = client.post("/api/v1/notices/preview", headers=staff, json={"code": "WELCOME", **body})
    assert pv.status_code == 200 and pv.json() == {"subject": "Hi Ananya", "body": "Card 1000000001"}
    pv = client.post("/api/v1/notices/preview", headers=staff, json={"code": "WELCOME", "patron_card": "reader1", **body})
    assert pv.json()["subject"] == "Hi Reader1"
    r = client.delete("/api/v1/notices/templates/WELCOME/email", headers=admin)
    assert r.status_code == 200 and not r.json()["customized"]
    patron = login(client, "reader1")
    assert client.get("/api/v1/notices/templates", headers=patron).status_code == 403
    assert client.get("/api/v1/notices/outbox", headers=patron).status_code == 403


def test_outbox_api_filters_and_resend(client, staff, admin, lib, db):
    n = _queue_one(db, lib)
    r = client.get("/api/v1/notices/outbox", params={"status": "pending", "patron_card": "reader1"}, headers=staff)
    assert r.status_code == 200 and r.json()["total"] == 1 and r.json()["results"][0]["code"] == "WELCOME"
    assert client.get("/api/v1/notices/outbox", params={"patron_card": "nobody"}, headers=staff).json()["total"] == 0
    assert client.post("/api/v1/notices/outbox/deliver", headers=staff).status_code == 403
    r = client.post("/api/v1/notices/outbox/deliver", headers=admin)
    assert r.status_code == 200 and r.json()["sent"] == 1
    r = client.post(f"/api/v1/notices/outbox/{n.id}/resend", headers=staff)
    assert r.status_code == 200 and r.json()["status"] == "pending" and r.json()["attempts"] == 0
    r = client.get(f"/api/v1/patrons/{lib['patron'].id}/notices", headers=staff)
    assert r.json()["total"] == 1


def test_messaging_preferences_api(client, staff, lib):
    me = login(client, "reader1")
    r = client.get("/api/v1/opac/me/messaging", headers=me)
    prefs = {p["code"]: p["channel"] for p in r.json()["results"]}
    assert prefs["HOLD_READY"] == "email" and "WELCOME" not in prefs
    r = client.put("/api/v1/opac/me/messaging", headers=me, json={"preferences": {"OVERDUE": "none"}})
    assert r.status_code == 200 and {p["code"]: p["channel"] for p in r.json()["results"]}["OVERDUE"] == "none"
    assert client.put("/api/v1/opac/me/messaging", headers=me,
                      json={"preferences": {"OVERDUE": "sms"}}).status_code == 422  # no phone
    pid = lib["patron"].id
    r = client.get(f"/api/v1/patrons/{pid}/messaging", headers=staff)
    assert {p["code"]: p["channel"] for p in r.json()["results"]}["OVERDUE"] == "none"
    r = client.put(f"/api/v1/patrons/{pid}/messaging", headers=staff, json={"preferences": {"OVERDUE": "email"}})
    assert r.status_code == 200


def test_staff_created_patron_gets_welcome(client, staff, lib, db):
    r = client.post("/api/v1/patrons", headers=staff, json={
        "first_name": "New", "last_name": "Member", "email": "new.member@example.org",
        "category_id": lib["cats"]["ADULT"].id, "home_branch_id": lib["branches"]["MAIN"].id})
    assert r.status_code == 201
    n = db.query(Notification).filter_by(patron_id=r.json()["id"]).one()
    assert n.code == "WELCOME" and r.json()["card_number"] in n.body

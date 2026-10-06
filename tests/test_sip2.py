"""SIP2: wire-format unit tests and end-to-end tests over a real TCP socket."""

from __future__ import annotations

import asyncio
import socket
import threading
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from conftest import PASSWORD

from shelfwise.sip2 import protocol as p
from shelfwise.sip2.client import SipClient

SIP_PASSWORD = "Kiosk#Passw0rd!"


# ====================================================================== protocol


def _independent_checksum(data: bytes) -> str:
    total = 0
    for b in data:
        total = (total + b) & 0xFFFF
    return format((0x10000 - total) & 0xFFFF, "04X")


def test_checksum_matches_reference_algorithm():
    for msg in [b"9300CNuser|COpass|AY1AZ", b"99000802.00AY0AZ", b"23001" + b"x" * 300 + b"AY9AZ", b"AZ"]:
        assert p.checksum(msg) == _independent_checksum(msg)
        assert p.checksum_ok(msg, p.checksum(msg))
    assert not p.checksum_ok(b"9300CNuser|AY1AZ", "0000")
    assert not p.checksum_ok(b"x", "zzzz")


def test_format_and_parse_roundtrip_with_error_detection():
    raw = p.format_message("94", ["1"], [], sequence="3", error_detection=True)
    assert raw.endswith(b"\r") and b"AY3AZ" in raw
    msg = p.parse(raw)
    assert msg.code == "94" and msg.fixed == {"ok": "1"} and msg.sequence == "3" and msg.checksum


def test_parse_fixed_and_variable_fields():
    raw = "11YN20260101    120000                  AOLIB|AA123|ABITEM1|ACpw|BON|\r"
    m = p.parse(raw)
    assert m.name == "checkout"
    assert m.fixed["renewal_policy"] == "Y" and m.fixed["no_block"] == "N"
    assert m.fixed["transaction_date"] == "20260101    120000"
    assert m.get("AA") == "123" and m.get("AB") == "ITEM1" and m.get("BO") == "N"
    assert m.get("XX") is None and m.get("XX", "d") == "d"


def test_parse_repeated_fields_and_custom_delimiter():
    raw = "661" + "0002" + "0001" + "20260101    120000" + "AOX^BMa^BMb^BNc^"
    m = p.parse(raw, delimiter="^")
    assert m.get_all("BM") == ["a", "b"] and m.get_all("BN") == ["c"]
    assert m.fixed["renewed_count"] == "0002"


def test_parse_detects_bad_checksum():
    good = p.format_message("93", ["0", "0"], [("CN", "u"), ("CO", "p")], sequence="1")
    tampered = good.replace(b"CNu", b"CNv")
    with pytest.raises(p.ChecksumError):
        p.parse(tampered)
    # ...unless verification is disabled
    assert p.parse(tampered, verify_checksum=False).get("CN") == "v"


def test_parse_checksum_over_non_ascii_bytes():
    raw = p.format_message("24", [" " * 14, "000", " " * 18], [("AE", "Ånanya Ïyer")], sequence="2")
    assert p.parse(raw).get("AE") == "Ånanya Ïyer"


@pytest.mark.parametrize("bad", ["", "X", "ab123", "00", "11YN2026", "9300CNa|C|"])
def test_parse_rejects_malformed(bad):
    with pytest.raises(p.MalformedMessage):
        p.parse(bad)


def test_parse_tolerates_crlf_and_leading_lf():
    m = p.parse(b"\n9900302.00\r\n")
    assert m.code == "99" and m.fixed["protocol_version"] == "2.00"


def test_format_validates_fixed_widths_and_sanitises_values():
    with pytest.raises(ValueError):
        p.format_message("94", ["11"])
    with pytest.raises(ValueError):
        p.format_message("94", [])
    with pytest.raises(ValueError):
        p.format_message("42", [])
    raw = p.format_message("36", ["Y", " " * 18], [("AF", "a|b\rc"), ("AG", None)])
    assert raw == b"36Y" + b" " * 18 + b"AFa b c|\r"


def test_redact_hides_secrets():
    text = "9300CNkiosk|COsecret|CPMAIN|"
    red = p.redact(text)
    assert "secret" not in red and "CO***" in red and "CNkiosk" in red
    assert "pin" not in p.redact("63001" + " " * 28 + "AAcard|ADpin|ACterm|")


def test_dates_and_amounts():
    dt = datetime(2026, 3, 1, 18, 30, 5)
    assert p.sip_datetime(dt) == "20260301   Z183005"
    assert p.parse_sip_datetime(p.sip_datetime(dt)) == dt
    ist = ZoneInfo("Asia/Kolkata")
    local = p.sip_datetime(dt, ist)
    assert local == "20260302    000005"
    assert p.parse_sip_datetime(local, ist) == dt
    assert p.parse_sip_datetime(" " * 18) is None and p.parse_sip_datetime("garbage-garbage-xx") is None
    assert p.amount(1250) == "12.50" and p.amount(5) == "0.05" and p.amount(-300) == "-3.00"
    assert p.parse_amount("12.5") == 1250 and p.parse_amount("3") == 300 and p.parse_amount("x") is None
    assert p.count4(12) == "0012" and p.count4(123456) == "9999"


# ====================================================================== server fixtures


@pytest.fixture()
def sip_account(db, lib):
    from shelfwise.models import SipAccount
    from shelfwise.security import hash_password
    from shelfwise.sip2 import handlers

    handlers.login_limiter.reset()
    acc = SipAccount(login="kiosk", password_hash=hash_password(SIP_PASSWORD), institution_id="SWTEST",
                     branch_id=lib["branches"]["MAIN"].id, name="Test kiosk", allow_holds=True, allow_fee_paid=True,
                     sort_bins={"hold": "2", "transfer": "3", "default": "1"})
    db.add(acc)
    db.commit()
    return acc


class _ServerThread:
    def __init__(self, **cfg):
        from shelfwise.sip2.server import ServerConfig, Sip2Server

        self.loop = asyncio.new_event_loop()
        self.server = Sip2Server(ServerConfig(host="127.0.0.1", port=0, **cfg))
        ready = threading.Event()

        def run():
            asyncio.set_event_loop(self.loop)
            self.loop.run_until_complete(self.server.start())
            ready.set()
            self.loop.run_forever()

        self.thread = threading.Thread(target=run, daemon=True)
        self.thread.start()
        assert ready.wait(10)
        self.port = self.server.port

    def stop(self):
        asyncio.run_coroutine_threadsafe(self.server.stop(), self.loop).result(10)
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(10)
        self.loop.close()


@pytest.fixture()
def sip_server(engine):
    srv = _ServerThread(login_timeout=5)
    yield srv
    srv.stop()


@pytest.fixture()
def sip(sip_server, sip_account):
    c = SipClient("127.0.0.1", sip_server.port, timeout=10)
    assert c.login("kiosk", SIP_PASSWORD, "MAIN")
    yield c
    c.close()


def now18() -> str:
    return p.sip_datetime(datetime.now(UTC).replace(tzinfo=None))


def checkout(c, card, barcode, *, renewal="N", no_block="N", extra=()):
    return c.request("11", [renewal, no_block, now18(), " " * 18],
                     [("AO", "SWTEST"), ("AA", card), ("AB", barcode), ("AC", ""), *extra])


def checkin(c, barcode, location="MAIN"):
    return c.request("09", ["N", now18(), now18()], [("AP", location), ("AO", "SWTEST"), ("AB", barcode), ("AC", "")])


def patron_info(c, card, summary=" " * 10, extra=()):
    return c.request("63", ["001", now18(), summary], [("AO", "SWTEST"), ("AA", card), *extra])


# ====================================================================== integration


def test_login_failure_then_success(sip_server, sip_account, db):
    with SipClient("127.0.0.1", sip_server.port) as c:
        assert not c.login("kiosk", "wrong-password")
        assert not c.login("nobody", "x")
        assert c.login("kiosk", SIP_PASSWORD, "DESK1")
        status = c.sc_status()
    assert status.code == "98" and status.fixed["online_status"] == "Y"
    assert status.fixed["protocol_version"] == "2.00"
    bx = status.get("BX")
    assert len(bx) == 16 and bx[0] == "Y" and bx[11] == "N"  # item status update unsupported
    assert status.get("AO") == "SWTEST" and status.get("AN") == "DESK1"
    from shelfwise.models import AuditLog

    actions = [a.action for a in db.query(AuditLog).all()]
    assert actions.count("sip2_login_failed") == 2 and "sip2_login" in actions
    for a in db.query(AuditLog).all():
        assert SIP_PASSWORD not in str(a.details)


def test_repeated_login_failures_disconnect(sip_server, sip_account):
    with SipClient("127.0.0.1", sip_server.port) as c:
        assert not c.login("kiosk", "bad1")
        assert not c.login("kiosk", "bad2")
        assert not c.login("kiosk", "bad3")
        with pytest.raises((ConnectionError, OSError)):
            c.login("kiosk", SIP_PASSWORD)


def test_requests_before_login_are_refused(sip_server, sip_account, lib):
    with SipClient("127.0.0.1", sip_server.port) as c:
        r = c.request("23", ["001", now18()], [("AO", "X"), ("AA", "reader1")])
        assert r.code == "24" and r.fixed["patron_status"] == "Y" * 14 and "log in" in r.get("AF")
        s = c.sc_status()
        assert s.code == "98" and s.fixed["online_status"] == "N"


def test_inactive_account_and_network_restrictions(sip_server, sip_account, db):
    sip_account.allowed_networks = "10.0.0.0/8"
    db.commit()
    with SipClient("127.0.0.1", sip_server.port) as c:
        assert not c.login("kiosk", SIP_PASSWORD)
    sip_account.allowed_networks = "127.0.0.0/8, ::1/128"
    sip_account.is_active = False
    db.commit()
    with SipClient("127.0.0.1", sip_server.port) as c:
        assert not c.login("kiosk", SIP_PASSWORD)
    sip_account.is_active = True
    db.commit()
    with SipClient("127.0.0.1", sip_server.port) as c:
        assert c.login("kiosk", SIP_PASSWORD)


def test_patron_status_and_password_verification(sip, lib):
    r = sip.request("23", ["001", now18()], [("AO", "SWTEST"), ("AA", "reader1"), ("AD", PASSWORD)])
    assert r.code == "24" and r.fixed["patron_status"] == " " * 14
    assert r.get("BL") == "Y" and r.get("CQ") == "Y" and r.get("AE") == "Reader1 Test"
    assert r.get("BH") == "INR" and r.get("BV") == "0.00"
    r = sip.request("23", ["001", now18()], [("AO", "SWTEST"), ("AA", "reader1"), ("AD", "nope")])
    assert r.get("CQ") == "N" and r.fixed["patron_status"] == "Y" * 14
    r = sip.request("23", ["001", now18()], [("AO", "SWTEST"), ("AA", "no-such-card")])
    assert r.get("BL") == "N" and r.fixed["patron_status"] == "Y" * 14


def test_checkout_checkin_cycle_with_audit_and_item_info(sip, lib, make_book, db):
    from shelfwise.models import AuditLog, Item, ItemStatus, Loan

    b, (item,) = make_book("Self Check Story", material_type="book")
    r = checkout(sip, "reader1", item.barcode)
    assert r.code == "12" and r.fixed["ok"] == "1" and r.fixed["desensitize"] == "Y"
    assert r.get("AJ") == "Self Check Story" and len(r.get("AH")) == 18 and r.get("CK") == "001"
    loan = db.query(Loan).filter(Loan.item_id == item.id, Loan.returned_at.is_(None)).one()
    assert r.get("BK") == str(loan.id)
    entry = db.query(AuditLog).filter(AuditLog.action == "checkout").one()
    assert entry.details["via"] == "sip2" and entry.details["sip_account"] == "kiosk"
    assert entry.details["terminal"] == "MAIN" and entry.ip == "127.0.0.1"

    info = sip.request("17", [now18()], [("AO", "SWTEST"), ("AB", item.barcode)])
    assert info.code == "18" and info.fixed["circulation_status"] == "04" and info.fixed["security_marker"] == "02"
    assert info.get("AH") == r.get("AH") and info.get("CF") == "0" and info.get("AQ") == "MAIN"

    # Second checkout to the same patron without renewal policy is refused...
    again = checkout(sip, "reader1", item.barcode)
    assert again.fixed["ok"] == "0" and again.fixed["desensitize"] == "N" and "renew" in again.get("AF")
    # ...but with renewal policy = Y it renews.
    again = checkout(sip, "reader1", item.barcode, renewal="Y")
    assert again.fixed["ok"] == "1" and again.fixed["renewal_ok"] == "Y"
    db.expire_all()
    assert db.get(Loan, loan.id).renewals == 1

    back = checkin(sip, item.barcode)
    assert back.code == "10" and back.fixed["ok"] == "1" and back.fixed["resensitize"] == "Y"
    assert back.fixed["alert"] == "N" and back.get("AA") == "reader1" and back.get("CL") == "1"
    db.expire_all()
    assert db.get(Item, item.id).status == ItemStatus.available
    # Checking in again: not on loan, still accepted (checked_in_ok defaults to True)
    again = checkin(sip, item.barcode)
    assert again.fixed["ok"] == "1" and "not checked out" in again.get("AF")


def test_checkout_blocked_by_policy_and_unknowns(sip, lib, make_book, db):
    from shelfwise.models import LedgerEntry, LedgerKind

    _, (item,) = make_book("Blocked")
    db.add(LedgerEntry(patron_id=lib["patron"].id, kind=LedgerKind.manual, amount=999999, note="Damage"))
    db.commit()
    r = checkout(sip, "reader1", item.barcode)
    assert r.fixed["ok"] == "0" and "Outstanding charges" in r.get("AF")
    status = sip.request("23", ["001", now18()], [("AO", "SWTEST"), ("AA", "reader1")])
    assert status.fixed["patron_status"][0] == "Y" and status.fixed["patron_status"][10] == "Y"
    assert status.get("BV") == "9999.99"
    # no-block (offline) transactions are accepted regardless of blocks
    r = checkout(sip, "reader1", item.barcode, no_block="Y")
    assert r.fixed["ok"] == "1"
    assert checkout(sip, "ghost", item.barcode).fixed["ok"] == "0"
    assert checkout(sip, "reader2", "NO-SUCH-ITEM").fixed["ok"] == "0"
    unknown = checkin(sip, "NO-SUCH-ITEM")
    assert unknown.fixed["ok"] == "0" and unknown.fixed["alert"] == "Y"
    assert sip.request("17", [now18()], [("AB", "NO-SUCH")]).fixed["circulation_status"] == "01"


def test_checkin_routes_holds_and_transfers(sip, lib, make_book, db):
    from shelfwise.models import Hold, HoldStatus
    from shelfwise.services import circulation

    b, (item,) = make_book("Wanted Book")
    assert checkout(sip, "reader1", item.barcode).fixed["ok"] == "1"
    patron2 = lib["patron2"]
    circulation.place_hold(db, db.merge(patron2), b, pickup_branch_id=lib["branches"]["MAIN"].id)
    db.commit()
    r = checkin(sip, item.barcode)
    assert r.fixed["ok"] == "1" and r.fixed["alert"] == "Y"
    assert r.get("CV") == "01" and r.get("CT") == "MAIN" and r.get("CY") == "reader2" and r.get("CL") == "2"
    assert db.query(Hold).one().status == HoldStatus.ready

    # A copy returned at another branch with no holds must go home (transfer alert 04)
    _, (item2,) = make_book("Traveller")
    assert checkout(sip, "reader1", item2.barcode).fixed["ok"] == "1"
    r = checkin(sip, item2.barcode, location="EAST")
    assert r.fixed["alert"] == "Y" and r.get("CV") == "04" and r.get("CT") == "MAIN" and r.get("CL") == "3"

    # Hold at another pickup branch -> transit alert 02
    b3, (item3,) = make_book("Far Pickup")
    assert checkout(sip, "reader1", item3.barcode).fixed["ok"] == "1"
    circulation.place_hold(db, db.merge(patron2), b3, pickup_branch_id=lib["branches"]["EAST"].id)
    db.commit()
    r = checkin(sip, item3.barcode)
    assert r.get("CV") == "02" and r.get("CT") == "EAST"


def test_patron_information_lists_and_ranges(sip, lib, make_book, db):
    from shelfwise.models import Loan

    barcodes = []
    for i in range(3):
        _, (item,) = make_book(f"Book {i}")
        assert checkout(sip, "reader1", item.barcode).fixed["ok"] == "1"
        barcodes.append(item.barcode)
    loan = db.query(Loan).filter(Loan.item_id == db.query(Loan).first().item_id).one()
    loan.due_at = datetime.now(UTC).replace(tzinfo=None) - timedelta(days=3)
    db.commit()

    r = patron_info(sip, "reader1", "  Y       ")  # charged items
    assert r.code == "64" and r.fixed["charged_items_count"] == "0003" and r.fixed["overdue_items_count"] == "0001"
    assert r.get_all("AU") == barcodes[:3] or sorted(r.get_all("AU")) == sorted(barcodes)
    assert r.get("BL") == "Y" and r.get("AE") == "Reader1 Test" and r.get("BE") == "reader1@example.org"
    assert r.get("CB") == "0010" and r.get("PC") == "ADULT"
    r = patron_info(sip, "reader1", "  Y       ", [("BP", "2"), ("BQ", "2")])
    assert len(r.get_all("AU")) == 1
    r = patron_info(sip, "reader1", " Y        ")
    assert len(r.get_all("AT")) == 1 and not r.get_all("AU")
    # Password supplied and wrong: nothing personal is disclosed.
    r = patron_info(sip, "reader1", "  Y       ", [("AD", "wrong")])
    assert r.get("CQ") == "N" and not r.get_all("AU") and r.get("AE") == "" and r.fixed["charged_items_count"] == "0000"


def test_require_patron_password(sip, sip_account, lib, make_book, db):
    sip_account.require_patron_password = True
    db.commit()
    _, (item,) = make_book("Needs PIN")
    r = checkout(sip, "reader1", item.barcode)
    assert r.fixed["ok"] == "0" and "PIN" in r.get("AF")
    r = checkout(sip, "reader1", item.barcode, extra=[("AD", PASSWORD)])
    assert r.fixed["ok"] == "1"


def test_renew_and_renew_all(sip, lib, make_book, db):
    _, (a,) = make_book("Renew A")
    _, (b,) = make_book("Renew B", itype="REF")  # reference: 0 renewals allowed
    for it in (a, b):
        assert checkout(sip, "reader1", it.barcode).fixed["ok"] == "1"
    r = sip.request("29", ["N", "N", now18(), " " * 18], [("AO", "SWTEST"), ("AA", "reader1"), ("AB", a.barcode)])
    assert r.code == "30" and r.fixed["ok"] == "1" and r.fixed["renewal_ok"] == "Y"
    r = sip.request("29", ["N", "N", now18(), " " * 18], [("AO", "SWTEST"), ("AA", "reader1"), ("AB", b.barcode)])
    assert r.fixed["ok"] == "0" and "Renewal limit" in r.get("AF")
    r = sip.request("29", ["N", "N", now18(), " " * 18], [("AO", "SWTEST"), ("AA", "reader2"), ("AB", a.barcode)])
    assert r.fixed["ok"] == "0"
    r = sip.request("65", [now18()], [("AO", "SWTEST"), ("AA", "reader1")])
    assert r.code == "66" and r.fixed["ok"] == "1"
    assert r.get_all("BM") == [a.barcode] and r.get_all("BN") == [b.barcode]
    assert r.fixed["renewed_count"] == "0001" and r.fixed["unrenewed_count"] == "0001"


def test_block_and_enable_patron(sip, lib, db):
    from shelfwise.models import Patron, SipPatronBlock

    r = sip.request("01", ["Y", now18()], [("AO", "SWTEST"), ("AL", "Card found in book drop"), ("AA", "reader1")])
    assert r.code == "24" and r.fixed["patron_status"][4] == "Y" and r.get("BL") == "N"
    db.expire_all()
    assert db.get(Patron, lib["patron"].id).is_active is False
    assert db.query(SipPatronBlock).one().reason == "Card found in book drop"
    r = sip.request("25", [now18()], [("AO", "SWTEST"), ("AA", "reader1")])
    assert r.code == "26" and r.get("BL") == "Y" and r.fixed["patron_status"] == " " * 14
    db.expire_all()
    assert db.get(Patron, lib["patron"].id).is_active is True
    # Patron enable never re-activates an account suspended by staff
    p2 = db.get(Patron, lib["patron2"].id)
    p2.is_active = False
    db.commit()
    r = sip.request("25", [now18()], [("AO", "SWTEST"), ("AA", "reader2")])
    assert r.get("BL") == "N" and "staff" in r.get("AF")


def test_fee_paid_and_fine_items(sip, lib, db):
    from shelfwise.models import LedgerEntry, LedgerKind
    from shelfwise.services import circulation

    db.add(LedgerEntry(patron_id=lib["patron"].id, kind=LedgerKind.overdue, amount=500, note="Late A"))
    db.add(LedgerEntry(patron_id=lib["patron"].id, kind=LedgerKind.overdue, amount=300, note="Late B"))
    db.commit()
    r = patron_info(sip, "reader1", "   Y      ")
    assert r.fixed["fine_items_count"] == "0002" and r.get("BV") == "8.00"
    assert r.get_all("AV")[0].startswith("5.00 INR Late A")
    fee = lambda amt: sip.request("37", [now18(), "01", "00", "INR"],  # noqa: E731
                                  [("BV", amt), ("AO", "SWTEST"), ("AA", "reader1"), ("BK", "TX-1")])
    assert fee("50.00").fixed["payment_accepted"] == "N"  # more than owed
    assert fee("abc").fixed["payment_accepted"] == "N"
    r = fee("5.00")
    assert r.code == "38" and r.fixed["payment_accepted"] == "Y" and r.get("BK") == "TX-1"
    assert circulation.balance(db, lib["patron"].id) == 300
    r = patron_info(sip, "reader1", "   Y      ")
    assert r.fixed["fine_items_count"] == "0001" and r.get_all("AV")[0].startswith("3.00 INR Late B")


def test_holds_via_sip(sip, lib, make_book, db):
    from shelfwise.models import Hold, HoldStatus

    b, (item,) = make_book("Holdable")
    assert checkout(sip, "reader2", item.barcode).fixed["ok"] == "1"
    r = sip.request("15", ["+", now18()], [("BS", "MAIN"), ("AO", "SWTEST"), ("AA", "reader1"), ("AB", item.barcode)])
    assert r.code == "16" and r.fixed["ok"] == "1" and r.fixed["available"] == "N" and r.get("BR") == "1"
    assert db.query(Hold).one().status == HoldStatus.queued
    r = patron_info(sip, "reader1", "     Y    ")
    assert r.fixed["unavailable_holds_count"] == "0001" and r.get_all("CD") == ["Holdable"]
    info = sip.request("17", [now18()], [("AB", item.barcode)])
    assert info.get("CF") == "1"
    r = sip.request("15", ["-", now18()], [("AO", "SWTEST"), ("AA", "reader1"), ("AJ", str(b.id))])
    assert r.fixed["ok"] == "1"
    db.expire_all()
    assert db.query(Hold).one().status == HoldStatus.cancelled


def test_disabled_services_get_proper_failure_responses(sip, sip_account, lib, make_book, db):
    sip_account.allow_checkout = False
    sip_account.allow_fee_paid = False
    db.commit()
    _, (item,) = make_book("Nope")
    r = checkout(sip, "reader1", item.barcode)
    assert r.code == "12" and r.fixed["ok"] == "0" and "not available" in r.get("AF")
    r = sip.request("19", [now18()], [("AO", "SWTEST"), ("AB", item.barcode), ("CH", "x")])
    assert r.code == "20" and r.fixed["item_properties_ok"] == "0"
    status = sip.sc_status()
    assert status.get("BX")[1] == "N" and status.fixed["checkout_ok"] == "N"


def test_end_session_and_resend(sip, lib):
    r = sip.request("35", [now18()], [("AO", "SWTEST"), ("AA", "reader1")])
    assert r.code == "36" and r.fixed["end_session"] == "Y"
    last = sip.send_raw(b"97\r")
    assert last.startswith(b"36Y")
    last = sip.send_raw(b"97AZFEF5\r")
    assert last.startswith(b"36Y")


def test_error_detection_and_malformed_messages(sip_server, sip_account, db, lib):
    sip_account.error_detection = True
    db.commit()
    with SipClient("127.0.0.1", sip_server.port, error_detection=True) as c:
        assert c.login("kiosk", SIP_PASSWORD)
        r = c.request("23", ["001", now18()], [("AO", "SWTEST"), ("AA", "reader1")])
        assert r.code == "24" and r.sequence is not None and r.checksum is not None
        # A corrupted frame -> 96 (please resend)
        good = p.format_message("23", ["001", now18()], [("AA", "reader1")], sequence="4")
        assert c.send_raw(good.replace(b"reader1", b"reader2")).startswith(b"96")
        # Checksums are mandatory for this account
        assert c.send_raw(p.format_message("23", ["001", now18()], [("AA", "reader1")])).startswith(b"96")
        # Garbage and unknown codes are answered with 96, not a crash
        assert c.send_raw(b"hello\r").startswith(b"96")
        assert c.send_raw(b"42xyz\r").startswith(b"96")
        # ...and the connection still works afterwards
        assert c.request("35", [now18()], [("AA", "reader1")]).code == "36"


def test_too_many_malformed_messages_closes_connection(sip):
    with pytest.raises((ConnectionError, OSError)):
        for _ in range(10):
            sip.send_raw(b"garbage\r")


def test_crlf_and_lf_terminators_and_pipelining(sip_server, sip_account):
    s = socket.create_connection(("127.0.0.1", sip_server.port), timeout=10)
    try:
        s.sendall(b"9300CNkiosk|CO" + SIP_PASSWORD.encode() + b"|\r\n9900302.00\n")
        data = b""
        while data.count(b"\r") < 2:
            data += s.recv(4096)
        first, second, _ = data.split(b"\r", 2)
        assert first == b"941" and second.startswith(b"98Y")
    finally:
        s.close()


def test_idle_timeout_before_login(engine, sip_account):
    srv = _ServerThread(login_timeout=0.3)
    try:
        s = socket.create_connection(("127.0.0.1", srv.port), timeout=5)
        assert s.recv(10) == b""  # server hung up
        s.close()
    finally:
        srv.stop()


def test_oversized_message_closes_connection(sip):
    with pytest.raises((ConnectionError, OSError)):
        sip.send_raw(b"63" + b"x" * 40000)


def test_concurrent_connections(sip_server, sip_account, lib, make_book):
    items = [make_book(f"Parallel {i}")[1][0] for i in range(4)]
    results = []

    def worker(barcode):
        with SipClient("127.0.0.1", sip_server.port) as c:
            assert c.login("kiosk", SIP_PASSWORD)
            results.append(checkout(c, "reader1", barcode).fixed["ok"])

    threads = [threading.Thread(target=worker, args=(i.barcode,)) for i in items]
    for t in threads:
        t.start()
    for t in threads:
        t.join(30)
    assert results == ["1"] * 4

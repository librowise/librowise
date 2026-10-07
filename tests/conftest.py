from __future__ import annotations

import os
from datetime import timedelta

import pytest

os.environ["LIBROWISE_ENVIRONMENT"] = "test"
os.environ["LIBROWISE_SECRET_KEY"] = "test-secret-key-not-for-production"
os.environ["LIBROWISE_METADATA_LOOKUP_ENABLED"] = "false"

from fastapi.testclient import TestClient  # noqa: E402

from librowise import db as dbmod  # noqa: E402
from librowise.config import get_settings  # noqa: E402
from librowise.models import Patron, Role, utcnow  # noqa: E402
from librowise.security import ai_limiter, hash_password, login_limiter  # noqa: E402

PASSWORD = "Test#Passw0rd!"


# Set LIBROWISE_TEST_DATABASE_URL (e.g. postgresql+psycopg://user:pw@localhost:55432/librowise_test)
# to run the whole suite against PostgreSQL. The schema is rebuilt once per session and every
# table is truncated before each test.
TEST_DATABASE_URL = os.environ.get("LIBROWISE_TEST_DATABASE_URL", "")
_schema_ready: set[str] = set()


@pytest.fixture()
def engine(tmp_path):
    get_settings.cache_clear()
    url = TEST_DATABASE_URL or f"sqlite:///{(tmp_path / 'test.db').as_posix()}"
    os.environ["LIBROWISE_DATABASE_URL"] = url
    eng = dbmod.init_engine(url)
    if TEST_DATABASE_URL and url in _schema_ready:
        dbmod.truncate_all()
    else:
        if TEST_DATABASE_URL:
            dbmod.drop_all()
            _schema_ready.add(url)
        dbmod.create_all()
    login_limiter.reset()
    ai_limiter.reset()
    from librowise.ai import semantic

    semantic.index.invalidate()
    yield eng
    eng.dispose()


@pytest.fixture()
def db(engine):
    s = dbmod.SessionLocal()
    yield s
    s.close()


@pytest.fixture()
def lib(db):
    """Library structure (branches, item types, categories, rules) + three users."""
    from librowise.seed import seed_structure

    s = seed_structure(db)
    cats, branches = s["cats"], s["branches"]
    today = utcnow().date()

    def user(card, role=Role.patron, cat="ADULT", **kw):
        p = Patron(card_number=card, email=f"{card}@example.org", first_name=card.title(), last_name="Test",
                   role=role, category_id=cats[cat].id, home_branch_id=branches["MAIN"].id,
                   password_hash=hash_password(PASSWORD), expires_on=today + timedelta(days=365), **kw)
        db.add(p)
        db.flush()
        return p

    s["admin"] = user("admin", Role.admin, "STAFF")
    s["librarian"] = user("librarian", Role.librarian, "STAFF")
    s["patron"] = user("reader1")
    s["patron2"] = user("reader2")
    s["make_user"] = user
    db.commit()
    return s


@pytest.fixture()
def make_book(db, lib):
    from librowise.services import catalog

    def make(title="Test Book", copies=1, itype="BOOK", **fields):
        b = catalog.create_biblio(db, {"title": title, "authors": fields.pop("authors", ["Author, Test"]), **fields})
        items = [catalog.create_item(db, b, {"branch_id": lib["branches"]["MAIN"].id,
                                             "item_type_id": lib["itypes"][itype].id}) for _ in range(copies)]
        db.commit()
        return b, items

    return make


@pytest.fixture()
def client(engine):
    from librowise.app import create_app

    with TestClient(create_app()) as c:
        yield c


def login(client: TestClient, username: str, password: str = PASSWORD) -> dict:
    r = client.post("/api/v1/auth/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


@pytest.fixture()
def staff(client, lib):
    return login(client, "librarian")


@pytest.fixture()
def admin(client, lib):
    return login(client, "admin")

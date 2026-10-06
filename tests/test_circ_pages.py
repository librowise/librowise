"""The circulation-services pages render for the right people."""

from conftest import login


def test_staff_pages_render(client, lib):
    login(client, "librarian")  # cookie session, like a browser
    for path, page in [("/staff/calendar", "staff-calendar"), ("/staff/notices", "staff-notices"),
                       ("/staff/requests", "staff-requests")]:
        r = client.get(path)
        assert r.status_code == 200, path
        assert f'data-page="{page}"' in r.text
        assert 'href="/staff/calendar"' in r.text and 'href="/staff/requests"' in r.text  # in the sidebar
    # Administration stays last in the staff navigation
    from shelfwise.web import STAFF_NAV

    assert STAFF_NAV[-1][0] == "admin"


def test_staff_pages_redirect_patrons_and_anonymous(client, lib):
    r = client.get("/staff/calendar", follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"].startswith("/login")
    login(client, "reader1")
    r = client.get("/staff/notices", follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"] == "/account"


def test_register_page(client, lib, admin):
    client.cookies.clear()  # the admin fixture signed in; visit anonymously (it keeps its bearer token)
    r = client.get("/register")
    assert r.status_code == 200 and 'data-page="opac-register"' in r.text and 'id="register-form"' in r.text
    assert 'href="/register"' in client.get("/login").text
    client.put("/api/v1/admin/settings/allow_self_registration", json={"value": False}, headers=admin)
    r = client.get("/register")
    assert r.status_code == 200 and 'id="register-form"' not in r.text
    login(client, "reader1")
    assert client.get("/register", follow_redirects=False).status_code == 303


def test_account_page_has_suggestions_tab(client, lib):
    login(client, "reader1")
    r = client.get("/account")
    assert r.status_code == 200 and 'data-tab="suggestions"' in r.text

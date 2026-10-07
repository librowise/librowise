"""OPAC discovery: search suggestions, did-you-mean, virtual shelf and citation formatting."""

from __future__ import annotations

from librowise.services import citations, discovery


def test_suggest_titles_authors_subjects(client, make_book):
    make_book("The Great Gatsby", authors=["Fitzgerald, F. Scott"], subjects=["Jazz Age -- Fiction"])
    make_book("Great Expectations", authors=["Dickens, Charles"], subjects=["Orphans -- Fiction"])
    make_book("Dombey and Son", authors=["Dickens, Charles"], subjects=["Families"])
    r = client.get("/api/v1/search/suggest", params={"q": "gre"}).json()
    titles = [s["label"] for s in r["suggestions"] if s["kind"] == "title"]
    assert set(titles) == {"The Great Gatsby", "Great Expectations"}
    assert all(s["href"].startswith("/record/") for s in r["suggestions"] if s["kind"] == "title")
    authors = client.get("/api/v1/search/suggest", params={"q": "dick"}).json()["suggestions"]
    assert {"kind": "author", "label": "Dickens, Charles", "href": "/search?author=Dickens%2C%20Charles"} in authors
    subjects = client.get("/api/v1/search/suggest", params={"q": "orph"}).json()["suggestions"]
    assert any(s["kind"] == "subject" and s["label"] == "Orphans" for s in subjects)
    assert client.get("/api/v1/search/suggest", params={"q": "g"}).json()["suggestions"] == []
    assert client.get("/api/v1/search/suggest", params={"q": "\"* OR NEAR("}).status_code == 200  # FTS syntax is neutralised
    assert client.get("/api/v1/search/suggest", params={"q": "x" * 101}).status_code == 422


def test_did_you_mean(client, db, make_book):
    make_book("Introduction to Psychology", subjects=["Psychology"])
    make_book("Harry Potter and the Philosopher's Stone", authors=["Rowling, J. K."])
    r = client.get("/api/v1/search/did-you-mean", params={"q": "pyschology"}).json()
    assert r["suggestion"] == "psychology" and r["total"] == 1
    assert client.get("/api/v1/search/did-you-mean", params={"q": "harry poter"}).json()["suggestion"] == "harry potter"
    assert client.get("/api/v1/search/did-you-mean", params={"q": "psychology"}).json()["suggestion"] is None
    assert client.get("/api/v1/search/did-you-mean", params={"q": "zzqxv"}).json()["suggestion"] is None
    # the vocabulary follows catalogue changes
    make_book("Quantum Entanglement")
    assert discovery.did_you_mean(db, "entanglment") == "entanglement"


def test_virtual_shelf_neighbours(client, db, make_book):
    books = {}
    for cn, title in [("500.1 AAA", "A"), ("510.2 BBB", "B"), ("520.3 CCC", "C"), ("530.4 DDD", "D"), ("540.5 EEE", "E")]:
        b, (item,) = make_book(title)
        item.call_number = cn
        books[title] = b
    db.commit()
    r = client.get(f"/api/v1/biblios/{books['C'].id}/shelf", params={"n": 2}).json()
    assert r["anchor"] == "520.3 CCC"
    assert [x["title"] for x in r["before"]] == ["A", "B"]
    assert [x["title"] for x in r["after"]] == ["D", "E"]
    assert r["after"][0]["call_number"] == "530.4 DDD" and "availability" in r["after"][0]
    assert client.get("/api/v1/biblios/999999/shelf").status_code == 404


REC = {"id": 7, "title": "Nineteen eighty-four", "subtitle": "a novel", "authors": ["Orwell, George"], "publisher": "Secker & Warburg",
       "pub_year": 1949, "edition": "2nd ed.", "isbn": "9780451524935", "material_type": "book", "language": "en",
       "subjects": ["Dystopias"], "url": "https://lib.example/record/7"}


def test_citation_styles():
    assert citations.apa(REC) == "Orwell, G. (1949). Nineteen eighty-four: a novel (2nd ed.). Secker & Warburg."
    assert citations.apa(REC, html=True) == "Orwell, G. (1949). <i>Nineteen eighty-four: a novel</i> (2nd ed.). Secker &amp; Warburg."
    assert citations.mla(REC) == "Orwell, George. Nineteen Eighty-four: A Novel. 2nd ed., Secker & Warburg, 1949."
    assert citations.chicago(REC) == "Orwell, George. Nineteen Eighty-four: A Novel. 2nd ed. Secker & Warburg, 1949."
    two = {**REC, "authors": ["Kernighan, Brian W.", "Ritchie, Dennis M."], "edition": None, "subtitle": None}
    assert citations.apa(two).startswith("Kernighan, B. W., & Ritchie, D. M. (1949).")
    assert citations.mla(two).startswith("Kernighan, Brian W., and Dennis M. Ritchie.")
    assert citations.chicago(two).startswith("Kernighan, Brian W. and Dennis M. Ritchie.")
    many = {**REC, "authors": ["A, B", "C, D", "E, F"]}
    assert citations.mla(many).startswith("A, B, et al.")
    assert citations.apa(many).startswith("A, B., C, D., & E, F.")
    none = {**REC, "authors": [], "pub_year": None}
    assert citations.apa(none).startswith("Nineteen eighty-four: a novel (2nd ed.). (n.d.).")


def test_bibtex_and_ris():
    bib = citations.bibtex(REC)
    assert bib.startswith("@book{orwell1949nineteen,")
    assert "author = {Orwell, George}" in bib and "publisher = {Secker \\& Warburg}" in bib and "year = {1949}" in bib
    ris = citations.ris(REC)
    lines = ris.split("\r\n")
    assert lines[0] == "TY  - BOOK" and "AU  - Orwell, George" in lines and "PY  - 1949" in lines
    assert lines[-2] == "ER  - " and ris.endswith("\r\n")
    assert citations.parse_name("Tagore, Rabindranath, 1861-1941").given == "Rabindranath"
    assert citations.parse_name("Arundhati Roy").last == "Roy"


def test_cite_endpoint_and_downloads(client, make_book):
    b, _ = make_book("Godaan", authors=["Premchand, Munshi"], pub_year=1936, publisher="Saraswati Press")
    r = client.get(f"/api/v1/biblios/{b.id}/cite").json()
    assert [c["style"] for c in r["citations"]] == ["apa", "mla", "chicago", "bibtex", "ris"]
    assert r["citations"][0]["text"] == "Premchand, M. (1936). Godaan. Saraswati Press."
    ris = client.get(f"/api/v1/biblios/{b.id}/cite", params={"style": "ris", "download": "true"})
    assert ris.headers["content-type"].startswith("application/x-research-info-systems")
    assert 'filename="premchand1936godaan.ris"' in ris.headers["content-disposition"]
    assert f"UR  - http://testserver/record/{b.id}" in ris.text
    bib = client.get(f"/api/v1/biblios/{b.id}/cite", params={"style": "bibtex", "download": "true"})
    assert bib.headers["content-type"].startswith("application/x-bibtex") and bib.text.startswith("@book{")
    assert client.get(f"/api/v1/biblios/{b.id}/cite", params={"style": "harvard"}).status_code == 422

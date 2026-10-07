"""A compact MARC21 bibliographic field dictionary used for editor hints and validation warnings.

Each entry: tag -> (label, repeatable, help, {subfield: label}, (ind1 hint, ind2 hint)).
Covers the ~80 tags cataloguers touch daily; anything else is still editable, just unlabelled.
"""

from __future__ import annotations

_NAME_SUBS = {"a": "Name", "b": "Numeration", "c": "Titles and words", "d": "Dates", "e": "Relator term",
              "q": "Fuller form of name", "t": "Title of a work", "0": "Authority record number", "4": "Relator code"}
_CORP_SUBS = {"a": "Corporate name", "b": "Subordinate unit", "c": "Location of meeting", "d": "Date",
              "e": "Relator term", "n": "Number of part", "t": "Title of a work", "0": "Authority record number",
              "4": "Relator code"}
_MEET_SUBS = {"a": "Meeting name", "c": "Location", "d": "Date", "e": "Subordinate unit", "j": "Relator term",
              "n": "Number", "q": "Name following jurisdiction", "0": "Authority record number"}
_SUBJ_SUBS = {"a": "Topical term", "v": "Form subdivision", "x": "General subdivision",
              "y": "Chronological subdivision", "z": "Geographic subdivision", "2": "Source of heading",
              "0": "Authority record number"}
_SUBJ_IND2 = "Thesaurus: 0 LCSH, 1 LC children's, 2 MeSH, 4 source not specified, 7 source in $2"
_LINK_SUBS = {"a": "Main entry heading", "t": "Title", "d": "Place, publisher, date", "g": "Related parts",
              "w": "Record control number", "x": "ISSN", "z": "ISBN", "i": "Relationship information"}

FIELDS: dict[str, tuple[str, bool, str, dict[str, str], tuple[str, str]]] = {
    "LDR": ("Leader", False, "24 positions: 05 record status, 06 type of record, 07 bibliographic level, "
            "09 character coding (a = Unicode), 17 encoding level, 18 cataloguing form.", {}, ("", "")),
    "001": ("Control number", False, "The record's control number assigned by the cataloguing agency.", {}, ("", "")),
    "003": ("Control number identifier", False, "MARC code of the agency whose control number is in 001.", {}, ("", "")),
    "005": ("Date and time of latest transaction", False, "yyyymmddhhmmss.f — updated automatically on save.", {}, ("", "")),
    "006": ("Fixed-length data elements — additional material characteristics", True, "18 positions.", {}, ("", "")),
    "007": ("Physical description fixed field", True, "Coded physical characteristics (e.g. 'ta' for text).", {}, ("", "")),
    "008": ("Fixed-length data elements", False, "40 positions: 00-05 date entered, 06 date type, 07-10 date 1, "
            "15-17 place, 35-37 language.", {}, ("", "")),
    "010": ("Library of Congress control number", False, "LCCN.", {"a": "LC control number", "z": "Cancelled LCCN"}, ("", "")),
    "015": ("National bibliography number", True, "", {"a": "National bibliography number", "2": "Source"}, ("", "")),
    "016": ("National bibliographic agency control number", True, "", {"a": "Record control number", "2": "Source"}, ("", "")),
    "020": ("ISBN", True, "One ISBN per field; qualify in $q (e.g. hardcover).",
            {"a": "ISBN", "c": "Terms of availability", "q": "Qualifying information", "z": "Cancelled/invalid ISBN"}, ("", "")),
    "022": ("ISSN", True, "", {"a": "ISSN", "l": "ISSN-L", "y": "Incorrect ISSN", "z": "Cancelled ISSN"}, ("Level of international interest", "")),
    "024": ("Other standard identifier", True, "UPC, EAN, ISMN, DOI…", {"a": "Standard number", "2": "Source"}, ("Type of number", "Difference indicator")),
    "028": ("Publisher or distributor number", True, "", {"a": "Number", "b": "Source"}, ("Type of number", "Note/added entry")),
    "035": ("System control number", True, "e.g. (OCoLC)12345.", {"a": "System control number", "z": "Cancelled number"}, ("", "")),
    "040": ("Cataloguing source", False, "", {"a": "Original cataloguing agency", "b": "Language of cataloguing",
                                              "c": "Transcribing agency", "d": "Modifying agency", "e": "Description conventions"}, ("", "")),
    "041": ("Language code", True, "MARC language codes, repeat $a for each language.",
            {"a": "Language of text", "h": "Original language", "b": "Language of summary"}, ("Translation indication", "Source of code")),
    "043": ("Geographic area code", False, "", {"a": "Geographic area code"}, ("", "")),
    "050": ("Library of Congress call number", True, "", {"a": "Classification number", "b": "Item number"}, ("Existence in LC collection", "Source of call number")),
    "060": ("National Library of Medicine call number", True, "", {"a": "Classification number", "b": "Item number"}, ("", "")),
    "080": ("Universal Decimal Classification number", True, "", {"a": "UDC number", "2": "Edition"}, ("", "")),
    "082": ("Dewey Decimal Classification number", True, "Shelfwise uses the first 082 $a as the record's classification.",
            {"a": "Classification number", "b": "Item number", "2": "Edition number"}, ("Type of edition: 0 full, 1 abridged", "Source: 0 LC, 4 other")),
    "084": ("Other classification number", True, "", {"a": "Classification number", "2": "Source"}, ("", "")),
    "090": ("Local call number", True, "", {"a": "Classification", "b": "Item number"}, ("", "")),
    "100": ("Main entry — personal name", False, "Primary author. Linked to personal name authorities.", _NAME_SUBS,
            ("Type of name: 0 forename, 1 surname, 3 family", "")),
    "110": ("Main entry — corporate name", False, "", _CORP_SUBS, ("Type: 0 inverted, 1 jurisdiction, 2 direct order", "")),
    "111": ("Main entry — meeting name", False, "", _MEET_SUBS, ("Type: 0 inverted, 1 jurisdiction, 2 direct order", "")),
    "130": ("Main entry — uniform title", False, "", {"a": "Uniform title", "l": "Language", "f": "Date", "0": "Authority record number"}, ("Nonfiling characters", "")),
    "210": ("Abbreviated title", True, "", {"a": "Abbreviated title"}, ("", "")),
    "222": ("Key title", True, "", {"a": "Key title"}, ("", "Nonfiling characters")),
    "240": ("Uniform title", False, "", {"a": "Uniform title", "l": "Language of a work", "f": "Date of a work"}, ("Printed or displayed", "Nonfiling characters")),
    "245": ("Title statement", False, "Required. $a is the title proper; ind2 = number of nonfiling characters (e.g. 4 for 'The ').",
            {"a": "Title", "b": "Remainder of title", "c": "Statement of responsibility", "h": "Medium", "n": "Number of part",
             "p": "Name of part"}, ("Title added entry: 0 no, 1 yes", "Nonfiling characters 0-9")),
    "246": ("Varying form of title", True, "", {"a": "Title proper", "b": "Remainder of title", "i": "Display text"}, ("Note/added entry", "Type of title")),
    "250": ("Edition statement", True, "", {"a": "Edition statement", "b": "Remainder of edition statement"}, ("", "")),
    "255": ("Cartographic mathematical data", True, "", {"a": "Statement of scale", "b": "Projection", "c": "Coordinates"}, ("", "")),
    "260": ("Publication, distribution, etc. (imprint)", True, "Pre-RDA imprint; prefer 264 for new records.",
            {"a": "Place", "b": "Publisher", "c": "Date"}, ("Sequence", "")),
    "263": ("Projected publication date", False, "", {"a": "Projected publication date"}, ("", "")),
    "264": ("Production, publication, distribution, manufacture and copyright", True, "ind2 1 = publication, 4 = copyright date.",
            {"a": "Place", "b": "Name of producer/publisher", "c": "Date"}, ("Sequence", "Function: 0 production, 1 publication, 2 distribution, 3 manufacture, 4 copyright")),
    "300": ("Physical description", True, "e.g. $a 320 pages : $b illustrations ; $c 24 cm.",
            {"a": "Extent", "b": "Other physical details", "c": "Dimensions", "e": "Accompanying material"}, ("", "")),
    "310": ("Current publication frequency", False, "", {"a": "Frequency", "b": "Date"}, ("", "")),
    "336": ("Content type", True, "RDA content type, e.g. text / txt / rdacontent.", {"a": "Term", "b": "Code", "2": "Source"}, ("", "")),
    "337": ("Media type", True, "RDA media type, e.g. unmediated / n / rdamedia.", {"a": "Term", "b": "Code", "2": "Source"}, ("", "")),
    "338": ("Carrier type", True, "RDA carrier type, e.g. volume / nc / rdacarrier.", {"a": "Term", "b": "Code", "2": "Source"}, ("", "")),
    "340": ("Physical medium", True, "", {"a": "Material base", "b": "Dimensions"}, ("", "")),
    "344": ("Sound characteristics", True, "", {"a": "Type of recording", "b": "Recording medium"}, ("", "")),
    "347": ("Digital file characteristics", True, "", {"a": "File type", "b": "Encoding format"}, ("", "")),
    "362": ("Dates of publication and/or sequential designation", True, "", {"a": "Dates/sequential designation"}, ("Format of date", "")),
    "490": ("Series statement", True, "Shelfwise uses the first 490 $a (or 830 $a) as the series.",
            {"a": "Series statement", "v": "Volume/sequential designation", "x": "ISSN"}, ("Series tracing: 0 untraced, 1 traced", "")),
    "500": ("General note", True, "", {"a": "General note"}, ("", "")),
    "501": ("With note", True, "", {"a": "With note"}, ("", "")),
    "502": ("Dissertation note", True, "", {"a": "Dissertation note", "b": "Degree", "c": "Institution", "d": "Year"}, ("", "")),
    "504": ("Bibliography, etc. note", True, "", {"a": "Bibliography note"}, ("", "")),
    "505": ("Formatted contents note", True, "", {"a": "Formatted contents note", "t": "Title", "r": "Statement of responsibility"}, ("Display constant", "Level of content designation")),
    "506": ("Restrictions on access note", True, "", {"a": "Terms governing access"}, ("Restriction", "")),
    "508": ("Creation/production credits note", True, "", {"a": "Credits note"}, ("", "")),
    "510": ("Citation/references note", True, "", {"a": "Name of source", "c": "Location within source"}, ("Coverage", "")),
    "511": ("Participant or performer note", True, "", {"a": "Participant or performer note"}, ("Display constant", "")),
    "515": ("Numbering peculiarities note", True, "", {"a": "Numbering peculiarities note"}, ("", "")),
    "518": ("Date/time and place of an event note", True, "", {"a": "Date/time and place of an event note"}, ("", "")),
    "520": ("Summary, etc.", True, "Shelfwise uses the first 520 $a as the record description.",
            {"a": "Summary", "b": "Expansion of summary", "u": "URI"}, ("Display constant: blank summary, 1 review, 2 scope", "")),
    "521": ("Target audience note", True, "", {"a": "Target audience note", "b": "Source"}, ("Display constant", "")),
    "530": ("Additional physical form available note", True, "", {"a": "Additional physical form available note"}, ("", "")),
    "533": ("Reproduction note", True, "", {"a": "Type of reproduction", "b": "Place", "c": "Agency", "d": "Date"}, ("", "")),
    "538": ("System details note", True, "", {"a": "System details note"}, ("", "")),
    "540": ("Terms governing use and reproduction note", True, "", {"a": "Terms governing use and reproduction"}, ("", "")),
    "541": ("Immediate source of acquisition note", True, "", {"a": "Source of acquisition", "c": "Method", "d": "Date"}, ("Privacy", "")),
    "546": ("Language note", True, "", {"a": "Language note", "b": "Information code or alphabet"}, ("", "")),
    "550": ("Issuing body note", True, "", {"a": "Issuing body note"}, ("", "")),
    "561": ("Ownership and custodial history", True, "", {"a": "History"}, ("Privacy", "")),
    "580": ("Linking entry complexity note", True, "", {"a": "Linking entry complexity note"}, ("", "")),
    "583": ("Action note", True, "", {"a": "Action", "c": "Time/date of action", "k": "Action agent"}, ("Privacy", "")),
    "586": ("Awards note", True, "", {"a": "Awards note"}, ("Display constant", "")),
    "588": ("Source of description note", True, "", {"a": "Source of description note"}, ("Display constant", "")),
    "590": ("Local note", True, "Local, library-specific note.", {"a": "Local note"}, ("", "")),
    "600": ("Subject added entry — personal name", True, "Linked to name authorities used as subjects.",
            {**_NAME_SUBS, **{k: v for k, v in _SUBJ_SUBS.items() if k in "vxyz2"}}, ("Type of name", _SUBJ_IND2)),
    "610": ("Subject added entry — corporate name", True, "", {**_CORP_SUBS, **{k: v for k, v in _SUBJ_SUBS.items() if k in "vxyz2"}}, ("Type of name", _SUBJ_IND2)),
    "611": ("Subject added entry — meeting name", True, "", {**_MEET_SUBS, **{k: v for k, v in _SUBJ_SUBS.items() if k in "vxyz2"}}, ("Type of name", _SUBJ_IND2)),
    "630": ("Subject added entry — uniform title", True, "", {"a": "Uniform title", **{k: v for k, v in _SUBJ_SUBS.items() if k in "vxyz2"}}, ("Nonfiling characters", _SUBJ_IND2)),
    "648": ("Subject added entry — chronological term", True, "", {"a": "Chronological term", **{k: v for k, v in _SUBJ_SUBS.items() if k in "vxyz2"}}, ("", _SUBJ_IND2)),
    "650": ("Subject added entry — topical term", True, "Subdivisions ($v $x $y $z) are joined with ' -- '. Linked to topical authorities.",
            _SUBJ_SUBS, ("Level of subject", _SUBJ_IND2)),
    "651": ("Subject added entry — geographic name", True, "", {**_SUBJ_SUBS, "a": "Geographic name"}, ("", _SUBJ_IND2)),
    "653": ("Index term — uncontrolled", True, "Keywords not from a controlled vocabulary.", {"a": "Uncontrolled term"}, ("Level of index term", "Type of term")),
    "655": ("Index term — genre/form", True, "", {**_SUBJ_SUBS, "a": "Genre/form data"}, ("Type of heading", _SUBJ_IND2)),
    "656": ("Index term — occupation", True, "", {"a": "Occupation", "2": "Source"}, ("", "")),
    "700": ("Added entry — personal name", True, "Co-authors, editors, translators… Linked to name authorities.", _NAME_SUBS,
            ("Type of name: 0 forename, 1 surname, 3 family", "Type of added entry: blank, 2 analytical")),
    "710": ("Added entry — corporate name", True, "", _CORP_SUBS, ("Type of corporate name", "Type of added entry")),
    "711": ("Added entry — meeting name", True, "", _MEET_SUBS, ("Type of meeting name", "Type of added entry")),
    "720": ("Added entry — uncontrolled name", True, "", {"a": "Name", "e": "Relator term"}, ("Type of name", "")),
    "730": ("Added entry — uniform title", True, "", {"a": "Uniform title", "l": "Language"}, ("Nonfiling characters", "Type of added entry")),
    "740": ("Added entry — uncontrolled related/analytical title", True, "", {"a": "Title", "n": "Number of part", "p": "Name of part"}, ("Nonfiling characters", "Type of added entry")),
    "751": ("Added entry — geographic name", True, "", {"a": "Geographic name", "e": "Relator term"}, ("", "")),
    "760": ("Main series entry", True, "", _LINK_SUBS, ("Note controller", "Display constant")),
    "765": ("Original language entry", True, "", _LINK_SUBS, ("Note controller", "Display constant")),
    "773": ("Host item entry", True, "Links a component part to its host record.", _LINK_SUBS, ("Note controller", "Display constant")),
    "775": ("Other edition entry", True, "", _LINK_SUBS, ("Note controller", "Display constant")),
    "776": ("Additional physical form entry", True, "", _LINK_SUBS, ("Note controller", "Display constant")),
    "780": ("Preceding entry", True, "", _LINK_SUBS, ("Note controller", "Type of relationship")),
    "785": ("Succeeding entry", True, "", _LINK_SUBS, ("Note controller", "Type of relationship")),
    "787": ("Other relationship entry", True, "", _LINK_SUBS, ("Note controller", "Display constant")),
    "800": ("Series added entry — personal name", True, "", {**_NAME_SUBS, "v": "Volume"}, ("Type of name", "")),
    "810": ("Series added entry — corporate name", True, "", {**_CORP_SUBS, "v": "Volume"}, ("Type of name", "")),
    "811": ("Series added entry — meeting name", True, "", {**_MEET_SUBS, "v": "Volume"}, ("Type of name", "")),
    "830": ("Series added entry — uniform title", True, "Controlled form of the series; linked to uniform title authorities.",
            {"a": "Uniform title", "v": "Volume/sequential designation", "x": "ISSN", "0": "Authority record number"}, ("", "Nonfiling characters")),
    "850": ("Holding institution", True, "", {"a": "Holding institution"}, ("", "")),
    "852": ("Location", True, "", {"a": "Location", "b": "Sublocation", "h": "Classification part", "i": "Item part"}, ("Shelving scheme", "Shelving order")),
    "856": ("Electronic location and access", True, "URL of an online resource or related resource (ind2 0 resource, 1 version, 2 related).",
            {"u": "URI", "y": "Link text", "z": "Public note", "3": "Materials specified"}, ("Access method: 4 HTTP", "Relationship")),
    "880": ("Alternate graphic representation", True, "Vernacular script version of another field ($6 links them).", {"6": "Linkage"}, ("", "")),
    "942": ("Added entry elements (Koha)", False, "Koha local field: $c default item type.", {"c": "Koha item type", "n": "Suppress in OPAC"}, ("", "")),
    "952": ("Holdings (Koha items)", True, "Items are managed on the record page in Shelfwise; 952 fields are not stored with the record.",
            {"a": "Home branch", "b": "Current branch", "o": "Call number", "p": "Barcode", "y": "Item type", "g": "Price"}, ("", "")),
}


def as_json() -> dict:
    return {tag: {"label": label, "repeatable": rep, "help": help_, "subfields": subs,
                  "ind1": ind[0], "ind2": ind[1], "control": tag == "LDR" or tag < "010"}
            for tag, (label, rep, help_, subs, ind) in FIELDS.items()}


def label(tag: str) -> str | None:
    entry = FIELDS.get(tag)
    return entry[0] if entry else None


def repeatable(tag: str) -> bool:
    entry = FIELDS.get(tag)
    return True if entry is None else entry[1]

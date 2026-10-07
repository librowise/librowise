"""Authority control API (staff) and the public heading browse index (OPAC)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import Response
from pydantic import Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..ai import semantic
from ..db import get_db
from ..deps import client_ip, require
from ..models import Authority, AuthorityType, Patron
from ..schemas import StrictModel
from ..services import audit, catalog
from ..services import authorities as svc

router = APIRouter(tags=["authorities"])

_TYPE_PATTERN = "^(" + "|".join(t.value for t in AuthorityType) + ")$"
_REL_PATTERN = "^(" + "|".join(svc.RELATIONSHIPS) + ")$"


class SeeAlsoIn(StrictModel):
    heading: str = Field(min_length=1, max_length=500)
    relationship: str = Field(default="related", pattern=_REL_PATTERN)


class AuthorityIn(StrictModel):
    auth_type: str = Field(pattern=_TYPE_PATTERN)
    heading: str = Field(min_length=1, max_length=500)
    variants: list[str] = Field(default_factory=list, max_length=200)
    see_also: list[SeeAlsoIn] = Field(default_factory=list, max_length=100)
    source: str = Field(default="local", max_length=32)
    notes: str | None = Field(default=None, max_length=10000)


class AuthorityPatch(StrictModel):
    auth_type: str | None = Field(default=None, pattern=_TYPE_PATTERN)
    heading: str | None = Field(default=None, min_length=1, max_length=500)
    keep_variant: bool = True
    variants: list[str] | None = Field(default=None, max_length=200)
    see_also: list[SeeAlsoIn] | None = Field(default=None, max_length=100)
    source: str | None = Field(default=None, max_length=32)
    notes: str | None = Field(default=None, max_length=10000)


class RenameIn(StrictModel):
    heading: str = Field(min_length=1, max_length=500)
    keep_variant: bool = True


class MergeIn(StrictModel):
    source_id: int
    target_id: int
    dry_run: bool = True


class GenerateIn(StrictModel):
    roles: list[str] = Field(default_factory=lambda: ["author", "subject", "series"], max_length=3)
    min_count: int = Field(default=1, ge=1, le=10000)
    dry_run: bool = True


def _changed_catalogue() -> None:
    semantic.index.invalidate()


# ------------------------------------------------------------------ staff: list & reports


@router.get("/authorities")
def list_authorities(q: str | None = Query(default=None, max_length=200), type: str | None = Query(default=None, pattern=_TYPE_PATTERN),
                     group: str | None = Query(default=None, pattern="^(authors|subjects|titles)$"),
                     used: str | None = Query(default=None, pattern="^(used|unused)$"),
                     sort: str = Query(default="heading", pattern="^(heading|usage|updated|created)$"),
                     page: int = Query(default=1, ge=1, le=100000), per_page: int = Query(default=25, ge=1, le=200),
                     db: Session = Depends(get_db), _: Patron = Depends(require("catalog:read"))):
    """Search authorities by heading or variant, with record usage counts."""
    return svc.search(db, q, auth_type=type, group=group, used=used, sort=sort, page=page, per_page=per_page)


@router.get("/authorities/types")
def authority_types(_: Patron = Depends(require("catalog:read"))):
    return {"types": [{"value": t.value, "label": svc.TYPE_LABELS[t.value], "roles": list(svc.roles_for_type(t)),
                       "marc_tag": svc.TYPE_TAGS[t]} for t in AuthorityType],
            "relationships": list(svc.RELATIONSHIPS)}


@router.get("/authorities/unlinked")
def unlinked(role: str | None = Query(default=None, pattern="^(author|subject|series)$"),
             q: str | None = Query(default=None, max_length=200), limit: int = Query(default=200, ge=1, le=2000),
             db: Session = Depends(get_db), _: Patron = Depends(require("catalog:read"))):
    """Headings used in records that are not controlled by any authority (most frequent first)."""
    return svc.unlinked_headings(db, role=role, q=q, limit=limit)


@router.get("/authorities/export")
def export(fmt: str = Query(default="xml", pattern="^(xml|mrc)$"), ids: str | None = None,
           type: str | None = Query(default=None, pattern=_TYPE_PATTERN),
           db: Session = Depends(get_db), _: Patron = Depends(require("catalog:read"))):
    """Export authorities as MARC21 authority records (MARCXML or ISO 2709)."""
    stmt = select(Authority).where(Authority.deleted_at.is_(None)).order_by(Authority.normalized)
    if ids:
        stmt = stmt.where(Authority.id.in_([int(x) for x in ids.split(",") if x.strip().isdigit()][:10000]))
    if type:
        stmt = stmt.where(Authority.auth_type == AuthorityType(type))
    payload = svc.export(db.scalars(stmt.limit(100000)), fmt)
    media = "application/marcxml+xml" if fmt == "xml" else "application/marc"
    return Response(payload, media_type=media,
                    headers={"Content-Disposition": f'attachment; filename="shelfwise-authorities.{fmt}"'})


# ------------------------------------------------------------------ staff: mutations


@router.post("/authorities", status_code=201)
def create(body: AuthorityIn, request: Request, db: Session = Depends(get_db),
           user: Patron = Depends(require("authorities:write"))):
    data = body.model_dump()
    a = svc.create_authority(db, data)
    stats = svc.relink_for(db, [a])
    audit.record(db, "create", "authority", a.id, actor=user, ip=client_ip(request), heading=a.heading,
                 linked=stats["records"])
    db.commit()
    if stats["rewritten"]:
        _changed_catalogue()
    return {**svc.authority_out(a, svc.usage_counts(db, [a.id]).get(a.id, 0), full=True, db=db), "relink": stats}


@router.post("/authorities/merge")
def merge(body: MergeIn, request: Request, db: Session = Depends(get_db),
          user: Patron = Depends(require("authorities:write"))):
    """Preview (``dry_run``) or perform a merge of ``source`` into ``target``."""
    source, target = svc.get_authority(db, body.source_id), svc.get_authority(db, body.target_id)
    result = svc.merge(db, source, target, dry_run=body.dry_run)
    if body.dry_run:
        db.rollback()
        return result
    audit.record(db, "merge", "authority", target.id, actor=user, ip=client_ip(request), source_id=source.id,
                 source=result["source"]["heading"], target=target.heading, records=result["records"])
    db.commit()
    _changed_catalogue()
    return result


@router.post("/authorities/generate")
def generate(body: GenerateIn, request: Request, db: Session = Depends(get_db),
             user: Patron = Depends(require("authorities:write"))):
    """Create local authorities from headings already used in the catalogue (preview with ``dry_run``)."""
    bad = [r for r in body.roles if r not in svc.ROLE_TYPES]
    if bad:
        raise HTTPException(422, f"Unknown role(s): {', '.join(bad)}")
    result = svc.generate_from_catalogue(db, roles=body.roles, min_count=body.min_count, dry_run=body.dry_run)
    if body.dry_run:
        db.rollback()
        return result
    audit.record(db, "generate", "authority", None, actor=user, ip=client_ip(request), created=result["created"])
    db.commit()
    _changed_catalogue()
    return result


@router.post("/authorities/import")
async def import_authorities(request: Request, file: UploadFile = File(...), db: Session = Depends(get_db),
                             user: Patron = Depends(require("authorities:write"))):
    """Import MARC21 authority records (ISO 2709 or MARCXML): 1XX headings with 4XX/5XX references."""
    data = await file.read()
    if len(data) > 50 * 1024 * 1024:
        raise HTTPException(413, "File too large (50 MB max)")
    stats = svc.import_marc(db, data)
    audit.record(db, "marc_import", "authority", None, actor=user, ip=client_ip(request), filename=file.filename,
                 created=stats["created"], updated=stats["updated"])
    db.commit()
    _changed_catalogue()
    return stats


@router.post("/authorities/relink")
def relink(request: Request, db: Session = Depends(get_db), user: Patron = Depends(require("authorities:write"))):
    """Re-derive every record/authority link and rewrite variant headings to authorised forms."""
    stats = svc.relink_all(db)
    audit.record(db, "relink", "authority", None, actor=user, ip=client_ip(request), **stats)
    db.commit()
    _changed_catalogue()
    return stats


@router.get("/authorities/{authority_id}")
def get_one(authority_id: int, db: Session = Depends(get_db), _: Patron = Depends(require("catalog:read"))):
    a = svc.get_authority(db, authority_id)
    out = svc.authority_out(a, svc.usage_counts(db, [a.id]).get(a.id, 0), full=True, db=db)
    out["records"] = svc.linked_records(db, a)
    return out


@router.patch("/authorities/{authority_id}")
def update(authority_id: int, body: AuthorityPatch, request: Request, db: Session = Depends(get_db),
           user: Patron = Depends(require("authorities:write"))):
    a = svc.get_authority(db, authority_id)
    data = body.model_dump(exclude_unset=True)
    if "see_also" in data and data["see_also"] is not None:
        data["see_also"] = [dict(r) for r in data["see_also"]]
    result = svc.update_authority(db, a, data)
    audit.record(db, "update", "authority", a.id, actor=user, ip=client_ip(request), fields=sorted(data),
                 renamed=bool(result["renamed"]))
    db.commit()
    if result["renamed"] or result["relink"]["rewritten"]:
        _changed_catalogue()
    out = svc.authority_out(a, svc.usage_counts(db, [a.id]).get(a.id, 0), full=True, db=db)
    return {**out, "renamed": result["renamed"], "relink": result["relink"]}


@router.post("/authorities/{authority_id}/rename")
def rename(authority_id: int, body: RenameIn, request: Request, db: Session = Depends(get_db),
           user: Patron = Depends(require("authorities:write"))):
    """Change the authorised heading; linked records are rewritten and re-indexed."""
    a = svc.get_authority(db, authority_id)
    result = svc.rename(db, a, body.heading, keep_variant=body.keep_variant)
    audit.record(db, "rename", "authority", a.id, actor=user, ip=client_ip(request), old=result["from"],
                 new=result["to"], records=result["records"])
    db.commit()
    _changed_catalogue()
    return result


@router.delete("/authorities/{authority_id}", status_code=204)
def remove(authority_id: int, request: Request, db: Session = Depends(get_db),
           user: Patron = Depends(require("authorities:write"))):
    a = svc.get_authority(db, authority_id)
    svc.delete_authority(db, a)
    audit.record(db, "delete", "authority", a.id, actor=user, ip=client_ip(request), heading=a.heading)
    db.commit()
    return Response(status_code=204)


@router.get("/biblios/{biblio_id}/authorities")
def biblio_authorities(biblio_id: int, db: Session = Depends(get_db), _: Patron = Depends(require("catalog:read"))):
    catalog.get_biblio(db, biblio_id)
    return {"results": svc.biblio_links(db, biblio_id)}


# ------------------------------------------------------------------ public browse (OPAC)


@router.get("/browse")
def browse(index: str = Query(default="authors", pattern="^(authors|subjects|titles)$"),
           start: str = Query(default="", max_length=200), after: str | None = Query(default=None, max_length=500),
           before: str | None = Query(default=None, max_length=500), limit: int = Query(default=30, ge=1, le=100),
           db: Session = Depends(get_db)):
    """Alphabetical browse of authorised headings with see/see-also references and record counts."""
    return svc.browse(db, index, start, after=after, before=before, limit=limit)


@router.get("/browse/authorities/{authority_id}")
def browse_entry(authority_id: int, db: Session = Depends(get_db)):
    return svc.browse_entry(db, authority_id)

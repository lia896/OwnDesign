from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from postgrest.exceptions import APIError

from app.auth import CurrentUser, current_user
from app.db import audit, service
from app.responses import ok
from app.schemas import ProjectCreate, VersionCreate

router = APIRouter(prefix="/v1/projects")

PROJECT_COLUMNS = "id, studio_id, client_user_id, client_email, name, property_type, status, created_at, studio:studios(name, slug, status)"
VERSION_SUMMARY = "id, version_no, label, author_role, created_at"
UNIQUE_VIOLATION = "23505"
# Quotas: anyone with a studio link may create projects there, so each account is bounded per studio.
MAX_PROJECTS_PER_CLIENT = 20
MAX_VERSIONS_PER_PROJECT = 500


def _project_or_404(user: CurrentUser, project_id: UUID) -> dict:
    # RLS-scoped read: a project the caller may not see is indistinguishable from a missing one.
    rows = user.db.table("projects").select(PROJECT_COLUMNS).eq("id", str(project_id)).execute().data
    if not rows:
        raise HTTPException(404, "Project not found")
    return rows[0]


@router.get("")
def list_projects(studio_id: UUID | None = None, user: CurrentUser = Depends(current_user)):
    query = user.db.table("projects").select(PROJECT_COLUMNS).order("created_at", desc=True)
    query = query.eq("studio_id", str(studio_id)) if studio_id else query.eq("client_user_id", user.id)
    return ok(query.execute().data)


@router.post("", status_code=201)
def create_project(body: ProjectCreate, user: CurrentUser = Depends(current_user)):
    studio_id = str(body.studio_id)
    studio = service().table("studios").select("id").eq("id", studio_id).eq("status", "active").execute().data
    if not studio:
        raise HTTPException(404, "Studio not found")
    mine = user.db.table("projects").select("id").eq("studio_id", studio_id).eq("client_user_id", user.id).execute().data
    if len(mine) >= MAX_PROJECTS_PER_CLIENT:
        raise HTTPException(409, "You have reached the number of projects allowed with this studio")
    project = (
        service()
        .table("projects")
        .insert(
            {
                "studio_id": studio_id,
                "client_user_id": user.id,
                "client_email": user.email,
                "name": body.name,
                "property_type": body.property_type,
            }
        )
        .execute()
        .data[0]
    )
    audit("project.created", user.id, studio_id=studio_id, project_id=project["id"])
    return ok(project)


@router.get("/{project_id}")
def get_project(project_id: UUID, user: CurrentUser = Depends(current_user)):
    project = _project_or_404(user, project_id)
    role = "designer" if user.role_in(project["studio_id"]) else "client"
    return ok({**project, "my_role": role})


@router.get("/{project_id}/versions")
def list_versions(project_id: UUID, user: CurrentUser = Depends(current_user)):
    _project_or_404(user, project_id)
    rows = (
        user.db.table("plan_versions")
        .select(VERSION_SUMMARY)
        .eq("project_id", str(project_id))
        .order("version_no", desc=True)
        .execute()
        .data
    )
    return ok(rows)


@router.get("/{project_id}/versions/{version}")
def get_version(project_id: UUID, version: UUID | Literal["latest"], user: CurrentUser = Depends(current_user)):
    query = user.db.table("plan_versions").select(f"{VERSION_SUMMARY}, geometry").eq("project_id", str(project_id))
    query = query.order("version_no", desc=True).limit(1) if version == "latest" else query.eq("id", str(version))
    rows = query.execute().data
    if not rows:
        raise HTTPException(404, "Plan version not found")
    return ok(rows[0])


_ANY = object()


def save_version(user: CurrentUser, project: dict, label: str, geometry, *, base_version_no=_ANY) -> dict:
    """Adds the next immutable version. With base_version_no, refuses (409) when the newest version is another one,
    so a change computed on an older plan never lands on top of newer work. Returns the version summary."""
    if project["studio"]["status"] != "active":
        raise HTTPException(403, "This studio is not active")
    author_role = "designer" if user.role_in(project["studio_id"]) else "client"
    latest = (
        service()
        .table("plan_versions")
        .select("version_no")
        .eq("project_id", project["id"])
        .order("version_no", desc=True)
        .limit(1)
        .execute()
        .data
    )
    latest_no = latest[0]["version_no"] if latest else None
    if base_version_no is not _ANY and base_version_no != latest_no:
        raise HTTPException(409, "The plan has been saved since this suggestion was made. Ask again on the current plan.")
    if latest_no is not None and latest_no >= MAX_VERSIONS_PER_PROJECT:
        raise HTTPException(409, "This project has reached its limit of saved versions")
    try:
        version = (
            service()
            .table("plan_versions")
            .insert(
                {
                    "project_id": project["id"],
                    "version_no": (latest_no or 0) + 1,
                    "label": label,
                    "author_id": user.id,
                    "author_role": author_role,
                    "geometry": geometry.model_dump(by_alias=True, exclude_none=True),
                }
            )
            .execute()
            .data[0]
        )
    except APIError as error:
        if error.code == UNIQUE_VIOLATION:  # someone saved the same version number a moment earlier
            raise HTTPException(409, "The plan was saved elsewhere at the same time. Please save again.") from None
        raise
    audit(
        "plan_version.created",
        user.id,
        studio_id=project["studio_id"],
        project_id=project["id"],
        version_no=version["version_no"],
        author_role=author_role,
    )
    return {key: version[key] for key in ("id", "version_no", "label", "author_role", "created_at")}


@router.post("/{project_id}/versions", status_code=201)
def create_version(project_id: UUID, body: VersionCreate, user: CurrentUser = Depends(current_user)):
    return ok(save_version(user, _project_or_404(user, project_id), body.label, body.geometry))

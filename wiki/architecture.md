# Architecture

Sources: `backend/app/`, `frontend/js/`, `supabase/migrations/`.

```
frontend/   static HTML + ES modules, no build step
backend/    FastAPI, Python 3.13, uv
supabase/   migrations and managed auth settings
```

## Request path

1. The browser signs in with supabase-js (`frontend/js/api.js`). That is its only direct use of Supabase.
2. Every data call goes to the backend at `/v1/...` with `Authorization: Bearer <JWT>`.
3. `backend/app/auth.py` verifies the token and builds a per-request Supabase client carrying it.
4. Responses use the envelope `{success, data, error}` (`backend/app/responses.py`).

## Access model

- **Reads** use the caller's JWT, so Postgres row-level security decides what is visible.
- **Writes** use the service key, after the payload is validated and an RLS-scoped read confirms access.
- Role `authenticated` has SELECT only. Role `anon` has nothing.
- A new table needs: RLS enabled, a SELECT policy, explicit grants, and an isolation test.

## Tables

`studios`, `studio_memberships` (owner or designer; one owned studio per user), `studio_invites`,
`projects`, `plan_versions` (insert only, unique `(project_id, version_no)`), `audit_events` (insert only).

Phase 2 (`supabase/migrations/20261123*`): `project_briefs` (one JSON document per project),
`finish_selections` (unique per room and surface), `inspiration_assets`, `moodboard_items`,
`ai_conversations` (unique per project and user), `ai_messages`, `storage_deletions` (queue of files to remove).
Their SELECT policies go through `projects`, except conversations: only their own user reads them.
`ai_messages.kind` (`chat` or `copilot`) keeps the consultant page and the editor's copilot apart in one
conversation; `payload` holds a copilot turn's scope or its checked reply
(`supabase/migrations/20261126100000_copilot_messages.sql`).

## Plan geometry

One JSON document per version, validated in `backend/app/schemas.py` and edited by pure functions in
`frontend/js/plan.js`.

```json
{ "schema": 1, "units": "cm", "rooms": [], "walls": [], "openings": [], "furniture": [] }
```

- An opening is positioned by `offset` along its wall, so it moves with the wall.
- Furniture `x`/`y` is the centre.
- Limits: 100 rooms, 1000 of each other kind, coordinates within 100,000 cm, body under 2 MB.

## Editor

`frontend/js/editor/`: `main.js` (state, tools, keyboard, save), `render.js` (SVG), `pointer.js`
(drag, draw, pan, pinch, wheel), `panel.js` (inspector and versions), `copilot.js` (the AI copilot panel, pure
helpers in `frontend/js/copilot-logic.js`). A copilot preview is drawn instead of the plan without entering
the undo history; the canvas ignores pointer and keys (except Escape) while it shows, and any edit ends it. The whole canvas is redrawn on
each change; the plan object is never mutated.

## API

Studios, invites, studio activity (`GET /v1/studios/{id}/audit`, the latest 10 audit events, members
only): `backend/app/routes/studios.py`. Projects, versions: `backend/app/routes/projects.py`.
Quotas: 20 projects per client per studio, 500 versions per project.

Design assistance (`backend/app/routes/design.py`, `consultant.py`, catalog in `backend/app/catalog.py`):
`GET /v1/catalog`; under `/v1/projects/{id}`: `brief`, `finishes`, `assets`, `moodboard`
(GET and PUT, assets POST and DELETE), `consultant/messages` (GET, POST), `copilot/messages` (GET, POST),
`copilot/apply` (POST). Every write goes through
`_writable_project`, which refuses a suspended studio.

- **Images:** private bucket `project-assets`, no storage policies. The backend checks the file's bytes
  (not the declared type), stores it under `<project_id>/<uuid>.<ext>` and returns signed URLs valid for
  10 minutes. Deleting an asset row, directly or by cascade, queues the file in `storage_deletions`;
  the backend removes queued files after an asset is deleted. The 30-image limit is enforced by a
  database trigger. The body cap is 6 MB for `POST .../assets` only, 2 MB elsewhere.
- **Consultant:** `reserve_ai_message` (database function) takes a per-user lock, counts the user's
  messages of the last 24 hours across all projects, and stores the user message before the paid call.
  The project context goes to OpenAI as a separate, escaped, untrusted input item, not in the
  system prompt. A failed call keeps its slot. The OpenAI client is a FastAPI dependency (`get_openai`)
  so tests replace it. `OPENAI_API_KEY` and `OPENAI_MODEL` are read from `backend/.env`; without a key
  the endpoint answers 503.
- **Frontend:** `design.html` (brief, materials, moodboard tabs), `consultant.html`; pure logic in
  `frontend/js/design-logic.js`.

## Design copilot

The AI panel beside the plan editor (`backend/app/routes/copilot.py`, engine `backend/app/copilot.py`).

- **Ask:** the editor sends the plan as it is on screen (unsaved edits included, validated as `Geometry`) and a
  scope: project, room or item. The model gets rooms with inner bounds, openings, furniture with size, position
  and rotation, the measured `detected_problems`, and the brief, inside an escaped `<plan_context>` tag.
- **Reply:** OpenAI structured output (`REPLY_SCHEMA`, strict). `parse_reply` clips it and checks every proposed
  change. Unusable output is a 502 and is not stored.
- **Actions:** only `move_object`, `rotate_object`, `resize_object`, `remove_object` on furniture. A change is
  `applicable` when it names existing items and adds no new problem: furniture past a room's walls or outside
  every room, overlapping furniture, or an item in a door's swing (a square as deep as the door is wide, on
  both sides of the wall). Problems the plan already had are not blamed on the change.
- **Apply:** anyone with write access to the project. The server re-applies and re-checks the actions, then
  saves a new version through `save_version` in `projects.py`. `base_version_no` must still be the newest
  version, otherwise 409, so a suggestion never lands on top of a newer save.
- **Limits:** shares the consultant's daily cap of 30 questions per user. Room bounds are the box of the room's
  walls, so an L-shaped room is checked against its bounding box.


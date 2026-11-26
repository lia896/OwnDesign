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
(drag, draw, pan, pinch, wheel), `panel.js` (inspector and versions), `compare.js` (version comparison,
pure helpers in `frontend/js/compare-logic.js`). The whole canvas is redrawn on
each change; the plan object is never mutated.

**3D walkthrough:** `frontend/js/plan3d.js` (pure: wall boxes, collision, start point) and
`editor/view3d.js` (three.js, loaded with `import()` only when opened). three.js 0.180.0 is vendored in
`frontend/vendor/`. Assumed heights in cm: wall 260, door 210, window 90 to 210, eye 160. An opening cuts
every wall lying along it, because adjacent rooms have overlapping walls. Plans needing more than 5000
cuts are refused. No server or database change.

## API

Studios, invites, studio activity (`GET /v1/studios/{id}/audit`, the latest 10 audit events, members
only): `backend/app/routes/studios.py`. Projects, versions: `backend/app/routes/projects.py`.
Quotas: 20 projects per client per studio, 500 versions per project.

Design assistance (`backend/app/routes/design.py`, `consultant.py`, catalog in `backend/app/catalog.py`):
`GET /v1/catalog`; under `/v1/projects/{id}`: `brief`, `finishes`, `assets`, `moodboard`
(GET and PUT, assets POST and DELETE), `consultant/messages` (GET, POST).
Version comparison: `POST /v1/projects/{id}/versions/compare` with `version_a_id` and `version_b_id`. Every write goes through
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

## Version comparison

Read-only comparison of two saved versions, inside the editor page (`frontend/js/editor/compare.js`).

- **Engine:** `backend/app/diff.py`. Matches rooms, walls, openings and furniture by id. Furniture changes are
  `added`, `removed`, `moved`, `rotated`, `resized`, or `modified` (more than one of those, or a type change);
  moving into another room is reported with the move. Rooms, walls and openings are `structural` with
  `detail` added, removed or changed. Tolerances: 1 cm, 1 degree; rotation is compared as an angle (360 = 0).
  Each change carries `box_a`/`box_b` (where it is in each version) and only the properties that changed.
  Changes are grouped by room (the box of the room's walls); a group lists change ids, not copies.
- **Endpoint:** `POST /v1/projects/{id}/versions/compare` reads both versions through RLS and filtered by the
  project, so a version of another project is a 404. Same version twice is 422, a version that no longer
  validates is 422. It writes nothing.
- **View:** side by side (one shared view box, so zoom and pan stay in step) or a difference view (version B
  with removed elements dashed). Summary, filters by type and room, a list by room, before/after details.
  Selecting a change zooms both plans to it. Exit returns to the editor untouched; unsaved edits stay.
- **Styles:** the plan's drawing rules apply to `#canvas` and `.cmp-plan svg` alike. Tones: green added, red
  removed, amber changed, blue structural, always with an icon and a word.

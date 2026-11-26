# Testing

Sources: `backend/tests/`, `frontend/tests/`.

```sh
cd backend  && uv run pytest     # unit + integration (real dev Supabase) + browser E2E
cd frontend && npm test          # plan logic, node --test
```

First E2E run needs `uv run playwright install chromium`. Integration and E2E tests are skipped when
`backend/.env` is missing (a test module must not import `app.main` at module level, or collection fails there). They create users at `*@owndesign-test.example.com` and delete them afterwards.

## Suites

| File | Kind | Covers |
|---|---|---|
| `backend/tests/test_geometry.py` | unit, edge | geometry validation: bounds, duplicates, openings outside walls |
| `backend/tests/test_api.py` | integration, edge | auth, studios, invites, projects, versions, isolation, quotas, 413 on chunked upload, studio activity (members only) |
| `backend/tests/test_e2e.py` | end to end, edge | client journey (portal, wizard, editor, sign-up, save, reload); designer journey (studio dashboard metrics, invite, project cards, search, activity, edit a client's project); portal entry points (personal invite, blank canvas, invalid links, markup and long names) |
| `frontend/tests/plan.test.js` | unit | plan functions: add, move, remove, undo, rooms from the wizard |
| `frontend/tests/studio.test.js` | unit, edge | dashboard metrics, activity sentences, project filter |
| `frontend/tests/plan3d.test.js` | unit, edge | 3D wall boxes, doors, windows, overlapping walls, collision, sharp corners, oversized plans |

## Required after every change

End to end, regression (both full suites) and edge cases for the change (`CLAUDE.md`, step 5).

## CI

Source: `.github/workflows/ci.yml`. Report only: a red check does not block a merge ([open-items.md](open-items.md)).

| Job | Runs on | What it does |
|---|---|---|
| `frontend` | every push to `dev`/`main`, every pull request | `npm test` |
| `backend` | push to `dev`/`main` only | the full suite, browser journeys included, against the dev Supabase project |
| `backend-unit` | pull requests only | the suite with no secrets: unit tests run, the rest skip (22 passed, 78 skipped) |

- A pull request never gets secrets, also not from a branch of this repository. A pull request from
  `dev` to `main` still shows the full run, because checks attach to the commit and `dev` was pushed.
- `backend` takes its three Supabase values from the GitHub environment `ci`, which only `dev` and `main`
  may use ([security.md](security.md)). Its first step fails when one is missing, so a missing secret
  cannot turn into a green run of skipped tests.
- `backend` runs are never parallel (concurrency group `supabase-dev`): the suite deletes every test
  account at the end. GitHub keeps one waiting run; a newer push replaces an older waiting one, which then
  shows as cancelled.
- A local `uv run pytest` during a CI run breaks whichever finishes last, for the same reason. Wait for the
  run on `dev` before running the suite locally.
- Pull requests from forks may wait for "Approve and run" by the owner before any job starts.

Checked on 2026-11-26: a pull request with a failing test showed a red check (`frontend` failed,
`backend-unit` passed, `backend` skipped); a branch that added itself to the push trigger was refused by
the environment ("not allowed to deploy to ci"), with no step run; with the secret key missing, `backend`
failed in its first step. Not yet seen: a green `backend` run. It waits for the CI secret key.

## Last result

2026-11-26, after merging pull requests #9, #8 and #14: backend 100 passed (9 browser tests; the guest journey
now also walks in 3D), frontend 57 passed, locally. On GitHub: `frontend` green, `backend` not yet run to the
end (see CI), so the 3D step has not yet run on a Linux runner.

2026-11-23, new files:
`backend/tests/test_design.py` (brief, finishes, uploads, moodboard, isolation, quota, suspended studio) and
`test_consultant.py` (fake OpenAI client: context, privacy, cap, failure, injection, tag escaping);
`frontend/tests/design-logic.test.js`. `backend/tests/test_e2e_design.py` (6 browser tests: client journey for brief, finishes and moodboard with
reload; designer sees the client's data; client-side rejections, markup stays text; stranger and signed-out
visitor; consultant page limits) passes together with `test_e2e.py` (9 browser tests in all). No chat message
reaches OpenAI in the suite; the real call was checked by hand once.

2026-11-26 (version comparison, on a machine without `backend/.env`): backend 39 passed, 79 skipped (need
Supabase), frontend 37 passed. New: `backend/tests/test_diff.py` (17 engine tests: every change kind,
tolerances, angles, rooms, structure, grouping, empty and 1000-item plans), `test_compare.py` (access, other
project's version, same version, malformed input, writes nothing), `test_e2e_compare.py` (4 browser journeys),
`frontend/tests/compare.test.js`. Then run in full against a new development database: backend 133 passed
(browser journeys included), frontend 37 passed. That run caught one bug (the difference view hid version A
one frame late) and three test mistakes.

## Local setup notes

`backend/.env` needs `ALLOWED_ORIGINS` to include both `http://localhost:5500` and `http://127.0.0.1:5500` (the
journeys use the second). A system-level `OPENAI_API_KEY` overrides the one in `.env`; unset it before starting the backend.

`python -m http.server` can refuse connections on a loaded machine.

## Not covered

Real touch devices (pinch zoom), browsers other than Chromium, screen readers, load, a studio with
many projects. Code outside `backend/` and `frontend/` is not run by CI.

## Gotchas

- Every run of the backend suite deletes all `*@owndesign-test.example.com` accounts and their studios.
  Do not run it while someone is checking pages by hand with such accounts.
- Playwright matches accessible names by substring. A second link containing "Start designing" or a
  second heading containing the studio name breaks the journeys.

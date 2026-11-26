# Security

Sources: `supabase/migrations/`, `backend/app/main.py`, `backend/tests/test_api.py`, commit `f4ed029`.

## Tenant isolation

- A studio member sees the studio's projects. A client sees only their own. Enforced by RLS policies.
- Proven by tests through the API and directly against the Supabase Data API: no reading another
  studio's data, no direct writes, nothing visible to an anonymous caller.

## Controls in place

- JWT checked on every protected route; anonymous sign-ins are rejected.
- Strict input schemas: unknown fields rejected, numbers bounded, ids unique, openings must fit their wall.
- Request bodies capped at 2 MB by counting received bytes, so chunked uploads are capped too.
- Per-account quotas on projects and versions.
- Suspended studios cannot be written to.
- Invite tokens are random; the public invite lookup never returns the email.
- supabase-js is served from `frontend/vendor/`; every page has `script-src 'self'`.
- The DOM builder writes text nodes only, so plan and project names cannot inject markup.
- Secrets only in git-ignored files. History was scanned before the repository was published.

## Review of Phase 1

Independent security review and code review. No critical or high security finding. Fixed: CDN script
without integrity, chunked-body bypass of the size cap, account flooding, a race allowing two owned
studios, writes to suspended studios, sequence grants.

Not fixed, by decision: see [open-items.md](open-items.md).

## Review of the client portal and studio dashboard

No finding. The studio activity endpoint answers 403 to anyone who is not a member of an active
studio with that id, whether or not the studio exists, and returns no actor ids, tokens or emails.
A client's plan is drawn as SVG in the designer's browser from values the backend schema bounds as
finite numbers and fixed literals.

## Review of Phase 2 (backend)

`security-review` and a security-reviewer agent on the local commits. Fixed: a suspended studio could still
write design data; parallel uploads could pass the 30-image limit (now a database trigger); the consultant's
daily cap could be bypassed (empty answers, parallel calls, many projects) and is now reserved atomically per
user before the paid call; project text sent to OpenAI could pose as instructions (now an escaped,
untrusted input item). Checked, no finding: tenant isolation of every new table and route, upload byte
checks, signed URLs, no IDOR through asset or room ids. Not fixed: see the Phase 2 gaps in
[open-items.md](open-items.md). The Phase 2 frontend had a code review (fixed: expiring image links,
duplicate chat message after a failed answer, unvalidated `?project=`); a security review of the frontend
commits is still to do.

## CI (GitHub Actions)

Source: `.github/workflows/ci.yml`. The plan and the file were each reviewed by a security-reviewer agent, and
`security-review` ran on the commits. No critical finding. Two high findings on the plan, both built in:

- Secrets live in the environment `ci`, limited to `dev` and `main`, not at repository level. A fork, another
  branch or an edited workflow cannot get them (tried: refused).
- CI uses its own Supabase secret key, not the one from `backend/.env`.

Also in place: pull requests run in jobs with no secrets and never with `pull_request_target`; secrets reach
single steps, not the job; actions pinned to commit hashes and uv to a version; no cache, no artifacts
(Playwright traces hold tokens and the repository is public); read-only token.

**Before merging a pull request from a fork, read its diff of `backend/tests/`, `uv.lock`, `pyproject.toml`,
`frontend/package.json` and `.github/`.** Its green check ran without secrets; after the merge, the push run
executes that code with the service key.

What remains: the CI key is still a service key on the dev project; logs are public and GitHub masks exact
secret strings only, so a failing test's traceback is visible to everyone. See [open-items.md](open-items.md).

## Review of the 3D walkthrough (pull request #14)

Reviewed again here before merging, by reading and by a security-reviewer agent: no critical or high finding.
Plan values reach only three.js geometry as numbers, the content security policy is unchanged, and three.js is
served locally. The three vendored files are byte for byte the published npm package `three@0.180.0` (SHA-256
compared at merge time). The guard against oversized plans counts wall cuts, not boxes: the largest plan the
server accepts still makes the viewer's own tab sluggish ([open-items.md](open-items.md)).

## Every stage

Run the `security-review` skill on the branch's local commits before pushing (`CLAUDE.md`, step 7), and add
the outcome here and to [log.md](log.md).

## Version comparison (2026-11-26)

Reviewed on branch `feature/version-comparison`, no high-confidence findings. The endpoint reads both versions
with the caller's RLS client and the project filter; ids are typed UUIDs; nothing is written. All names and
labels reach the page as text.

# Plan Export Feature Specification

## PNG, PDF and DXF exports for print and CAD handoff

**Status:** Product decisions captured, technical validation pending  
**Date:** 26 November 2026  
**Product:** Atelier / OwnDesign

## 1. Purpose

Let authorized clients and designers download a saved floor plan as PNG, PDF or DXF. PNG and PDF support sharing and printing. DXF supports basic continuation in AutoCAD or another compatible CAD application.

The feature should make project handoff easier while keeping exported files traceable to a saved plan version. Exported plans are conceptual design material, not authorization for construction.

## 2. Business outcome

The export flow gives studios a clear deliverable they can share with clients and use as a starting point in CAD. Measure adoption by the share of active projects with at least one successful export, export success rate, and format usage.

## 3. Scope

### In scope

- PNG, PDF and DXF downloads from an authorized project.
- Export of any saved plan version, including earlier versions.
- Full-plan bounds, independent of editor zoom, pan or viewport.
- PNG and PDF layouts for A4 and A3.
- Basic editable 2D DXF with separate layers for walls, openings and furniture.
- Project and version identification in visual exports.
- A conceptual-plan notice in every format.
- An audit event visible in studio activity for each successful export.

### Out of scope

- Construction, permit, structural, electrical or plumbing drawings.
- A guarantee that a fit-to-page PDF is printed at a measured scale.
- DXF annotations for room names, areas or dimensions in the first release.
- Export of unsaved editor state.
- Multi-page tiling, custom title blocks, custom paper sizes or live supplier/product data.
- Importing or round-tripping DXF changes back into Atelier.

## 4. Users and access

Both clients and designers can export when they are authorized to view the project. The server must verify access to both the project and the selected saved version. A client-supplied project ID or version ID is not proof of access.

## 5. User flow

1. The user opens a project in the floor-plan editor and selects **Export**.
2. The user selects PNG, PDF or DXF.
3. The user selects a saved version. The latest saved version is preselected; earlier saved versions remain available.
4. For PNG or PDF, the user selects A4 or A3. Page orientation is selected automatically from plan proportions.
5. The user starts the export and downloads the generated file.
6. On successful generation, the system records the user, project, version, format and time in studio activity.

If the editor contains unsaved changes, the export remains based on the selected saved version. The interface should identify which version will be exported so the user does not mistake it for the unsaved draft.

## 6. Export requirements

| Format | Output |
| --- | --- |
| PNG | White background. A4 or A3 canvas at 300 DPI, matching the selected PDF page size. Includes the complete plan, room names, room areas, wall-length labels, project name, saved version and export date. |
| PDF | A4 or A3 page, automatically oriented and fitted to page. Includes the complete plan, room names, room areas, wall-length labels, project name, saved version and export date. Clearly states that scale is not guaranteed. |
| DXF | Basic editable 2D plan in centimetres. Separate layers for walls, openings and furniture. Includes a separate note layer for the conceptual-plan notice. Does not include room names, areas or dimension annotations in the first release. |

### Shared visual rules

- Export all saved-plan geometry, even when it is outside the current editor viewport.
- Include room names, room areas and wall-length labels in PNG and PDF.
- Exclude editor-only elements such as the grid, rulers, selection outlines, handles, temporary previews and editor controls.
- Use a white background in PNG and PDF.
- Suggested notice: **Conceptual plan only. Not for construction.**
- The PDF should also say: **Fit to page. Scale not guaranteed.**

### DXF layer proposal

- `WALLS`
- `OPENINGS`
- `FURNITURE`
- `NOTES`

The exact DXF entity types, wall-thickness representation and coordinate transform remain technical decisions. They must preserve the plan's visible geometry and dimensions as closely as the current data model allows, without implying construction-grade detail.

## 7. Functional requirements

1. Export is available only to users authorized to view the project.
2. The export is derived from the selected immutable saved version, not arbitrary geometry sent by the browser.
3. The latest saved version is the default. A user can choose any earlier saved version.
4. Unsaved changes are not exported in this release. If there are unsaved changes, the UI identifies the saved version being exported.
5. PNG and PDF include the whole plan, room labels and measurements, regardless of editor pan or zoom.
6. PNG uses a white background and selected A4 or A3 page dimensions at 300 DPI.
7. PDF supports A4 and A3, chooses orientation automatically, and fits the plan to one page.
8. PDF makes the lack of a guaranteed print scale visible.
9. DXF opens as an editable 2D drawing in a compatible CAD application, uses centimetres, and organizes basic plan geometry into the agreed layers.
10. Every output contains a conceptual-plan notice.
11. A successful export creates a studio activity record containing only the actor, project, saved version, format and timestamp. The event must not contain plan geometry or file contents.
12. A failed export does not create a success event or an incomplete download.
13. Exporting does not create or modify a plan version.

## 8. Acceptance criteria

- An authorized client and an authorized designer can export the same saved project version in each supported format.
- A user without project access cannot export by changing a project or version identifier.
- The latest saved version is preselected, and an earlier saved version can be selected.
- Exported PNG and PDF contain all plan geometry, labels and measurements without editor controls or viewport artifacts.
- PNG files use the selected A4 or A3 dimensions, 300 DPI and a white background.
- PDF files use A4 or A3, choose a suitable orientation, fit on one page and visibly state that scale is not guaranteed.
- DXF opens in the target CAD compatibility test environment, uses centimetres, displays the plan in the correct orientation and exposes the agreed layers for editing.
- The conceptual-plan notice appears in PNG, PDF and DXF.
- Successful exports appear in studio activity with the correct actor, project, version, format and timestamp.
- A failed generation does not appear as a successful export in studio activity.
- Exporting leaves saved plans and version history unchanged.

## 9. Security, privacy and implementation constraints

- Reuse the existing project authorization and tenant-isolation model.
- Validate project access and version ownership on the server before serving export data or recording activity.
- Keep generated files transient unless a later feature explicitly adds stored export artifacts.
- Do not send plan geometry to a third-party service for rendering.
- Any added browser library must be locally bundled, compatible with the repository's Content Security Policy, and reviewed for license suitability.
- Audit records should contain metadata only, not geometry, user-entered design text or file bytes.

## 10. Technical validation before implementation

1. Choose a DXF library and version that run in the selected architecture, support layers and required 2D entities, and have a suitable license.
2. Validate how the current wall centreline and thickness, door swing, window symbols, furniture dimensions and rotation map to DXF entities.
3. Verify the Y-axis transform. The editor uses a top-left origin with Y increasing downward; CAD viewers commonly use a different drawing convention.
4. Test representative exports in AutoCAD or a compatible viewer, including horizontal and vertical plans, rotated furniture, doors, windows, long room names and overlapping wall joins.
5. Verify PDF and PNG label legibility on both A4 and A3.
6. Decide how to record a successful export when file generation is browser-side, so studio activity does not report a download that failed before generation.

## 11. Repository touchpoints

The current plan model is validated in `backend/app/schemas.py`, saved versions are served by `backend/app/routes/projects.py`, and SVG rendering is implemented in `frontend/js/editor/render.js`. Studio activity is served by `backend/app/routes/studios.py`. The implementation should also follow tenant-isolation and professional-safety requirements in `wiki/architecture.md`, `wiki/security.md` and PRD requirement FR-19.

## 12. Confirmed product decisions

- Access: authorized clients and designers.
- Versions: any saved version; latest saved version is the default.
- Unsaved editor state: excluded.
- PNG background and quality: white, 300 DPI.
- PNG page dimensions: same selected A4 or A3 size as PDF.
- PDF layout: A4 or A3, automatic orientation, fit to page.
- Visual annotations: room names, room areas and wall-length labels in PNG and PDF.
- DXF scope: basic editable 2D drawing with walls, openings and furniture on separate layers, in centimetres.
- Safety notice: included in all formats.
- Studio activity: log successful export with actor, version, format and time.

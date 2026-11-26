# Design

Sources: Stitch project "AI Interior Design Platform" (reached through the Stitch MCP server),
`design/stitch/` (the pulled files), `frontend/css/app.css`.

## Design system

- "Architectural Atelier". Terracotta primary (`#9f3c16`, `#bf542c`), moss secondary, warm off-white
  surfaces. Plus Jakarta Sans, Inter, JetBrains Mono. Material Symbols icons. 4 px radius on
  controls, 8 px on cards.
- The tokens are CSS variables at the top of `frontend/css/app.css`. New UI uses them, not new colours.
- Brand in the UI: "ATELIER" with a green studio chip.
- Breakpoints: 1199 px and 767 px.
- Fonts load from Google Fonts ([open-items.md](open-items.md)).

## Screens

All eight Stitch screens are stored in `design/stitch/` (HTML plus a preview image each); the table
there lists the Stitch screen ids. Pulled 2026-11-19.

| Stitch screen | App page | State |
|---|---|---|
| Guided Room & Dimension Wizard | `frontend/wizard.html` | Built |
| 2D Floor Plan Canvas & Space Planner | `frontend/editor.html` | Built |
| Client Invitation & Guest Onboarding Portal | `frontend/entry.html` | Built |
| Studio Overview & Project Directory | `frontend/studio.html` | Built |
| Studio White-Label Branding & Atelier Settings | `frontend/branding.html` | Preview only: logo, colour presets and custom colours; nothing is saved |
| Client & Designer Project Dossier & Specs Export | none | Reference for the dossier and budget phase |
| Client AI Consultant & Spatial Advisor | `frontend/consultant.html` | Built (real data only; no credits, sample suggestions or action buttons) |
| 3D Render Views & Photorealistic Gallery | none | Reference for the renderings phase |

`index.html`, `auth.html`, `projects.html` and `design.html` (brief, materials, moodboard) have no Stitch screen; they follow the design system.

## Rules for turning a Stitch screen into a page

- Stitch HTML uses the Tailwind CDN and inline scripts. The app uses neither: plain CSS, ES modules,
  and a `script-src 'self'` policy on every page.
- Stitch screens are filled with sample data (credits, budgets, render queues, sign-off queues,
  compliance badges, people). A page shows only what the API returns; anything without a real source
  is left out until the phase that builds it ([decisions.md](decisions.md)).
- Entries for later phases may appear in navigation as disabled items titled "Coming in a later phase".
- Check whether a screen changed in Stitch before building from the stored copy: re-pull and compare.

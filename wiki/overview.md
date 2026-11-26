# Overview

Source: `Interior_Design_AI_PRD_EN.md`, `README.md`.

A multi-tenant web platform where an interior design studio invites clients, and the client and
designer work on the same floor plan. AI assistance comes in later phases.

## Built: Phase 1

- A designer signs up and opens a studio. One studio per owner.
- A client enters through the studio link, a personal invite link, or as a guest. The client portal
  (`entry.html`) offers guest or account access, and the wizard or a blank canvas as a starting point.
- A guided wizard builds the apartment from rooms and dimensions.
- A 2D editor (SVG): walls, partitions, doors, windows, generic furniture, undo/redo, pan/zoom, keyboard use.
- Every save adds an immutable version tagged `client` or `designer`.
- A guest's plan stays in the browser until they register and save.
- The studio dashboard (`studio.html`) shows metrics, project cards with a plan thumbnail, search,
  the studio link, invites and recent activity.
- One studio cannot see another studio's data ([security.md](security.md)).

## Built: Phase 2

- Design brief per project: styles (up to 5), colours, budget range and currency, household, lifestyle,
  needs, fixed constraints, existing items to accommodate (`design.html`).
- Finish selections per room and surface (floor, walls, ceiling, cabinets) from a fixed catalog of styles
  and materials.
- Inspiration and existing-item images (JPEG, PNG, WebP, 5 MB, 30 per project) in private storage, shown
  through short-lived signed URLs, and a moodboard of images, styles and materials with notes and order.
- AI consultant (`consultant.html`): OpenAI `gpt-5-mini`, answers from the project's brief, finishes and
  plan summary, recommends only and never edits the plan. One private conversation per user and project,
  30 messages per user per day.
- The client and the studio's designers see the same brief, finishes and moodboard; the conversation is
  private to the user who held it.

## Preview only

- Studio branding (`branding.html`): logo and three colours applied to a sample client entry page in the
  browser. Nothing is saved, nothing reaches real client pages, and the page is not linked from the app.

## Built: 3D walkthrough

- A first-person walkthrough of the plan, opened from the editor, including unsaved drafts. View only.
- Keyboard (any layout), drag to look, and on-screen buttons. Walls and windows block, doorways let through.
- Heights are assumed, because the plan stores none ([architecture.md](architecture.md)).

## Not built yet

Renderings, budget, dossier,
messaging and tasks, saved and applied studio branding, invitation emails, per-project team permissions, deployment,
rate limiting, subscriptions and credits.

## Next

Per the PRD: renderings, version comparison, budget and shopping list, dossier and handoff, messaging and
tasks, studio branding ([open-items.md](open-items.md) lists what must be settled before production).

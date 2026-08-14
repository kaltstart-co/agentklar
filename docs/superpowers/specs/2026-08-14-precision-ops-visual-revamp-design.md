# Agentklar Precision Ops Visual Revamp

**Status:** Approved for implementation

**Created:** 2026-08-14

## Goal

Replace the current warm-paper, serif-led editorial styling with a modern SaaS system that makes Agentklar feel like an operational control plane. The native control center and the product website must share one recognizable visual language.

The selected direction is **Precision Ops**: a cool light canvas, white working surfaces, dark navy navigation, restrained royal-blue interaction states, compact information density, and sans-serif typography throughout.

## Scope

- Restyle every native control-center route through its shared shell and components.
- Restyle the website home, features, and usage pages as one product family.
- Preserve all current workflows, content, routes, responsive behavior, security boundaries, and accessibility contracts.
- Update the website's embedded product preview and social preview to match the shipped control center.

## Visual System

### Color

- Canvas: cool gray (`#f5f7fb`).
- Primary surfaces: white (`#ffffff`).
- Navigation: deep navy (`#101828`) with a lighter active item (`#24324a`).
- Primary action: royal blue (`#315efb`) with a darker hover state.
- Text: blue-black primary, slate secondary.
- Borders: cool neutral gray.
- Status colors remain semantic: red for destructive or blocked, amber for waiting or review, green for passed or done, blue for active workflow.

Warm cream, paper texture, decorative ink borders, and editorial color treatments are removed.

### Typography

- Use the native UI sans stack headed by `-apple-system` and `BlinkMacSystemFont`, matching the approved mockup without adding a font download.
- Use the existing monospaced stack only for identifiers, paths, timestamps, and evidence metadata.
- Remove serif display typography.
- Page headings are compact and bold; they never dominate the operational content.

### Shape and Depth

- Controls and cards use consistent 6–10px radii.
- Thin cool-gray borders define structure.
- Shadows are soft and limited to raised surfaces such as dialogs, task cards, and the mobile rail.
- Primary actions are filled blue; secondary actions are white with neutral borders.
- No gradients, hard offset shadows, rotated marks, or decorative texture.

## Native Control Center

The existing information architecture remains intact.

- The left rail becomes a dark app-navigation surface with a blue Agentklar mark, high-contrast active navigation, and compact project selection.
- The top project bar becomes a white utility bar.
- Main content uses the cool-gray canvas with white component surfaces.
- Oversized editorial headings become compact SaaS page headers.
- Board columns become rounded neutral wells; task cards become compact white cards with subtle elevation.
- Overview projects, attention items, approvals, alerts, memory, context, knowledge, task details, dialogs, forms, tabs, and empty states use the same card, border, spacing, and status patterns.
- Mobile retains the existing accessible off-canvas rail, 44px touch targets, horizontal board scrolling, and no document-level overflow.
- Read-only and human-control states remain obvious and unchanged in behavior.

## Product Website

The website should look like the public face of the same application, not an editorial microsite.

- Navigation uses the Agentklar blue mark, compact sans typography, and modern button treatments.
- The home hero remains product-led but uses a tighter headline scale and a polished control-center preview based on Precision Ops.
- Feature and usage sections use white cards on a cool-gray canvas with restrained blue highlights.
- Terminal examples stay dark because they represent a terminal, not the site theme.
- Home, features, and usage share the same tokens, spacing rhythm, navigation, footer, and responsive behavior.
- Existing product claims and installation commands remain unchanged unless layout requires a shorter label.

## Interaction and Accessibility

- Preserve keyboard navigation, visible focus, semantic markup, skip links, reduced-motion behavior, and current ARIA labels.
- Hover and active states use color plus border or background changes, not color alone where state must remain legible.
- Text and controls meet WCAG AA contrast in their normal states.
- At 390px, pages have no document-level horizontal overflow; only the Kanban board scrolls horizontally.

## Verification

- Add a static visual-contract test that rejects the old cream and serif tokens and requires the Precision Ops tokens in the embedded control-center stylesheet.
- Add a site contract check that rejects the old paper/serif tokens across all three pages and requires the shared Precision Ops palette.
- Run `go test ./...` and `go build ./...`.
- Render and inspect the native control center and all three website pages on desktop and at 390px width.
- Verify navigation, board density and scrolling, form controls, focus states, read-only presentation, and document overflow.

## Non-goals

- No dark mode.
- No new frontend framework, dependency, font download, icon library, or build step.
- No workflow, API, database, or security changes.
- No information-architecture rewrite.
- No speculative customization or theming system.

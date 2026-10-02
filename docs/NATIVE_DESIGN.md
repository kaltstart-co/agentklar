# Native app design

## One workspace

Project tabs change the whole workspace. The sidebar has flat page links. Work is the starting page. App settings stay easy to find at the bottom.

## Page structure

| Page | Main content | Main action |
| --- | --- | --- |
| Work | Task list and selected result | New task |
| Instructions | Full document editor | Review changes |
| Context | Brief, memory and next steps | Save context |
| Team | Roles and selected responsibility | Add role / Save team |
| Models | Searchable model list | Refresh |
| Usage | Task usage and account allowance | Refresh |
| Settings | Connections, defaults, computers, updates | Relevant setup action |

Routing and delegation are team configuration. They open separately from the roster. Custom presets remain available. Only-when-asked remains the default.

## Visual rules

- System font: 14 body, 12 supporting text, 22 page title.
- Shared 28-point page gutter and 960-point reading width.
- One page title. One primary action per task.
- Flat tabs; no nested disclosure navigation.
- Icons accompany names. Entire rows are clickable.
- Long documents use the available height.
- Controls have named labels and aligned columns.
- Technical evidence opens in a named detail view.
- Unknown, unavailable and failed states stay visible.

## Review

- [ ] Every page
- [ ] Small window
- [ ] Long names
- [ ] Draft retention
- [ ] Setup review

This is the implementation guide. Checkmarks require a real native-app check; a successful build alone is not visual acceptance.

### Beta.37 preview check — 3 October 2026

The installed app was checked on Work, Team, Context, Instructions, Models, Usage and Settings Connections. Role fields, routing configuration and preset editing opened correctly. A temporary role draft survived opening and closing the preset editor. A 30-section Context draft scrolled and survived switching document tabs; it was cleared without saving. Instructions loaded the real project file. Model refresh returned 42 rows; harness filtering, search, clearing search and model/allowance details worked.

The native screen-control connection then closed. Reconnecting did not restore it. Small-window checks, long-name project tabs, the new task options and the other Settings tabs remain open. The temporary role is an unsaved local draft. No team, context, worker or connection was saved during review. This pass does not establish full visual acceptance.

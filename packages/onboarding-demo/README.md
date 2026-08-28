# Onboarding demo

A standalone reproduction of executor's **current** add-integration flow, from
"the CLI is connected" to "the integration has a working connection". No API, no
auth, no tenant — it runs off `src/fixtures.ts` and the public integrations.sh
endpoints.

```
bun run --cwd packages/onboarding-demo dev   # http://localhost:5199
```

Every screen is addressable: `#integrations-empty`, `#connect-dialog`,
`#add-openapi`, `#detail-accounts`, `#add-account-credential`,
`#add-account-place`, `#oauth-stuck`, `#integrations-populated`. `[` and `]`
step through them. `src/flow.ts` records, per screen, the route and source
component it was reproduced from plus the first-run reactions against it.

A floating Current / Reworked control in the bottom-right corner switches
between the two flows.

## Reworked flow

`#reworked` — the picker, `#reworked/installed`, `#reworked/custom`,
`#reworked/<domain>`, `#reworked/<domain>/auth`. Browse/Installed carries
navigation within the picker; the console sidebar stays as it is today. A deep link to a domain you have not added in this session
says so rather than rendering an empty screen — the prototype keeps no state
across reloads.

Registry picks and custom URLs converge: both become an added integration with
one `default` account reading Needs auth. Only the detail header differs, naming
where the definition came from.

## Fidelity

- The curated preset list is imported from the real plugin modules
  (`@executor-js/plugin-openapi/presets`, `@executor-js/plugin-mcp/presets`),
  so it is the list the console shows, in the console's order.
- UI primitives and design tokens are imported from `@executor-js/react`, not
  copied — the reproduction uses the same buttons, dialogs, card stacks, tabs
  and tokens as the console.
- The catalog search calls the real `integrations.sh/api/search` with the same
  250ms debounce and 2-character minimum.
- Screen structure and copy are transcribed from the source components named in
  the inspector.

What is faked: the workspace's own data (integrations, connections, tools) and
every mutation. Adding an integration waits and moves on; nothing persists.

`fixtures.ts` also exposes two integrations.sh endpoints the console does **not**
use today — `fetchCatalogDomains` (the whole ~3.4k-domain popularity-sorted
registry) and `fetchSurfaceCredentials` (per-domain credential label, the URL
that mints the key, and setup instructions). They are unused by the
reproduction and present as raw material for the rework.

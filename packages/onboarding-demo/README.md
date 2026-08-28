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
step through them. The right-hand panel names the route and source component
each screen was reproduced from, and quotes the first-run reactions recorded
against it.

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

# Browser bridge (path B reverse)

Completes the loop between **Executor Browser** (Chrome extension) and self-hosted Executor:

```text
Agent  →  tools.chrome.*  →  callTool(store)
                                 │
Extension ← long-poll jobs ←─────┘
    │
    └── POST result
```

## HTTP (extension)

All routes require the same auth as `/api/*` (API key as `Authorization: Bearer` or `x-api-key`).

| Method | Path | Role |
|--------|------|------|
| `POST` | `/api/browser-bridge/session` | Open reverse session |
| `GET` | `/api/browser-bridge/session/:id/jobs?waitMs=25000` | Long-poll jobs |
| `POST` | `/api/browser-bridge/session/:id/result` | `{ jobId, result }` |
| `DELETE` | `/api/browser-bridge/session/:id` | Close |
| `GET` | `/api/browser-bridge/sessions` | List mine |
| `POST` | `/api/browser-bridge/call` | Agent HTTP: enqueue + wait |

## Agent tools (MCP / execute)

Static integration **`chrome`**:

- `status` — live sessions
- `call` — `{ tool, args }` generic
- `snapshot` / `navigate` / `click` / `type` — convenience

Requires a live extension reverse session for the **same user** as the API key.

## Deploy

Enabled on `apps/host-selfhost` via `executor.config.ts`. Rebuild and restart the lab container / process after merging.

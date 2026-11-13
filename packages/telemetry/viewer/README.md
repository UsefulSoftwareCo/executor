# Telemetry viewer

The trace and log viewer for the bundled telemetry collector. Its source is Motel's `web/`
viewer at the revision `packages/telemetry/motel/source.json` pins, under Motel's MIT license
(`LICENSE`). The AI calls page is removed, and `src/contracts/api.ts` declares only the routes the
viewer reads, with the response shapes that Motel revision returns.

Nothing serves this build yet: Motel still serves its own viewer.

## Build

```sh
bun run --cwd packages/telemetry/viewer build
```

This writes `packages/telemetry/dist/collector/viewer/`: `index.html` and hashed files under
`assets/`.

## Serving

The viewer must be served at the origin root, beside the API it reads:

- `index.html` for `/`, `/traces`, `/trace/<id>` and `/logs`
- the files under `/assets/`
- `GET /api/services`, `/api/traces`, `/api/traces/<id>`, `/api/traces/<id>/logs` and
  `/api/logs` on the same origin

For development, `COLLECTOR_URL=http://127.0.0.1:<port> bun run --cwd packages/telemetry/viewer dev`
forwards `/api` to a running collector.

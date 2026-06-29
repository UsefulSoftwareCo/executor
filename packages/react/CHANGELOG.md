# @executor-js/react

## 1.4.44

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.24
  - @executor-js/api@1.4.44

## 1.4.43

### Patch Changes

- [#1199](https://github.com/RhysSullivan/executor/pull/1199) [`29936d5`](https://github.com/RhysSullivan/executor/commit/29936d5981256f8f953797d9ce8ce073ac6a0b6a) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Notify when a newer Executor is published. The CLI now prints an "update available" line under its ready banner, and the web shell's sidebar update card works for real (a new `/v1/app/npm/dist-tags` endpoint backs it). In the desktop app the card shows a native "Restart to update" action wired to the in-app updater instead of the npm command. The check is best-effort and offline-safe, and can be disabled with `EXECUTOR_DISABLE_UPDATE_CHECK`.

- Updated dependencies [[`29936d5`](https://github.com/RhysSullivan/executor/commit/29936d5981256f8f953797d9ce8ce073ac6a0b6a), [`29936d5`](https://github.com/RhysSullivan/executor/commit/29936d5981256f8f953797d9ce8ce073ac6a0b6a)]:
  - @executor-js/api@1.4.43
  - @executor-js/sdk@1.5.23

## 1.4.42

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.22
  - @executor-js/api@1.4.42

## 1.4.41

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.21
  - @executor-js/api@1.4.41

## 1.4.40

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.20
  - @executor-js/api@1.4.40

## 1.4.39

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.19
  - @executor-js/api@1.4.39

## 1.4.38

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.18
  - @executor-js/api@1.4.38

## 1.4.37

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.17
  - @executor-js/api@1.4.37

## 1.4.36

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.16
  - @executor-js/api@1.4.36

## 1.4.35

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.15
  - @executor-js/api@1.4.35

## 1.4.34

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.14
  - @executor-js/api@1.4.34

## 1.4.33

### Patch Changes

- Updated dependencies []:
  - @executor-js/api@1.4.33
  - @executor-js/sdk@1.5.13

## 1.4.32

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.12
  - @executor-js/api@1.4.32

## 1.4.31

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.11
  - @executor-js/api@1.4.31

## 1.4.30

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.10
  - @executor-js/api@1.4.30

## 1.4.29

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.9
  - @executor-js/api@1.4.29

## 1.4.28

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.8
  - @executor-js/api@1.4.28

## 1.4.27

### Patch Changes

- Updated dependencies [[`7cee242`](https://github.com/RhysSullivan/executor/commit/7cee242f07687b0d8711201c620d8c61594adc15), [`7cee242`](https://github.com/RhysSullivan/executor/commit/7cee242f07687b0d8711201c620d8c61594adc15)]:
  - @executor-js/sdk@1.5.7
  - @executor-js/api@1.4.27

## 1.4.26

### Patch Changes

- [#943](https://github.com/RhysSullivan/executor/pull/943) [`f485e4a`](https://github.com/RhysSullivan/executor/commit/f485e4a23cf3756b9e628cf2d9242fbc0b3da178) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **One auth model across OpenAPI, GraphQL, and MCP**
  - Every protocol plugin now stores the same placements-based auth methods (the new `@executor-js/sdk/http-auth` vocabulary): an API-key method carries any mix of header and query placements, each rendered from its own credential input — so one source can declare OAuth, a bearer-header-plus-team-id-query method, a plain bearer, and a query token side by side, and one connection can carry several values (e.g. both Datadog keys).
  - MCP and GraphQL gain what only OpenAPI could do before: multi-placement methods, query-parameter credentials (servers like ui.sh's `?token=`), and multi-input connections. Rendering, catalog projection, slug normalization, and the React method editor/codec are shared instead of triplicated; the connect modal collects one value per input.
  - Invoking with an unresolvable credential input now fails with `connection_value_missing` (naming the missing inputs) instead of silently dialing unauthenticated.
  - Stored integration configs are rewritten to the canonical shape by a one-off migration: local and self-host run it automatically at startup; cloud operators run `bun run db:migrate-auth:prod` before deploying. Connection bindings and stored credential values are preserved exactly.
  - Authoring: apikey methods are authored in ONE request-shaped dialect on every plugin — it reads like the request it produces: `{ type: "apiKey", headers: { Authorization: ["Bearer ", variable("token")] }, queryParams: { team_id: [variable("team_id")] } }` (`variable()` is exported from each plugin; a plain-string value is a static literal). Inputs normalize to the canonical placements model, which is what stored configs and the catalog read as. Authoring is strict where the renderer is: a value carries at most one variable, as the final part.
  - Every method is keyed by `kind` — OpenAPI's oauth templates re-key from the retired `type: "oauth"` spelling to `kind: "oauth2"` (matching MCP/GraphQL); the one-off migration rewrites stored entries.
  - Breaking (wire): the retired single-placement inputs (`headerName` on MCP, `in`/`name` on GraphQL), raw canonical-placement inputs, and `type: "oauth"` oauth inputs are rejected. The `mcp.addServer` singular `auth` shorthand still works.

- Updated dependencies []:
  - @executor-js/sdk@1.5.4
  - @executor-js/api@1.4.26

## 1.4.25

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.3
  - @executor-js/api@1.4.25

## 1.4.24

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.2
  - @executor-js/api@1.4.24

## 1.4.23

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.1
  - @executor-js/api@1.4.23

## 1.4.22

### Patch Changes

- Updated dependencies [[`7d7fbbd`](https://github.com/RhysSullivan/executor/commit/7d7fbbda9c0912e70334dcc809ec755ba3328f68), [`1ba0193`](https://github.com/RhysSullivan/executor/commit/1ba01932919e6aee25a76c4c093841df8539adad)]:
  - @executor-js/sdk@1.5.0
  - @executor-js/api@1.4.22

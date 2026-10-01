# Cloud coexistence identity endpoint

`GET /__coexistence/identity?kind=browser|mcp&organization=<id-or-slug>` is a
private bridge for the separate cloud coexistence router. It is disabled unless
`EXECUTOR_COEXISTENCE_KEY` is configured with at least 32 characters. The caller
must supply that key as `x-executor-coexistence-key`.

Browser requests validate the existing sealed WorkOS session and current org
membership. An omitted org uses the session's selected org. MCP requests use the
existing MCP credential validator and explicit organization selector; cookies do
not authenticate MCP requests. Existing WorkOS JWT and API-key behavior remains
owned by that validator.

The response contains only `userId`, `organizationId`, `organizationSlug` and
`role`. It never returns emails, cookies or credentials. Missing/wrong bridge
keys receive 404, invalid credentials 401, inaccessible orgs 403, and dependency
failures 503. All replies have `Cache-Control: no-store`.

This endpoint does not freeze or migrate data, change domains, or authorize a
cutover. No production deployment accompanies it. Configure the key only on the
intended backends and gateway; never in a browser bundle. The gateway must strip
private bridge headers from public traffic.

Verification: from `e2e`, run
`../node_modules/.bin/vitest run --project cloud cloud/coexistence-identity.test.ts`.
The scenario uses the real v1 Cloud runtime and WorkOS emulator, testing session
validation, cross-org denial, private-header protection and cookie-only MCP denial.

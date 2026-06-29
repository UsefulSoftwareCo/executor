// Dev-server API entry. `vite.config.ts`'s `executorApiPlugin` dynamically
// imports THIS module (via a computed specifier) at request time under
// `bunx --bun vite dev`, kept separate from the static config graph so Vite's
// Node-based config loader does not follow `@executor-js/host-mcp`'s
// extensionless re-exports (which resolve under Bun, not Node ESM).
export { makeSelfHostApiHandler } from "../app";

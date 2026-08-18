// TanStack Start's internal virtual server-entry modules (registered by the
// Start vite plugin; the same ids `start-server-core`'s `loadEntries`
// imports). server.ts imports them to time module evaluation separately from
// first-request app initialization — only the evaluation side effect matters,
// so the value shape is left untyped. Kept in a standalone declaration file:
// shorthand ambient modules only register from a non-module file
// (env-augment.d.ts is a module).
declare module "#tanstack-router-entry";
declare module "#tanstack-start-entry";

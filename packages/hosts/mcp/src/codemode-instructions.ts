/**
 * The server `instructions` for codemode (sandbox) sessions: the shortest
 * path from a request to a call, mirroring `passthroughInstructions`. Every
 * byte is loaded into each client session, so the long guide stays behind
 * `skills({ name: "execute" })`.
 */
export const codemodeInstructions = (): string =>
  [
    "Executor runs tools of connected integrations inside `execute` (a TypeScript sandbox). Fastest path, one call:",
    '1. `const { items } = await tools.search({ query: "<action words>", namespace: "<integration slug or alias>", limit: 3 });`',
    '2. `if (!items[0]) return "no matching tool"; return await tools[items[0].path]({ ...arguments });`',
    "`namespace` accepts the slug or an unambiguous alias (`gmail` resolves to `google_gmail`); the `execute` description lists the connected integrations. Omit `namespace` when the integration is unknown.",
    "Call `tools.describe.tool({ path })` only when the argument shape is unknown. Results are `{ ok: true, data }` or `{ ok: false, error }`.",
    'Read `skills({ name: "execute" })` once per session for files, `emit`, pagination, and resume.',
  ].join("\n");

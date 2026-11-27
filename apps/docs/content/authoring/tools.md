---
title: Tools, routers, and schemas
description: "Declare queries, mutations, nested routers, dynamic routers, schemas, app icons, and caching in an Executor app."
slug: "/build/tools"
---

An Executor app publishes tools by placing `query` and `mutation` operations inside its `tools` router in `index.ts`. Operations declare typed `input` and `output` schemas (`object`, `string`, `number`, `boolean`, `array`, `record`, `literal`, `json`, `jsonSchema`), nest under `router` or `dynamicRouter`, and can declare `icons` and use `ctx.cache`. These APIs work on **Local**, **Self-host**, and **Cloud**.

**The step that matters most:** mount tools under `tools: router({ ... })` in `defineApp`, using `query` for reads and `mutation` for writes.

**Prerequisites:** an app you can edit and deploy. See [Build an app](/docs/build).

**You'll know it worked when…** after `executor apps deploy`, the tool paths appear on the **Tools** tab and in `tools.search`, and running a query returns validated output.

## How to use it

The authoring API is the same across **Local**, **Self-host**, and **Cloud**; deploy using your target's workflow in [Build an app](/docs/build#deploying).

### Queries and mutations

- **`query(options, run)`** declares a read operation. It receives a read-only SQL handle (each `ctx.sql.exec` runs in a transaction that rolls back, and row-changing statements fail), `ctx.fetch`, `ctx.cache`, `ctx.signal`, and any declared accounts. A query can still call external APIs.
- **`mutation(options, run)`** declares a write operation. It receives a writable SQL handle (`ctx.sql.exec` and `ctx.sql.transaction`), `ctx.fetch`, `ctx.cache`, `ctx.signal`, `ctx.elicit`, and any declared accounts.

Both accept `{ title?, description?, annotations?, input, output?, approval? }` and an `async (ctx, input) => result` handler. Use `decodeJson(response, schema)` to decode HTTP JSON responses with safe status and parse errors (`ResponseStatusError` and `ResponseDecodeError`).

### Schemas

Use the schema builders exported from `apps`:

- Primitives and containers: `string(options?)`, `number(options?)`, `boolean(options?)`, `literal("open")`, `array(schema)`, `object({ ... })`, `record(schema)`, `json()`, and `jsonSchema(rawJsonSchema)`.
- Pass `{ title, description }` to `string()`, `number()`, or `boolean()` (and `minLength` to `string()`), and chain `.optional()` or `.default(value)` on any schema.
- Always declare `input` (use `object({})` when a tool takes no arguments). Declare `output` whenever the result shape is known so the host validates responses and exposes output types to agents.

### Routers and dynamic routers

Mount operations and sub-routers with `router(children, options?)`:

- Nested keys become dotted tool paths: `router({ issues: router({ list, close }) })` publishes `issues.list` and `issues.close`.
- Router options are `title`, `description`, `instructions`, `icons`, and `tags` (a map of tag name to description). Agents see each router's `title` and `description` beside its tools, and `instructions` becomes a skill (see [Ship skills with an app](/docs/build/skills)).
- Use `router(existingRouter, options)` to override metadata on an imported router, and `renameTools(source, fn)` to rename tools from an imported router.
- Use `dynamicRouter({ list, resolve, meta? })` for tools discovered at runtime from an external service or connected account. `list()` returns tool metadata with names relative to the router. Set `readOnly: true` for queries. `resolve(name)` returns the corresponding query or mutation declaration, or `undefined`. Optional `meta()` returns router options. All three callbacks may return promises. If TypeScript cannot infer a standalone router's handler context, pass the context type explicitly, for example `dynamicRouter<QueryContext>(…)` for a query-only router.

### Icons and cache

- Declare app icons in the first argument of `defineApp` (`defineApp({ icons: [...] }, { tools })`), or declare router icons with `router(children, { icons: [...] })`. Each icon is `{ src, mimeType?, sizes?, theme?: "light" | "dark" }`.
- Use `ctx.cache` (`get`, `revalidate`, `read`, `readMany`, `write`, `invalidate`, `forAccount`) to cache expensive reads or upstream schemas across invocations. For reads tied to a selected account, call `ctx.cache.forAccount(account)`. It scopes entries by account identity, method, and credential generation.

## Example

Save this file as `index.ts` beside the pinned `package.json` from [Build an app](/docs/build) (with `dependencies.apps` set to the version from `executor apps framework`). GitHub's public API must be reachable from your Executor host.

```ts index.ts
import {
  array,
  decodeJson,
  defineApp,
  literal,
  number,
  object,
  query,
  router,
  string,
} from "apps";

const issueSchema = object({
  number: number(),
  title: string(),
  state: literal("open").optional(),
});

const listIssues = query(
  {
    description: "List open issues for a public GitHub repository",
    input: object({
      owner: string({ description: "Repository owner" }),
      repo: string({ description: "Repository name" }),
    }),
    output: object({ issues: array(issueSchema) }),
  },
  async ({ cache }, { owner, repo }) => {
    const issues = await cache.get({
      key: ["github-issues", owner, repo],
      schema: array(issueSchema),
      freshFor: "5 minutes",
      staleFor: "1 hour",
      load: async ({ fetch, signal }) => {
        const res = await fetch(
          `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=open&per_page=10`,
          {
            headers: {
              Accept: "application/vnd.github+json",
              "User-Agent": "executor-app",
            },
            signal,
          },
        );
        return decodeJson(res, array(issueSchema));
      },
    });
    return { issues };
  },
);

export default defineApp(
  {
    icons: [
      {
        src: "https://github.githubassets.com/favicons/favicon.svg",
        mimeType: "image/svg+xml",
        theme: "light",
      },
    ],
  },
  {
    tools: router({
      issues: router(
        { list: listIssues },
        {
          title: "GitHub issues",
          description: "Inspect issues in a public repository.",
        },
      ),
    }),
  },
);
```

Create and deploy the folder as **GitHub Issues**, then call `issues.list` for a public repository and check that it returns an `issues` array:

```bash
APP_ID=$(executor apps create --name "GitHub Issues" --files ./github-issues | node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).id')
executor apps deploy --app "$APP_ID" --files ./github-issues
executor execute --code 'return await tools["github-issues"].issues.list({ owner: "jqlang", repo: "jq" })'
```

## Limits

- **Router keys:** each key must match `/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/` (1 to 100 characters, no dots). `__proto__`, `constructor`, and `prototype` are reserved. Mount each mutation at one path only.
- **No automatic approval inference:** marking an operation as `query` or setting `annotations: { readOnlyHint: true }` does not configure approval behavior; annotations are advisory metadata only. Configure approvals explicitly as described in [Input prompts and tool approvals](/docs/build/input-and-approvals).
- **App icons:** an app can declare up to 8 icons whose serialized JSON is at most 32,768 characters as counted by JavaScript's `String.length`. Each `src` must be an `https:` URL or a base64 `data:image/svg+xml`, `image/png`, `image/webp`, or `image/jpeg` URI.
- **Cache bounds:** the app's cache holds at most 100,000 entries and 128,000,000 bytes in total, and each cache entry holds up to 2 MB.
- **Per-`exec` SQL boundaries:** each query `ctx.sql.exec` runs in a transaction that rolls back. Each mutation `ctx.sql.exec` outside `ctx.sql.transaction(...)` commits independently of the handler's other `exec` calls; see [App storage and SQLite](/docs/build/storage).

## Related

- [Build an app](/docs/build)
- [Accounts and providers](/docs/build/accounts)
- [Input prompts and tool approvals](/docs/build/input-and-approvals)
- [Tools and approvals](/docs/concepts/tools-and-approvals)

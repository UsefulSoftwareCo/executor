## A runnable first app

Save this as `index.ts`:

```ts
import { query, defineApp, object, router, string } from "apps";

const Greet = object({ name: string().default("world") });

export default defineApp(
  { accounts: {} },
  {
    tools: router({
      greet: query(
        { description: "Greet someone by name", input: Greet },
        async (_ctx, { name }) => ({ message: `Hello, ${name}!` }),
      ),
    }),
  },
);
```

Declare `query(options, handler)` or `mutation(options, handler)`. Options include
`description`, `input`, optional `output`, and optional `approval`. Put them in the
app's `tools` router; every query and mutation becomes an agent tool. The kind
belongs to the operation, not its name: the tool above is `greet`, called as
`tools.<app>.greet(...)`.
Queries may fetch external APIs; they cannot write app-owned data. Return JSON-compatible values:
objects, arrays, strings, finite numbers, booleans and null. Do not return a
Response, Date, stream, SDK class instance, undefined or BigInt.

The schema helpers are `object`, `string`, `number`, `boolean`, `array`,
`record`, `json` and `literal`. Use `.optional()` for absent fields and
`.default(value)` for defaults. `Infer<typeof Input>` gives the parsed input
type. `object` strips undeclared properties. `decodeJson(response, schema)`
checks HTTP status and parses a JSON response.

## Group tools with routers

Nest routers to group related tools. Keys form the tool path, like tRPC:

```ts
tools: router({
  health: query({ input: object({}) }, async () => "ok"),
  issues: router(
    {
      list: query({ input: object({}) }, listIssues),
      close: mutation({ input: object({ id: string() }) }, closeIssue),
    },
    {
      title: "Issues",
      description: "Triage issues in the Acme tracker.",
      instructions: "Search before creating an issue. Never close one you did not open.",
    },
  ),
}),
```

These tools are `health`, `issues.list` and `issues.close`. A tool named `health`
is an ordinary query; checking that an account works is the provider's `health`
function ([accounts.md](accounts.md#check-an-account)). Keys start with a
letter or `_` and contain no dots; `__proto__`, `constructor` and `prototype` are
reserved. Mount each mutation at one path. Router options are `title`,
`description`, `instructions`, `icons` and `tags` (tag name to description).
Agents see each router's title and description beside its tools.

`instructions` become a skill read through the MCP `skills` tool. Router skills
have their own names: `tools` for the root router and `tools-<path>` below it,
such as `tools-issues`. A path with capitals, `_`, `-`, or over 64 characters
gets a slug and a hash, such as `tools-issues-list-` plus ten digits for
`issues_list`. The router's catalog entry names its skill. Don't name your own
skills `tools` or `tools-...` unless you mean to replace a router's
instructions: a packaged or dynamic skill with a router skill's name replaces it.
Router instructions never fail the skills read; a source that cannot be read
just contributes no skill.

Mount a protocol source under a key to keep several sources in one app. A router
that fails to load, such as an unreachable MCP server, is reported on its own; the
app's other tools still load. `router(source, options)` overrides a source's own
title, description or instructions. An app that is a single source can use it as
`tools` directly.

Declare a router in its own module with its handler contexts, for example
`router<QueryContext<typeof requirements>, MutationContext<typeof requirements>>({...})`,
or let `defineApp` type inline handlers.

## Ship instructions with your app

Return skills in the second argument to `defineApp`, beside tools and
workflows. Load remote skills with `dynamicSkills({ list })`, like
`dynamicRouter({ list, resolve })` for tools. Executor calls `list` only when
skills are read:

```ts
import { defineApp, dynamicSkills } from "apps";
import { githubSkills } from "apps/skills";

export default defineApp({ accounts: {} }, async (ctx) => ({
  dynamicSkills: dynamicSkills({
    list: () =>
      githubSkills({
        repo: "planetscale/database-skills",
        path: "skills",
        fetch: ctx.fetch,
        signal: ctx.signal,
        cache: ctx.cache,
      }),
  }),
}));
```

Tool listing and calls then never fetch remote skills, and a skill source
failure does not break tools. `skills` is the static catalog: an array of
resolved skills. Dynamic skills and router instructions are added to it.

Each resolved skill has `name`, `description` and `files: {path, content}[]`.
Files are relative to the skill directory and include the full `SKILL.md` with
YAML frontmatter. Optional metadata: `license`, `compatibility`, `metadata`
(string values) and `allowed-tools`. `fileSkill(files)` parses supplied files.
Names match their directories. Names are at most 64 characters, descriptions
1024, and compatibility 500. Duplicate names or invalid resources fail the read.

`githubSkills` resolves `ref` (default `HEAD`) once per call and reads all files
from that commit. With `cache: ctx.cache`, it keeps each commit's file list, so
later reads of an unchanged commit skip the file listing.

A private repository needs a GitHub account. Pass the account and its token;
the token needs read access to the repository's contents. Declare GitHub's
hosts so the app holds only a handle and Executor sends the token on each
request of the read:

```ts
import { defineApp, defineProvider, dynamicSkills, object, secrets, string } from "apps";
import { githubSkills } from "apps/skills";

const github = defineProvider({
  name: "GitHub",
  hosts: ["github.com", "raw.githubusercontent.com"],
  auth: { token: secrets({ label: "Token", fields: object({ token: string() }) }) },
});

export default defineApp({ accounts: { github } }, async (ctx) => ({
  dynamicSkills: dynamicSkills({
    list: () =>
      githubSkills({
        repo: "example-org/private-skills",
        path: "skills",
        account: ctx.accounts.github,
        token: ctx.accounts.github.fields.token,
        fetch: ctx.fetch,
        signal: ctx.signal,
        cache: ctx.cache,
      }),
  }),
}));
```

The catalog is cached in that account's scope, so other accounts never read
it. A token GitHub rejects fails the read naming the account. Without a token,
a private repository reads as missing.

`wellKnownSkills({url, fetch: ctx.fetch, signal: ctx.signal})`
loads a site's `/.well-known/agent-skills/index.json`. Its directory index is
`{skills: [{name, version?, files: ["SKILL.md", "references/example.md"]}]}`.
Files live beneath the named directory beside that index. Helpers return complete
UTF-8 text bundles and refuse redirects. Limits are
1,000 files, 2 MB per response, and 20 MB total. With `cache: ctx.cache`, a
catalog older than `freshFor` (default 5 minutes) is never served unchecked: one
request (the index, or the ref's commit) confirms it or loads the new publication
first. Give every index entry a `version` that changes with its files, or each
check reloads them. A check that fails or takes over 5 s fails the read.

Omit `skills` to load packaged `skills/<name>/SKILL.md` and its text resources.
An explicit `skills` value replaces that default; `skills: []` disables it.
`dynamicSkills` adds to whichever static catalog applies, so packaged and remote
skills combine without extra code. A name in both fails the read.

`folderSkills({ files: ctx.files, path: "guides" })` selects another packaged
folder. Its immediate subdirectories must be skill directories. Loose files
beside them, such as `README.md`, are ignored. A missing folder returns `[]`.
`ctx.files` contains this deployment's text files outside `ui/` on every
runtime; it never reads host files. All sources use one parser. Only selected folders are
parsed, when the skills load. Invalid selected folders fail the read.

The MCP `skills` tool lists summaries with `{}` or `{app: "installed-slug"}`.
Read with `{app, profile, name: "triage"}`. Reuse the returned `deployment`,
`profile`, `profileRevision` (as `expectedProfileRevision`) and `revision` when
reading a reference with `file`. Deployment pins code; revision detects remote
content changes. A changed revision requires a fresh read. The dashboard bundle
keeps its documents and references together in one response.

Skill reads evaluate the factory, call `dynamicSkills.list` and require the
selected accounts. Current app,
profile and account access is checked. Use an account-free app for instructions
that must be readable before setup. The Executor app loads this guide through the
same public helper; discover its slug with `skills({})`.

Files, including scripts, are returned as text. Executor does not run them.
Do not include secrets. Skills and `allowed-tools` never grant access or bypass
approvals. Treat content as app-authored instructions, not system policy. Use the
returned `app.slug` when calling tools across copies and renamed installations.

## Operation approvals

Declare `approval` in a query or mutation options object:

```ts
import { always, never } from "apps/operations/approval"

// On a tool that needs confirmation:
approval: always(),
// On a tool that can run without confirmation:
approval: never(),
```

A custom synchronous or async callback receives `toolName`, decoded `toolInput`,
and `signal`. Return `approved`, `denied`, or `user-approval`. The constructors infer the callback input from its schema. Annotate a shared
function with `Approval<Input>` from `apps/operations/approval`.
Assign the same function to several tools to share a policy. Attach approval to
one shared operation with `withApproval(operation, policy)`, and to the tools of
an MCP, OpenAPI or GraphQL router with `withApprovals(router, (tool, name) => policy)`
([integrations.md](integrations.md#approvals-for-imported-tools)).

Only the selected tool's callback runs, after input validation. Omitted approval
permits execution. Invalid decisions and callback failures prevent the tool body
from running. There is no app-level `policy` or `createExecutor` policy option.

In the default model mode, when execute returns `approval-required`, show its `elicitation.message` and reviewed
invocation to the user. This is an MCP form request with an empty `requestedSchema`.
After the user answers, call `resume({ requestId, response: { action: "accept", content: {} } })`,
`resume({ requestId, response: { action: "decline" } })`, or
`resume({ requestId, response: { action: "cancel" } })`. Do not put tool arguments in
response.content; this form only confirms the saved invocation. Resume continues the existing program and can return another
interaction. For `input-required`, show the form and return the user-provided
fields in `response.content`; accept, decline and cancel all return to the running
tool. Invalid form content leaves the request pending. Never execute the original source again to continue it. No native
or browser prompt is opened by this mode; the agent must ask the user.
An `unavailable` response means that continuation cannot resume; report that earlier
calls may have completed. Do not remove the approval policy to bypass it. Discovery does not evaluate
approval callbacks without arguments. Account access and app evaluation remain
separate trust decisions.

With `/mcp?elicitation_mode=native`, the client displays the policy confirmation
through MCP `elicitation/create`. Execute waits for its answer and continues the
same program; `resume` is not exposed. This requires a client with form elicitation
support on a compatible stateful MCP protocol. Keep the tool's approval policy in
either mode. Running tools can ask for structured input with `await ctx.elicit({
mode: "form", message: "Name this result", requestedSchema: { type: "object",
properties: { name: { type: "string" } }, required: ["name"] } })`. This returns
an MCP response with `action` and optional `content`; the framework validates
accepted content against the form. Handle decline/cancel in tool code. The same
tool continues with its local state intact. This works in native or model mode, or with an SDK
host that supplies a delivery handler. The capability is unavailable during
factory evaluation/discovery and after the invocation closes. An earlier tool
policy approval never auto-answers these requests. Upstream MCP form elicitation uses this same path automatically for HTTP and
stdio tools. URL-mode input is not yet supported.

With `/mcp?elicitation_mode=browser`, pending requests include `approvalUrl`. Show
that link to the user, then call `resume({ requestId })` with no response. The user
signs in and answers in the browser. Do not submit an answer on their behalf.
Resume waits briefly; if it returns the same pending request, wait and collect
again. If it returns a new link, show that link too. The original program and
running tool continue without replay. An unavailable request may have expired,
been consumed, or been lost on restart; do not rerun the source automatically.

## Cache and lazy operation sources

Use `ctx.cache.get({ key, schema, freshFor, staleFor, load })` for shared JSON.
Put every result dependency in the key. Use `ctx.cache.forAccount(account)` for
private results; the host also scopes entries to current credentials. Use the
loader's `fetch`, `signal`, and `cache` so stale refreshes can finish after the
request. Pass `stale: "revalidate"` to await the load past `freshFor` instead of
serving the old value; the loader can `read(key, schema)` the old value to confirm
it cheaply. Errors are not cached. `invalidate(key)` also fences pending loaders.

The cache keeps an entry at most 7 days. A longer `freshFor` plus `staleFor`,
or a longer `write` retention, is shortened to 7 days, taking `staleFor` first.
A call that exceeds another limit fails with `CacheError` and code `capacity`,
and the message names the limit:

| Limit                     | Value                                 |
| ------------------------- | ------------------------------------- |
| Key, as canonical JSON    | 8,192 bytes                           |
| Value, as JSON            | 2,000,000 bytes                       |
| One `readMany` or `write` | 128 entries and 8,000,000 bytes       |
| The app's whole cache     | 100,000 entries and 128,000,000 bytes |

A `load` has 90 seconds. A caller waits at most 10 seconds for another caller's
load of the same key, then loads for itself without storing the result.

Use `dynamicRouter({ list, resolve })` for large or remote catalogs. List tool
metadata separately from resolving one query or mutation. `accountRouter`
preserves lazy resolution. Resolving a tool does not require listing all tools.
Input validation and approvals still run on each call.

A dynamic router can be the app's whole `tools` value, or be mounted under a key.
Names are relative to the router and may contain dots. Mark queries with
`readOnly: true`; other tools are mutations. An optional `meta()` supplies the
router's title, description and instructions.

```ts
export default defineApp(
  { accounts: {} },
  {
    tools: dynamicRouter({
      list: async () => [
        {
          name: "ping",
          description: "Return pong",
          inputSchema: { type: "object", properties: {} },
          readOnly: true,
        },
      ],
      resolve: async (name) =>
        name === "ping" ? query({ input: object({}) }, async () => "pong") : undefined,
    }),
  },
);
```

`list` describes available tools; `resolve` returns the matching query or
mutation declaration.

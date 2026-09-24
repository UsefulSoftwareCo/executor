## A runnable first app

Save this as `index.ts`:

```ts
import { query, defineApp, object, string } from "apps";

const Greet = object({ name: string().default("world") });

export default defineApp(
  { accounts: {} },
  {
    queries: {
      greet: query(
        { description: "Greet someone by name", input: Greet },
        async (_ctx, { name }) => ({ message: `Hello, ${name}!` }),
      ),
    },
  },
);
```

Declare `query(options, handler)` or `mutation(options, handler)`. Options include
`description`, `input`, optional `output`, and optional `approval`. Put the result
in the matching `queries` or `mutations` catalog. Both become agent tools.
Queries may fetch external APIs; they cannot write app-owned data. Return JSON-compatible values:
objects, arrays, strings, finite numbers, booleans and null. Do not return a
Response, Date, stream, SDK class instance, undefined or BigInt.

The schema helpers are `object`, `string`, `number`, `boolean`, `array`,
`record`, `json` and `literal`. Use `.optional()` for absent fields and
`.default(value)` for defaults. `Infer<typeof Input>` gives the parsed input
type. `object` strips undeclared properties. `decodeJson(response, schema)`
checks HTTP status and parses a JSON response.

## Ship instructions with your app

Return resolved skills in the second argument to `defineApp`, beside queries,
mutations and workflows. Load a published GitHub directory inside the factory:

```ts
import { defineApp } from "apps";
import { githubSkills } from "apps/skills";

export default defineApp({ accounts: {} }, async (ctx) => ({
  skills: await githubSkills({
    repo: "planetscale/database-skills",
    path: "skills",
    fetch: ctx.fetch,
    signal: ctx.signal,
  }),
}));
```

Each resolved skill has `name`, `description` and `files: {path, content}[]`.
Files are relative to the skill directory and include the full `SKILL.md` with
YAML frontmatter. Optional metadata: `license`, `compatibility`, `metadata`
(string values) and `allowed-tools`. `fileSkill(files)` parses supplied files.
Names match their directories. Names are at most 64 characters, descriptions
1024, and compatibility 500. Duplicate names or invalid resources fail the read.

`githubSkills` resolves `ref` (default `HEAD`) once per call and reads all files
from that commit. `wellKnownSkills({url, fetch: ctx.fetch, signal: ctx.signal})`
loads a site's `/.well-known/agent-skills/index.json`. Its directory index is
`{skills: [{name, version?, files: ["SKILL.md", "references/example.md"]}]}`.
Files live beneath the named directory beside that index. Helpers return complete
UTF-8 text bundles, refuse redirects, and keep no persistent cache. Limits are
1,000 files, 2 MB per response, and 20 MB total.

Omit `skills` to load packaged `skills/<name>/SKILL.md` and its text resources.
An explicit `skills` value replaces that default; `skills: []` disables it.
To combine packaged and remote skills, use the same folder loader explicitly:

```ts
import { defineApp } from "apps";
import { folderSkills, githubSkills } from "apps/skills";

export default defineApp({ accounts: {} }, async (ctx) => ({
  skills: [
    ...(await folderSkills({ files: ctx.files })),
    ...(await githubSkills({
      repo: "planetscale/database-skills",
      path: "skills",
      fetch: ctx.fetch,
      signal: ctx.signal,
    })),
  ],
}));
```

`folderSkills({ files: ctx.files, path: "guides" })` selects another packaged
folder. Its immediate subdirectories must be skill directories. Loose files
beside them, such as `README.md`, are ignored. A missing folder returns `[]`.
`ctx.files` contains this deployment's text files on every runtime; it never
reads host files. All sources use one parser. Only selected folders are
parsed, when the skills load. Invalid selected folders fail the read.

The MCP `skills` tool lists summaries with `{}` or `{app: "installed-slug"}`.
Read with `{app, profile, name: "triage"}`. Reuse the returned `deployment`,
`profile`, `profileRevision` (as `expectedProfileRevision`) and `revision` when
reading a reference with `file`. Deployment pins code; revision detects remote
content changes. A changed revision requires a fresh read. The dashboard bundle
keeps its documents and references together in one response.

Skill reads evaluate the factory and require the selected accounts. Current app,
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
MCP, OpenAPI or GraphQL operations with `withApproval(operation, policy)`.

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

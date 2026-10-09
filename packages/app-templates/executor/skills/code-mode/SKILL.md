---
name: code-mode
description: Call Executor app tools from execute. Search and signatures, slugs and profiles, unavailable apps, account connections, approvals and resume, limits and errors.
---

# Code mode

`execute` runs one JavaScript program over every app you can reach. App tools
are async functions under `tools`. One program can call several tools, combine
their results and return a small value, so large results never pass through
your context.

The interpreter has no imports, `fetch`, `process`, filesystem or timers. A
tool call is its only way out. Use `await` and `Promise.all` for independent
calls. `console.log` output comes back in `logs`. Write JavaScript; TypeScript
syntax is not portable across Executor hosts.

## Find tools and read signatures

```js
return await tools.search({ query: "send email", namespace: "gmail", limit: 5 });
```

`tools.search({ query?, namespace?, limit?, offset? })` returns one page of
ranked matches. Each item in `items` has the exact callable `path`, the first
line of its `description` and its `input` type on one line. A longer input type
is cut and marked `inputTruncated: true`. A tool that several profiles expose
with the same signature is one item, and `alsoAt` lists its other paths.
`namespaces` lists each app, profile and titled router on the page once, with
the profile's account labels, instead of repeating them in every item.

`namespace` is an app slug, such as `gmail`, or a namespace inside it. Without
it, search loads and searches every app, which is slower. A page holds at most
`limit` items, 10 by default, and stops sooner at a quarter of the output limit
(16 KB by default). `remaining` counts the matches after the page, and `next`
is the input for the following page, or `null` after the last match: call
`tools.search(next)` to continue.

Search leaves out output types and later description lines. For full detail,
pass up to 20 exact paths from search:

```js
return await tools.search.describe({ paths: ["<path from search>"] });
```

`describe` returns `items` with the whole `description` and the TypeScript
`signature`, with input and output types, plus their `namespaces`. A path that
names no tool comes back in `missing` with the closest `matches`.

Read a tool's input type before calling it; never guess argument names. Use
`describe` when the input was truncated or you need the result's shape. Each
tool takes one object. Tools generated from an API put route parameters under
`path`, query parameters under `query` and the request payload under `body`.

Prefer a narrow namespace and a small limit over broad searches, and return
only the fields you need. Call paths exactly as returned.

## Slugs and profiles

Every app has a slug, which is its namespace: `tools.<slug>`. An app without
accounts exposes `tools.<slug>.<tool>`. An app with accounts exposes one
namespace per account profile, `tools.<slug>.profiles["<profile-id>"].<tool>`;
the profile selects which saved accounts its tools use. Search results list
each profile and its accounts in `namespaces`. Use the one the user means and
ask when it is unclear. The `skills` tool takes the same slug as `app`, and
needs `profile` when an app has several.

Each execution discovers apps when the program or a search first reaches
them. After deploying or reconfiguring an app, or connecting an account, start
a new `execute` to see the change.

## Unavailable apps

Every completed result lists `unavailableApps`: apps, profiles or routers that
could not expose tools in this execution, each with a `reason`. Other apps keep
working. Search leaves out an unavailable app's tools, `describe` reports their
paths in `missing`, and calling one fails with that reason.

- `AppProfileRequired`: the app needs an account and you have no enabled
  profile. Connect an account (below), then start a new execution.
- `AppDiscoveryTimedOut`: the app did not list its tools in time. Discovery
  waits about 10 seconds, then stops once listings make no progress for 5
  seconds. A listing that was still running continues in the background, so
  retry in a new `execute` after a few seconds. If the app keeps timing out,
  tell the user its server may be down or overloaded.
- Other reasons are JSON with `code`, `message` and often `recovery`. Follow
  `recovery.instructions`.

## Connect accounts

Never ask the user to paste secrets into chat, never put credentials in tool
arguments or source, and never search their files for tokens. The Executor app
(slug `executor`) issues a secure browser link instead:

- Local: `accountConnect.issue`, then `accountConnections.get` to check it.
- Hosted: `accounts.connect`, then `accounts.connection` to check it. Hosted
  management calls need the organization: call `context.get({})` first and pass
  its `organization` as `path.organization`. For an OAuth sign-in,
  `accounts.oauthSetup` lists the scopes it will request; tell the user.

Search for these tools and read their input types first. Give the user the
returned URL. After they finish, check the connection in a new execution, then
start another to call the app's tools. Never wait or poll inside one program.

## Approvals and input

A tool can require the user's approval, and a running tool can ask for input.
The program then pauses, and `execute` returns `status: "approval-required"` or
`"input-required"` with a `requestId` and an `elicitation` describing the
question. How you answer depends on the connection's mode:

- Model mode (the default): show the request to the user and get their answer.
  Call `resume` with `{ requestId, response: { action: "accept", content } }`,
  or with `action: "decline"` or `"cancel"`. Put the user's form fields in
  `content`. Never approve on the user's behalf.
- Browser mode: the result includes `approvalUrl`. Show it to the user, who
  answers in their signed-in browser, then call `resume({ requestId })`.
- Native mode: the MCP client shows its own prompt, and `execute` continues by
  itself. There is no `resume` tool.

`resume` continues the same program and returns its next pause or its result.
Declining makes that call fail inside the program. Never run the program's
source again to continue it: earlier calls may already have taken effect.
`unavailable` means the request expired, was already answered or was lost when
the server restarted. `busy` means another `resume` is advancing the program;
wait for it.

## Limits

These are the defaults. The source limit is fixed; a host can change the others.

- Program source: 65,536 characters, including app source passed as data. With
  a shell, deploy large apps with the `executor apps` CLI instead.
- Output: 65,536 bytes for the returned value, warnings and logs together. A
  larger value comes back as a truncated string that says so. Return fewer
  fields, a count, or one page.
- Tool calls: 100 per execution.
- Time: 5 minutes per execution, including discovery. Time spent waiting for
  the user does not count.

## Read results and errors

A completed result has `execution.ok`. On success, `execution.value` holds what
the program returned. On failure, `execution.error` has a `kind`, a `message`,
and for Executor errors a `response` with `code`, `status`, `message` and
`recovery`. `recovery.action` is for the user; `recovery.instructions` are for
you. `toolCalls` lists every call in order with its `outcome`.

- `ParseError`, `UnsupportedSyntax`: fix the program; `location` points at it.
- `UnknownTool`: the path is wrong or its app did not load. Check
  `unavailableApps` and search again. `suggestions` may list close paths.
- `InvalidToolInput`, or a `response.code` of `InputInvalid`: the input does
  not match the signature; the message names the fields.
- `ToolFailure`: the tool or its service failed. Follow `recovery`.
- `ToolCallLimitExceeded`, `TimeoutExceeded`: split the work into smaller
  executions.

Calls with outcome `success` took effect, and `interrupted` calls may have.
Effects are never rolled back. Read the current state before retrying a write.
Inside a program, a caught tool error's `message` is the same JSON as
`response`, so a program can handle expected failures itself.

`status: "capacity-exceeded"` means the server is running too many programs.
Wait briefly, then retry.

Send feedback with the Executor app's `feedback.submit` tool when Executor gets
in your way or something works especially well; the `executor` skill says how.

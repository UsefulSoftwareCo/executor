---
title: The MCP endpoint
description: "One endpoint gives an agent every app you have configured, without putting a credential in the agent. Codemode, sign-in and elicitation modes explained."
---

Executor serves one MCP endpoint at `/mcp`. Every app you have configured is
reachable through it. You do not add one MCP server per service, and you do not
paste a credential into the agent.

- Hosted: `https://mcp.executor.sh/mcp`
- Self-host: `<your origin>/mcp`
- Local: `http://127.0.0.1:4312/mcp`

The transport is streamable HTTP. See
[Add an MCP client](/mcp-clients) for the exact setup commands.

## The tools

The endpoint does not expose one MCP tool per app tool. However many apps you
add, the tool list stays the same size. When a client connects, the server's
MCP instructions introduce Executor to the agent. They are the Executor app's
`executor` skill, which points to its `code-mode` and `app-authoring` skills.

- **`skills`** reads the instructions an app ships. Call `skills({})` for a list
  of what is visible, `skills({ app: "support-inbox" })` for one app's skills,
  and `skills({ app: "support-inbox", name: "triage" })` to read one. It
  connects no account and runs no code.
- **`execute`** runs a JavaScript program over your apps.
- **`resume`** continues a program that paused for an approval or for input.
  It is not present in native mode, where the client answers in place.

## Codemode

`execute` is the way an agent uses your apps. The agent writes a short
JavaScript program; Executor runs it in a sandboxed interpreter and returns what
the program returns.

Inside the program, app tools are ordinary async functions:

```js
return await tools.search({ query: "vercel projects" });
```

Search returns a page of tools: each one's exact callable path, the first line
of its description and its input type. Each app and profile is listed once.
`next` continues to the following page, and
`tools.search.describe({ paths })` returns a tool's whole signature, including
its output type. An app without accounts is called by its slug,
`tools.<app>.<tool>`. An app with accounts is called through one of your
profiles, which chooses the accounts its tools use:

```js
const projects = await tools.vercel.profiles["<profile-id>"].listProjects({});
return projects.projects.map((project) => project.name);
```

The agent can call several tools, join the results and return only the part it
needs. That is the point: the whole result set never has to pass through the
model's context.

The interpreter has no `fetch`, no `process`, no filesystem and no imports. Its
only way out is a tool call, which enters the trusted runtime where your
credentials live. Limits are cooperative, not process isolation. Discovery is
not cached across changes, so run `tools.search` again in a new `execute` after
you add or reconfigure an app.

Some limits are fixed by the server and a client cannot raise them: 65,536
characters of program source, 100 tool calls, 5 minutes, and 65,536 bytes of
output.

## Signing in from the browser

Hosted and self-host use OAuth. Your client registers itself, opens your browser
at `/mcp/authorize`, and you sign in there. You then choose an organization and
approve the connection. The client receives a token; it never receives your
password or your accounts.

The grant that comes back is bound to one
[organization](/concepts/organizations-and-access). Switching organization in
the dashboard later does not retarget an existing connection, including after
the token refreshes. To use a second organization, connect again and approve it
separately.

Every request revalidates the token, the approval and your current membership. A
revoked grant returns 401. Losing membership returns 403.

The consent screen approves every app available to you. To give an agent less,
connect it through a scoped connection instead.

## Scoped connections

A **scoped connection** is a named MCP URL that reaches only what you turned on.
Create one under **Scoped connections** on the dashboard's Connect page. For
each app, choose which of your profiles it runs as, or none for an app without
accounts, and which tools it exposes: all tools, read-only tools, or the tools
you pick. All and read-only include tools the app adds later. Approval rules
still come from each app's code.

Each connection has its own URL, `/mcp?connection=<id>`. Add
`&elicitation_mode=browser` or `native` to it for another
[mode](#elicitation-modes). The client signs in at that URL as above, and its
grant follows the connection: edits apply to connected agents at once, and
revoking the connection revokes every grant issued through it. Personal access
tokens and the local server key are not limited by a connection; they keep full
access at the plain URL.

On hosted and self-host, **Connected agents** on the same page lists each
client you approved, with the apps it can reach, and revokes its grant.

## Elicitation modes

When a tool needs an approval, or needs input, Executor has to ask you. Where
that question appears depends on the mode, which you pick in the endpoint URL
and which is then fixed in the grant.

| Mode      | URL                             | Where you answer                                                                                                                       |
| --------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `model`   | `/mcp`                          | The agent shows you the request and calls `resume` with your answer. This is the default.                                              |
| `native`  | `/mcp?elicitation_mode=native`  | Your MCP client's own prompt. The `execute` call stays open and continues. There is no `resume`.                                       |
| `browser` | `/mcp?elicitation_mode=browser` | A signed-in page in your browser. The result carries an `approvalUrl`; the agent calls `resume({ requestId })` to collect your answer. |

Native mode needs a client that implements form elicitation. Browser mode is the
one to use when you do not want the agent to be the one holding the question.

The mode is part of the grant, not just the URL. Changing the query string on an
issued connection does not change the mode.

## What is coming later

- Remembering an approval, so the same action is not asked again.
- Resuming a program after the server restarts. A lost session cannot be
  continued, and the program must not be run again automatically, because
  earlier tool calls may already have taken effect.

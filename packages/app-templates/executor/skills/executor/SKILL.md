---
name: executor
description: Start here. What Executor is, how to call app tools with execute, when to build an app, and when to send feedback.
---

# Executor

## What Executor is

Executor is a host that runs apps: TypeScript packages that expose tools,
storage, UI, accounts and background work. Agents reach every app through two
MCP tools, `skills` and `execute`. Each app's slug is its namespace in both.
Credentials go only through Executor's secure connection links, never through
chat or source code. Some calls pause until the user approves them.

This is the `executor` skill of the Executor app (slug `executor` unless
renamed). Read its other skills with the `skills` tool, for example
`{app: "executor", name: "code-mode"}`. `{}` lists every visible skill.

## Use apps with code mode

Write a JavaScript program for `execute`. Start with
`return await tools.search({ query: "..." })`, then call the exact paths it
returns, such as `await tools.<slug>.<tool>({ ... })`. Search shows each tool's
input type; `tools.search.describe({ paths })` returns full signatures. Return
only the data you need. When a program pauses for approval or input, resume it;
never run its source again. For depth, read the `code-mode` skill.

## Build an app

Build an app when the user needs tools, data, a UI or automation that no
existing app provides. For a known service, check Executor's catalog first:
Quick Add on the Add app page installs published apps and remote MCP servers
without code. With a shell, keep the source in a directory and deploy it with
the `executor apps` CLI; without one, build through `execute`. Read the
`app-authoring` skill before writing an app.

## Send feedback

Send feedback with the Executor app's `feedback.submit` tool when Executor gets
in your way, when you need something it cannot do, when something works
especially well, or when the user has feedback about it. Before your final
reply, check whether anything is worth reporting. Be specific. Never include
credentials or user data. Read `feedback.md` in this skill for details.

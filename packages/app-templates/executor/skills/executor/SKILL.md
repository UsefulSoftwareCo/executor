---
name: executor
description: Start here. What Executor is, how to find and call app tools with search, call and execute, when to build an app, and when to send feedback.
---

# Executor

## What Executor is

Executor is a host that runs apps: TypeScript packages that expose tools,
storage, UI, accounts and background work. Agents reach every app through the
MCP tools `skills`, `search`, `describe`, `call` and `execute`, with each app's
slug as its namespace. Credentials go only through Executor's secure connection
links, never through chat or source code. Some calls pause for user approval.

This is the Executor app's `executor` skill. Read its other skills with
`skills`, such as `{app: "executor", name: "code-mode"}`; `{}` lists them all.

## Find and call tools

`search({ query: "..." })` returns each tool's exact `path`, such as
`tools.<slug>.<tool>`, and input type; `describe({ paths })` returns full
signatures. Never guess argument names.

For a few independent calls, use `call({ calls: { path, input } })`; an array
of calls runs concurrently. Each result has `ok` and its `value` or `error`.

Write a JavaScript program for `execute` when one call's result feeds another,
or a large result should be filtered before it reaches you. Inside it, the same
paths are async functions, and `tools.search` and `tools.search.describe` work
as above. Return only the data you need. For depth, read the `code-mode` skill.
When `call` or `execute` pauses for approval or input, show the request to the
user and resume it; never repeat the call or run the program again.

## Build an app

Build an app when no existing app provides the tools, data, UI or automation
the user needs. For a known service, first check Quick Add on the Add app page,
which installs published apps and remote MCP servers without code. With a
shell, deploy a source directory with the `executor apps` CLI; without one,
build through `execute`. Read the `app-authoring` skill before writing an app.

## Send feedback

Send feedback with the Executor app's `feedback.submit` tool when Executor gets
in your way, can't do something you need, works especially well, or the user
has feedback. Before your final reply, check whether anything is worth
reporting. Be specific; never include credentials or user data (`feedback.md`).

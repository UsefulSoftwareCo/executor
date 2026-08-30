---
"@executor-js/sdk": patch
"@executor-js/api": patch
"@executor-js/local-app": patch
---

fix: surface executions interrupted by a daemon restart instead of losing them silently

A paused execution lives as an in-memory fiber inside the running engine. When
the local service restarts (login, crash, upgrade), every fiber is gone and a
later `executor resume` read as "approval expired" — silently discarding work
the agent believed was still pending.

Executions now write a lightweight durable tombstone (id + status +
timestamp, no arguments, no results, no secrets) at pause time. On boot the
service marks every non-terminal tombstone `interrupted`; resuming an
interrupted execution returns an explicit `InterruptedExecutionError` telling
the agent to re-trigger the action, which is safe because nothing ran.

Also adds the `@executor-js/sdk` execution-record store used by hosts that
need the same guarantee (cloud, self-host).

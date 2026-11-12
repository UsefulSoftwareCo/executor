---
"apps": patch
"@executor-js/sdk": patch
"@executor-js/app-templates": patch
---

`ctx.workflows.start`, `get`, `list` and `terminate` work again in apps built on `apps`
0.0.1-beta.91 or earlier. Since the rename of deployments to versions the host sent runs
without their former `deployment` field, so those apps could not read any answer and every
call failed as a retryable `engine` failure, even when the run had started. The host now sends
runs in their encoded form, with both names.

A control call the host refuses, such as a `key` over 128 characters, fails with reason `input`,
not retryable, and a message naming the field and the rule it broke; no run is started. A start
whose run was saved, including one whose storage failed right after the save, fails as `engine`,
not retryable, with the run's ID. A start whose commit failed or timed out answers with its run
when Executor can read it back. A start whose save may have committed, and a `start` or
`terminate` that Executor did not answer or whose answer the app could not read, are not
retryable either, and their message says the run may have started or stopped and how to check. A
start without a key is never told to start again, since that would create another run.
Executor's own errors keep their tag and message through workflow controls.

The app-authoring skill lists the workflow limits and what each control failure means.

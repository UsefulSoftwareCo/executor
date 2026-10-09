# Alchemy patch

`alchemy@2.0.0-beta.80.patch` changes both the published JavaScript (`lib/`)
and the Bun TypeScript entry points (`src/`). It carries:

- **Worker-safe runtime imports.** `Action`, `Apply`, `Output`, `PhysicalName`
  and `Resource` read the stack through `StackContext` instead of importing
  `Stack.ts`. The new `CloudflareRuntimeServices` module exports `Providers`
  and `CloudflareEnvironment` without loading every Cloudflare provider. The
  Cloud Worker reconciles app-domain DNS records with these at runtime.
- **DNS records.** `zoneName` skips the zone lookup for relative names, and
  `ownershipComment` marks records with the stack's instance ID so an
  interrupted create is recovered instead of adopting another owner's record.
- **Request lifetimes.** Service-binding fetches keep the inbound request's
  abort signal. Streamed responses end their request and event scopes when the
  client disconnects. A Durable Object's constructor resources belong to an
  instance scope that closes when construction fails.
- **Platform timing.** `platformSpan` records Worker and Durable Object phases
  (initialization, waits, handlers, cleanup) as native spans and
  `alchemy.phase` log records, so time before the Effect tracer exists is visible.
- **Local Durable Object bindings.** A local Worker declares only its own
  Durable Object namespaces, not another Worker's bindings whose script name
  is still unresolved during precreate.
- **macOS dev watching.** `Bundle.watch` on macOS rebuilds from one recursive
  `fs.watch` over the module graph's common directory instead of rolldown's
  watcher. Rolldown's FSEvents backend holds a descriptor for each watched
  directory and every ancestor up to `/`, per Worker. Cloud's local Workers
  took the dev sidecar past 10,240 descriptors, macOS `posix_spawn` refuses
  pipes above that (`OPEN_MAX`), and workerd failed with `spawn EBADF`. A load
  hook widens the watch before rolldown reads each source and records its
  stat. Changes during a build are kept and checked against the graph it
  collected, and a source whose stat changed after it was loaded rebuilds
  again, which covers edits FSEvents misses while a new stream starts.
  Renaming a directory that holds a graph file rebuilds, and so does an event
  without a file name. The watched directory's inode is polled every 500 ms:
  when it or an ancestor is moved or replaced, the graph rebuilds (a missing
  entry is reported as rolldown's own watcher does) and the watch moves to the
  nearest directory that still exists, so moving it back rebuilds again. A
  move undone between two polls keeps the inode and may send no event; the
  poll also tracks the change times of the watched directory and its
  ancestors and, when one changes, rebuilds if a source differs from what the
  last build read. Rebuilds that follow a build go through the same 50 ms
  debounce as file events, and the poll timer is unref'd.
  Plugins' `watchChange` hooks are not called; alchemy's own, which reports
  the rebuild, is the only one in use. Linux keeps rolldown's watcher. Drop
  this part when rolldown watches without per-directory descriptors on macOS.
- **One first build at a time.** `Bundle.watch` waits for its turn before a
  watcher's first build and gives it up when that build ends or fails, when
  the watcher closes or cannot start (it then reports the error), and after
  60 s at the latest: a first build that hangs keeps running, but the next one
  starts beside it and the sidecar logs a warning. A watcher closed while it
  waits leaves the queue at once. `e2e/tests/alchemy-first-builds.spec.ts`
  (`bun run e2e:alchemy-first-builds`, in the `check` job) checks these under
  Node (`lib/`) and Bun (`src/`). The dev sidecar starts every local Worker's watcher at once,
  and rolldown already spreads each build over every core, so seventeen Cloud
  Workers building side by side only multiplied memory: the sidecar reached
  8-10.6 GB, the kernel killed it when several local Clouds started on one
  host, and every Worker failed with `WebSocket connection failed`. One at a
  time it peaks at 4-4.7 GB and starts as fast. Rebuilds after an edit and
  deploy builds (`Bundle.build`) do not wait. Drop this part when alchemy
  bounds concurrent first builds itself.

Upstream beta.80 now provides what the beta.79 patch also carried: storing a
no-op resource before signalling dependents
([alchemy-run/alchemy#1717](https://github.com/alchemy-run/alchemy/issues/1717)),
ignoring only missing DNS records on delete and read, and credential-free local
Worker, R2, Hyperdrive and Workflow providers. Local identities now come from
`CLOUDFLARE_ACCOUNT_ID`, a configured profile, or a fixed local account in CI.

Upstream beta.80 also changed workflow step failures. The engine retries a step
only when it fails with an `Effect.fail` value it can serialize. A defect, an
interruption or failure data it cannot serialize (such as an error with a
`message` getter) ends the workflow with `NonRetryableError`. beta.79 retried
defects, and Executor's provisioning, app workflow and organization removal
steps used to die. They now fail with typed errors, so their configured retries
still apply; an app's `NonRetryableError` remains a defect.

Do not use `bun patch --commit` to regenerate this patch. It previously
dropped a trailing `};` from an unrelated no-newline-at-EOF hunk. Preserve
existing sections byte-for-byte, append targeted diffs manually, and compare
patched installs outside the intended files.

When upgrading, port each part onto the new release by hand and check it
against upstream changes. Context-free application of the old patch misplaced
local-provider hunks into live providers during the beta.80 upgrade.

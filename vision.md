# Vision

> The product vision for Executor — what it is, the model it's built on, everything it
> should eventually do, and the discipline for getting there. Implementations churn; this is
> the destination they're heading toward, applied as incremental changes to the existing
> codebase, not a rewrite.

## What Executor is

Executor is an **open-source layer for your integrations** — a catalog of every operation
across a company's software, plus the auth, scoping, policy, history, and oversight to act on
it safely.

- It is **not AI-specific.** Agents are a primary consumer, but the layer is a general way to
  represent and interop between sources of capability.
- It is **not code-mode-specific.** Code mode is one way to call tools; it isn't the point.
- It is a category of **source** and a way to **interop between them** through one set of
  concepts.

The bet: as work shifts toward agents acting through software, every company needs one layer
where anything a human could do is callable — auditable, across every account — and where new
capability is _composed_ on a shared substrate, not rebuilt per integration. One primitive
unlocks the whole slice: catalog + auth + tools + scoping + UI + workflows + storage.

It runs the same two ways from one codebase: an **in-process SDK** (no server, single-player,
instant) and a **hosted service** (multiplayer, cloud). Single-player must feel great;
multiplayer must be powerful; neither carries the other's weight.

## Core concepts

- **Tool** — an id, an optional input schema, and an optional output schema (JSON Schema today;
  may grow richer types). The unit of capability. Addressed as
  `<source>.<scope>.<connection>.<tool>`.
- **Source** — contains tools. A source is produced by a plugin from some config (an OpenAPI
  spec, a GraphQL endpoint, an MCP server, a CLI's install/run). The core never sees the raw
  config — only a normalized manifest.
- **Connection** — a credential, born wired, identified by `(scope, source, name)`. The `name`
  is required and load-bearing (the account: `work`, `personal`, `prod`). One source holds many
  connections.
- **Secret** — never lives in Executor and never reaches the agent. A connection holds a
  `SecretRef` (a pointer — `op://`, `keychain://`, `env://`, `vault://`); a provider resolves it
  at call time, in trusted space, behind a proxy.
- **Scope** — placement and identity. An ordered, merged set (see _Scopes_). Every record is
  placed in a scope.
- **Policy** — gates execution (allow / require-approval / block). Attached to sources and
  connections (see _Policies_).
- **Plugin** — registers sources, tools, providers, storage, surfaces. The one open extension
  seam (see _The model_).
- **Manager / Invoker** — the core runtime roles: a manager owns a source's tools and config; an
  invoker executes a tool through the right connection and proxy.

## The model — core, first-party, one seam, surfaces

Executor is a **tiny core**, a set of **first-party capabilities** built on it, **one open
extension seam**, and **surfaces** that expose it.

**The core (the floor):** `execute(path, args)` (the one verb); the **catalog** of tools;
**connections**; **scopes**; **policies/guardrails**; and `scope()` — narrow the executor to a
subset, the seam everything composes through.

**First-party capabilities** are a fixed, known set, included or omitted as modules — _not_ a
generic plugin registry: toolkits, the MCP host, generative UI, workflows, storage, skills,
audit/runs, the internal-apps catalog. They're separable but they don't go through an abstract
plugin contract, because nobody outside you needs to add a new _kind_ of them.

**One open plugin seam: sources.** There are thousands of APIs; you'll never enumerate them; you
want others to add them. That is where an open contract (`resolveTools` / `invokeTool`) earns its
complexity. Secret **providers** are the one plausible second seam, for the same reason.

> The discipline: do not make "everything a plugin." Keep first-party capabilities first-party,
> and keep exactly one open seam (sources, + maybe providers). Reversible — extract a new seam
> only when several first-party capabilities demand the same one.

**Surfaces / hosts** serve the executor over a wire: MCP, HTTP, CLI, stdio, triggers, the web
app. The SDK works fully in-process with none of them.

## Composition — artifacts × surfaces, and the axes

Everything you build is a point in a small space of orthogonal axes. New things become
coordinates, not bespoke subsystems — this is what keeps the breadth tractable.

- **kind** — tool / view (UI) / workflow / skill / store / connection
- **lifetime** — ephemeral (a turn/session) / durable (deployed, addressable, re-openable)
- **origin** — imported (a spec) / authored (code) / invoked-inline (produced by a call)
- **surface** — in-process / MCP / HTTP / CLI / trigger / web
- **delivery** — inline value / handle / embedded resource / deep link _(negotiated by client
  capability)_

Two rules fall out and dissolve most "how does X compose" confusion:

1. **Artifacts vs surfaces.** What you _build_ (kind) is separate from how it's _reached_
   (surface). Build once; a surface projects it. A workflow defined once is reachable via cron,
   MCP, or in-process. A view defined once renders standalone or returns over MCP. Not everything
   fits every surface (a workflow isn't a slow tool; a UI isn't an HTTP handler).
2. **Rich outputs negotiate delivery.** Too big or too rich for the channel → return a
   _reference_ the client resolves per its capability. A large result → a **storage handle**. A
   UI → an **embedded UI resource** if the client renders it (MCP apps), else a **deep link**
   into the web app. UI is not special; it's a rich output under the same rules as everything.

## Scopes (scope merging)

Placement is an **ordered, merged set of scopes**, outer (authority) → inner (actor). You add
tools, connections, and policies at a global, workspace, or account level; override secrets and
policies per scope; and create temporary scopes. Single-player is one scope; multiplayer is the
same model with more entries.

Three fixed merge rules, nothing configurable:

- **visibility = union** (you see everything placed in any scope you hold);
- **guardrails/policy = deny-union, outer-wins** (an outer scope's `block` can't be weakened
  inward; mandatory flows in);
- **scalars/config/secret-overrides = innermost-wins** (the nearest scope to the actor wins).

`org | user` is just the **two-element case** of this. The current codebase collapsed scopes to
fixed org/user; the direction is to model it as an _ordered list that today has two entries_, so
the resolver is already the general one and inserting a "team" or "environment" level later is
additive, not a rewrite — added demand-driven, only when a real case needs the middle level.

**Why scopes are a dimension, not indirection.** A past mistake (the credential-binding model:
credential / slot / binding as separate objects wired together) caused an overcorrection that
flattened scopes along with killing bindings. The lesson: **fuse indirection, keep dimensions.**
A binding is a layer whose only job is to _connect_ two things — fuse it away (born-wired
connections did this). A scope is a property that varies independently and meaningfully — keep
it; flatten it and it leaks back as workarounds. Placement stays a **direct, inline property** on
each record (the way `scope` already sits on a connection); never reintroduce an object whose job
is to _attach_ a record to a scope.

## Connections, secrets & auth

- **Connection = a credential, born wired** (secret + account fused; no slot/binding split),
  identified by `(scope, source, name)` with `name` required.
- **Multiple accounts per source per scope** (distinct names). Per-member auth (each connects
  their own) and team-level shared auth (one credential placed in an outer scope) are both just
  placement.
- **Auth template vs credential.** A source declares _how_ it authenticates (OAuth / bearer /
  API key — a discriminated set); each connection fills that template.
- **Secrets never reach the agent.** Resolved by a provider at call time, in trusted space,
  behind a **tool-proxy** — credentials never enter agent or sandbox code. **No escape hatch:** a
  `SecretRef` never appears in a tool's I/O schema or any MCP/host response.
- **Heterogeneous backends per member** (1Password / keychain / env / vault), declared
  separately. **Credential lifecycle** (refresh, rotation, revocation, expiry) handled below the
  agent.

## Sources & source kinds

Each kind is added through the **one open seam** (`resolveTools` + `invokeTool`): **OpenAPI**,
**GraphQL**, **MCP servers**, **CLI** (install + run, no spec), **direct API / raw-fetch**, and
later **direct database** and **email**. The plugin owns the opaque config and raw spec; the core
reasons over a **normalized manifest** (schemas, side-effect class, auth template, data labels,
required capabilities, an LLM-authored description). **Spec auto-refresh** tracks upstream drift
and **must never auto-expand authority** — new operations appear _ungranted until reviewed_.

An **integrations registry** lets people discover and add sources.

## Policies

Policies gate **execution** — `approve` / `require_approval` / `block` — and are distinct from
toolkits (which gate visibility). Resolution is _most-restrictive-wins_; **plugin defaults** let
a source ship a tool pre-marked `require_approval` (destructive detection), with `approve` as the
override when an import wrongly flags a safe action.

How people actually use them today (real usage): glob patterns over the address, where _every_
rule targets a **source** and wildcards the scope/connection (`stripe_api.*.*.disputes.*`,
`pscale.*.*.execute_write_query`) — i.e. faking structural targeting because there's nowhere to
attach it. The direction:

- **Kill the global glob list. Attach policy to the source and connection records** — the two
  structural levels. **Connection overrides source** (innermost-wins), with **scope authority
  layered on top** (outer/org mandatory, can't be weakened inward).
- Fixing a mis-flagged tool becomes `approve` _on that source/connection_, directly.
- **Toolkits carry no policy** — they're pure curation and inherit whatever source/connection
  policies apply to the tools they expose. This dissolves the old global-vs-toolkit merge
  conflict.

## Toolkits & scoping

A **toolkit is pure curation** — a named subset of tools (a `ToolSet`) that yields a **scoped
view** of the executor. Used for **per-agent capability control**: lock down exactly what an
added agent can reach (a background firewall-monitor agent gets _only_ a monitor tool and an
update-firewall tool, and nothing that builds). **`toolkits.list` feeds a consent screen** — the
grantable slices an agent or OAuth flow requests. Single-player keeps toolkits too.

## Authorization & capabilities

One model over a **typed capability namespace**, three layers kept apart: **grants** (positive
authority; toolkits are grant bundles), **policy/guardrails** (deny/approval), and **runtime**
(object-capability handles only — no ambient executor, no raw secret, no unrestricted fetch).

The tool axis stays a **predicate** (`ToolSet`); **meta-capability kinds are typed per-kind** —
`author-tools` (effects ceiling), `generate-UI`, `allocate-storage` (quota), `deploy`,
`trigger-register`, `egress`. **Capabilities compose transitively, enforced by the
`scope()`-narrowed executor as a membrane:** an authored tool runs against its author's captured
scope, so a toolkit-X agent's tool calling toolkit-Y fails because Y was never in scope. `scope()`
strictly intersects (never widens); delegation routes through a granter; one enforcement surface,
no advisory mode — the local isolate and the cloud worker enforce the same membrane.

## Surfaces

You build once; surfaces project.

- **In-process** — `execute`, the SDK path. No server.
- **MCP** — a scoped endpoint (`/mcp?toolkit=...`) over a _scoped executor_; the host
  authenticates → resolves the toolkit → `scope()` → hands the narrowed executor to the MCP
  server, which never sees a toolkit. Default shape is **meta-tools** (`search` + `describe` +
  `execute` + `run_code`) so a huge catalog doesn't blow context, with a direct-tools opt-out.
  **Authoring tools** (`render`, `create_workflow`, `author_tool`, `skills.create`) appear only
  when the scope grants the matching meta-capability.
- **MCP apps with dynamic UI** — React-flight / RSC + code mode for rich UI returned over MCP
  (an embedded UI resource on capable clients, a deep link otherwise).
- **MCP channels** — talk back to the agent mid-tool-call (the "Claude Code over Discord"
  pattern), for human-in-the-loop and elicitation.
- **HTTP** — any capability projected as a route, after policy/auth/versioning/CORS.
- **CLI** — the same operations from the terminal (see _Distribution_).
- **Triggers** — a schedule (cron) or an event that fires an artifact.
- **Web app** — the UI-capable surface where views render and deep links land.

## What you build

- **Custom tools & API gateway.** Write a tool as a function and deploy it; it joins the catalog.
  **Account-parametric** — a custom function calls a catalog op without baking in an account; the
  account is passed at invocation. Executor doubles as an **API gateway** with a **generated typed
  SDK** for everything added.
- **Workflows.** Multi-step sequences of tool calls with **durable run semantics**, built ideally
  on `use workflow` (or Cloudflare Workflows). User-defined entry points; **cron + event
  triggers**; infrastructure-as-code. A step _is_ a catalog tool call.
- **Generative UI.** A **view** governed by lifetime × delivery: ephemeral (the agent calls
  `render`) or durable (an authored dashboard). Rich UI runs in a sandbox; it calls only the
  tools its scope grants, proxied server-side, never holding credentials.
- **Skills.** Shared, code-authored knowledge — the company knowledge base as code — that agents
  draw on, that **surfaces in tool search**, and can **run tools inline** to cut round-trips.
  Served off MCP and from a `.well-known`. File-backed (see _Authoring model_).
- **Internal apps catalog & custom UI snippets.** Store and share custom UI and internal apps.
- **Configure Executor via Executor** — managing sources, connections, scopes, policies,
  toolkits is itself done through tools.

## Authoring model — two paths

Every authored artifact (skill, custom tool, workflow, UI) has **two first-class authoring
paths**, matched to two contexts:

- **File + deploy** (developer, with the CLI): `executor/skills/`, `executor/tools/`, … authored
  in a repo, `executor deploy` pushes them. Git gives versioning, review, rollback. The
  canonical, org-shared tier.
- **A tool over MCP** (an agent with no CLI, e.g. in a desktop client): `skills.create`,
  `author_tool`, `create_workflow` write to the runtime directly. Zero friction, no filesystem.

These aren't two sources of truth: each artifact has **one master** distinguished by origin and
**scope/tier** (a runtime-authored artifact is personal/inner-scope; a deployed one is
org/outer-scope, git-backed). **Promotion** is an explicit handoff — `executor pull` materializes
a good runtime artifact into files for review and merge, graduating it to canonical. With a
git-backed store (below), runtime authoring is literally a commit-from-a-worker and promotion is
a branch/namespace merge.

## Storage — two substrates

Split by lifetime/kind, not one confused store:

- **Authored artifacts** (skills, custom tools, workflows, UI — durable, versioned, reviewed) →
  **git-backed**: local Git, and in the cloud **Cloudflare Artifacts** (git-over-HTTPS, push
  commits from a Worker, read at runtime via a Workers binding / ArtifactFS, namespaces ≈ scopes,
  versioning/pinning/rollback from git for free). "Git stands in for Cloudflare Artifacts" is
  literal — local == remote with no translation. Both authoring paths commit to one repo.
- **Agent state** (data — reactive, high-frequency) → **KV / SQLite / filesystem**. Every chat
  gets a temporary KV + SQLite + filesystem the agent can use; the agent can also create stores
  on scopes to persist between calls. Accessed **as ordinary tools** (no side-channel API).
  Addressed by **handles** + a search-across-stores utility. **Reactive** (Convex-style: a
  workflow writes, a UI/chat sees it live, with access rules). **Large results land in storage**
  and return a handle — which is how the MCP context-overflow problem is actually solved.

## The Run model

Every execution, on any surface, produces or attaches to a **Run**: id, parent run, artifact
version, principal chain, capability set, policy version, input hash, output handle, logs, spans,
approvals, retries, cancellation, status. One record **collapses four features into views over
it**: audit log, human-in-the-loop approvals, workflow runs, and resumability/debugging.

## Human-in-the-loop

Pause a call and require a human before it proceeds: **MCP elicitation**, a **gated `resume`
tool** (the user simply doesn't always allow it), a **resume URL**, or an **MCP channel**
talk-back mid-call. A gated call returns a _pending_ Run with a resume reference.

## Sandbox & runtime

Untrusted code — user plugins, agent-authored tools, generative-UI bundles — runs sandboxed:
locally a **V8 isolate** (and the quickjs / dynamic-worker / deno-subprocess runtimes), in the
cloud a **Cloudflare Dynamic Worker**. **Default-deny.** Both enforce the **same capability
membrane** (the scope-narrowed executor; `env` is the capability set; outbound closed except
through the tool-execution binding). Credentials never enter the sandbox. Let the agent write
whatever it needs; ship instructions (skills) as part of Executor.

## Distribution, the CLI & remotes

The `executor` CLI is **three things at once**: the **local runtime** (run a full instance and
start using it), the **control plane** (local _and_ remote, same commands), and an
**agent-facing surface**. Distribution surfaces are all "local": `executor` (CLI), `executor
service install` (daemon), `executor web` (web app) — one instance, delivered differently.

- **Remotes ("cores").** Add remote instances; one shared sign-in; call them identically.
  Execution **runs where the credential lives** — invoke from machine B, it runs on A with A's
  credential; nothing crosses machines.
- **Merge local + remote** (the "SSH for tools" / OpenTunnel model) — a tool on one machine is
  callable from anywhere.
- **Deploy & dev.** `deploy` (with `--check`) pushes authored artifacts; git-backed `sync`;
  hot-reload `dev`; local filesystem access. **Configure Executor via Executor** from the CLI.

## Cloud & user-generated extensions

The hosted product runs on a **Cloudflare substrate** and lets users **write plugins and load
them dynamically, sandboxed** — each in a Worker isolate with a **declared capability manifest**
(a plugin asking for specific scopes can do exactly that and nothing else). User plugins ride the
**source seam** and the capability membrane, opened **last and curated**. Local == remote via
**substrate substitution**: a local V8 isolate stands in for the dynamic worker, Git for
Cloudflare Artifacts, local SQLite for hosted storage.

## Cross-cutting concerns

- **Data provenance / tainting** — label data handles (source, connection, scope, sensitivity,
  retention, allowed readers/egress) so policy can reason as data flows tool → storage → UI →
  chat.
- **Egress / allowed-hosts** — prevents **data** exfiltration (credentials are already safe via
  the proxy), not credential leakage. A guardrail facet.
- **Simulation / emulation** — run tools against the `@executor-js/emulate` emulators
  (wire-level, stateful, real OAuth + credentials + request ledger) for side-effect-free testing.
- **Multiple language targets** — JS now, Python later (data/analysis work).

## Architecture

Built on **Effect**. The same SDK is in-memory _and_ client/server; SDK-only users need no
server; serving is a standard Web `Request → Response` handler. The discipline that keeps breadth
cheap is the **seam discipline**: the platform owns generic concerns (auth, caching, retries,
schema, rendering, transport, the Run); a plugin owns only the source-specific resolve/invoke.

## Principles

- **One unifying primitive** — everything reduces to "invoke tool T → typed output."
- **Tiny core; compose the rest.** Ship the primitives that build an extendable product.
- **No silent defaults; explicit addressing.** The account is always in the path.
- **Type the human surface, not the agent surface.**
- **Secrets never reach the agent; authority only narrows.**
- **Visibility ≠ permission** — curation (toolkits) is separate from governance (policy).
- **Share the substrate aggressively; split the surfaces deliberately.** The failure mode of a
  broad product is too many features in one undifferentiated human surface — keep that surface
  minimal.
- **Fuse indirection; keep dimensions.** (Born-wired connections, not credential bindings;
  stacked scopes, not flattened ones.)
- **One master per record** — file-backed or runtime-authored, never two live masters.

## How we build it

- **Don't rewrite — evolve the existing codebase.** This vision is a map you steer toward with
  incremental, git-shaped changes, not a greenfield rebuild. The wedge already exists.
- **The wedge:** be best-in-class at the catalog of imported tools + connections/secrets, exposed
  through one invocation interface — with zero-token-exposure, the Run/audit record, human
  approval, the capability membrane, and code-mode/meta-tool search baked in. Then sequence
  nearest-to-substrate first: MCP → storage → workflows → generative UI → user plugins (curated,
  last). Three substrate invariants keep composition cheap: one typed invocation primitive;
  authorization inherited from the substrate, never re-implemented; a hard seam between
  substrate-generic and source-specific code.
- **Vision mode vs build mode.** This document is vision mode — generativity ("and then you'd
  want X") is the point. In **build mode, every "and then you'd want X" is a YAGNI to defer**, not
  a dependency to satisfy. Build the smallest thing useful on its own; let the next be _pulled_ by
  real pain, not _pushed_ by imagined composition. The tell that you've slipped back to vision
  mode: the next step needs two other things built first. (Example: v1 skills = read a folder,
  expose `skills.search` + `skills.get`. No scopes, toolkits, environments, or git required.)

## North-star scenarios

- **The shared-data loop.** "Every morning at 9am, load my GitHub issues into SQLite": a
  scheduled workflow writes to storage; a generative-UI front end reads it live; you chat with the
  agent over the same data. One substrate, three readers.
- **The scoped agent.** "An agent I can message that can _only_ update my calendar." A toolkit
  exposes a one-tool slice; the agent connects to a scoped MCP endpoint; it physically cannot
  reach anything else.

## Positioning

The open-source alternative to closed integration layers; interops with adjacent projects; one
primitive serving both backend-for-customers and internal-team use. The model is to nail a wedge,
then grow many composing capabilities on a shared substrate — without letting the human-facing
surface bloat with it.

## Open questions

- Data provenance/tainting — the label model and how policy consumes it.
- Skills ↔ custom functions ↔ specs — where the boundaries sit and how the capability gate
  follows references.
- Typegen ownership — leaning "don't own it; expose as a utility."
- Reconciliation UX for merged local+remote catalogs; filesystem overlay vs CLI-routed.
- Storage allocation default — which class is the default and how handles are named.
- Raw-fetch manifest — how an untyped tool kind declares its capabilities.

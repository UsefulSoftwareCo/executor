# Telemetry viewer

Executor telemetry: the trace and log viewer for the bundled telemetry collector. Its source is Motel's `web/`
viewer in [`UsefulSoftwareCo/motel`](https://github.com/UsefulSoftwareCo/motel) at `b1783f4d344fd2e0fa584ef00b3e71838a8a1e03`, under Motel's MIT license
(`LICENSE`). The AI calls page is removed, and `src/contracts/api.ts` declares only the routes the
viewer reads, with the response shapes that Motel revision returns.

The collector serves this build when it is started with `--viewer <dir>` (its README, The viewer).

## Build

```sh
bun run --cwd packages/telemetry/viewer build
```

This writes `packages/telemetry/dist/viewer/`, beside the collector's own `dist/collector/`, which its build replaces whole: `index.html` and hashed files under
`assets/`, and the notices for the code in them:

- `runtime-packages.txt` lists, as `name@version`, every package the bundler put into the
  script or the stylesheet. The viewer itself is `@executor-js/telemetry-viewer@workspace`.
- `licenses/<name>@<version>/` holds each one's licence and notice files, with `/` in a scoped
  name written as `__`. The viewer's own directory holds Motel's MIT licence.

`notices.ts` takes the packages from the modules of the emitted chunks, the bundler's own helpers
(`@voidzero-dev/vite-plus-core`, whose licence covers Vite and Rolldown) and the files Tailwind
read for the stylesheet. Each package must have a licence file of its own: a non-empty `LICENSE`,
`LICENCE` or `COPYING`, optionally with a suffix such as `-MIT` and an extension such as `.md` or
`.txt`. The build fails, naming the package, when one has none; a `NOTICE`, `COPYRIGHT` or
third-party notices file is copied beside the licence but does not stand in for it. The layout is
the one `scripts/releases/runtime-bundle.ts` writes for a release, so the two can be merged.

## Lists

The collector returns lists a page at a time. The trace list, a trace's logs and the logs page
show `+` after a count while more pages remain, and a "Load more" control under the list that
reads the next page with the previous page's `nextCursor`. Rows already shown are not read again.
A page that fails to load keeps the rows above it and offers to try again.

Refresh starts a list again from its first page and stops any later page still loading; on a
trace, Refresh reads the trace and its logs together. Leaving a page, or changing its filter or
trace, drops its list the same way.

The "Load more" control stays in place while a page loads, so keyboard focus stays on it. When
the last page arrives focus moves to the line under the list, which is a live region that
announces the new count.

While a trace's logs are not all loaded, the per-span counts on its waterfall read like `67+L`,
with a tooltip saying they are loaded so far, and the span panel says "Logs (67 loaded so far)".
A span whose logs are all on pages not yet loaded shows no count on the waterfall until they are.

## A trace answered in part

The Rust collector answers a trace too large to send whole with its earliest spans by start time,
and adds `partial: {spanCount, returned}` to it. Motel never sends `partial`. When it is present
the trace page says above the waterfall how many of how many spans are shown, the header's span
count reads `returned of spanCount`, and its duration and error count, which the collector
computes from the spans in the answer, are labelled as covering the spans shown. The waterfall's
collapse tooltips say their descendant counts are of the spans shown.

A trace's `warnings` (one per missing parent, and on a partial trace a first line saying it was
cut) show above the waterfall: the first three, how many there are, and a control that opens the
rest in a scrolling list of fixed height that renders only the rows in view. Each warning stays on
one line; the list scrolls sideways to the end of the longest one in view, and takes keyboard
focus so the arrow keys scroll it. The trace list cannot
show which traces have warnings: neither Motel nor the Rust collector puts them on a trace summary.

The collector, like Motel, adds a placeholder span for each missing parent and counts it in the
trace's error count. A span is a placeholder when the trace's warnings name its id as missing
(`missing span <id> (<n> child…)`); its name alone does not decide it. When a trace has one, the
error count says that placeholders count as errors.

The waterfall numbers the spans and links each to its parent once per trace. Descendant counts and
collapsing follow those links, not the order of the spans, without recursion, and end on a cycle
of parent links. Each row draws its depth guides as one element. So a chain of hundreds of
thousands of spans opens.

## Serving

The viewer must be served at the origin root, beside the API it reads:

- `index.html` for `/`, `/traces`, `/trace/<id>` and `/logs`
- the files under `/assets/`
- `GET /api/services`, `/api/traces`, `/api/traces/<id>`, `/api/traces/<id>/logs` and
  `/api/logs` on the same origin

For development, `COLLECTOR_URL=http://127.0.0.1:<port> bun run --cwd packages/telemetry/viewer dev`
forwards `/api` to a running collector.

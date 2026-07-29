/**
 * The `create-artifact` tool's pure half: what the model is told, and what the server
 * refuses to render.
 *
 * The tool itself lives in `tool-server.ts` beside `execute` and `skills` —
 * this module holds only the description text and the code guard, so both can
 * be tested without standing up an MCP server.
 */

import { PROVIDED_GLOBAL_NAMES } from "@executor-js/execution";

import { oldStyleAddressRejection } from "./artifact-bindings";

/** The MCP-Apps resource the ui-bearing tools render into. */
export const MCP_APPS_SHELL_RESOURCE_URI = "ui://executor/shell.html";

/**
 * The web-app deep link for a saved artifact — the delivery path for clients
 * that can't render MCP Apps. One helper so every host emits the same shape;
 * hosts differ only in the origin and org slug they pass, and hosts with no
 * known origin (stdio) pass none and skip the link entirely.
 *
 * The console routes artifacts at `/{-$orgSlug}/artifacts/$artifactId`, where
 * the org segment is optional. Optional is not the same as absent: on a host
 * that scopes by org, a bare link resolves against whatever org the browser
 * happens to land on after auth, which is the wrong one as soon as a user
 * belongs to two. So every host that knows its session's org slug passes it,
 * exactly as `buildResumeApprovalUrl` does for the approval hand-off, and the
 * bare form is left to genuinely unscoped hosts.
 */
export const artifactUrlFor =
  (webBaseUrl: string, organizationSlug?: string | null) =>
  (artifactId: string): string => {
    const orgPath = organizationSlug ? `/${encodeURIComponent(organizationSlug)}` : "";
    return new URL(`${orgPath}/artifacts/${encodeURIComponent(artifactId)}`, webBaseUrl).toString();
  };

// ---------------------------------------------------------------------------
// Code guard
// ---------------------------------------------------------------------------
//
// Generated code is evaluated inside the shell with ~280 names already bound as
// function parameters (React hooks, TanStack Query, every shadcn/Recharts/Lucide
// export, `tools`). A `const Card = ...` in the model's source shadows the real
// binding and the component renders as a blank frame with a confusing runtime
// error — so we reject redeclarations before the code ever reaches the iframe,
// with a message that tells the model what to do instead.
//
// The other rejection is `run(...)`. It was once the escape hatch for multi-step
// composition and is now gone from the scope entirely: arbitrary code is opaque
// to the invalidation helpers (a hand-rolled `queryKey` defeats
// `queryFilter`-based refresh) and to artifact analysis, which reads
// `tools.<integration>...` paths out of the source. Code that calls it would
// fail at render time with a bare ReferenceError, so it is caught here where the
// message can point at the declarative replacement.
//
// The third rejection is a hook called inside a loop body. Models that never
// fetch the skill reach for pagination the imperative way — a `for` loop in the
// component body with a `useQuery` per page, each one `enabled` by the previous
// page's cursor. That is a rules-of-hooks violation (the hook count varies per
// render) and a silently capped read, and `.infiniteQueryOptions` is the thing
// they didn't know about. The error names it.
//
// This is deliberately NOT a general "is this good code" check. The donor branch
// also rejected array literals whose variable name looked data-ish
// (`const rows = [{...},{...}]`), which false-positives on legitimate display
// constants — chart configs, tab definitions, column headers. That heuristic is
// dropped; the "fetch live data with useQuery" guidance lives in the skill.

const REACT_DESTRUCTURING_DECLARATION = /\b(?:const|let|var)\s*\{[^{}]*\}\s*=\s*React\b/s;

/** A call to the removed `run` global. Not preceded by `.` or an identifier
 *  character, so `foo.run(...)` and `rerun(...)` — a component's own helpers —
 *  stay legal. */
const REMOVED_RUN_CALL = /(?<![.\w$])run\s*\(/;

const OBJECT_DESTRUCTURING_DECLARATION = /\b(?:const|let|var)\s*\{([^{}]*)\}\s*=/gs;

const PROVIDED_GLOBAL_DECLARATION =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b|\bfunction\s+([A-Za-z_$][\w$]*)\s*\(|\bclass\s+([A-Za-z_$][\w$]*)\b/g;

const firstDefined = (...values: Array<string | undefined>): string | undefined =>
  values.find((value): value is string => value !== undefined);

const localDestructuredName = (part: string): string | undefined => {
  const binding = part
    .replace(/^\s*\.\.\./, "")
    .split("=")[0]
    ?.trim();
  const alias = binding?.match(/:\s*([A-Za-z_$][\w$]*)\s*$/)?.[1];
  return alias ?? binding?.match(/^([A-Za-z_$][\w$]*)\b/)?.[1];
};

/** A component's own local `run` — legal, since it shadows nothing anymore. */
const LOCAL_RUN_DECLARATION = /\b(?:const|let|var|function)\s+run\b/;

// ---------------------------------------------------------------------------
// Hooks inside loop bodies
// ---------------------------------------------------------------------------
//
// Finding a loop's body needs brace matching, not a regex — a regex either stops
// at the first `}` (missing the common nested-block shape) or runs to the last
// one (flagging a `useQuery` that merely follows a closed loop). So: blank out
// comments and string/template literals so their braces and the word "useQuery"
// can't skew the scan, then walk braces from each loop header.
//
// Nothing here is a parser. Loops assembled dynamically, hooks reached through
// a helper called from a loop, and other exotica slip past — false negatives are
// fine. A false positive is not: legal code must never be refused.

/** Replaces comments and quoted/template literals with same-length blanks, so
 *  offsets stay valid and their contents can't be mistaken for code. */
const withLiteralsBlanked = (code: string): string => {
  const blank = (text: string): string => text.replace(/[^\n]/g, " ");
  return code.replace(
    // Order matters: line comment, block comment, then each quote flavour.
    /\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g,
    blank,
  );
};

/** A React hook call: `useFoo(`, not `x.useFoo(` and not `abusefoo(`. */
const HOOK_CALL = /(?<![.\w$])(use[A-Z][\w$]*)\s*\(/;

/** The head of a loop, up to where its body starts. `do` has no header parens. */
const LOOP_HEAD = /\b(for|while|do)\b/g;

/** The body of the loop whose keyword ends at `afterKeyword`, or `null` when it
 *  can't be delimited confidently (unbalanced braces, generator-mangled source)
 *  — in which case nothing is reported rather than something guessed. */
const loopBody = (code: string, keyword: string, afterKeyword: number): string | null => {
  let index = afterKeyword;
  const skipSpace = (): void => {
    while (index < code.length && /\s/.test(code[index] ?? "")) index += 1;
  };

  // `for (...)` / `while (...)`: step over the header's parens first. A hook in
  // the header itself is not the shape we're after.
  if (keyword !== "do") {
    skipSpace();
    if (code[index] !== "(") return null;
    let depth = 0;
    for (; index < code.length; index += 1) {
      if (code[index] === "(") depth += 1;
      else if (code[index] === ")") {
        depth -= 1;
        if (depth === 0) {
          index += 1;
          break;
        }
      }
    }
    if (depth !== 0) return null;
  }

  skipSpace();

  // Only a braced body is scanned. A braceless one has no delimiter to trust —
  // its end would have to be guessed at the next semicolon, which in JSX prose
  // can run far past the statement and reach an unrelated hook. Giving up costs
  // only `for (…) useQuery(…)`, which no generator writes.
  if (code[index] !== "{") return null;

  const start = index;
  let depth = 0;
  for (; index < code.length; index += 1) {
    if (code[index] === "{") depth += 1;
    else if (code[index] === "}") {
      depth -= 1;
      if (depth === 0) return code.slice(start + 1, index);
    }
  }
  return null;
};

/** `do` is also an ordinary English word that can appear in JSX text ahead of an
 *  expression container ("nothing to do {count}"), where `for`/`while` are
 *  protected by their required header parens. Only a `do` that starts a
 *  statement is a loop. */
const startsStatement = (code: string, at: number): boolean => {
  const before = code.slice(0, at).trimEnd();
  return before === "" || /[;{}()]$/.test(before);
};

/** The first hook called inside any loop body, or `undefined`. */
const hookCalledInLoop = (code: string): string | undefined => {
  const scannable = withLiteralsBlanked(code);
  for (const match of scannable.matchAll(LOOP_HEAD)) {
    const keyword = match[1] ?? "";
    if (keyword === "do" && !startsStatement(scannable, match.index)) continue;
    const body = loopBody(scannable, keyword, match.index + match[0].length);
    const hook = body === null ? undefined : HOOK_CALL.exec(body)?.[1];
    if (hook) return hook;
  }
  return undefined;
};

/** Hooks whose in-loop use is almost always hand-rolled cursor pagination. */
const PAGINATION_HOOKS = new Set(["useQuery", "useInfiniteQuery", "useSuspenseQuery"]);

// ---------------------------------------------------------------------------
// Create-time smoke render
// ---------------------------------------------------------------------------

/**
 * What a server-side trial render concluded, as this package sees it.
 *
 * Declared here rather than imported so the MCP host keeps no type dependency
 * on the shell package — `@executor-js/mcp-apps-shell`'s renderer satisfies this
 * structurally, and a host that has no renderer to inject does not have to
 * resolve the module at all.
 */
export type ArtifactSmokeRenderResult =
  | { readonly status: "ok" }
  | { readonly status: "failed"; readonly message: string; readonly componentStack?: string };

/** The leading frames of a component stack: enough to locate the component that
 *  threw, not so much that the message is a wall. */
const COMPONENT_STACK_FRAMES = 6;

const trimmedComponentStack = (stack: string): string =>
  stack
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, COMPONENT_STACK_FRAMES)
    .join("\n");

/**
 * Turn a failed smoke render into the message the model is refused with.
 *
 * The real error, verbatim, plus where it happened and what class of problem it
 * is. The last part matters: saying the render happened with every query still
 * pending tells the model that guarding the loading state is a valid fix, which
 * is not obvious from `Cannot read properties of undefined` alone.
 */
export const smokeRenderRejection = (result: ArtifactSmokeRenderResult): string | null => {
  if (result.status === "ok") return null;
  return [
    `This component threw on its first render, so the artifact would show an error instead of a UI: ${result.message}`,
    result.componentStack ? `\n${trimmedComponentStack(result.componentStack)}\n` : "",
    "The render happened with every query still pending and no data returned — exactly the state the user sees first — so guard the loading state (`if (query.isLoading) return <ArtifactLoading />`) and read possibly-absent data with `?.`.",
    "Fix the component and call create-artifact again.",
  ]
    .filter((part) => part.length > 0)
    .join(" ");
};

// ---------------------------------------------------------------------------
// Provider pairing
// ---------------------------------------------------------------------------
//
// A handful of the components in scope read a React context that only their own
// wrapper supplies, and throw outright when it is missing. `<ChartTooltipContent
// />` outside a `<ChartContainer>` is the case this was written for: the
// artifact saves, the row is fine, and then the page dies on first render with
// `useChart must be used within a <ChartContainer />` — a failure the user sees
// and the model never does.
//
// The check is a table, not an analysis. If a name that requires a wrapper
// appears anywhere in the code and the wrapper's name appears nowhere, the code
// cannot possibly be correct, so it is refused with the pairing spelled out.
// That is deliberately weaker than the smoke render below (which catches the
// same class properly, and much more): this pass is free, runs first, and gives
// a message that names the fix rather than quoting a stack.
//
// Scope: `packages/react`'s components that `throw` on a missing context are
// `useChart` (chart.tsx), `useCarousel` (carousel.tsx), `useFormField`
// (form.tsx) and `useSidebar` (sidebar.tsx). Only the chart family is exported
// from the shell's component barrel, so only it is listed. `Tooltip` needs a
// `TooltipProvider` too, but the shell's inner renderer already wraps every
// artifact in one, so requiring it here would refuse working code.

/** Names whose presence obliges a wrapper, and the wrapper each one needs. */
const PROVIDER_PAIRINGS: readonly {
  readonly required: string;
  readonly dependents: readonly string[];
  readonly hint: string;
}[] = [
  {
    required: "ChartContainer",
    dependents: [
      "useChart",
      "ChartTooltip",
      "ChartTooltipContent",
      "ChartLegend",
      "ChartLegendContent",
    ],
    hint: 'Wrap the chart in `<ChartContainer config={{ series: { label: "Series", color: "var(--chart-1)" } }} className="h-[240px] w-full">…</ChartContainer>`.',
  },
];

/**
 * Whether `name` is INVOKED — rendered as `<Name`, or called as `name(`.
 *
 * Deliberately narrower than "the word appears". JSX text is ordinary prose
 * inside the source (`<CardContent>No ChartTooltipContent here</CardContent>`)
 * and is not blanked by `withLiteralsBlanked`, because it is not a literal — so
 * a bare-word match would refuse a component that merely names another one in
 * its copy. Requiring a `<` or a `(` costs only the alias case
 * (`const T = ChartTooltip`), which is a false negative, and false negatives are
 * the side to err on: the smoke render below catches it anyway.
 */
const invokesName = (scannable: string, name: string): boolean =>
  new RegExp(String.raw`<\s*${name}(?![\w$])|(?<![.\w$])${name}\s*\(`).test(scannable);

/** Whether `name` appears at all as an identifier. Used for the WRAPPER side,
 *  where a loose match is the safe direction: over-crediting a wrapper lets a
 *  broken artifact through to the smoke render, while under-crediting one would
 *  refuse working code. */
const mentionsName = (scannable: string, name: string): boolean =>
  new RegExp(String.raw`(?<![.\w$])${name}(?![\w$])`).test(scannable);

/** The first pairing the code breaks, or `null`. Comments and string literals
 *  are blanked first, so a name that only appears in a commented-out line
 *  neither triggers a rejection nor satisfies one. */
const providerPairingRejection = (code: string): string | null => {
  const scannable = withLiteralsBlanked(code);
  for (const pairing of PROVIDER_PAIRINGS) {
    if (mentionsName(scannable, pairing.required)) continue;
    const dependent = pairing.dependents.find((name) => invokesName(scannable, name));
    if (!dependent) continue;
    return [
      `\`${dependent}\` only works inside a \`<${pairing.required}>\`, which this code never renders.`,
      `It reads a React context that \`${pairing.required}\` provides, so it throws on the first render and the artifact shows an error instead of a UI.`,
      pairing.hint,
    ].join(" ");
  }
  return null;
};

/** `null` when the code may be rendered, otherwise the reason to hand back. */
export const validateArtifactCode = (code: string): string | null => {
  // Checked first: a five-segment address is the mistake a model that only read
  // the `execute` skill will make, and every other rejection below would be a
  // confusing thing to hear about code whose real problem is its addressing.
  const oldStyleAddress = oldStyleAddressRejection(code);
  if (oldStyleAddress) return oldStyleAddress;

  if (REMOVED_RUN_CALL.test(code) && !LOCAL_RUN_DECLARATION.test(code)) {
    return [
      "`run(code)` no longer exists — artifact code is purely declarative `tools.*`.",
      "Read data with useQuery(tools.<ns>.<tool>.queryOptions(args)),",
      "page through a cursor with useInfiniteQuery(tools.<ns>.<tool>.infiniteQueryOptions(args, { getNextPageParam })),",
      "and write with useMutation(tools.<ns>.<tool>.mutationOptions({ onSuccess })).",
    ].join(" ");
  }

  const loopedHook = hookCalledInLoop(code);
  if (loopedHook) {
    return [
      `\`${loopedHook}\` is called inside a loop body.`,
      "React hooks must run unconditionally at the top level of the component, in the same order every render.",
      PAGINATION_HOOKS.has(loopedHook)
        ? "To read every page of a cursor, use one useInfiniteQuery(tools.<ns>.<tool>.infiniteQueryOptions(args, { cursorKey, getNextPageParam })) and render data.pages — never a loop of useQuery calls, one per page."
        : "Move the hook out of the loop, and derive per-item values from its result instead.",
    ].join(" ");
  }

  const missingProvider = providerPairingRejection(code);
  if (missingProvider) return missingProvider;

  if (REACT_DESTRUCTURING_DECLARATION.test(code)) {
    return [
      "Do not destructure React in create-artifact.",
      "Hooks such as useState are already in scope; use useState(...) directly or React.useState(...).",
    ].join(" ");
  }

  for (const match of code.matchAll(OBJECT_DESTRUCTURING_DECLARATION)) {
    const names = match[1]?.split(",").flatMap((part) => {
      const name = localDestructuredName(part);
      return name ? [name] : [];
    });
    const providedName = names?.find((name) => PROVIDED_GLOBAL_NAMES.has(name));
    if (providedName) {
      return [
        `Provided global "${providedName}" is already in scope and cannot be redeclared.`,
        "Remove the destructuring declaration and use the provided global directly.",
      ].join(" ");
    }
  }

  for (const match of code.matchAll(PROVIDED_GLOBAL_DECLARATION)) {
    const name = firstDefined(match[1], match[2], match[3]);
    if (name && PROVIDED_GLOBAL_NAMES.has(name)) {
      return [
        `Provided global "${name}" is already in scope and cannot be redeclared.`,
        "Remove the local declaration and use the provided global directly.",
      ].join(" ");
    }
  }

  return null;
};

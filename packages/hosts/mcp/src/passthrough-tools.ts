// ---------------------------------------------------------------------------
// Passthrough mode — the pure half.
//
// `?mode=passthrough` serves every visible integration tool as its own MCP
// tool instead of the single `execute` codemode tool. This module owns the
// two decisions that make that surface deterministic and safe, with no I/O so
// they can be pinned by unit tests:
//
//   1. NAMING. An executor address (`tools.<integration>.<owner>.<connection>.
//      <tool>`) does not fit the MCP tool-name grammar: the tool segment carries
//      dots (`aliases.deleteAlias`) and can be long. Names are mangled to
//      `<integration>__<tool>` (dots → `_`), and when an integration has more
//      than one connection to `<integration>__<connection>__<tool>`, so the
//      surface stays fully transparent — there is never a hidden routing
//      parameter. Anything over the length cap is truncated and suffixed with
//      a short hash of the full address; a residual collision gets the same
//      treatment. The map from MCP name back to address lives in the session,
//      so the wire never carries an address the client chose.
//
//   2. ANNOTATIONS. Policy is evaluated ONCE, while the list is built, and
//      surfaced as MCP `ToolAnnotations` for the harness's native approval:
//      `require_approval` → `destructiveHint: true`, `approve` → `false`. Both
//      `destructiveHint` and `readOnlyHint` are always set explicitly, because
//      the MCP spec defaults an absent `destructiveHint` to TRUE — leaving it
//      off would make every tool prompt. `block`ed tools never reach here.
//
// The consequence, stated plainly: in passthrough mode `require_approval` is
// advisory. A harness that auto-approves calls the tool and the server runs it.
// `block` stays enforced server-side, on both the list and the call.
// ---------------------------------------------------------------------------

import type { ToolProjection } from "@executor-js/sdk";

/** The MCP tool-name grammar the SDK and every major client accept. */
const TOOL_NAME_SAFE = /^[A-Za-z0-9_-]+$/;

/** The Anthropic API caps tool names at 64 characters; other providers are
 *  looser, so this is the binding constraint. */
export const MAX_TOOL_NAME_LENGTH = 64;

/** Separator between the integration, the optional connection, and the tool. */
const SEGMENT_SEPARATOR = "__";

/** Length of the hash suffix (`-` + hex) appended to a truncated or
 *  colliding name. Seven hex digits is plenty of headroom for a workspace
 *  catalog while leaving the human-readable prefix as long as possible. */
const HASH_HEX_LENGTH = 7;

/** MCP annotations a passthrough tool advertises. Mirrors the SDK's
 *  `ToolAnnotations` fields this surface sets, without importing its Zod type. */
export interface PassthroughAnnotations {
  readonly title: string;
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  /** Integration tools reach external systems by definition. */
  readonly openWorldHint: true;
}

export interface PassthroughTool {
  /** The MCP tool name, unique within the session. */
  readonly name: string;
  readonly projection: ToolProjection;
  readonly annotations: PassthroughAnnotations;
}

/** Replace every character outside the MCP name grammar with `_`. Dots in a
 *  tool name are structural (`group.leaf`), so they become `_` too rather than
 *  being dropped, keeping `aliases.deleteAlias` distinguishable from
 *  `aliasesdeleteAlias`. */
const sanitizeSegment = (segment: string): string =>
  Array.from(segment, (char) => (TOOL_NAME_SAFE.test(char) ? char : "_")).join("");

/** FNV-1a over UTF-16 code units — stable, dependency-free, and good enough to
 *  spread a few thousand addresses across 28 bits. This is a disambiguator,
 *  not a security primitive. */
const fnv1a = (input: string): number => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
};

const hashSuffix = (address: string): string =>
  `-${fnv1a(address).toString(16).padStart(8, "0").slice(0, HASH_HEX_LENGTH)}`;

/** Fit `name` under the cap by truncating and appending the address hash, so
 *  two long names that share a prefix still differ. */
const fitWithHash = (name: string, address: string): string => {
  const suffix = hashSuffix(address);
  return `${name.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length)}${suffix}`;
};

/**
 * The preferred (pre-collision) MCP name for a projection. `multiConnection`
 * says whether the integration has more than one visible connection in this
 * session, which decides whether the connection segment is spelled out.
 */
export const preferredToolName = (
  projection: Pick<ToolProjection, "integration" | "connection" | "name">,
  multiConnection: boolean,
): string => {
  const segments = multiConnection
    ? [projection.integration, projection.connection, projection.name]
    : [projection.integration, projection.name];
  return segments.map(sanitizeSegment).join(SEGMENT_SEPARATOR);
};

/**
 * Map policy + plugin annotations onto MCP annotations. `readOnly` is a plugin
 * fact (HTTP method, GraphQL kind, upstream hint); absent means unknown, which
 * must read as `false` — advertising read-only for a tool nobody vouched for
 * would let a harness skip a prompt it should show.
 */
export const passthroughAnnotations = (
  projection: Pick<ToolProjection, "policy" | "readOnly" | "name">,
): PassthroughAnnotations => ({
  title: projection.name,
  readOnlyHint: projection.readOnly === true,
  destructiveHint: projection.policy === "require_approval",
  openWorldHint: true,
});

/**
 * Assign a unique MCP name to every projection. Deterministic for a given
 * input order: the first claimant of a name keeps it, later ones get the hash
 * suffix. Sorting the input by address first makes the assignment stable
 * across sessions, which matters because a client caches tool names.
 */
export const assignPassthroughNames = (
  projections: readonly ToolProjection[],
): readonly PassthroughTool[] => {
  const sorted = [...projections].sort((a, b) =>
    String(a.address) < String(b.address) ? -1 : String(a.address) > String(b.address) ? 1 : 0,
  );

  // Which integrations are served through more than one connection.
  const connectionsByIntegration = new Map<string, Set<string>>();
  for (const projection of sorted) {
    let set = connectionsByIntegration.get(projection.integration);
    if (!set) {
      set = new Set();
      connectionsByIntegration.set(projection.integration, set);
    }
    set.add(`${projection.owner}/${projection.connection}`);
  }

  const taken = new Set<string>();
  const out: PassthroughTool[] = [];
  for (const projection of sorted) {
    const multi = (connectionsByIntegration.get(projection.integration)?.size ?? 0) > 1;
    const address = String(projection.address);
    let name = preferredToolName(projection, multi);
    if (name.length > MAX_TOOL_NAME_LENGTH || taken.has(name)) {
      name = fitWithHash(name, address);
    }
    // A hash collision on top of a name collision is astronomically unlikely
    // but not impossible; keep extending until unique rather than silently
    // dropping a tool from the surface.
    let salt = 0;
    while (taken.has(name)) {
      salt += 1;
      name = fitWithHash(name, `${address}#${salt}`);
    }
    taken.add(name);
    out.push({ name, projection, annotations: passthroughAnnotations(projection) });
  }
  return out;
};

/**
 * The sandbox code a passthrough call runs. Built HERE from the session's
 * resolved address and a JSON-encoded argument — never concatenated from raw
 * model input — and shaped exactly like the artifact `execute-action` grammar
 * (`return await tools.<path>(<json>)`), so it takes the same engine path as
 * every other execution: billing, rate limits, shape memory and analytics all
 * see it as one execution.
 */
export const passthroughCallCode = (address: string, args: unknown): string => {
  // The whole dotted address is ONE JSON string literal in bracket notation:
  // `tools["github.org.main.items.then"](...)`. Two reasons it is not a chain
  // of property accesses. The tool segment is customer-controlled (an OpenAPI
  // spec may set `x-executor-toolPath`), so it must be data in the generated
  // source, never syntax. And every sandbox proxy reserves the property name
  // `then` (a thenable check would otherwise await the proxy itself), so a
  // per-segment chain could never reach a tool whose path contains `then`.
  // Each proxy joins the accessed keys with `.` to form the dispatch path, so
  // a single key holding the dotted address reassembles to exactly the same
  // path the chain would have.
  const bare = address.startsWith("tools.") ? address.slice("tools.".length) : address;
  return `return await tools[${JSON.stringify(bare)}](${JSON.stringify(args ?? {})});`;
};

/**
 * Narrow a projection list to the requested integrations (`?integrations=`).
 * Unknown slugs match nothing rather than failing the session: a client that
 * names an integration the caller has not connected simply gets no tools for
 * it, and the server instructions say so.
 */
export const filterPassthroughIntegrations = (
  projections: readonly ToolProjection[],
  integrations: readonly string[] | undefined,
): readonly ToolProjection[] => {
  if (!integrations || integrations.length === 0) return projections;
  const wanted = new Set(integrations);
  return projections.filter((projection) => wanted.has(projection.integration));
};

/**
 * The server `instructions` a passthrough session advertises. Names the count
 * so a client that truncates its tool list at least sees why, and points at
 * the filter for trimming it.
 */
export const passthroughInstructions = (input: {
  readonly toolCount: number;
  readonly integrations: readonly string[];
  readonly requested: readonly string[] | undefined;
}): string => {
  const lines = [
    `This server exposes ${input.toolCount} integration tool${input.toolCount === 1 ? "" : "s"} directly (passthrough mode).`,
    "Each tool is named <integration>__<tool>, or <integration>__<connection>__<tool> when an integration has several connections.",
    "Tools marked destructiveHint require the user's approval in your client before you call them; readOnlyHint marks tools that never mutate upstream state.",
  ];
  if (input.integrations.length > 0) {
    lines.push(`Integrations served: ${input.integrations.join(", ")}.`);
  }
  if (input.requested && input.requested.length > 0) {
    const missing = input.requested.filter((slug) => !input.integrations.includes(slug));
    if (missing.length > 0) {
      lines.push(
        `Requested but not connected (no tools served): ${missing.join(", ")}. Connect them in the Executor console.`,
      );
    }
  } else {
    lines.push(
      "To narrow this list, connect with ?integrations=<slug>,<slug> on the endpoint URL.",
    );
  }
  return lines.join("\n");
};

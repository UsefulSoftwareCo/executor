// ---------------------------------------------------------------------------
// Server-side product-analytics event catalog.
//
// The server analog of the browser catalog in packages/react/src/api/
// analytics.tsx, which is BROWSER-ONLY by design (its own header says server
// events need their own seam — this is that seam). Cloud keeps its browser
// client; this catalog is for the surfaces that had none: the local daemon
// (CLI + desktop) and self-host.
//
// PROPERTY RULES (same line the browser catalog draws):
//   - Metadata about product usage only — the question these answer is "how
//     are product features being used", never "what is this user doing".
//   - Never secrets, tokens, credentials, code, tool arguments or results.
//   - Never user free text: no connection names, no tool addresses, no
//     toolkit slugs (user-entered labels — send booleans/counts instead).
//   - Plugin keys (`openapi`, `mcp`, `graphql`, ...) ARE allowed: a fixed,
//     product-defined vocabulary. Integration slugs are NOT — stricter than
//     the browser catalog: these events leave the user's own infrastructure,
//     and WHICH integrations someone uses is their business, not ours. The
//     kind of integration is the product question; the slug is not.
//   - Identity is the anonymous per-install id only; no emails, no hostnames,
//     no person or org names.
// ---------------------------------------------------------------------------

/**
 * Which door an execution came through. Bound structurally by the host (each
 * serving plane wraps its engine once), never inferred from a header or flag:
 *   - `mcp` — an agent invoking over the MCP surface.
 *   - `api` — the HTTP executions API (CLI `call`/`resume`, the web console).
 */
export type ExecutionPlane = "mcp" | "api";

/**
 * Which door an artifact operation came through: an agent calling the MCP
 * artifact tools, or a human in the console UI (whose data layer is the
 * artifacts HTTP API). Bound at each door's composition point, mirroring
 * `ExecutionPlane`.
 */
export type ArtifactVia = "agent" | "ui";

export interface AnalyticsEvents {
  /**
   * A code execution reached a terminal outcome. Recorded once per execution
   * at completion — a paused execution is recorded when its resume completes,
   * not when it pauses. `toolkit` marks executions served by a toolkit-scoped
   * MCP endpoint (the toolkit's slug is a user label and deliberately absent).
   */
  execution_completed: {
    readonly ok: boolean;
    readonly plane: ExecutionPlane;
    readonly toolkit: boolean;
  };
  /** An integration row was created (upsert re-registers are not counted). */
  integration_added: { readonly plugin_key: string };
  /** An integration was removed by the user. */
  integration_removed: { readonly plugin_key: string };
  /** A generative-UI artifact was saved as a new row. */
  artifact_created: { readonly via: ArtifactVia };
  /**
   * An artifact was opened for its content: the agent's `show-artifact` or
   * the console detail page. Internal reads (binding resolution inside an
   * execution) deliberately do not count.
   */
  artifact_viewed: { readonly via: ArtifactVia };
  /** An existing artifact was overwritten in place, or renamed. */
  artifact_updated: { readonly via: ArtifactVia };
  /** An artifact was deleted. Only the UI offers deletion today. */
  artifact_deleted: { readonly via: ArtifactVia };
}

export type AnalyticsEventName = keyof AnalyticsEvents;

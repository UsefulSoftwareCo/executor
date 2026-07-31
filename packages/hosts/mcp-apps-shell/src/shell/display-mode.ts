/**
 * How the shell decides whether it is a document or an app.
 *
 * ## The two modes, and why the difference is structural
 *
 * An artifact is rendered in two very different places, and they want opposite
 * things from the same code:
 *
 *  - **Embedded in a chat thread** (Claude and every other MCP-Apps client). The
 *    artifact is one block in a conversation that scrolls. It must be exactly as
 *    tall as its content, because anything else either clips it or leaves a hole
 *    in the transcript. The app reports its content height, the host grows the
 *    frame, the PAGE scrolls. This is `inline`, and it is correct there.
 *
 *  - **On the console's artifact detail page.** The artifact IS the page. There
 *    is nothing else on the surface to scroll past, so growing the frame to
 *    content produces the failure this module exists to fix: a table of 143 rows
 *    pushes its own "Projects" header, its search box and its filters off the
 *    top of the screen, and the user scrolls a document when they expected an
 *    app. What they want — a stable header over a scrolling table — is not
 *    something the artifact's author can express, no matter what they write,
 *    because `h-full` against an unbounded parent is just `h-auto`. The artifact
 *    never had a viewport to lay out against.
 *
 * So the fix is not a prompt rule. The host must hand the app a BOUNDED height
 * and stop growing with it, and the app must turn that bound into a real
 * `height: 100%` chain the artifact's own `flex-1 min-h-0 overflow-auto` can
 * resolve against.
 *
 * ## Why `fullscreen` and not a mode of our own
 *
 * The MCP Apps spec's display mode is a CLOSED union — `"inline" | "fullscreen"
 * | "pip"` (`McpUiDisplayMode`). There is no "fill", and inventing one would
 * mean a value no other host could ever understand travelling on a spec field
 * whose whole purpose is that hosts agree on it.
 *
 * `fullscreen` is the spec's existing word for the situation the detail page is
 * actually in: the app owns the whole surface it is given rather than sitting in
 * a flow of other content. That is exactly what the detail page offers it — the
 * viewport below the title bar, and nothing else competing for it. So the
 * console advertises `displayMode: "fullscreen"`, and the shell reads the spec
 * field rather than a private flag.
 *
 * The bound itself rides `containerDimensions`, which the shell already honors
 * (it is how the old unconditional 800px cap was replaced). The distinction that
 * carries the meaning is `height` versus `maxHeight`: a FIXED `height` is the
 * spec's way of saying "this is the room you have, exactly", where `maxHeight`
 * only says "no more than this". Fill mode sends a fixed `height`, so the app
 * can size to it rather than merely staying under it.
 *
 * Reading BOTH — the mode and a fixed height — is deliberate. A host that says
 * `fullscreen` but never reports a height has told the shell nothing it can lay
 * out against, and the safe answer there is to keep behaving like a document.
 */
import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps";

/**
 * The display mode the console's artifact detail page advertises.
 *
 * Named rather than inlined so the host and the shell cannot drift apart on
 * which of the spec's three modes means "the artifact owns this surface".
 */
export const FILL_DISPLAY_MODE = "fullscreen" as const;

/** The mode every other host gets, and the default when none is advertised. */
export const INLINE_DISPLAY_MODE = "inline" as const;

/**
 * The exact height the host has given the app, or `null` when it has not given
 * it one.
 *
 * `containerDimensions` is a union: one arm carries a fixed `height`, the other
 * an optional `maxHeight`. Only the fixed arm is a viewport — `maxHeight` is a
 * ceiling on growth, which is the inline story, not this one.
 */
const fixedContainerHeight = (ctx: McpUiHostContext | undefined): number | null => {
  const container = ctx?.containerDimensions;
  if (!container) return null;
  if (!("height" in container)) return null;
  const { height } = container;
  return typeof height === "number" && height > 0 ? height : null;
};

/**
 * Whether this host has given the app a bounded viewport to fill.
 *
 * Both halves are required, and neither is redundant:
 *
 *  - the mode says the app owns its surface, which is a statement about
 *    LAYOUT INTENT that only the host can make;
 *  - the fixed height says how much surface that is, which is the number the
 *    app cannot measure for itself (its own viewport IS the frame the host
 *    sizes, so measuring it would be circular).
 *
 * A host advertising `fullscreen` with no fixed height gets inline behaviour,
 * which is the honest fallback: without a bound there is nothing for `height:
 * 100%` to resolve against, and growing to content at least shows everything.
 */
export const isFillDisplayMode = (ctx: McpUiHostContext | undefined): boolean =>
  ctx?.displayMode === FILL_DISPLAY_MODE && fixedContainerHeight(ctx) !== null;

/** The bounded viewport height, or `null` when this host is not filling one. */
export const fillViewportHeight = (ctx: McpUiHostContext | undefined): number | null =>
  isFillDisplayMode(ctx) ? fixedContainerHeight(ctx) : null;

/**
 * The host call that says "the artifact is on screen now".
 *
 * ## Why a host needs to be told
 *
 * Opening an artifact is a three-document journey — the console fetches the
 * row, loads the shell document into an iframe, and the shell compiles the JSX
 * into a further nested frame. A host that wants to hold ONE loading surface
 * across all of it (the console does; see `ArtifactStageSkeleton`) needs to know
 * when the last of those has actually painted, and nothing in the MCP-Apps
 * protocol says so. `ui/notifications/size-changed` is the closest thing and it
 * is not the same fact: the shell document reports its own size while it is
 * still booting, long before any artifact exists, and a fill-mode host ignores
 * the report entirely.
 *
 * So the shell says it explicitly, once, when it has something to show.
 *
 * ## "Rendered" means presented, not successful
 *
 * The signal fires for the ERROR surfaces too — a compile failure, a component
 * that threw, an artifact that rendered fine. All three are "the shell is done
 * waiting and the user should be looking at the frame rather than a skeleton",
 * which is the only question the host is asking. A signal that fired only on
 * success would strand a failed artifact under a loading state forever, which is
 * a worse bug than the one this exists to fix.
 *
 * ## Why this is its own module
 *
 * Same reason as `./preview-capture`, and it is a hard constraint rather than a
 * preference: `shell-app.tsx` imports `virtual:executor-tailwind-browser` and
 * `virtual:executor-inner-renderer`, which exist only inside the standalone
 * shell's own Vite build. Importing a constant FROM there drags those virtual
 * modules into the console's bundle, where nothing supplies them, and the
 * artifact renderer then fails to load at all. A module with no imports of its
 * own is what lets both halves agree on the vocabulary.
 *
 * ## Why it rides `callServerTool`
 *
 * Because that seam already exists in every host, exactly as the preview capture
 * does. The console intercepts the name before the tool transport, so it never
 * reaches `/executions` — a "you can stop waiting now" is not an execution and
 * must not be metered, approved or logged as one.
 */
export const ARTIFACT_RENDERED_TOOL = "executor-artifact-rendered";

/**
 * The host-context key by which a host asks to be told.
 *
 * Carried on `McpUiHostContext`'s open index signature, the spec's own
 * forward-compatibility seam — the same door `PREVIEW_CAPTURE_HOST_CONTEXT_KEY`
 * goes through. Only the console sets it, because only the console holds a
 * loading surface it needs to take down. Every real MCP client omits it and the
 * shell never makes the call, so no host is sent a tool name it has never heard
 * of.
 *
 * A separate key from the preview capture rather than one "this is the console"
 * flag: they are two independent capabilities, and a host that wants a seamless
 * handoff without storing thumbnails should be able to say exactly that.
 */
export const RENDER_SIGNAL_HOST_CONTEXT_KEY = "executorRenderSignal";

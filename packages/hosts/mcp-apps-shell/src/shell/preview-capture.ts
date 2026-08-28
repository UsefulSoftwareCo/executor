/**
 * The host call that stores a settled-render snapshot.
 *
 * ## Why this is its own module
 *
 * Both ends of the capture name it: the shell document sends it, and the
 * console's `ArtifactShell` answers it. But `shell-app.tsx` imports
 * `virtual:executor-tailwind-browser` and `virtual:executor-inner-renderer`,
 * which only exist inside the standalone shell's own Vite build — so importing
 * this constant FROM there drags those virtual modules into the console's
 * bundle, where nothing supplies them, and the artifact renderer fails to load
 * at all.
 *
 * Keeping the shared name in a module with no imports is what lets both sides
 * agree on it without either pulling in the other's build graph.
 *
 * ## What it is
 *
 * Not an MCP tool the server advertises. It rides the `callServerTool` seam
 * because that seam already exists in every host, and the console intercepts it
 * before the tool transport — a snapshot is not an execution and must never be
 * metered, approved or logged as one. A host that does not implement the name
 * simply rejects the call, which is exactly the fail-quiet behaviour a preview
 * upgrade should have.
 */
export const SAVE_ARTIFACT_PREVIEW_TOOL = "executor-save-artifact-preview";

/**
 * The host-context key by which a host asks for a preview snapshot.
 *
 * Carried on `McpUiHostContext`'s open index signature, which is the spec's own
 * forward-compatibility seam. Only the console sets it — it is the only host
 * with somewhere to put a preview — so everywhere else the inner frame skips
 * the capture entirely rather than doing the work and dropping it.
 */
export const PREVIEW_CAPTURE_HOST_CONTEXT_KEY = "executorPreviewCapture";

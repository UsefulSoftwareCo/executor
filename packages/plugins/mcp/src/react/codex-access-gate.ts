// ---------------------------------------------------------------------------
// When the Codex plugin card may hand over its Add button.
//
// The probe behind this is the only way to know whether macOS will let the
// plugin run: privacy decisions are not readable, so the card tries the real
// path and reads the answer. Adding before that answer arrives produces an
// integration that looks connected and fails on its first call, at a point
// where the explanation — and the switch that fixes it — are no longer on
// screen.
// ---------------------------------------------------------------------------

/** The `checkCodexPluginAccess` result, as the card holds it. */
export interface CodexAccessState {
  readonly status: string;
  readonly message?: string;
}

/**
 * The plugin was reached and refused.
 *
 * Only `blocked` counts. `unsupported` (a host that cannot spawn stdio at all)
 * and `nothing-to-check` (a plugin with no probe) are answers, not blocks, and
 * holding the button on either would strand plugins that need no permission.
 */
export const accessBlocked = (access: CodexAccessState | null): boolean =>
  access !== null && access.status === "blocked";

/**
 * The answer is still coming.
 *
 * A card that declares permissions runs the probe on open, so `null` there
 * means the check has not reported yet rather than that nothing will check.
 * Without permissions there is nothing to wait for, and the button stays live.
 */
export const accessPending = ({
  checking,
  declaresPermissions,
  access,
}: {
  readonly checking: boolean;
  readonly declaresPermissions: boolean;
  readonly access: CodexAccessState | null;
}): boolean => checking || (declaresPermissions && access === null);

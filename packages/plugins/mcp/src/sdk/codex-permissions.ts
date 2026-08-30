// ---------------------------------------------------------------------------
// macOS permissions for the Codex plugins.
//
// These plugins drive the real machine, so macOS gates them behind TCC. Two
// facts shape everything here, both established by probing a live install
// rather than from documentation:
//
//   * The permissions do NOT all attach to the same identity. Reading Messages
//     works from a host with no Full Disk Access, because the Codex Computer
//     Use SERVICE (`com.openai.sky.CUAService`) holds that grant and does the
//     reading. But sending an Apple Event is attributed to the RESPONSIBLE
//     process — the app that launched the chain — so Automation is granted per
//     host. The same call therefore succeeds from a terminal whose app is
//     approved and fails from a desktop app that is not.
//
//   * A denial is permanent until the user acts. macOS asks once; after that
//     `-1743` (`errAEEventNotPermitted`) comes back forever and no prompt is
//     shown again. So "try and see" is not a recovery strategy — the user has
//     to be told which entry to enable, and taken there.
//
// The failure this produces is otherwise indecipherable: the plugin reports
// "server error -1743: Unknown error", which reaches the caller scrubbed to an
// opaque internal error id. Classifying it here is what turns the most common
// first-run failure into something a person can act on.
// ---------------------------------------------------------------------------

/** A macOS privacy pane, as a deep link `open` understands. */
const settingsUrl = (pane: string): string =>
  `x-apple.systempreferences:com.apple.preference.security?${pane}`;

export interface CodexPermission {
  readonly id: "automation" | "accessibility" | "screen-recording" | "contacts" | "full-disk";
  /** What macOS calls this in System Settings. */
  readonly label: string;
  /** Which entry the user must find and enable there. */
  readonly entry: string;
  /** Why this plugin needs it, in the user's terms. */
  readonly why: string;
  readonly settingsUrl: string;
}

/** Automation is per-HOST: the app that spawned the chain is what macOS asks
 *  about, so the entry is executor itself rather than anything Codex ships. */
const automation = (target: string, why: string): CodexPermission => ({
  id: "automation",
  label: "Automation",
  entry: `Executor → ${target}`,
  why,
  settingsUrl: settingsUrl("Privacy_Automation"),
});

/** Screen Recording and Accessibility attach to the Codex Computer Use app,
 *  which is why granting them once in Codex covers every host. */
const computerUsePermissions: readonly CodexPermission[] = [
  {
    id: "screen-recording",
    label: "Screen Recording",
    entry: "Codex Computer Use",
    why: "so it can see the app it is operating",
    settingsUrl: settingsUrl("Privacy_ScreenCapture"),
  },
  {
    id: "accessibility",
    label: "Accessibility",
    entry: "Codex Computer Use",
    why: "so it can click, type, and scroll",
    settingsUrl: settingsUrl("Privacy_Accessibility"),
  },
];

const messagesPermissions: readonly CodexPermission[] = [
  automation("Messages", "so it can read your chats and send on your behalf"),
  {
    id: "contacts",
    label: "Contacts",
    entry: "Codex Computer Use",
    why: "so it can turn names into the right phone numbers",
    settingsUrl: settingsUrl("Privacy_Contacts"),
  },
];

/** What each plugin needs, keyed by preset id. Absent means nothing beyond
 *  having Codex installed. */
export const CODEX_PERMISSIONS: Readonly<Record<string, readonly CodexPermission[]>> = {
  "codex-messages": messagesPermissions,
  "codex-computer-use": computerUsePermissions,
  "codex-computer-history": computerUsePermissions,
  "codex-chrome": [automation("Google Chrome", "so it can drive your browser")],
};

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Apple Event failures that mean "the user has not allowed this", as opposed
 *  to a target that is missing or busy.
 *
 *  `-1743` is `errAEEventNotPermitted`: the grant was DECLINED, or never
 *  answered and has since defaulted closed. `-600`/`-609` are the connection
 *  errors macOS returns when it refuses to hand the sender a port at all,
 *  which is how the same denial presents on some paths. */
const APPLE_EVENT_DENIED = [-1743, -609, -600] as const;

const deniedCodePattern = new RegExp(`(?:^|[^0-9-])(${APPLE_EVENT_DENIED.join("|")})(?![0-9])`);

/** A permission failure recognised in an upstream tool error, or null when the
 *  error is about something else. Matching is on the numeric code, not on
 *  wording: the plugin's own text is "Unknown error". */
export const permissionFailure = (
  message: string,
  presetId: string | undefined,
): CodexPermission | null => {
  if (!deniedCodePattern.test(message)) return null;
  const permissions = presetId === undefined ? [] : (CODEX_PERMISSIONS[presetId] ?? []);
  // Automation is the one a host can actually be missing; the Codex-owned
  // grants are shared and fail differently. Fall back to the first declared.
  return permissions.find((permission) => permission.id === "automation") ?? permissions[0] ?? null;
};

/** The message a caller sees instead of "Unknown error".
 *
 *  Written for whoever reads it next — a person, or a model relaying to one.
 *  It names the block, the exact entry to enable, and where, because macOS
 *  will not ask again on its own. */
export const permissionFailureMessage = (permission: CodexPermission): string =>
  [
    `macOS blocked this: ${permission.label} access has not been allowed.`,
    `Open System Settings → Privacy & Security → ${permission.label}, find "${permission.entry}", and turn it on — ${permission.why}.`,
    "macOS only asks once, so a prompt will not appear again until it is enabled there.",
  ].join(" ");

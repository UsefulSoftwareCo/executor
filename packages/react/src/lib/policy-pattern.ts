import { matchPattern, type Owner } from "@executor-js/sdk/shared";

// ---------------------------------------------------------------------------
// Policy pattern bridge.
//
// The executor now matches tool policies against the FULL tool address
// `integration.owner.connection.tool` (so a policy CAN target one connection).
// The UI, however, shows a connection-AGNOSTIC tree keyed on the display id
// `integration.<tool>` — the owner/connection segments are deliberately hidden
// (single-player has no owner; multiplayer groups by connection elsewhere).
//
// So a policy authored from a tool/integration node applies across ALL of that
// integration's connections: wildcard the owner + connection segments →
// `integration.*.*.<tool>`. The whole-integration form (`integration.*`) and the
// universal `*` already cover the deeper segments via their trailing `*`, so
// they pass through unchanged. This is applied at every UI site that BUILDS a
// pattern from a node AND every site that LOOKS UP whether a stored pattern is
// the exact rule on a node, so the two stay symmetric.
// ---------------------------------------------------------------------------

export const toPolicyPattern = (displayPattern: string): string => {
  if (displayPattern === "*") return "*";
  const firstDot = displayPattern.indexOf(".");
  if (firstDot === -1) return displayPattern; // bare integration slug, no tail
  const integration = displayPattern.slice(0, firstDot);
  const rest = displayPattern.slice(firstDot + 1);
  if (rest === "*") return displayPattern; // `integration.*` — trailing * is already a subtree
  return `${integration}.*.*.${rest}`;
};

export { matchPattern };

// ---------------------------------------------------------------------------
// Account-scoped bridge.
//
// The account-grouped Tools tab shows the same tool once per connection. A
// rule authored from a row inside one account's section must govern THAT
// account only — a Slack bot connection and a Slack user connection are
// different credentials with different capabilities, and blocking a tool on
// one must not silently block it on the other. So instead of wildcarding the
// owner + connection segments, fill them in: `integration.<owner>.<conn>.<tool>`.
// `integration.*` becomes the whole-account subtree
// `integration.<owner>.<conn>.*`. Apply the returned mapper at both the site
// that BUILDS a pattern and the site that LOOKS UP the exact rule, exactly as
// with `toPolicyPattern`.
// ---------------------------------------------------------------------------

export const accountPolicyPattern =
  (owner: Owner, connection: string) =>
  (displayPattern: string): string => {
    if (displayPattern === "*") return "*";
    const firstDot = displayPattern.indexOf(".");
    if (firstDot === -1) return `${displayPattern}.${owner}.${connection}.*`;
    const integration = displayPattern.slice(0, firstDot);
    const rest = displayPattern.slice(firstDot + 1);
    return `${integration}.${owner}.${connection}.${rest}`;
  };

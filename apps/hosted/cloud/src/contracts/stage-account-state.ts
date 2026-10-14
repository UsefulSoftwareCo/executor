/**
 * A test stage that signs in through production's OAuth proxy also sends production's
 * connected-account callback, `executor.sh/api/oauth/callback`, the one services that allow only
 * approved callbacks accept. Its OAuth `state` names the stage's browser origin after v2's prefix,
 * `x2.<base64url origin>.<random>`, so v1's edge still forwards it to production, and production
 * sends the browser to that origin's callback page without a lookup. The random part is base64url
 * and never has a dot, so production's own states never carry an origin.
 */
import { Option } from "effect";
import { accountOAuthStatePrefix } from "./edge-paths.ts";

/** The state prefix of a stage whose browser origin is `origin`. */
export const stageAccountStatePrefix = (origin: string) =>
  `${accountOAuthStatePrefix}${Buffer.from(origin).toString("base64url")}.`;

/** The browser origin a stage's state names, or none for every other state. */
export const stageAccountStateOrigin = (state: string): Option.Option<string> => {
  if (!state.startsWith(accountOAuthStatePrefix)) return Option.none();
  const rest = state.slice(accountOAuthStatePrefix.length);
  const end = rest.indexOf(".");
  if (end <= 0) return Option.none();
  const encoded = rest.slice(0, end);
  const decoded = Buffer.from(encoded, "base64url");
  // Only the exact encoding of an HTTP(S) origin names a stage.
  if (decoded.toString("base64url") !== encoded) return Option.none();
  const origin = URL.parse(decoded.toString("utf8"));
  return origin !== null &&
    (origin.protocol === "https:" || origin.protocol === "http:") &&
    origin.origin === decoded.toString("utf8")
    ? Option.some(origin.origin)
    : Option.none();
};

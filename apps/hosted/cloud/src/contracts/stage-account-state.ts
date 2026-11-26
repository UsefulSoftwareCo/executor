import { Option } from "effect";
import { accountOAuthStatePrefix } from "./edge-paths.ts";

export const stageAccountStatePrefix = (origin: string) =>
  `${accountOAuthStatePrefix}${Buffer.from(origin).toString("base64url")}.`;

export const stageAccountStateOrigin = (state: string): Option.Option<string> => {
  if (!state.startsWith(accountOAuthStatePrefix)) return Option.none();
  const rest = state.slice(accountOAuthStatePrefix.length);
  const end = rest.indexOf(".");
  if (end <= 0) return Option.none();
  const encoded = rest.slice(0, end);
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.toString("base64url") !== encoded) return Option.none();
  const origin = URL.parse(decoded.toString("utf8"));
  return origin !== null &&
    (origin.protocol === "https:" || origin.protocol === "http:") &&
    origin.origin === decoded.toString("utf8")
    ? Option.some(origin.origin)
    : Option.none();
};

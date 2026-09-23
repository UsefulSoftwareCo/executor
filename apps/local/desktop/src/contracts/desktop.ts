import { Schema } from "effect";

/** Only the child server's exact loopback HTTP origin can host the dashboard. */
export const LocalOrigin = Schema.String.check(
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "http:" &&
        url.hostname === "127.0.0.1" &&
        url.port !== "" &&
        url.origin === value
      );
    } catch {
      return false;
    }
  }),
);

/** Safe desktop failures never include process output, bootstrap tokens or callback URLs. */
export class DesktopFailed extends Schema.TaggedError<DesktopFailed>()("DesktopFailed", {
  stage: Schema.Literals(["configuration", "start", "ready", "server-exit", "window", "oauth"]),
}) {}

/** Private fd4 message; OAuth response parameters must never be copied to a log. */
export const DesktopCallback = Schema.Struct({
  version: Schema.Literal(1),
  url: Schema.RedactedFromValue(
    Schema.String.check(
      Schema.makeFilter((value) => {
        try {
          const url = new URL(value);
          return (
            url.protocol === "http:" &&
            url.hostname === "127.0.0.1" &&
            !url.username &&
            !url.password
          );
        } catch {
          return false;
        }
      }),
    ),
  ),
});

/** Accept ordinary web links; operating-system and executable schemes are not supported. */
export const externalUrl = (value: string): URL | undefined => {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
      ? url
      : undefined;
  } catch {
    return undefined;
  }
};

/** Update-provider failures never expose raw release-feed responses. */
export class UpdateFailed extends Schema.TaggedError<UpdateFailed>()("UpdateFailed", {}) {}

/** Browser launch failures never expose pairing links, session cookies or server responses. */
export class BrowserOpenFailed extends Schema.TaggedError<BrowserOpenFailed>()(
  "BrowserOpenFailed",
  {},
) {}

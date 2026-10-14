/** Deployed stages publish their own OAuth Client ID Metadata Document. */
import { clientMetadataDocumentPath, clientMetadataSetting } from "@executor-js/hosted-server";
import { Config, Effect, Option } from "effect";
import { cloudAccountRedirectUri } from "../implementation/oauth-proxy-settings.ts";
import { cloudHosts } from "./stage.ts";

/**
 * The Worker binding that turns the document on for a deployed stage. It is derived from the
 * stage's public origin, so it always names the document this Worker serves. Production and
 * test stages get it; local development has no public HTTPS origin and leaves it unset.
 */
export const clientMetadataBinding = (origin: URL) =>
  Effect.gen(function* () {
    // A second, hand-set value would leave two bindings for one name.
    const configured = yield* Config.String("EXECUTOR_OAUTH_CLIENT_METADATA_URL").pipe(
      Config.option,
    );
    if (Option.isSome(configured))
      return yield* Effect.die(
        new Error(
          "Deployed stages derive EXECUTOR_OAUTH_CLIENT_METADATA_URL from their origin. " +
            "Remove it from the deploy environment.",
        ),
      );
    return {
      EXECUTOR_OAUTH_CLIENT_METADATA_URL: new URL(clientMetadataDocumentPath, origin).href,
    };
  });

/**
 * The document this deployment serves and the callback it lists, from the same settings as the
 * account sign-ins: the document handler and the executor both read this one value.
 */
export const cloudClientMetadata = Effect.gen(function* () {
  const hosts = yield* cloudHosts;
  const redirect = yield* cloudAccountRedirectUri;
  return yield* clientMetadataSetting({
    origin: hosts.browser,
    oauthRedirectUri: Option.getOrUndefined(redirect),
  });
});

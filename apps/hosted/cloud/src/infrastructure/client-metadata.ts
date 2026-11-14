/** Deployed stages publish their own OAuth Client ID Metadata Document. */
import {
  type ClientMetadataSetting,
  clientMetadataDocumentPath,
  clientMetadataSetting,
} from "@executor-js/hosted-server";
import { Config, Effect, Option } from "effect";
import { cloudAccountRedirectUri } from "../implementation/oauth-proxy-settings.ts";
import { cloudHosts } from "./stage.ts";

/**
 * The Worker binding that turns the document on for a deployed stage. It is derived from the
 * stage's public site origin, the edge (`executor.sh`) where the stage has role hosts, so it
 * always names the document this Worker serves there. Production and test stages get it; local
 * development has no public HTTPS origin and leaves it unset.
 */
export const clientMetadataBinding = Effect.gen(function* () {
  // A second, hand-set value would leave two bindings for one name.
  const configured = yield* Config.String("EXECUTOR_OAUTH_CLIENT_METADATA_URL").pipe(Config.option);
  if (Option.isSome(configured))
    return yield* Effect.die(
      new Error(
        "Deployed stages derive EXECUTOR_OAUTH_CLIENT_METADATA_URL from their origin. " +
          "Remove it from the deploy environment.",
      ),
    );
  const hosts = yield* cloudHosts;
  return {
    EXECUTOR_OAUTH_CLIENT_METADATA_URL: new URL(clientMetadataDocumentPath, hosts.site).href,
  };
});

/**
 * The document new sign-ins use and the callback it lists, from the same settings as the account
 * sign-ins: the edge's document handler and the executor both read this one value.
 */
export const cloudClientMetadata = Effect.gen(function* () {
  const hosts = yield* cloudHosts;
  const redirect = yield* cloudAccountRedirectUri;
  return yield* clientMetadataSetting({
    origin: hosts.browser,
    oauthRedirectUri: Option.getOrUndefined(redirect),
  });
});

/**
 * The document the deployment origin serves. Where the current one is on the edge, this is the
 * one the deployment origin published before it moved there, unchanged: its URL and its own
 * origin's callback. Each grant keeps the client ID it was issued to (`OAuthGrant.client`) and
 * renews with it, and an authorization server may fetch that document again, so it stays served.
 * No sign-in starts with it any more. Without role hosts the deployment serves the current one.
 */
export const deploymentClientMetadata = (current: Option.Option<ClientMetadataSetting>) =>
  Effect.gen(function* () {
    const { deployment } = yield* cloudHosts;
    const url = new URL(clientMetadataDocumentPath, deployment).href;
    return Option.map(current, (setting): ClientMetadataSetting =>
      setting.url === url
        ? setting
        : { url, served: true, redirectUri: new URL("/api/oauth/callback", deployment).href },
    );
  });

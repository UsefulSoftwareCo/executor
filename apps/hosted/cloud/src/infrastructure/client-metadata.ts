import {
  type ClientMetadataSetting,
  clientMetadataDocumentPath,
  clientMetadataSetting,
} from "@executor-js/hosted-server";
import { Config, Effect, Option } from "effect";
import { cloudAccountRedirectUri } from "../implementation/oauth-proxy-settings.ts";
import { cloudHosts } from "./stage.ts";

export const clientMetadataBinding = Effect.gen(function* () {
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

export const cloudClientMetadata = Effect.gen(function* () {
  const hosts = yield* cloudHosts;
  const redirect = yield* cloudAccountRedirectUri;
  return yield* clientMetadataSetting({
    origin: hosts.browser,
    oauthRedirectUri: Option.getOrUndefined(redirect),
  });
});

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

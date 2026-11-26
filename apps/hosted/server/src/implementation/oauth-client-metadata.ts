import { httpsOnlyUrlPolicy, parseDestination } from "@executor-js/utils/url-policy";
import { Config, Effect, Option } from "effect";
import { HttpServerResponse } from "effect/http";
import {
  type ClientMetadataDocument,
  ClientMetadataUrlInvalid,
  clientMetadataDocumentPath,
  clientMetadataLogoPath,
  hostedOAuthClientName,
} from "../contracts/oauth-client-metadata.ts";
import { accountOAuthRedirectUri } from "./auth.ts";

export interface ClientMetadataSetting {
  readonly url: string;
  readonly served: boolean;
  readonly redirectUri: string;
}

const documentCallback = (url: URL, served: boolean, callback: string) =>
  !served || new URL(callback).origin === url.origin
    ? callback
    : new URL("/api/oauth/callback", url.origin).href;

const parse = (value: string, origin: string, callback: string) =>
  Effect.gen(function* () {
    const url = parseDestination(value, httpsOnlyUrlPolicy);
    if (url === undefined || url.href !== value || value.includes("?") || url.pathname === "/") {
      const own = new URL(clientMetadataDocumentPath, origin);
      return yield* new ClientMetadataUrlInvalid({
        reason: "format",
        message: `EXECUTOR_OAUTH_CLIENT_METADATA_URL must be an HTTPS URL on a public host with a path, and no query, fragment or credentials. ${
          parseDestination(own.href, httpsOnlyUrlPolicy) === undefined
            ? "This host's own origin is not public HTTPS, so authorization servers cannot fetch a document from it."
            : `To serve this host's own document, use ${own.href}.`
        }`,
      });
    }
    const served = url.pathname === clientMetadataDocumentPath;
    if (!served && url.origin === new URL(origin).origin)
      return yield* new ClientMetadataUrlInvalid({
        reason: "path",
        message: `This host serves its client metadata document at ${clientMetadataDocumentPath}, not ${url.pathname}.`,
      });
    return {
      url: url.href,
      served,
      redirectUri: documentCallback(url, served, callback),
    } satisfies ClientMetadataSetting;
  });

export const clientMetadataSetting = (auth: {
  readonly origin: string;
  readonly oauthRedirectUri: string | undefined;
}) =>
  Config.String("EXECUTOR_OAUTH_CLIENT_METADATA_URL").pipe(
    Config.option,
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none<ClientMetadataSetting>()),
        onSome: (value) =>
          parse(value, auth.origin, accountOAuthRedirectUri(auth)).pipe(Effect.map(Option.some)),
      }),
    ),
  );

/** RFC 8252 loopback callbacks belong to native clients; OpenID providers refuse them for web. */
const applicationType = (callback: string) => {
  const url = new URL(callback);
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    ? "native"
    : "web";
};

export const clientMetadataDocument = (setting: Option.Option<ClientMetadataSetting>) =>
  Effect.sync(() => {
    if (Option.isNone(setting) || !setting.value.served)
      return HttpServerResponse.empty({ status: 404 });
    const url = new URL(setting.value.url);
    const callback = setting.value.redirectUri;
    const document: ClientMetadataDocument = {
      client_id: url.href,
      client_name: hostedOAuthClientName,
      client_uri: url.origin,
      logo_uri: new URL(clientMetadataLogoPath, url.origin).href,
      redirect_uris: [callback],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: applicationType(callback),
    };
    return HttpServerResponse.jsonUnsafe(document, {
      headers: {
        "cache-control": "public, max-age=300",
        "x-content-type-options": "nosniff",
      },
    });
  });

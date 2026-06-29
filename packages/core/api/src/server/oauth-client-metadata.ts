import { Effect, Layer, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

export const OAUTH_CLIENT_ID_METADATA_DOCUMENT_BASE_PATH = "/oauth/client-id-metadata" as const;
export const OAUTH_CLIENT_ID_METADATA_DOCUMENT_PATH =
  `${OAUTH_CLIENT_ID_METADATA_DOCUMENT_BASE_PATH}.json` as const;
export const OAUTH_CLIENT_ID_METADATA_DOCUMENT_TARGET_PATH_PREFIX =
  `${OAUTH_CLIENT_ID_METADATA_DOCUMENT_BASE_PATH}/` as const;
export const OAUTH_CLIENT_ID_METADATA_DOCUMENT_DEFAULT_TARGET = "default" as const;
export const OAUTH_CLIENT_ID_METADATA_DOCUMENT_LOCAL_TARGET = "local" as const;

type MetadataTarget =
  | typeof OAUTH_CLIENT_ID_METADATA_DOCUMENT_DEFAULT_TARGET
  | typeof OAUTH_CLIENT_ID_METADATA_DOCUMENT_LOCAL_TARGET
  | string;

interface OAuthClientIdMetadataDocument {
  readonly client_id: string;
  readonly client_name: string;
  readonly client_uri: string;
  readonly redirect_uris: readonly string[];
  readonly grant_types: readonly ["authorization_code"];
  readonly response_types: readonly ["code"];
  readonly token_endpoint_auth_method: "none";
  readonly application_type: "web" | "native";
}

const pathWithMountPrefix = (mountPrefix?: string): `/${string}` =>
  `${mountPrefix ?? ""}${OAUTH_CLIENT_ID_METADATA_DOCUMENT_PATH}` as `/${string}`;

const targetPathWithMountPrefix = (mountPrefix?: string): `/${string}` =>
  `${mountPrefix ?? ""}${OAUTH_CLIENT_ID_METADATA_DOCUMENT_TARGET_PATH_PREFIX}*` as `/${string}`;

const callbackPathWithMountPrefix = (mountPrefix?: string): `/${string}` =>
  `${mountPrefix ?? ""}/oauth/callback` as `/${string}`;

export const oauthClientIdMetadataDocumentPath = (mountPrefix?: string): `/${string}` =>
  pathWithMountPrefix(mountPrefix);

export const oauthClientIdMetadataDocumentTargetPath = (
  target: MetadataTarget,
  mountPrefix?: string,
): `/${string}` =>
  `${mountPrefix ?? ""}${OAUTH_CLIENT_ID_METADATA_DOCUMENT_TARGET_PATH_PREFIX}${encodeURIComponent(
    target,
  )}.json` as `/${string}`;

const firstForwardedHeaderValue = (headers: Headers, name: string): string | undefined => {
  const value = headers.get(name)?.split(",")[0]?.trim();
  return value ? value : undefined;
};

const parseAbsoluteUrl = (value: string): URL | undefined => {
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(value)) return undefined;
  return new URL(value);
};
const decodeUriComponentOption = Option.liftThrowable(decodeURIComponent);

const pathSearchAndHash = (value: string, fallbackPath: `/${string}`): string => {
  const parsed = parseAbsoluteUrl(value);
  if (parsed) return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  return value.startsWith("/") ? value : fallbackPath;
};

const metadataTargetFromPath = ({
  pathname,
  mountPrefix,
}: {
  readonly pathname: string;
  readonly mountPrefix?: string;
}): MetadataTarget | undefined => {
  const prefix = `${mountPrefix ?? ""}${OAUTH_CLIENT_ID_METADATA_DOCUMENT_TARGET_PATH_PREFIX}`;
  if (!pathname.startsWith(prefix) || !pathname.endsWith(".json")) return undefined;
  const encoded = pathname.slice(prefix.length, -".json".length);
  if (!encoded || encoded.includes("/")) return undefined;
  const target = Option.getOrUndefined(
    Option.map(decodeUriComponentOption(encoded), (value) => value.trim()),
  );
  return target ? target : undefined;
};

export const oauthClientIdMetadataDocumentUrlFromRequest = ({
  requestUrl,
  webRequest,
  mountPrefix,
}: {
  readonly requestUrl: string;
  readonly webRequest: Request;
  readonly mountPrefix?: string;
}): URL => {
  const requestAbsoluteUrl = parseAbsoluteUrl(requestUrl) ?? parseAbsoluteUrl(webRequest.url);
  const proto =
    firstForwardedHeaderValue(webRequest.headers, "x-forwarded-proto") ??
    requestAbsoluteUrl?.protocol.replace(/:$/, "") ??
    "http";
  const host =
    firstForwardedHeaderValue(webRequest.headers, "x-forwarded-host") ??
    firstForwardedHeaderValue(webRequest.headers, "host") ??
    requestAbsoluteUrl?.host ??
    "localhost";
  const origin = `${proto}://${host}`;
  return new URL(pathSearchAndHash(requestUrl, pathWithMountPrefix(mountPrefix)), origin);
};

const localLoopbackRedirectUris = (mountPrefix?: string): readonly string[] => {
  const callbackPath = callbackPathWithMountPrefix(mountPrefix);
  return [
    new URL(callbackPath, "http://127.0.0.1").toString(),
    new URL(callbackPath, "http://localhost").toString(),
    new URL(callbackPath, "http://[::1]").toString(),
  ];
};

export const oauthClientIdMetadataDocumentFromRequest = ({
  requestUrl,
  webRequest,
  mountPrefix,
}: {
  readonly requestUrl: string;
  readonly webRequest: Request;
  readonly mountPrefix?: string;
}): OAuthClientIdMetadataDocument => {
  const url = oauthClientIdMetadataDocumentUrlFromRequest({ requestUrl, webRequest, mountPrefix });
  const target = metadataTargetFromPath({ pathname: url.pathname, mountPrefix });

  if (target === OAUTH_CLIENT_ID_METADATA_DOCUMENT_LOCAL_TARGET) {
    return {
      client_id: url.toString(),
      client_name: "Executor Local",
      client_uri: url.origin,
      redirect_uris: localLoopbackRedirectUris(mountPrefix),
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "native",
    };
  }

  // The org selector travels in the OAuth `state` (see #1147 and apps/cloud
  // start.ts, which reads it back from state on the callback), never as a
  // provider-facing query param on redirect_uri. Org targets get a distinct
  // `client_id` URL, but all targets register the SAME bare callback so the
  // redirect_uri the client sends matches this document exactly. Providers
  // (e.g. PostHog) compare redirect_uri as an exact string, so an extra query
  // param here would fail with "Mismatching redirect URI".
  const redirectUri = new URL(callbackPathWithMountPrefix(mountPrefix), url.origin);

  return {
    client_id: url.toString(),
    client_name: "Executor",
    client_uri: url.origin,
    redirect_uris: [redirectUri.toString()],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    application_type: "web",
  };
};

export const makeOAuthClientIdMetadataRoute = (
  mountPrefix?: string,
): Layer.Layer<never, never, HttpRouter.HttpRouter> => {
  const handler = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: HTTP router request conversion failure is an edge defect, not recoverable route input
    const webRequest = yield* HttpServerRequest.toWeb(request).pipe(Effect.orDie);
    const metadata = oauthClientIdMetadataDocumentFromRequest({
      requestUrl: request.url,
      webRequest,
      mountPrefix,
    });

    return HttpServerResponse.jsonUnsafe(metadata, {
      headers: {
        "cache-control": "public, max-age=300",
      },
    });
  });

  return Layer.mergeAll(
    HttpRouter.add("GET", pathWithMountPrefix(mountPrefix), handler),
    HttpRouter.add("GET", targetPathWithMountPrefix(mountPrefix), handler),
  );
};

import { Option } from "effect";

export const v1ClientIdMetadataPrefix = "/api/oauth/client-id-metadata";

export const isV1ClientIdMetadataPath = (pathname: string) =>
  pathname === `${v1ClientIdMetadataPrefix}.json` ||
  pathname.startsWith(`${v1ClientIdMetadataPrefix}/`);

const decodeComponent = Option.liftThrowable(decodeURIComponent);

export const v1ClientIdMetadataDocument = (url: URL) => {
  const own = new URL(`${url.pathname}${url.search}`, url.origin);
  const prefix = `${v1ClientIdMetadataPrefix}/`;
  const encoded =
    own.pathname.startsWith(prefix) && own.pathname.endsWith(".json")
      ? own.pathname.slice(prefix.length, -".json".length)
      : "";
  const target =
    encoded === "" || encoded.includes("/")
      ? undefined
      : Option.getOrUndefined(Option.map(decodeComponent(encoded), (value) => value.trim()));
  if (target === "local")
    return {
      client_id: own.toString(),
      client_name: "Executor Local",
      client_uri: own.origin,
      redirect_uris: [
        "http://127.0.0.1/api/oauth/callback",
        "http://localhost/api/oauth/callback",
        "http://[::1]/api/oauth/callback",
      ],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "native",
    };
  return {
    client_id: own.toString(),
    client_name: "Executor",
    client_uri: own.origin,
    redirect_uris: [new URL("/api/oauth/callback", own.origin).toString()],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    application_type: "web",
  };
};

/** Scoped connection fixtures through public product routes and the standard OAuth endpoints. */
import { expect } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { createHash, randomBytes } from "node:crypto";
import { Api, body, type Session } from "./api.ts";
import { Evidence } from "./evidence.ts";
import { Target } from "./platform.ts";
import { targetHosts } from "./role-hosts.ts";
import { appsManifest } from "./apps-release.ts";

const RunTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("app") }),
  Schema.Struct({ kind: Schema.Literal("profile"), id: Schema.String }),
]);
/** The public connection record, including the MCP URL that issues grants bound to it. */
export const ConnectionView = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  url: Schema.String,
  policy: Schema.Struct({
    apps: Schema.Array(
      Schema.Struct({ app: Schema.String, runsAs: Schema.Array(RunTarget), tools: Schema.Unknown }),
    ),
  }),
});
/** An `execute` result: the program's completion and its value. */
export const Execution = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({ ok: Schema.Boolean, value: Schema.optional(Schema.Unknown) }),
});
const Tokens = Schema.Struct({
  access_token: Schema.NonEmptyString,
  refresh_token: Schema.NonEmptyString,
});
const Grants = Schema.Array(
  Schema.Struct({ clientId: Schema.String, grant: Schema.Struct({ id: Schema.String }) }),
);

/**
 * Run the authorization-code flow for one resource as a signed-in browser session, using the
 * endpoints' JSON redirect mode instead of rendering the consent page. The authorization code
 * goes to a loopback URL that is never contacted; the consent response carries it.
 * An undefined resource sends no RFC 8707 `resource` parameter, as some MCP clients do.
 */
export const consentTo = (
  session: Session,
  resource: string | undefined,
  headers: Record<string, string> = {},
) =>
  Effect.gen(function* () {
    const api = yield* Api,
      target = yield* Target,
      http = yield* HttpClient.HttpClient;
    // Authorization and consent run on the browser origin, Cloud's `app.` host.
    const origin = targetHosts(target).browser;
    const redirect = "http://127.0.0.1:9/callback";
    const registered = yield* api.request(
      yield* api.session(),
      "POST",
      "/api/auth/oauth2/register",
      {
        client_name: "Scoped connection client",
        redirect_uris: [redirect],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
    );
    expect(registered.status).toBe(201);
    const { client_id: clientId } = yield* body(
      Schema.Struct({ client_id: Schema.String }),
      registered,
    );
    const verifier = randomBytes(32).toString("base64url");
    const resourceField: Record<string, string> = resource === undefined ? {} : { resource };
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirect,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      scope: "mcp offline_access",
      ...resourceField,
      state: randomBytes(16).toString("hex"),
    });
    const opened = yield* api.request(
      session,
      "GET",
      `/api/auth/oauth2/authorize?${query.toString()}`,
      undefined,
      { accept: "application/json" },
    );
    expect(opened.status).toBe(200);
    const next = new URL((yield* body(Schema.Struct({ url: Schema.String }), opened)).url, origin);
    // An unknown or disabled resource is refused before consent, back at the client's redirect.
    if (next.origin !== origin)
      return {
        status: undefined,
        refused: next.searchParams.get("error"),
        clientId,
        consentResources: undefined,
        tokens: Effect.die("The authorization request was refused"),
      };
    const consentPage = next;
    const consented = yield* api.request(
      session,
      "POST",
      "/api/auth/oauth2/consent",
      { accept: true, oauth_query: consentPage.search.slice(1) },
      headers,
    );
    /** Exchange the approved code; only an accepted consent has one. */
    const tokens = Effect.gen(function* () {
      const { url } = yield* body(Schema.Struct({ url: Schema.String }), consented);
      const code = new URL(url).searchParams.get("code");
      expect(code).not.toBeNull();
      const exchanged = yield* Effect.scoped(
        Effect.gen(function* () {
          const response = yield* http.execute(
            HttpClientRequest.post(`${origin}/api/auth/oauth2/token`).pipe(
              HttpClientRequest.bodyUrlParams({
                grant_type: "authorization_code",
                client_id: clientId,
                code: code ?? "",
                code_verifier: verifier,
                redirect_uri: redirect,
                ...resourceField,
              }),
            ),
          );
          expect(response.status).toBe(200);
          return yield* response.json;
        }),
      );
      return Redacted.make((yield* Schema.decodeUnknownEffect(Tokens)(exchanged)).access_token);
    });
    return {
      status: consented.status,
      refused: null,
      clientId,
      /** The resources the consent page was asked to approve. */
      consentResources: consentPage.searchParams.getAll("resource"),
      tokens,
    };
  });

/** The ID of the grant this session issued to a client, read from the public grants list. */
export const clientGrantId = (session: Session, clientId: string) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const grants = yield* body(Grants, yield* api.request(session, "GET", "/api/auth/mcp/grants"));
    const grant = grants.find((item) => item.clientId === clientId);
    if (grant === undefined) return yield* Effect.die(`No grant was issued to ${clientId}`);
    return grant.grant.id;
  });

/** Revoke every grant this session issued to the given clients, even after a failed scenario. */
export const revokeClientGrants = (session: Session, clients: () => readonly string[]) =>
  Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const api = yield* Api,
        evidence = yield* Evidence;
      const listed = yield* api.request(session, "GET", "/api/auth/mcp/grants");
      const grants = yield* body(Grants, listed);
      const owned = grants.filter((grant) => clients().includes(grant.clientId));
      for (const grant of owned)
        yield* api.request(session, "POST", "/api/auth/mcp/grants/revoke", { id: grant.grant.id });
      yield* evidence.json("connection-grant-cleanup.json", { revokedGrants: owned.length });
    }).pipe(Effect.orDie),
  );

/** Account-free app with one read-only and one writing tool. */
export const readWriteAppFiles = (receipt: string) => [
  {
    path: "index.ts",
    content: `
import { defineApp, mutation, object, query, string, router } from "apps";
export default defineApp({ accounts: {} }, async () => ({
  tools: router({
    read: query({ description: "Read the receipt", input: object({}) }, async () => ({ read: ${JSON.stringify(receipt)} })),
    write: mutation({ description: "Write a message", input: object({ message: string() }) }, async (_, input) => ({ wrote: input.message })),
  }),
}));
`,
  },
  appsManifest,
];

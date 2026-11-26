import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Deferred, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";

export interface ChooserAuthorization {
  readonly clientId: string;
  readonly person: string;
  readonly prompt: string | null;
  readonly chooserShown: boolean;
}

export interface ChooserRegistration {
  readonly clientId: string;
  readonly clientName: string | undefined;
}

export type RegistrationAnswer = "issue" | "rate_limited" | "rejected" | "same_client";

interface Token {
  readonly clientId: string;
  readonly organization: string;
  readonly refresh: boolean;
  readonly renewed: boolean;
  revoked: boolean;
}

export interface ChooserCall {
  readonly clientId: string;
  readonly renewed: boolean;
}

const RegistrationRequest = Schema.Struct({
  redirect_uris: Schema.Array(Schema.String),
  client_name: Schema.optional(Schema.String),
});
const McpMessage = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  method: Schema.String,
  params: Schema.optional(Schema.Struct({ protocolVersion: Schema.optional(Schema.String) })),
});

export interface ChooserRefresh {
  readonly clientId: string;
  readonly accepted: boolean;
}

export const organizationChooserService = (
  options: {
    readonly management?: boolean;
    readonly expiresIn?: number;
    readonly promptValues?: "null" | "overflowing";
  } = {},
) =>
  Effect.gen(function* () {
    const address = yield* Deferred.make<string>();
    const management = options.management ?? true;
    const refreshes: ChooserRefresh[] = [];
    const calls: ChooserCall[] = [];
    let answer: RegistrationAnswer = "issue";
    let clientLimit = Number.POSITIVE_INFINITY;
    let deletionStatus = 204;
    let person = "alex";
    let browserReturn: string | undefined;
    const clients = new Map<string, { readonly token: string }>();
    const registrations: ChooserRegistration[] = [];
    const deletions: string[] = [];
    const deletionAttempts: string[] = [];
    const refusedTokens = new Set<string>();
    const authorizations: ChooserAuthorization[] = [];
    const consent = new Map<string, string>();
    const pending = new Map<string, URLSearchParams>();
    const codes = new Map<
      string,
      { clientId: string; organization: string; redirect: string; challenge: string }
    >();
    const tokens = new Map<string, Token>();
    const consentKey = (clientId: string, who: string) => JSON.stringify([clientId, who]);

    const approve = (params: URLSearchParams, organization: string, who: string) => {
      const clientId = params.get("client_id") ?? "";
      consent.set(consentKey(clientId, who), organization);
      const code = randomUUID();
      codes.set(code, {
        clientId,
        organization,
        redirect: params.get("redirect_uri") ?? "",
        challenge: params.get("code_challenge") ?? "",
      });
      const callback = new URL(params.get("redirect_uri") ?? "");
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", params.get("state") ?? "");
      const location =
        browserReturn === undefined ? callback : new URL("/oauth/callback", browserReturn);
      location.search = callback.search;
      return HttpServerResponse.empty({ status: 302, headers: { location: location.href } });
    };
    const issue = (clientId: string, organization: string, renewed = false) => {
      const access = `synthetic-access-${randomUUID()}`;
      const refresh = `synthetic-refresh-${randomUUID()}`;
      tokens.set(access, { clientId, organization, refresh: false, renewed, revoked: false });
      tokens.set(refresh, { clientId, organization, refresh: true, renewed, revoked: false });
      return {
        access_token: access,
        refresh_token: refresh,
        token_type: "Bearer",
        expires_in: options.expiresIn ?? 3600,
        scope: "mcp",
      };
    };
    const metadata = Effect.gen(function* () {
      const origin = yield* Deferred.await(address);
      return yield* HttpServerResponse.json({
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: ["mcp"],
      });
    });

    const routes = Layer.mergeAll(
      HttpRouter.add("GET", "/.well-known/oauth-protected-resource", metadata),
      HttpRouter.add("GET", "/.well-known/oauth-protected-resource/mcp", metadata),
      HttpRouter.add(
        "GET",
        "/.well-known/oauth-authorization-server",
        Effect.gen(function* () {
          const origin = yield* Deferred.await(address);
          const published = JSON.stringify({
            issuer: origin,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            registration_endpoint: `${origin}/register`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
            scopes_supported: ["mcp"],
          });
          const promptValues =
            options.promptValues === "null"
              ? "null"
              : options.promptValues === "overflowing"
                ? '["consent", 1e400]'
                : undefined;
          return HttpServerResponse.text(
            promptValues === undefined
              ? published
              : `${published.slice(0, -1)},"prompt_values_supported":${promptValues}}`,
            { contentType: "application/json" },
          );
        }),
      ),
      HttpRouter.add(
        "POST",
        "/register",
        Effect.gen(function* () {
          const origin = yield* Deferred.await(address);
          if (answer === "rate_limited")
            return HttpServerResponse.empty({ status: 429, headers: { "retry-after": "60" } });
          if (answer === "rejected" || clients.size >= clientLimit)
            return yield* HttpServerResponse.json(
              { error: "invalid_client_metadata", error_description: "Too many clients" },
              { status: 400 },
            );
          const request = yield* HttpServerRequest.HttpServerRequest;
          const input = yield* request.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(RegistrationRequest)),
          );
          const reused = answer === "same_client" ? registrations[0]?.clientId : undefined;
          const clientId = reused ?? `synthetic-client-${randomUUID()}`;
          const token = reused === undefined ? `synthetic-registration-${randomUUID()}` : "";
          if (reused === undefined) clients.set(clientId, { token });
          registrations.push({ clientId, clientName: input.client_name });
          return yield* HttpServerResponse.json(
            {
              client_id: clientId,
              client_name: input.client_name,
              token_endpoint_auth_method: "none",
              redirect_uris: input.redirect_uris,
              client_id_issued_at: Math.floor(Date.now() / 1000),
              ...(management
                ? {
                    registration_client_uri: `${origin}/register/${clientId}`,
                    registration_access_token: clients.get(clientId)?.token,
                  }
                : {}),
            },
            { status: 201 },
          );
        }),
      ),
      HttpRouter.add(
        "DELETE",
        "/register/:client",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const clientId = decodeURIComponent(new URL(request.url, "http://localhost").pathname)
            .split("/")
            .at(-1);
          const client = clientId === undefined ? undefined : clients.get(clientId);
          if (
            clientId === undefined ||
            client === undefined ||
            request.headers.authorization !== `Bearer ${client.token}`
          )
            return HttpServerResponse.empty({ status: 401 });
          deletionAttempts.push(clientId);
          if (deletionStatus !== 204) return HttpServerResponse.empty({ status: deletionStatus });
          clients.delete(clientId);
          for (const key of consent.keys())
            if (JSON.parse(key)[0] === clientId) consent.delete(key);
          deletions.push(clientId);
          return HttpServerResponse.empty({ status: 204 });
        }),
      ),
      HttpRouter.add(
        "GET",
        "/authorize",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const params = new URL(request.url, "http://localhost").searchParams;
          const clientId = params.get("client_id") ?? "";
          if (!clients.has(clientId) || params.get("code_challenge_method") !== "S256")
            return HttpServerResponse.text("Unknown client or no PKCE", { status: 400 });
          const prompt = params.get("prompt");
          const openid = (params.get("scope") ?? "").split(" ").includes("openid");
          const asked = openid && prompt !== null && prompt.split(" ").includes("consent");
          const earlier = consent.get(consentKey(clientId, person));
          const chooserShown = earlier === undefined || asked;
          authorizations.push({ clientId, person, prompt, chooserShown });
          if (!chooserShown) return approve(params, earlier, person);
          const transaction = randomUUID();
          pending.set(transaction, params);
          return HttpServerResponse.html(
            `<!doctype html><html lang="en"><meta charset="utf-8"><title>Choose an organization</title><main><h1>Choose an organization</h1><p>An app wants to use your data.</p><a href="/authorize/choose?transaction=${transaction}&amp;organization=X">Organization X</a> <a href="/authorize/choose?transaction=${transaction}&amp;organization=Y">Organization Y</a></main></html>`,
          );
        }),
      ),
      HttpRouter.add(
        "GET",
        "/authorize/choose",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const query = new URL(request.url, "http://localhost").searchParams;
          const params = pending.get(query.get("transaction") ?? "");
          if (params === undefined) return HttpServerResponse.text("Unknown", { status: 400 });
          pending.delete(query.get("transaction") ?? "");
          return approve(params, query.get("organization") === "Y" ? "Y" : "X", person);
        }),
      ),
      HttpRouter.add(
        "POST",
        "/token",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const form = new URLSearchParams(yield* request.text);
          const clientId = form.get("client_id") ?? "";
          const refreshing = form.get("grant_type") === "refresh_token";
          if (!clients.has(clientId) || refusedTokens.has(clientId)) {
            if (refreshing) refreshes.push({ clientId, accepted: false });
            return yield* HttpServerResponse.json({ error: "invalid_client" }, { status: 401 });
          }
          if (form.get("grant_type") === "authorization_code") {
            const code = codes.get(form.get("code") ?? "");
            codes.delete(form.get("code") ?? "");
            if (
              code === undefined ||
              code.clientId !== clientId ||
              code.redirect !== form.get("redirect_uri") ||
              createHash("sha256")
                .update(form.get("code_verifier") ?? "")
                .digest("base64url") !== code.challenge
            )
              return yield* HttpServerResponse.json({ error: "invalid_grant" }, { status: 400 });
            return yield* HttpServerResponse.json(issue(clientId, code.organization));
          }
          if (form.get("grant_type") === "refresh_token") {
            const token = tokens.get(form.get("refresh_token") ?? "");
            if (
              token === undefined ||
              token.revoked ||
              !token.refresh ||
              token.clientId !== clientId
            ) {
              refreshes.push({ clientId, accepted: false });
              return yield* HttpServerResponse.json({ error: "invalid_grant" }, { status: 400 });
            }
            refreshes.push({ clientId, accepted: true });
            token.revoked = true;
            return yield* HttpServerResponse.json(issue(clientId, token.organization, true));
          }
          return yield* HttpServerResponse.json(
            { error: "unsupported_grant_type" },
            { status: 400 },
          );
        }),
      ),
      HttpRouter.add(
        "POST",
        "/mcp",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const origin = yield* Deferred.await(address);
          const token = tokens.get((request.headers.authorization ?? "").replace(/^Bearer /u, ""));
          if (token === undefined || token.revoked || token.refresh)
            return yield* HttpServerResponse.json(
              { error: "invalid_token" },
              {
                status: 401,
                headers: {
                  "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
                },
              },
            );
          const message = yield* request.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(McpMessage)),
          );
          if (message.id === undefined) return HttpServerResponse.empty({ status: 202 });
          const reply = (body: object) =>
            HttpServerResponse.json({ jsonrpc: "2.0", id: message.id, ...body });
          if (message.method === "initialize")
            return yield* reply({
              result: {
                protocolVersion: message.params?.protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: "Organization chooser service", version: "1.0.0" },
              },
            });
          if (message.method === "tools/list")
            return yield* reply({
              result: {
                tools: [
                  {
                    name: "whoami",
                    description: "The organization this connection acts in",
                    inputSchema: { type: "object" },
                    annotations: { readOnlyHint: true },
                  },
                ],
              },
            });
          if (message.method === "tools/call") {
            calls.push({ clientId: token.clientId, renewed: token.renewed });
            const result = { organization: token.organization };
            return yield* reply({
              result: {
                content: [{ type: "text", text: JSON.stringify(result) }],
                structuredContent: result,
              },
            });
          }
          return yield* reply({ error: { code: -32601, message: "Method not found" } });
        }),
      ),
    );
    const services = yield* Layer.build(
      HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
      ),
    );
    const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
    if (!("port" in server.address))
      return yield* Effect.die("The organization chooser service needs a TCP listener");
    const origin = `http://127.0.0.1:${server.address.port}`;
    yield* Deferred.succeed(address, origin);
    return {
      origin,
      url: `${origin}/mcp`,
      signInAs: (who: string) =>
        Effect.sync(() => {
          person = who;
        }),
      answerRegistrations: (next: RegistrationAnswer) =>
        Effect.sync(() => {
          answer = next;
        }),
      limitClients: (limit: number) =>
        Effect.sync(() => {
          clientLimit = limit;
        }),
      refuseTokens: (clientId: string) =>
        Effect.sync(() => {
          refusedTokens.add(clientId);
        }),
      answerDeletions: (status: number) =>
        Effect.sync(() => {
          deletionStatus = status;
        }),
      revokeApp: (clientId: string, who: string) =>
        Effect.sync(() => {
          consent.delete(consentKey(clientId, who));
        }),
      returnBrowsersTo: (next: string | undefined) =>
        Effect.sync(() => {
          browserReturn = next;
        }),
      clients: Effect.sync(() => [...clients.keys()]),
      registrations: Effect.sync(() => [...registrations]),
      deletions: Effect.sync(() => [...deletions]),
      deletionAttempts: Effect.sync(() => [...deletionAttempts]),
      refreshes: Effect.sync(() => [...refreshes]),
      calls: Effect.sync(() => [...calls]),
      authorizations: Effect.sync(() => [...authorizations]),
    };
  });

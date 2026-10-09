/**
 * Authorize the request opened by a real client, using the product's browser flow. `client` is the
 * name the consent page shows for it.
 */
import { Context, Effect, Layer, Redacted, Schema } from "effect";
import { Api, body } from "./api.ts";
import { Actors, password } from "./actors.ts";
import { Browser } from "./browser.ts";
import { Evidence } from "./evidence.ts";
import { Target } from "./platform.ts";

class ConsentFailed extends Schema.TaggedError<ConsentFailed>()("ConsentFailed", {
  operation: Schema.String,
}) {
  get message() {
    return this.operation;
  }
}
const make = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors,
    browser = yield* Browser,
    evidence = yield* Evidence,
    target = yield* Target;
  return {
    approve: (request: {
      readonly url: Redacted.Redacted<string>;
      readonly clientId: string;
      readonly client: string;
    }) =>
      Effect.gen(function* () {
        const url = new URL(Redacted.value(request.url));
        const callback = URL.parse(url.searchParams.get("redirect_uri") ?? "");
        const state = url.searchParams.get("state");
        if (
          !state ||
          !callback ||
          callback.protocol !== "http:" ||
          !["localhost", "127.0.0.1", "[::1]"].includes(callback.hostname)
        )
          return yield* new ConsentFailed({
            operation: "Client did not request a loopback OAuth callback with state",
          });
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            const response = yield* api.request(
              actors.owner,
              "GET",
              "/api/auth/oauth2/get-consents",
            );
            if (response.status !== 200)
              return yield* new ConsentFailed({
                operation: "Cannot list client grants for cleanup",
              });
            const grants = yield* body(
              Schema.Array(Schema.Struct({ id: Schema.String, clientId: Schema.String })),
              response,
            );
            const owned = grants.filter((grant) => grant.clientId === request.clientId);
            for (const grant of owned) {
              const deleted = yield* api.request(
                actors.owner,
                "POST",
                "/api/auth/oauth2/delete-consent",
                { id: grant.id },
              );
              if (deleted.status !== 200)
                return yield* new ConsentFailed({
                  operation: "Cannot revoke the test client's grant",
                });
            }
            yield* evidence.json("client-grant-cleanup.json", {
              clientId: request.clientId,
              revokedGrants: owned.length,
            });
          }).pipe(Effect.orDie),
        );
        yield* browser.omitNetworkTrace;
        // Cloud starts with a signed-in synthetic browser. Self-host exercises its password sign-in.
        if (target.metadata.target === "cloud") yield* browser.login(actors.owner);
        yield* browser.use(`Open the browser requested by ${request.client}`, (page) =>
          page.goto(Redacted.value(request.url)),
        );
        if (target.metadata.target === "self-host") {
          yield* browser.use("Sign in as the synthetic owner", (page) =>
            page.getByLabel("Email", { exact: true }).fill("owner@example.test"),
          );
          yield* browser.use("Enter the self-host password", (page) =>
            page.getByLabel("Password", { exact: true }).fill(password),
          );
          yield* browser.use("Continue the client's sign-in", (page) =>
            page.getByRole("button", { name: "Sign in", exact: true }).click(),
          );
        }
        yield* browser.use(`Executor names ${request.client} on the consent page`, (page) =>
          page.getByText(request.client, { exact: true }).waitFor({ state: "visible" }),
        );
        const response = yield* api.request(actors.owner, "GET", "/api/auth/organization/list");
        const organizations = yield* body(
          Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
          response,
        );
        const organization = organizations.find(
          (organization) => organization.id === actors.organization.id,
        );
        if (!organization)
          return yield* new ConsentFailed({ operation: "Test organization is unavailable" });
        yield* browser.use("Choose the authorized organization", (page) =>
          page.getByRole("combobox").click(),
        );
        yield* browser.use("Select the synthetic organization", (page) =>
          page.getByRole("option", { name: organization.name, exact: true }).click(),
        );
        yield* browser.checkpoint(`Approve ${request.client}'s connection`);
        // A client can close its callback listener after accepting the code, before
        // the browser finishes loading. Observe the exact request, then let the
        // caller verify the client's authenticated connection.
        yield* browser.use(`Authorize ${request.client} and return to its callback`, (page) =>
          Promise.all([
            page.waitForRequest((request) => {
              const returned = new URL(request.url());
              return (
                request.isNavigationRequest() &&
                returned.origin === callback.origin &&
                returned.pathname === callback.pathname &&
                returned.searchParams.get("state") === state &&
                Boolean(returned.searchParams.get("code")) &&
                !returned.searchParams.has("error")
              );
            }),
            page.getByRole("button", { name: "Connect", exact: true }).click(),
          ]).then(() => undefined),
        );
      }),
  };
});
const Grants = Schema.Array(
  Schema.Struct({ clientId: Schema.String, grant: Schema.Struct({ id: Schema.String }) }),
);
/** Pair a fresh browser session as the local operator, as the dashboard's pairing link does. */
export const pairLocalOperator = Effect.gen(function* () {
  const api = yield* Api,
    target = yield* Target;
  const session = yield* api.session();
  const pairing = yield* session.send("POST", "/auth/pair", undefined, {
    authorization: `Bearer ${Redacted.value(target.apiKey)}`,
  });
  if (pairing.status !== 200)
    return yield* new ConsentFailed({ operation: "Cannot create a local pairing link" });
  const link = yield* body(Schema.Struct({ url: Schema.String }), pairing);
  const token = new URLSearchParams(new URL(link.url).hash.slice(1)).get("pair");
  if (!token) return yield* new ConsentFailed({ operation: "Pairing link has no token" });
  const exchanged = yield* session.send(
    "POST",
    "/auth/exchange",
    { token },
    { origin: target.metadata.origin },
  );
  if (exchanged.status !== 200)
    return yield* new ConsentFailed({ operation: "Cannot pair the local operator" });
  return session;
});
/** Local consent needs no organization: the dashboard pairing identifies its single operator. */
const makeLocal = Effect.gen(function* () {
  const api = yield* Api,
    browser = yield* Browser,
    evidence = yield* Evidence,
    target = yield* Target;
  return {
    approve: (request: {
      readonly url: Redacted.Redacted<string>;
      readonly clientId: string;
      readonly client: string;
    }) =>
      Effect.gen(function* () {
        const url = new URL(Redacted.value(request.url));
        const callback = URL.parse(url.searchParams.get("redirect_uri") ?? "");
        const state = url.searchParams.get("state");
        if (
          !state ||
          !callback ||
          callback.protocol !== "http:" ||
          !["localhost", "127.0.0.1", "[::1]"].includes(callback.hostname)
        )
          return yield* new ConsentFailed({
            operation: "Client did not request a loopback OAuth callback with state",
          });
        const session = yield* pairLocalOperator.pipe(
          Effect.provideService(Api, api),
          Effect.provideService(Target, target),
        );
        const origin = { origin: target.metadata.origin };
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            const listed = yield* session.send("GET", "/api/auth/mcp/grants", undefined, origin);
            if (listed.status !== 200)
              return yield* new ConsentFailed({
                operation: "Cannot list client grants for cleanup",
              });
            const grants = yield* body(Grants, listed);
            const owned = grants.filter((grant) => grant.clientId === request.clientId);
            for (const grant of owned) {
              const revoked = yield* session.send(
                "POST",
                "/api/auth/mcp/grants/revoke",
                { id: grant.grant.id },
                origin,
              );
              if (revoked.status !== 200)
                return yield* new ConsentFailed({
                  operation: "Cannot revoke the test client's grant",
                });
            }
            yield* evidence.json("client-grant-cleanup.json", {
              clientId: request.clientId,
              revokedGrants: owned.length,
            });
          }).pipe(Effect.orDie),
        );
        yield* browser.omitNetworkTrace;
        yield* browser.login(session);
        yield* browser.use(`Open the browser requested by ${request.client}`, (page) =>
          page.goto(Redacted.value(request.url)),
        );
        yield* browser.use(`Executor Local names ${request.client} on the consent page`, (page) =>
          page.getByText(request.client, { exact: true }).waitFor({ state: "visible" }),
        );
        yield* browser.checkpoint(`Approve ${request.client}'s connection`);
        yield* browser.use(`Authorize ${request.client} and return to its callback`, (page) =>
          Promise.all([
            page.waitForRequest((request) => {
              const returned = new URL(request.url());
              return (
                request.isNavigationRequest() &&
                returned.origin === callback.origin &&
                returned.pathname === callback.pathname &&
                returned.searchParams.get("state") === state &&
                Boolean(returned.searchParams.get("code")) &&
                !returned.searchParams.has("error")
              );
            }),
            page.getByRole("button", { name: "Connect", exact: true }).click(),
          ]).then(() => undefined),
        );
      }),
  };
});
/** Target-specific browser sign-in is injected beneath the shared real-client scenario. */
export class McpConsent extends Context.Service<McpConsent, Effect.Success<typeof make>>()(
  "e2e/McpConsent",
) {
  static readonly layer = Layer.effect(McpConsent, make);
  static readonly localLayer = Layer.effect(McpConsent, makeLocal);
}

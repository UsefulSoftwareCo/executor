/** Authorize the request opened by a real client, using the hosted product's browser flow. */
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
    approve: (request: { readonly url: Redacted.Redacted<string>; readonly clientId: string }) =>
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
            yield* evidence.json("claude-grant-cleanup.json", {
              clientId: request.clientId,
              revokedGrants: owned.length,
            });
          }).pipe(Effect.orDie),
        );
        yield* browser.omitNetworkTrace;
        // Cloud starts with a signed-in synthetic browser. Self-host exercises its password sign-in.
        if (target.metadata.target === "cloud") yield* browser.login(actors.owner);
        yield* browser.use("Open the browser requested by Claude", (page) =>
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
        yield* browser.use("Executor names Claude Code on the consent page", (page) =>
          page
            .getByText("Claude Code (executor_e2e)", { exact: true })
            .waitFor({ state: "visible" }),
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
        yield* browser.checkpoint("Approve Claude Code's connection");
        // Claude can close its callback listener after accepting the code, before
        // the browser finishes loading. Observe the exact request, then let the
        // caller verify Claude's authenticated connection and real tool result.
        yield* browser.use("Authorize Claude Code and return to its callback", (page) =>
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
}

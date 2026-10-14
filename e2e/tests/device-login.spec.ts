/**
 * `executor apps login` signs in with a code (RFC 8628) that a signed-in person approves on the
 * dashboard's device page, which the CLI opens when a browser can. The CLI ends up with a grant
 * for the organization chosen on the page, the API audience, and a refresh token. The token endpoint answers polls with RFC 8628's errors and redeems an approved
 * code once.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Fiber, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appsCli } from "../support/apps-cli.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";
import { targetHosts } from "../support/role-hosts.ts";
import { scenarios } from "../test-plan.ts";

const deviceGrant = "urn:ietf:params:oauth:grant-type:device_code";
const Consents = Schema.Array(Schema.Struct({ id: Schema.String }));

/** Revoke every grant the owner approved in this case; each case has its own owner. */
const revokeOwnerGrants = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors;
  const listed = yield* api.request(actors.owner, "GET", "/api/auth/oauth2/get-consents");
  for (const consent of yield* body(Consents, listed))
    yield* api.request(actors.owner, "POST", "/api/auth/oauth2/delete-consent", {
      id: consent.id,
    });
}).pipe(Effect.orDie);

/** Approve or deny the code on the device page as the owner, capturing each state. */
const decideInBrowser = (input: {
  readonly url: string;
  readonly userCode: string;
  readonly typed: boolean;
  readonly accept: boolean;
}) =>
  Effect.gen(function* () {
    const browser = yield* Browser,
      actors = yield* Actors,
      api = yield* Api;
    yield* browser.omitNetworkTrace;
    yield* browser.login(actors.owner);
    yield* browser.use("Open the device page the CLI named", (page) => page.goto(input.url));
    if (input.typed) {
      yield* browser.use("The page asks for the code", (page) =>
        page.getByLabel("Code", { exact: true }).waitFor({ state: "visible" }),
      );
      // People type codes loosely; the page accepts lower case without the dash.
      yield* browser.use("Type the code the CLI printed", (page) =>
        page
          .getByLabel("Code", { exact: true })
          .fill(input.userCode.replace("-", "").toLowerCase()),
      );
      yield* browser.checkpoint("Enter the device code");
      yield* browser.use("Continue to the request", (page) =>
        page.getByRole("button", { name: "Continue", exact: true }).click(),
      );
    }
    yield* browser.use("The page names the registered client", (page) =>
      page.getByText("Executor CLI", { exact: true }).waitFor({ state: "visible" }),
    );
    yield* browser.use("The page shows the code to compare", (page) =>
      page.getByText(input.userCode, { exact: true }).waitFor({ state: "visible" }),
    );
    yield* browser.use("The page states the requested access", (page) =>
      page.getByText("Connect to the Executor API", { exact: true }).waitFor({ state: "visible" }),
    );
    if (!input.accept) {
      yield* browser.checkpoint("Review the device request");
      yield* browser.use("Deny the request", (page) =>
        page.getByRole("button", { name: "Deny", exact: true }).click(),
      );
      yield* browser.use("The page confirms the denial", (page) =>
        page.getByText("Request denied.", { exact: true }).waitFor({ state: "visible" }),
      );
      return yield* browser.checkpoint("Device request denied");
    }
    const organizations = yield* body(
      Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
      yield* api.request(actors.owner, "GET", "/api/auth/organization/list"),
    );
    const organization = organizations.find((item) => item.id === actors.organization.id);
    expect(organization, "the owner belongs to the test organization").toBeDefined();
    yield* browser.use("Choose the organization to connect", (page) =>
      page.getByRole("combobox").click(),
    );
    yield* browser.use("Select the synthetic organization", (page) =>
      page.getByRole("option", { name: organization?.name ?? "", exact: true }).click(),
    );
    yield* browser.use("The organization list closes", (page) =>
      page.getByRole("listbox").waitFor({ state: "hidden" }),
    );
    yield* browser.checkpoint("Review the device request");
    yield* browser.use("Connect the device", (page) =>
      page.getByRole("button", { name: "Connect", exact: true }).click(),
    );
    yield* browser.use("The page confirms the device is connected", (page) =>
      page.getByText("Your device is connected.", { exact: true }).waitFor({ state: "visible" }),
    );
    yield* browser.checkpoint("Device connected");
  });

layer(HostedLive, { excludeTestServices: true })("Device login", (it) => {
  it.effect(scenarios.deviceLoginCli.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const hosts = targetHosts(yield* Target);
        const tools = yield* appsCli;
        yield* Effect.addFinalizer(() => revokeOwnerGrants);
        // The CLI finds no browser to open, so the person types the code it printed.
        const login = yield* tools.deviceLogin(hosts.api, "fails");
        expect(login.verificationUri).toBe(`${hosts.browser}/device`);
        expect(new URL(login.verificationUriComplete).searchParams.get("user_code")).toBe(
          login.userCode,
        );
        yield* decideInBrowser({
          url: login.verificationUri,
          userCode: login.userCode,
          typed: true,
          accept: true,
        });
        const finished = yield* Fiber.join(login.finished);
        expect(finished.code, finished.stderr).toBe(0);
        expect(finished.stdout).toContain(`Connected to ${hosts.api} as @`);
        // The saved session is an ordinary CLI session for the chosen organization.
        const listed = yield* tools.cli(["list", "--host", hosts.api]);
        expect(listed.code, listed.stderr).toBe(0);
      }),
    ),
  );

  it.effect(scenarios.deviceLoginNoOsStore.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const hosts = targetHosts(yield* Target);
        const tools = yield* appsCli;
        yield* Effect.addFinalizer(() => revokeOwnerGrants);
        // A server over SSH without a Secret Service. A browser opened there would not reach the
        // person, so the CLI opens none.
        yield* tools.withoutOsStore;
        const login = yield* tools.deviceLogin(hosts.api, "remote");
        yield* decideInBrowser({
          url: login.verificationUriComplete,
          userCode: login.userCode,
          typed: false,
          accept: true,
        });
        const finished = yield* Fiber.join(login.finished);
        expect(finished.code, finished.stderr).toBe(0);
        const saved = finished.stderr.match(
          /No system credential store is available, so the session is saved in (\S+), readable only by you\./u,
        )?.[1];
        expect(saved, finished.stderr).toBeDefined();
        const file = saved ?? "";
        expect(tools.path.dirname(file)).toBe(
          tools.path.join(tools.home, ".local", "state", "executor", "auth"),
        );
        const info = yield* tools.fs.stat(file);
        expect(info.mode & 0o777, "only the user can read the session").toBe(0o600);
        expect(yield* tools.osStoreUsed).toBe(false);
        expect(Option.isNone(yield* tools.browserOpened), "no browser opens over SSH").toBe(true);
        // Later commands read the session from the file, as they would from the OS store.
        const listed = yield* tools.cli(["list", "--host", hosts.api]);
        expect(listed.code, listed.stderr).toBe(0);
      }),
    ),
  );

  it.effect(scenarios.deviceLoginDenied.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const hosts = targetHosts(yield* Target);
        const tools = yield* appsCli;
        yield* Effect.addFinalizer(() => revokeOwnerGrants);
        // The CLI opens the approval page with the code filled in.
        const login = yield* tools.deviceLogin(hosts.api, "opens");
        expect(yield* tools.openedPage).toBe(login.verificationUriComplete);
        yield* decideInBrowser({
          url: login.verificationUriComplete,
          userCode: login.userCode,
          typed: false,
          accept: false,
        });
        const finished = yield* Fiber.join(login.finished);
        expect(finished.code).toBe(1);
        expect(finished.stderr).toContain(
          "Sign-in was cancelled or denied in the browser. Run executor apps login to try again.",
        );
        expect(finished.stderr).not.toContain("Not signed in");
      }),
    ),
  );

  it.effect(scenarios.deviceAuthorizationGrant.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence,
          http = yield* HttpClient.HttpClient;
        const hosts = targetHosts(yield* Target);
        const resource = `${hosts.api}/api`;
        yield* Effect.addFinalizer(() => revokeOwnerGrants);
        const send = (request: HttpClientRequest.HttpClientRequest, label: string) =>
          Effect.scoped(
            Effect.gen(function* () {
              const response = yield* http.execute(request);
              const value: unknown = yield* response.json;
              // Record only outcomes; bodies hold codes and tokens.
              yield* evidence.json(`${label}-${response.status}.json`, {
                status: response.status,
              });
              return { status: response.status, body: value };
            }),
          ).pipe(Effect.orDie);
        const form = (url: string, fields: Record<string, string>, label: string) =>
          send(HttpClientRequest.post(url).pipe(HttpClientRequest.bodyUrlParams(fields)), label);

        // Discovery advertises the endpoint and the grant, as RFC 8628 section 4 describes.
        const protectedResource = yield* body(
          Schema.Struct({ authorization_servers: Schema.NonEmptyArray(Schema.String) }),
          yield* send(
            HttpClientRequest.get(`${hosts.api}/.well-known/oauth-protected-resource/api`),
            "resource-metadata",
          ),
        );
        const issuer = new URL(protectedResource.authorization_servers[0]);
        const metadata = yield* body(
          Schema.Struct({
            device_authorization_endpoint: Schema.String,
            token_endpoint: Schema.String,
            registration_endpoint: Schema.String,
            grant_types_supported: Schema.Array(Schema.String),
          }),
          yield* send(
            HttpClientRequest.get(
              `${issuer.origin}/.well-known/oauth-authorization-server${issuer.pathname}`,
            ),
            "authorization-server-metadata",
          ),
        );
        expect(metadata.device_authorization_endpoint).toBe(
          `${hosts.browser}/api/auth/oauth2/device-authorization`,
        );
        expect(metadata.grant_types_supported).toContain(deviceGrant);

        const registered = yield* send(
          yield* HttpClientRequest.bodyJson(
            HttpClientRequest.post(metadata.registration_endpoint),
            {
              client_name: "Device protocol client",
              token_endpoint_auth_method: "none",
              grant_types: [deviceGrant, "refresh_token"],
              response_types: [],
              scope: "executor offline_access",
            },
          ).pipe(Effect.orDie),
          "register",
        );
        expect(registered.status).toBe(201);
        const { client_id } = yield* body(Schema.Struct({ client_id: Schema.String }), registered);
        const Started = Schema.Struct({
          device_code: Schema.String,
          user_code: Schema.String,
          verification_uri: Schema.String,
          verification_uri_complete: Schema.String,
          expires_in: Schema.Number,
          interval: Schema.Number,
        });
        const start = form(
          metadata.device_authorization_endpoint,
          { client_id, scope: "executor offline_access", resource },
          "device-authorization",
        ).pipe(Effect.flatMap((response) => body(Started, response)));
        const poll = (deviceCode: string, label: string) =>
          form(
            metadata.token_endpoint,
            { grant_type: deviceGrant, device_code: deviceCode, client_id },
            label,
          );
        const OAuthError = Schema.Struct({ error: Schema.String });
        const errorOf = (response: { readonly status: number; readonly body: unknown }) =>
          body(OAuthError, response).pipe(Effect.map((value) => value.error));
        const lookup = (userCode: string) =>
          api.request(
            actors.owner,
            "GET",
            `/api/auth/device/request?user_code=${encodeURIComponent(userCode)}`,
          );
        const decide = (userCode: string, accept: boolean) =>
          api.request(
            actors.owner,
            "POST",
            "/api/auth/device/decide",
            { user_code: userCode, accept },
            { "x-executor-organization": actors.organization.id },
          );

        // A request the person denies.
        const denied = yield* start;
        expect(denied.user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/u);
        expect(denied.verification_uri).toBe(`${hosts.browser}/device`);
        expect(denied.verification_uri_complete).toBe(
          `${hosts.browser}/device?user_code=${denied.user_code}`,
        );
        expect(denied.expires_in).toBe(600);
        expect(denied.interval).toBe(5);
        expect(yield* errorOf(yield* poll(denied.device_code, "pending"))).toBe(
          "authorization_pending",
        );
        // Polling again inside the interval is told to slow down; the interval grows to ten.
        expect(yield* errorOf(yield* poll(denied.device_code, "early"))).toBe("slow_down");
        const reviewed = yield* lookup(denied.user_code.replace("-", "").toLowerCase());
        expect(reviewed.status).toBe(200);
        expect(
          yield* body(
            Schema.Struct({ clientId: Schema.String, resource: Schema.String }),
            reviewed,
          ),
        ).toEqual({ clientId: client_id, resource });
        // Decisions need the browser's own origin, as consent does.
        const crossSite = yield* actors.owner.send("POST", "/api/auth/device/decide", {
          user_code: denied.user_code,
          accept: true,
        });
        expect(crossSite.status).toBe(403);
        expect((yield* decide(denied.user_code, false)).status).toBe(200);
        expect((yield* lookup(denied.user_code)).status).toBe(409);
        expect((yield* decide(denied.user_code, true)).status).toBe(409);
        yield* Effect.sleep("10500 millis");
        expect(yield* errorOf(yield* poll(denied.device_code, "denied"))).toBe("access_denied");
        expect(yield* errorOf(yield* poll(denied.device_code, "after-denial"))).toBe(
          "invalid_grant",
        );

        // A request the person approves is redeemed once, for the chosen organization.
        const approved = yield* start;
        expect(approved.user_code).not.toBe(denied.user_code);
        expect((yield* decide(approved.user_code, true)).status).toBe(200);
        const issued = yield* poll(approved.device_code, "approved");
        expect(issued.status).toBe(200);
        const tokens = yield* body(
          Schema.Struct({
            access_token: Schema.RedactedFromValue(Schema.NonEmptyString),
            refresh_token: Schema.RedactedFromValue(Schema.NonEmptyString),
            scope: Schema.String,
          }),
          issued,
        );
        expect(tokens.scope.split(" ").sort()).toEqual(["executor", "offline_access"]);
        expect(yield* errorOf(yield* poll(approved.device_code, "replayed"))).toBe("invalid_grant");
        const context = yield* send(
          HttpClientRequest.get(`${hosts.api}/api/context`).pipe(
            HttpClientRequest.bearerToken(Redacted.value(tokens.access_token)),
          ),
          "context",
        );
        expect(context.status).toBe(200);
        expect(
          (yield* body(Schema.Struct({ organization: Schema.String }), context)).organization,
        ).toBe(actors.organization.id);
        // The refresh token rotates like the browser flow's.
        const refreshed = yield* form(
          metadata.token_endpoint,
          {
            grant_type: "refresh_token",
            client_id,
            refresh_token: Redacted.value(tokens.refresh_token),
            resource,
          },
          "refresh",
        );
        expect(refreshed.status).toBe(200);

        // A code nobody issued is not found.
        expect((yield* decide("BBBB-BBBB", true)).status).toBe(404);
      }),
    ),
  );
});

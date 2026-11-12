/**
 * Cases that fail on purpose, each in one step whose cause carries planted secrets.
 * failure-text.spec.ts runs them in their own Vitest process and checks what their log, their
 * Vitest results and their evidence say about each failure.
 */
import { layer } from "@effect/vitest";
import { request } from "node:http";
import { Effect, Redacted, Schema } from "effect";
import { Api, type Session } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { replaceResponses } from "../support/browser-responses.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
import { heldValue, reveal, secret, secretConfig } from "../support/failure-text.ts";
import { noPageErrors } from "../support/page-errors.ts";
import { Target, driver } from "../support/platform.ts";
import { freePort } from "../support/ports.ts";
import { targetHosts } from "../support/role-hosts.ts";
import {
  preparationFailure,
  reportUnavailable,
  writePreparation,
} from "../sdk/prepare-scenarios.ts";
import { failureTextCases, planted, shapes, webhookVariable } from "./titles.ts";

/** The harness holds the revealed secret as it holds a session or a key. */
const revealed = () => reveal(Redacted.make(planted.revealed));
/** A driver step that fails with `message`, as an SDK whose error echoes its input does. */
const echoing = (label: string, message: string) =>
  Effect.gen(function* () {
    const evidence = yield* Evidence;
    return yield* evidence.step(
      label,
      driver(label, () => Promise.reject(new Error(message))),
    );
  });

layer(TestLive, { excludeTestServices: true })("Failure text cases", (it) => {
  it.effect(failureTextCases.nodeProtocol, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const evidence = yield* Evidence;
        const label = "POST /mcp on a kept-alive connection";
        // `node:http` refuses an `https:` URL before it sends anything.
        yield* evidence.step(
          label,
          driver(
            label,
            () =>
              new Promise((resolve, reject) => {
                const sent = request(
                  `https://agent:${planted.password}@127.0.0.1:9/mcp?token=${planted.query}`,
                  { method: "POST", headers: { authorization: `Bearer ${revealed()}` } },
                  resolve,
                );
                sent.on("error", reject);
                sent.end();
              }),
          ),
        );
      }),
    ),
  );

  it.effect(failureTextCases.strictMode, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser;
        const secret = revealed();
        yield* browser.use("Click the repeated text", (page) =>
          page
            .setContent(`<p data-key="${secret}">Same</p><p>Same</p>`)
            .then(() => page.getByText("Same").click()),
        );
      }),
    ),
  );

  it.effect(failureTextCases.timeout, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser;
        // The planted failure's own timeout, so the case fails well inside its deadline.
        yield* browser.use("Click a button that never appears", (page) =>
          page
            .setContent("<p>Nothing to click</p>")
            .then(() => page.getByRole("button", { name: "Missing" }).click({ timeout: 500 })),
        );
      }),
    ),
  );

  it.effect(failureTextCases.request, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser;
        const port = yield* freePort;
        const secret = revealed();
        // Nothing listens on the port, so the request fails and its call log lists its headers.
        yield* browser.use("Request a refused port with credentials", (page) =>
          page.request.get(
            `http://agent:${planted.password}@127.0.0.1:${port}/refused?token=${planted.query}#${planted.query}`,
            {
              headers: {
                authorization: `Bearer ${planted.header}`,
                cookie: `session=${planted.cookie}`,
                "x-api-key": secret,
              },
            },
          ),
        );
      }),
    ),
  );

  it.effect(failureTextCases.echoed, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const evidence = yield* Evidence;
        const secret = revealed();
        const label = "Call an SDK that echoes its input";
        return yield* evidence.step(
          label,
          driver(label, () =>
            Promise.reject(
              new Error(
                `Invalid token ${secret} for http://agent:${planted.password}@upstream.test/v1?key=${planted.query}; session ${planted.opaque}`,
                {
                  cause: Object.assign(
                    new Error(`connect ECONNREFUSED 127.0.0.1:1 while sending ${secret}`),
                    { code: "ECONNREFUSED" },
                  ),
                },
              ),
            ),
          ),
        );
      }),
    ),
  );

  it.effect(failureTextCases.pageErrors, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser;
        const secret = revealed();
        const errors = yield* browser.use("Open a page whose scripts throw", (page) => {
          const raised: string[] = [];
          const both = new Promise<void>((resolve) =>
            page.on("pageerror", (error) => {
              raised.push(error.message);
              if (raised.length === 2) resolve();
            }),
          );
          return page
            .setContent(
              [
                `<script>throw new Error("Minified React error #418; visit https://react.dev/errors/418?args[]=${planted.query} for the full message")</script>`,
                `<script>throw new Error("Rendered ${secret} into the page")</script>`,
              ].join(""),
            )
            .then(() => both)
            .then(() => raised);
        });
        yield* noPageErrors(errors, "The page hydrates without errors");
      }),
    ),
  );

  it.effect(failureTextCases.consoleErrors, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser;
        const secret = reveal(Redacted.make(planted.consoleSecret));
        const errors = yield* browser.use("Open a page that logs an error", (page) => {
          const logged: string[] = [];
          page.on("console", (message) => {
            if (message.type() === "error") logged.push(message.text());
          });
          return page
            .route("http://failure-text.test/**", (route) =>
              route.fulfill({
                contentType: "text/html",
                body: `<script>console.error("Console saw ${secret}")</script>`,
              }),
            )
            .then(() =>
              page.goto(
                `http://failure-text.test/console?token=${planted.consoleQuery}#${planted.consoleQuery}`,
              ),
            )
            .then(() => logged);
        });
        yield* noPageErrors(errors, "The page logs no errors");
      }),
    ),
  );

  it.effect(failureTextCases.filled, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser;
        // A disabled field is never editable, so the fill times out after logging its text.
        yield* browser.use("Fill a disabled field", (page) =>
          page
            .setContent('<input aria-label="Key" disabled>')
            .then(() => page.getByLabel("Key").fill(planted.typed, { timeout: 500 })),
        );
      }),
    ),
  );

  it.effect(failureTextCases.straddle, (context) =>
    Effect.gen(function* () {
      const secret = reveal(Redacted.make(planted.straddle));
      // The line is cut at 400 characters, 14 characters into the secret.
      return yield* echoing(
        "Call an SDK with a long message",
        `${"x".repeat(385)} ${secret} and the rest of the line`,
      );
    }).pipe((program) => withCase(context, program)),
  );

  it.effect(failureTextCases.split, (context) =>
    Effect.gen(function* () {
      reveal(Redacted.make(planted.splitPiece));
      return yield* echoing(
        "Call an SDK that echoes a token",
        `token ${planted.splitToken} refused`,
      );
    }).pipe((program) => withCase(context, program)),
  );

  it.effect(failureTextCases.requestFailed, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const session = yield* api.session();
        // A line break inside a header value makes it invalid, so the client refuses to send it.
        return yield* api.request(session, "GET", "/api/auth/self-host/config", undefined, {
          authorization: `Bearer ${planted.refusedHeader}\nnext`,
        });
      }),
    ),
  );

  it.effect(failureTextCases.replaced, (context) =>
    withCase(
      context,
      Effect.scoped(
        Effect.gen(function* () {
          const browser = yield* Browser;
          yield* replaceResponses("*failure-text-probe*", () => {
            throw new Error(
              `replacement rejected Bearer ${planted.replaced} for http://upstream.test/x?key=${planted.query}`,
            );
          });
          // The page's fetch loses its response; the replacement's failure fails the scope.
          yield* browser.use("Read a replaced response", (page) =>
            page.goto("/").then(() =>
              page.evaluate(() =>
                fetch("/failure-text-probe").then(
                  () => "answered",
                  () => "lost",
                ),
              ),
            ),
          );
        }),
      ),
    ),
  );

  it.effect(failureTextCases.sessionCookie, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const session = yield* api.session();
        // The product sets the session cookie; the harness never reveals it.
        yield* api.request(session, "POST", "/api/auth/self-host/setup", {
          name: "Failure Text Owner",
          email: "owner@example.test",
          password: "failure-text-password-1",
          organizationName: "Failure text",
        });
        const cookies = yield* session.cookies;
        // Reading the cookies registers them; a spec that echoes one without `reveal` is masked.
        const [first] = Redacted.value(cookies);
        return yield* echoing("Echo the session cookie", `session ${first?.value ?? "absent"}`);
      }),
    ),
  );

  it.effect(failureTextCases.login, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser;
        const target = yield* Target;
        const origin = new URL(targetHosts(target).browser);
        // A session no other part of the harness has read: only signing the browser in reveals it.
        const session: Session = {
          cookies: Effect.succeed(
            Redacted.make([
              {
                name: "failure_text_session",
                value: planted.loginCookie,
                domain: origin.hostname,
                path: "/",
                httpOnly: true,
                secure: origin.protocol === "https:",
                sameSite: "Lax" as const,
                expires: -1,
              },
            ]),
          ),
          send: () => Effect.die("This session sends no requests"),
        };
        yield* browser.login(session);
        return yield* browser.use("Echo the browser's cookie", (page) =>
          page
            .context()
            .cookies()
            .then((cookies) =>
              Promise.reject(new Error(`cookie ${cookies[0]?.value ?? "absent"} refused`)),
            ),
        );
      }),
    ),
  );

  for (const [shape, { value, title }] of Object.entries(shapes))
    it.effect(title, (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const label = `Echo a ${shape} secret`;
          switch (shape) {
            case "jwt":
              return yield* echoing(label, `401 for Authorization: Bearer ${value}`);
            case "signedCookie":
              reveal(Redacted.make(value));
              return yield* echoing(label, `the browser sent ${encodeURIComponent(value)}`);
            case "axiom":
              return yield* echoing(label, `query refused for ${value}`);
            case "oauthCode":
              return yield* echoing(
                label,
                `Location: /api/auth/callback/github?code=${value}&state=${planted.oauthState}`,
              );
            case "base64":
              reveal(Redacted.make(value));
              return yield* echoing(label, `signature ${value} does not match`);
            case "hex":
              secret(value);
              return yield* echoing(label, `key ${value} expired`);
            case "digits":
              yield* Schema.decodeUnknownEffect(Schema.Struct({ code: heldValue(Schema.String) }))({
                code: value,
              });
              return yield* echoing(label, `code ${value} expired`);
            default: {
              const configured = yield* secretConfig(webhookVariable);
              return yield* echoing(label, `signature checked with ${reveal(configured)}`);
            }
          }
        }),
      ),
    );

  it.effect(failureTextCases.preparation, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const evidence = yield* Evidence;
        const session = yield* api.session();
        // A set-up request that fails in transport, its header quoted in the inner cause.
        const failed = yield* api
          .request(session, "GET", "/api/auth/self-host/config", undefined, {
            authorization: `Bearer ${planted.preparationHeader}\nnext`,
          })
          .pipe(Effect.flip);
        const unavailable = [
          {
            title: "A prepared organization",
            id: "failure-text-preparation",
            failure: failed._tag,
            detail: preparationFailure(failed),
          },
        ];
        // Preparation's own log line and record, written where this case's evidence is.
        yield* reportUnavailable(unavailable);
        yield* writePreparation(evidence.directory, {
          organizations: 0,
          unavailableOrganizations: unavailable,
        });
      }),
    ),
  );

  it.effect(failureTextCases.passing, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser;
        yield* browser.use("Open a page", (page) => page.setContent("<p>Fine</p>"));
      }),
    ),
  );
});

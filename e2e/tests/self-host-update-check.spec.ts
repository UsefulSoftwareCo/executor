/**
 * The self-host server's daily check for a newer release: it asks the npm registry it installs app
 * packages from for the `executor` dist-tags, and shows owners and admins an "Update available"
 * block that opens how to update. Each case starts a fresh instance with a release version and a
 * loopback registry that records what reaches it; other registry paths pass through to the run's
 * own registry, so app builds work as usual.
 *
 * Each scenario holds one behaviour or a few small ones: every case starts at least one product
 * process, and the ten cases together, in one scenario, outran one scenario's time limit on a slow
 * runner.
 */
import { expect, layer } from "@effect/vitest";
import { Config, Effect, FileSystem, Option, Schedule } from "effect";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { Page } from "playwright";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { startControlledSelfHost, startFreshSelfHost } from "../support/managed-server.ts";
import { serverControl } from "../support/server-control.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

const distTags = "/-/package/executor/dist-tags";
const password = "correct horse battery";

interface Asked {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
}

/** How the registry answers the dist-tags: with the tags, a 503, a body that is no JSON, or never. */
type Answer = "tags" | "unavailable" | "malformed" | "hold";

/**
 * A registry on loopback that answers the dist-tags as `answer` says, which a case may change, and
 * records each dist-tags request. Anything else goes to `upstream`, the run's registry.
 */
const registry = (options: {
  readonly tags: Record<string, string>;
  readonly answer?: Answer;
  readonly upstream: Option.Option<string>;
}) =>
  Effect.acquireRelease(
    Effect.callback<{
      readonly origin: string;
      readonly asked: Array<Asked>;
      answer: Answer;
      close: () => void;
    }>((resume) => {
      const asked: Array<Asked> = [];
      const state = { answer: options.answer ?? "tags" };
      const server = createServer((request, response) => {
        if (request.url?.split("?")[0] === distTags) {
          asked.push({
            method: request.method ?? "",
            url: request.url,
            headers: request.headers,
          });
          if (state.answer === "hold") return;
          if (state.answer === "unavailable") {
            response.writeHead(503);
            response.end();
            return;
          }
          response.writeHead(200, { "content-type": "application/json" });
          response.end(state.answer === "malformed" ? "{" : JSON.stringify(options.tags));
          return;
        }
        if (Option.isNone(options.upstream)) {
          response.writeHead(404);
          response.end();
          return;
        }
        void fetch(`${options.upstream.value.replace(/\/+$/u, "")}${request.url}`, {
          headers: { accept: request.headers.accept ?? "*/*" },
        })
          .then((answer) =>
            answer.arrayBuffer().then((bytes) => {
              response.writeHead(answer.status, {
                "content-type": answer.headers.get("content-type") ?? "application/octet-stream",
              });
              response.end(Buffer.from(bytes));
            }),
          )
          .catch(() => {
            response.writeHead(502);
            response.end();
          });
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        resume(
          Effect.succeed({
            origin: `http://127.0.0.1:${port}`,
            asked,
            get answer() {
              return state.answer;
            },
            set answer(next: Answer) {
              state.answer = next;
            },
            close: () => {
              server.closeAllConnections();
              server.close();
            },
          }),
        );
      });
    }),
    (stub) => Effect.sync(() => stub.close()),
  );

/** A proxy on loopback that records the URL of each request through it and answers 502. */
const proxy = Effect.acquireRelease(
  Effect.callback<{ readonly origin: string; readonly seen: Array<string>; close: () => void }>(
    (resume) => {
      const seen: Array<string> = [];
      const server = createServer((request, response) => {
        seen.push(request.url ?? "");
        response.writeHead(502);
        response.end();
      });
      // An HTTPS request through a proxy opens a tunnel first.
      server.on("connect", (request, socket) => {
        seen.push(request.url ?? "");
        socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        resume(
          Effect.succeed({
            origin: `http://127.0.0.1:${port}`,
            seen,
            close: () => {
              server.closeAllConnections();
              server.close();
            },
          }),
        );
      });
    },
  ),
  (stub) => Effect.sync(() => stub.close()),
);

/** A port nothing listens on: an instance with no way out. */
const closedPort = Effect.callback<number>((resume) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    server.close(() => resume(Effect.succeed(port)));
  });
});

/** Send a request as the signed-in browser does, with the instance's origin. */
const send = (origin: string, method: "GET" | "POST", route: string, data?: unknown) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    return yield* browser.use(`${method} ${route}`, (page) =>
      page.request
        .fetch(`${origin}${route}`, {
          method,
          headers: { origin },
          ...(data === undefined ? {} : { data }),
        })
        .then((response) => response.text().then((body) => ({ status: response.status(), body }))),
    );
  });

/** Set up the fresh instance as its owner, and add an admin and a member by invitation. */
const people = (origin: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const owner = {
      name: "Alex Owner",
      email: "owner@example.test",
      password,
      organizationName: "Example Studio",
    };
    expect((yield* send(origin, "POST", "/api/auth/self-host/setup", owner)).status).toBe(200);
    const listed = yield* send(origin, "GET", "/api/auth/organization/list");
    const [organization] = JSON.parse(listed.body) as Array<{ id: string; slug: string }>;
    const invite = (role: "admin" | "member") =>
      send(origin, "POST", "/api/auth/organization/invite-member", {
        email: `${role}@example.test`,
        role,
        organizationId: organization!.id,
      }).pipe(Effect.map((response) => (JSON.parse(response.body) as { id: string }).id));
    const invitations = { admin: yield* invite("admin"), member: yield* invite("member") };
    const signOut = browser.use("Sign out", (page) => page.context().clearCookies());
    for (const role of ["admin", "member"] as const) {
      yield* signOut;
      expect(
        (yield* send(origin, "POST", "/api/auth/self-host/register", {
          invitation: invitations[role],
          email: `${role}@example.test`,
          name: `Sam ${role}`,
          password,
        })).status,
      ).toBe(200);
    }
    const signIn = (role: "owner" | "admin" | "member") =>
      Effect.gen(function* () {
        yield* signOut;
        expect(
          (yield* send(origin, "POST", "/api/auth/sign-in/email", {
            email: `${role}@example.test`,
            password,
          })).status,
        ).toBe(200);
      });
    return { slug: organization!.slug, signIn };
  });

const opener = (page: Page) =>
  page.locator("aside.sidebar").getByRole("button", { name: /^How to update to v/ });

/** Open the apps page and give the server's answer time to arrive. */
const openApps = (origin: string, slug: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    yield* browser.use("Open the apps page", (page) =>
      page
        .setViewportSize({ width: 1280, height: 800 })
        .then(() => page.goto(`${origin}/org/${slug}/apps`))
        .then(() => page.getByRole("heading", { level: 1, name: /^Apps/ }).waitFor())
        .then(() => page.waitForLoadState("networkidle")),
    );
  });

/** What the instance tells a person about the update. */
const status = (origin: string, slug: string) =>
  send(origin, "GET", `/api/self-host/update?organization=${slug}`);

/** Wait for the check, which runs in the background after start, to have asked. */
const askedOnce = (asked: ReadonlyArray<Asked>) =>
  Effect.suspend(() =>
    asked.length > 0 ? Effect.void : Effect.fail(new Error("The registry was not asked")),
  ).pipe(Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 100 }));

const beta = { latest: "1.6.12", beta: "2.0.0-beta.142" };
const release = { EXECUTOR_BUILD_VERSION: "2.0.0-beta.141" };
// The operator lets the server reach plain HTTP on loopback, where the mirror listens.
const loopback = { EXECUTOR_URL_ALLOW_LOOPBACK_HTTP: "true" };
/** The run's own registry, which the stub passes everything but the dist-tags to. */
const upstreamRegistry = Config.NonEmptyString("E2E_NPM_REGISTRY").pipe(Config.option);

layer(TestLive, { excludeTestServices: true })("Self-host update check", (it) => {
  it.effect(scenarios.selfHostUpdateCheck.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser;
        const target = yield* Target;
        const upstream = yield* upstreamRegistry;

        // A beta instance whose registry names a newer beta: owners and admins see it, members
        // do not, and the registry is asked once, with nothing about the instance.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const stub = yield* registry({ tags: beta, upstream });
            const origin = yield* startFreshSelfHost(target, {
              ...release,
              ...loopback,
              EXECUTOR_NPM_REGISTRY: stub.origin,
            });
            yield* askedOnce(stub.asked);
            const { slug, signIn } = yield* people(origin);

            yield* signIn("owner");
            yield* openApps(origin, slug);
            yield* browser.use("Wait for the update block", (page) => opener(page).waitFor());
            yield* browser.checkpoint("Update available for the owner");
            expect(
              yield* browser.use("Read the block", (page) =>
                page
                  .locator("aside.sidebar .sidebar-update")
                  .innerText()
                  .then((text) => text.split("\n").filter((line) => line.trim() !== "")),
              ),
            ).toEqual(["Update available", "Version 2.0.0-beta.142 is available."]);
            yield* browser.use("Open how to update", (page) =>
              opener(page)
                .focus()
                .then(() => page.keyboard.press("Enter"))
                .then(() => page.getByRole("dialog", { name: "How to update" }).waitFor()),
            );
            yield* browser.checkpoint("How to update");
            expect(
              yield* browser.use("Read how to update", (page) =>
                page.getByRole("dialog", { name: "How to update" }).evaluate((dialog) => ({
                  description: dialog.querySelector("p")?.textContent,
                  steps: [...dialog.querySelectorAll("ol > li")].map((step) =>
                    (step as HTMLElement).innerText.replace(/\s+/gu, " ").trim(),
                  ),
                  notes: dialog.querySelector("a")?.getAttribute("href"),
                })),
              ),
            ).toEqual({
              description:
                "This instance runs v2.0.0-beta.141; v2.0.0-beta.142 is available. Only owners and admins see this.",
              steps: [
                "Stop the container and back up its data volume.",
                "Pull the new image: docker pull ghcr.io/usefulsoftwareco/executor-selfhost:2.0.0-beta.142",
                "Remove only the stopped container, then run it again with the same volume and settings.",
              ],
              notes:
                "https://github.com/UsefulSoftwareCo/executor/releases/tag/executor%402.0.0-beta.142",
            });
            yield* browser.use("Close how to update", (page) =>
              page.keyboard
                .press("Escape")
                .then(() =>
                  page
                    .getByRole("dialog", { name: "How to update" })
                    .waitFor({ state: "detached" }),
                ),
            );
            expect(
              yield* browser.use("Read the focused control", (page) =>
                page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null),
              ),
            ).toBe("How to update to v2.0.0-beta.142");

            yield* signIn("admin");
            yield* openApps(origin, slug);
            yield* browser.use("Wait for the admin's update block", (page) =>
              opener(page).waitFor(),
            );

            yield* signIn("member");
            yield* openApps(origin, slug);
            expect(
              yield* browser.use("Check the member sees nothing", (page) =>
                Promise.all([
                  opener(page).count(),
                  page.locator("aside.sidebar .sidebar-notice").count(),
                ]),
              ),
            ).toEqual([0, 0]);
            expect((yield* status(origin, slug)).status).toBe(403);
            yield* browser.use("Sign out the member", (page) => page.context().clearCookies());
            expect((yield* status(origin, slug)).status).toBe(401);

            // Three people opened the dashboard; the server asked the registry once, by itself.
            expect(stub.asked).toHaveLength(1);
            const [question] = stub.asked;
            expect([question!.method, question!.url]).toEqual(["GET", distTags]);
            // The apps Worker sends it as it sends app installs' requests: the Host header alone,
            // none of the server's own: no cookie, no credential, no trace (b3, traceparent), not
            // even a user agent, nothing that names the instance.
            const sent = JSON.stringify(question!.headers);
            expect(Object.keys(question!.headers).toSorted(), sent).toEqual(["host"]);
            expect(question!.headers.host).toBe(new URL(stub.origin).host);
            for (const revealing of ["2.0.0-beta.141", slug, new URL(origin).host, "example"])
              expect(sent, revealing).not.toContain(revealing);
          }),
        );
      }),
    ),
  );

  it.effect(scenarios.selfHostUpdateCheckChannels.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser;
        const target = yield* Target;
        const upstream = yield* upstreamRegistry;

        // A stable instance never moves to a beta, even one the `latest` tag names: nothing to show.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const stub = yield* registry({
              tags: { latest: "2.2.0-beta.2", beta: "2.2.0-beta.1" },
              upstream,
            });
            const origin = yield* startFreshSelfHost(target, {
              ...loopback,
              EXECUTOR_BUILD_VERSION: "2.1.0",
              EXECUTOR_NPM_REGISTRY: stub.origin,
            });
            yield* askedOnce(stub.asked);
            const { slug, signIn } = yield* people(origin);
            yield* signIn("owner");
            yield* openApps(origin, slug);
            expect(yield* browser.use("Check stable", (page) => opener(page).count())).toBe(0);
            expect(JSON.parse((yield* status(origin, slug)).body)).toEqual({ update: null });
          }),
        );

        // A beta instance moves to a newer stable release as well as a newer beta.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const stub = yield* registry({
              tags: { latest: "2.1.0", beta: "2.0.0-beta.142" },
              upstream,
            });
            const origin = yield* startFreshSelfHost(target, {
              ...release,
              ...loopback,
              EXECUTOR_NPM_REGISTRY: stub.origin,
            });
            yield* askedOnce(stub.asked);
            const { slug, signIn } = yield* people(origin);
            yield* signIn("owner");
            expect(JSON.parse((yield* status(origin, slug)).body)).toEqual({
              update: { current: "2.0.0-beta.141", available: "2.1.0" },
            });
          }),
        );
      }),
    ),
  );

  it.effect(scenarios.selfHostUpdateCheckDaily.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser;
        const target = yield* Target;
        const upstream = yield* upstreamRegistry;

        // Every attempt counts toward the day, whatever the answer: a refused or malformed answer
        // is not asked again on a restart, and the next day's start asks once more. The
        // instance's clock moves a day while it is stopped.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const stub = yield* registry({ tags: beta, answer: "unavailable", upstream });
            const instance = yield* startControlledSelfHost(target, {
              ...release,
              ...loopback,
              EXECUTOR_NPM_REGISTRY: stub.origin,
            });
            const origin = instance.metadata.origin;
            yield* askedOnce(stub.asked);
            const { slug, signIn } = yield* people(origin);
            const day = { milliseconds: 25 * 60 * 60 * 1000 };
            /** Restart the instance, sign in again and read its answer as the owner. */
            const restart = (moveClock: boolean) =>
              Effect.gen(function* () {
                yield* serverControl("stop");
                if (moveClock) yield* serverControl("clock/advance", 200, day);
                yield* serverControl("start");
                yield* signIn("owner");
                yield* openApps(origin, slug);
                return JSON.parse((yield* status(origin, slug)).body) as unknown;
              }).pipe(Effect.provideService(Target, instance));
            const asks = (count: number) =>
              Effect.suspend(() =>
                stub.asked.length >= count
                  ? Effect.void
                  : Effect.fail(new Error(`The registry was asked ${stub.asked.length} times`)),
              ).pipe(Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 100 }));

            // A 503: shown as nothing, and the same day's restart does not ask.
            expect(yield* restart(false)).toEqual({ update: null });
            expect(stub.asked).toHaveLength(1);
            // The next day asks once; the answer is no JSON, and a restart does not ask again.
            stub.answer = "malformed";
            expect(yield* restart(true)).toEqual({ update: null });
            yield* asks(2);
            expect(yield* restart(false)).toEqual({ update: null });
            expect(stub.asked).toHaveLength(2);
            // The day after, the registry answers, and the update shows: three questions in all.
            stub.answer = "tags";
            yield* restart(true);
            yield* asks(3);
            yield* browser.use("Wait for the update after a day", (page) =>
              page.reload().then(() => opener(page).waitFor()),
            );
            expect(JSON.parse((yield* status(origin, slug)).body)).toEqual({
              update: { current: "2.0.0-beta.141", available: "2.0.0-beta.142" },
            });
            expect(stub.asked).toHaveLength(3);
            // The next day the registry is down again: the release it named still exists, so the
            // owner still sees it.
            stub.answer = "unavailable";
            yield* restart(true);
            yield* asks(4);
            expect(yield* restart(false)).toEqual({
              update: { current: "2.0.0-beta.141", available: "2.0.0-beta.142" },
            });
            yield* browser.use("Wait for the update through the outage", (page) =>
              opener(page).waitFor(),
            );
            expect(stub.asked).toHaveLength(4);
          }),
        );
      }),
    ),
  );

  it.effect(scenarios.selfHostUpdateCheckRecord.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target;
        const upstream = yield* upstreamRegistry;

        // When the server cannot record an attempt, it does not ask: nothing would keep a restart
        // from asking again. Its record in the data directory is replaced by a directory, which can
        // be neither read nor written; on the next day's start and a restart, nothing is asked. Each
        // start says so once, as a warning an operator sees without asking for debug logs, naming
        // the record. Once the record can be written again, the next start asks.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const stub = yield* registry({ tags: beta, upstream });
            const instance = yield* startControlledSelfHost(target, {
              ...release,
              ...loopback,
              EXECUTOR_NPM_REGISTRY: stub.origin,
            });
            const origin = instance.metadata.origin;
            yield* askedOnce(stub.asked);
            const { slug, signIn } = yield* people(origin);
            const restart = (moveClock: boolean) =>
              Effect.gen(function* () {
                yield* serverControl("stop");
                if (moveClock)
                  yield* serverControl("clock/advance", 200, { milliseconds: 25 * 60 * 60 * 1000 });
                yield* serverControl("start");
                yield* signIn("owner");
                yield* openApps(origin, slug);
                return JSON.parse((yield* status(origin, slug)).body) as unknown;
              }).pipe(Effect.provideService(Target, instance));
            yield* serverControl("stop").pipe(Effect.provideService(Target, instance));
            const record = `${instance.directory}/data/update-check.json`;
            const fs = yield* FileSystem.FileSystem;
            yield* fs.remove(record);
            yield* fs.makeDirectory(record);
            // The check runs in the background after a start; each start's line is awaited before
            // the next stop.
            const warnings = fs
              .readFileString(`${instance.directory}/server.log`)
              .pipe(
                Effect.map((text) =>
                  text.split("\n").filter((line) => line.includes("Self-host update check")),
                ),
              );
            const warned = (count: number) =>
              warnings.pipe(
                Effect.filterOrFail(
                  (lines) => lines.length >= count,
                  () => new Error(`The server did not say ${count} times that the check is off`),
                ),
                Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 100 }),
              );
            yield* serverControl("start").pipe(Effect.provideService(Target, instance));
            yield* warned(1);
            expect(yield* restart(true)).toEqual({ update: null });
            yield* warned(2);
            expect(yield* restart(false)).toEqual({ update: null });
            yield* warned(3);
            expect(stub.asked).toHaveLength(1);
            const lines = yield* warnings;
            expect(lines).toHaveLength(3);
            for (const line of lines) {
              expect(JSON.parse(line)).toMatchObject({ level: "WARN" });
              expect(line).toContain(
                `Self-host update check is off: it cannot write its record to ${record} (`,
              );
            }
            yield* fs.remove(record, { recursive: true });
            expect(yield* restart(false)).toEqual({
              update: { current: "2.0.0-beta.141", available: "2.0.0-beta.142" },
            });
            expect(stub.asked).toHaveLength(2);
          }),
        );
      }),
    ),
  );

  it.effect(scenarios.selfHostUpdateCheckMirror.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target;
        const upstream = yield* upstreamRegistry;

        // A mirror on a private address over plain HTTP, which the URL policy for addresses users
        // give refuses but app installs read: the check reads it as installs do, and the owner sees
        // the update it names.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const stub = yield* registry({ tags: beta, upstream });
            const origin = yield* startFreshSelfHost(target, {
              ...release,
              EXECUTOR_URL_ALLOW_LOOPBACK_HTTP: "false",
              EXECUTOR_NPM_REGISTRY: stub.origin,
            });
            yield* askedOnce(stub.asked);
            const { slug, signIn } = yield* people(origin);
            yield* signIn("owner");
            expect(JSON.parse((yield* status(origin, slug)).body)).toEqual({
              update: { current: "2.0.0-beta.141", available: "2.0.0-beta.142" },
            });
            expect(stub.asked).toHaveLength(1);
          }),
        );

        // The server has proxy variables, for loopback too. App installs reach the registry directly,
        // without them, and so does the check: the mirror is asked, and nothing reaches the proxy.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const stub = yield* registry({ tags: beta, upstream });
            const through = yield* proxy;
            const origin = yield* startFreshSelfHost(target, {
              ...release,
              ...loopback,
              EXECUTOR_NPM_REGISTRY: stub.origin,
              HTTP_PROXY: through.origin,
              HTTPS_PROXY: through.origin,
              http_proxy: through.origin,
              https_proxy: through.origin,
              NO_PROXY: "",
              no_proxy: "",
            });
            yield* askedOnce(stub.asked);
            const { slug, signIn } = yield* people(origin);
            yield* signIn("owner");
            expect(JSON.parse((yield* status(origin, slug)).body)).toEqual({
              update: { current: "2.0.0-beta.141", available: "2.0.0-beta.142" },
            });
            expect(stub.asked).toHaveLength(1);
            expect(through.seen.filter((url) => url.includes("dist-tags"))).toEqual([]);
          }),
        );
      }),
    ),
  );

  it.effect(scenarios.selfHostUpdateCheckOff.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser;
        const target = yield* Target;
        const upstream = yield* upstreamRegistry;

        // Turned off: the server never asks, and shows nothing.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const stub = yield* registry({ tags: beta, upstream });
            const origin = yield* startFreshSelfHost(target, {
              ...release,
              ...loopback,
              EXECUTOR_NPM_REGISTRY: stub.origin,
              EXECUTOR_NO_UPDATE_CHECK: "1",
            });
            const { slug, signIn } = yield* people(origin);
            yield* signIn("owner");
            yield* openApps(origin, slug);
            expect(yield* browser.use("Check off", (page) => opener(page).count())).toBe(0);
            expect(JSON.parse((yield* status(origin, slug)).body)).toEqual({ update: null });
            expect(stub.asked).toHaveLength(0);
          }),
        );
      }),
    ),
  );

  it.effect(scenarios.selfHostUpdateCheckAirGapped.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser;
        const target = yield* Target;

        // Air-gapped: the registry cannot be reached at all. Nothing is shown and nothing fails.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const port = yield* closedPort;
            const origin = yield* startFreshSelfHost(target, {
              ...release,
              ...loopback,
              EXECUTOR_NPM_REGISTRY: `http://127.0.0.1:${port}`,
            });
            const { slug, signIn } = yield* people(origin);
            yield* signIn("owner");
            yield* openApps(origin, slug);
            expect(yield* browser.use("Check air-gapped", (page) => opener(page).count())).toBe(0);
            expect(
              yield* browser.use("Check no error is shown", (page) =>
                page.getByRole("alert").count(),
              ),
            ).toBe(0);
            expect(JSON.parse((yield* status(origin, slug)).body)).toEqual({ update: null });
          }),
        );
      }),
    ),
  );

  it.effect(scenarios.selfHostUpdateCheckUnanswered.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser;
        const target = yield* Target;
        const upstream = yield* upstreamRegistry;

        // A registry that never answers delays neither startup nor a page: the instance starts,
        // sets up and serves while the question is still open.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const stub = yield* registry({ tags: beta, answer: "hold", upstream });
            const origin = yield* startFreshSelfHost(target, {
              ...release,
              ...loopback,
              EXECUTOR_NPM_REGISTRY: stub.origin,
            });
            yield* askedOnce(stub.asked);
            const { slug, signIn } = yield* people(origin);
            yield* signIn("owner");
            yield* openApps(origin, slug);
            expect(yield* browser.use("Check unanswered", (page) => opener(page).count())).toBe(0);
            expect(JSON.parse((yield* status(origin, slug)).body)).toEqual({ update: null });
            expect(stub.asked).toHaveLength(1);
          }),
        );
      }),
    ),
  );
});

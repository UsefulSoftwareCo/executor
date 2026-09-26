/** Typed resource URLs reject malformed identifiers before any page brands or reads them. */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, TestLive, withCase, withHostedCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

/** A plain word, as typed or pasted, carries none of the typed identifier prefixes. */
const malformed = "notes";

const expectNotFound = (path: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    yield* browser.use(`Open ${path}`, (page) => page.goto(path));
    yield* browser.use(`${path} shows the missing-page state`, (page) =>
      page.getByRole("heading", { name: "Page not found", exact: true }).waitFor(),
    );
    expect(
      yield* browser.use(`${path} did not fail while rendering`, (page) =>
        page.getByRole("alert").filter({ hasText: "couldn’t load" }).count(),
      ),
      path,
    ).toBe(0);
  });

layer(HostedLive, { excludeTestServices: true })("Hosted malformed resource links", (it) => {
  it.effect(scenarios.hostedMalformedResourceLinks.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const browser = yield* Browser;
        const pageErrors: Array<string> = [];
        yield* browser.login(actors.owner);
        yield* browser.use("Record uncaught page errors", (page) => {
          page.on("pageerror", (error) => pageErrors.push(error.message));
          return Promise.resolve();
        });
        yield* browser.use("Open the organization", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps`),
        );
        yield* browser.use("The organization dashboard is ready", (page) =>
          page.getByRole("heading", { name: /^Apps/ }).first().waitFor(),
        );
        const org = `/org/${actors.organization.slug}`;
        for (const path of [
          `${org}/apps/${malformed}`,
          `${org}/apps/${malformed}/open`,
          `${org}/apps/${malformed}/setup`,
          `${org}/accounts/${malformed}`,
          `${org}/accounts/${malformed}/disconnect`,
          `${org}/connections/${malformed}`,
          `${org}/webhooks/${malformed}/${malformed}`,
        ])
          yield* expectNotFound(path);
        yield* browser.checkpoint("Malformed app link shows the missing-page state");
        expect(pageErrors).toEqual([]);
      }),
    ),
  );
});

layer(TestLive, { excludeTestServices: true })("Local malformed resource links", (it) => {
  it.effect(scenarios.localMalformedResourceLinks.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const browser = yield* Browser;
        const target = yield* Target;
        const session = yield* api.session();
        const pageErrors: Array<string> = [];
        const pairing = yield* session.send("POST", "/auth/pair", undefined, {
          authorization: `Bearer ${Redacted.value(target.apiKey)}`,
        });
        expect(pairing.status).toBe(200);
        const { url } = yield* body(Schema.Struct({ url: Schema.String }), pairing);
        yield* browser.use("Record uncaught page errors", (page) => {
          page.on("pageerror", (error) => pageErrors.push(error.message));
          return Promise.resolve();
        });
        yield* browser.use("Pair the local browser", (page) => page.goto(url));
        yield* browser.use("The paired dashboard is ready", (page) =>
          page.getByRole("heading", { name: /^Apps/ }).first().waitFor(),
        );
        for (const path of [
          `/apps/${malformed}`,
          `/apps/${malformed}/setup`,
          `/accounts/${malformed}`,
          `/webhooks/${malformed}/${malformed}`,
        ])
          yield* expectNotFound(path);
        expect(pageErrors).toEqual([]);
      }),
    ),
  );
});

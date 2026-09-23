/** A retained scenario composes the same actors, HTTP, browser and evidence adapters as tests. */
import { Context, Effect, Exit, Layer, Redacted, Schema, Semaphore } from "effect";
import { Api, SessionClients } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { Target } from "../support/platform.ts";
import { Evidence, Telemetry, scenarioEvidence } from "../support/evidence.ts";
import { RecordingFocus } from "../support/recording-focus.ts";
import { Browser, BrowserDriver } from "../support/browser.ts";
import { startScenario } from "./scenario.ts";
import { seedOrganization, SeedReceipt, DataShape } from "./data.ts";

/** Scenario failures retain safe operation names while detailed evidence stays local. */
export class ScenarioFailed extends Schema.TaggedError<ScenarioFailed>()("ScenarioFailed", {
  operation: Schema.String,
}) {}

/** Acquire an interactive scenario. The caller owns its scope and may use identical operations in a test. */
export const createScenario = (
  base: typeof Target.Service,
  input: { readonly id: string; readonly label: string },
) =>
  Effect.gen(function* () {
    const started = yield* startScenario(base, input.label, input.id);
    const target = Target.of({
      ...started,
      evidenceDirectory: `${base.evidenceDirectory ?? base.directory}/interactive/${input.id}`,
    });
    const runtime = SessionClients.layer.pipe(Layer.provideMerge(Layer.succeed(Target, target)));
    const evidence = scenarioEvidence({
      file: `interactive-${input.id}.ts`,
      name: input.label,
    }).pipe(
      Layer.provideMerge(
        Layer.mergeAll(Telemetry.layer, RecordingFocus.layer).pipe(Layer.provideMerge(runtime)),
      ),
    );
    const services = yield* Layer.build(Layer.fresh(Api.layer.pipe(Layer.provideMerge(evidence))));
    const api = Context.get(services, Api);
    const actors =
      target.metadata.target === "local"
        ? undefined
        : Context.get(
            yield* Layer.build(
              Layer.fresh(Actors.layer.pipe(Layer.provide(Layer.succeedContext(services)))),
            ),
            Actors,
          );
    const localSession =
      target.metadata.target === "local"
        ? yield* Effect.gen(function* () {
            const session = yield* api.session();
            const paired = yield* session.send("POST", "/auth/pair", undefined, {
              authorization: `Bearer ${Redacted.value(target.apiKey)}`,
            });
            const value = yield* Schema.decodeUnknownEffect(Schema.Struct({ url: Schema.String }))(
              paired.body,
            );
            const exchanged = yield* api.request(session, "POST", "/auth/exchange", {
              token: new URL(value.url).hash.slice("#pair=".length),
            });
            if (exchanged.status !== 200)
              return yield* new ScenarioFailed({
                operation: "Could not pair the local API session",
              });
            return session;
          })
        : undefined;
    const recorded = Context.get(services, Evidence);
    const gate = yield* Semaphore.make(1);
    let seedFailed = false;
    let seeded: typeof SeedReceipt.Type | undefined;
    let opened: typeof Browser.Service | undefined;
    return {
      target,
      actors,
      api,
      evidence: recorded,
      request: (
        role: "owner" | "admin" | "member",
        method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
        path: string,
        data?: unknown,
      ) =>
        Effect.gen(function* () {
          const session = actors?.[role] ?? localSession;
          if (session === undefined)
            return yield* new ScenarioFailed({
              operation: "Scenario has no authenticated session",
            });
          return yield* api.request(session, method, path, data);
        }),
      summary: Effect.sync(() => ({
        id: input.id,
        label: input.label,
        origin: target.metadata.origin,
        organization: actors?.organization,
        population: seeded,
        evidence: recorded.directory,
      })),
      seed: (shape: typeof DataShape.Type) =>
        gate.withPermits(1)(
          Effect.gen(function* () {
            if (actors === undefined)
              return yield* new ScenarioFailed({
                operation: "Organization data requires Cloud or self-host",
              });
            if (seedFailed)
              return yield* new ScenarioFailed({
                operation: "Seeding failed; create a fresh scenario before retrying",
              });
            const decoded = yield* Schema.decodeUnknownEffect(DataShape)(shape);
            if (seeded !== undefined) {
              if (
                seeded.shape.seed !== decoded.seed ||
                seeded.shape.apps !== decoded.apps ||
                seeded.shape.accounts !== decoded.accounts ||
                seeded.shape.records !== decoded.records
              )
                return yield* new ScenarioFailed({
                  operation: "Use a fresh scenario to change its data shape",
                });
              return seeded;
            }
            const result = yield* recorded
              .step("Seed a populated organization", seedOrganization(decoded))
              .pipe(
                Effect.provideService(Actors, actors),
                Effect.provideContext(services),
                Effect.exit,
              );
            if (Exit.isFailure(result)) {
              seedFailed = true;
              return yield* result;
            }
            seeded = result.value;
            yield* recorded.json("population.json", seeded);
            return seeded;
          }),
        ),
      open: (role: "owner" | "admin" | "member") =>
        gate.withPermits(1)(
          Effect.gen(function* () {
            if (opened === undefined) {
              const browserServices = yield* Layer.build(
                Layer.fresh(
                  Browser.layer.pipe(
                    Layer.provideMerge(BrowserDriver.captureLayer),
                    Layer.provide(Layer.succeedContext(services)),
                  ),
                ),
              );
              opened = Context.get(browserServices, Browser);
            }
            const browser = opened;
            if (actors !== undefined) {
              yield* browser.login(actors[role]);
              yield* browser.use("Open the retained scenario", (page) =>
                page.goto(`/org/${actors.organization.slug}/apps`),
              );
            } else {
              const session = yield* api.session();
              const paired = yield* session.send("POST", "/auth/pair", undefined, {
                authorization: `Bearer ${Redacted.value(target.apiKey)}`,
              });
              const value = yield* Schema.decodeUnknownEffect(
                Schema.Struct({ url: Schema.String }),
              )(paired.body);
              yield* browser.use("Open the paired local scenario", (page) => page.goto(value.url));
            }
            yield* browser.checkpoint("Interactive scenario ready");
            return { opened: true };
          }).pipe(Effect.provideContext(services)),
        ),
    };
  });

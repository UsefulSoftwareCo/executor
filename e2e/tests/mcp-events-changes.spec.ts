/**
 * A subscription keeps the event and arguments it was created with. When a redeploy removes a
 * filter those arguments name, or the event itself, the next refresh tells the client and stops
 * the subscription: -32014 schema_changed for changed filters, -32011 for a removed event, as the
 * draft extension asks. ChatGPT supports no `terminated` envelope, so a refresh is how it learns.
 */
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { scenarios } from "../test-plan.ts";
import { Api } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Granted, emitterFiles, eventFixtures, secrets } from "../support/events.ts";

/** The emitter's files with each source text replaced. */
const editedEmitter = (edits: readonly (readonly [string, string])[]) =>
  emitterFiles.map((file) => ({
    ...file,
    content: edits.reduce((content, [from, to]) => content.replaceAll(from, to), file.content),
  }));

layer(HostedLive, { excludeTestServices: true })("MCP event changes", (it) => {
  it.effect(
    scenarios.mcpEventChanges.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors;
          const {
            prefix,
            suffix,
            emitter,
            callbackUrl,
            awaitDeliveries,
            events,
            emit,
            rpcAs,
            ok,
            refused,
            createKey,
            name,
          } = yield* eventFixtures;
          const key = yield* createKey(`Event changes ${suffix}`);
          const subscribe = (args: Readonly<Record<string, unknown>>, eventName = name) =>
            rpcAs(key.key, "events/subscribe", {
              name: eventName,
              arguments: args,
              delivery: { mode: "webhook", url: callbackUrl, secret: secrets[0] },
              ttlMs: 60 * 60_000,
            });
          const redeploy = (edits: readonly (readonly [string, string])[]) =>
            Effect.gen(function* () {
              const deployed = yield* api.request(
                actors.owner,
                "POST",
                `${prefix}/apps/${emitter.id}/deploy`,
                { files: editedEmitter(edits) },
              );
              expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
            });

          const narrowed = yield* ok(Granted, yield* subscribe({ repo: "acme/widgets" }));
          const everything = yield* ok(Granted, yield* subscribe({}));

          // The filter `repo` becomes `repository`. Arguments that name `repo` no longer fit.
          yield* redeploy([["filters: { repo:", "filters: { repository:"]]);
          expect(yield* refused(yield* subscribe({ repo: "acme/widgets" }))).toMatchObject({
            code: -32014,
            data: { feature: "inputSchema", reason: "schema_changed" },
          });
          // Repeating the refresh still refuses: the subscription stays stopped.
          expect(yield* refused(yield* subscribe({ repo: "acme/widgets" }))).toMatchObject({
            code: -32014,
          });
          // A subscription without arguments still fits, so its refresh succeeds unchanged.
          const refreshed = yield* ok(Granted, yield* subscribe({}));
          expect(refreshed.id).toBe(everything.id);

          // The stopped subscription receives nothing; the other one still does.
          const opened = yield* emit("acme/widgets", 1);
          const delivered = yield* awaitDeliveries((all) =>
            events(all).some(
              (delivery) => delivery.id === opened && delivery.subscription === everything.id,
            ),
          );
          expect(
            events(delivered).filter(
              (delivery) => delivery.id === opened && delivery.subscription === narrowed.id,
            ),
          ).toHaveLength(0);

          // Renaming the event removes the one that subscription was created for.
          yield* redeploy([
            ["filters: { repo:", "filters: { repository:"],
            ['"issue.opened"', '"issue.created"'],
          ]);
          expect(yield* refused(yield* subscribe({}))).toMatchObject({
            code: -32011,
            data: { kind: "event" },
          });
          // A new subscription to the old name is refused the same way; the new name works.
          expect(
            yield* refused(yield* subscribe({ repository: "acme/widgets" }, name)),
          ).toMatchObject({ code: -32011 });
          yield* ok(
            Granted,
            yield* subscribe({ repository: "acme/widgets" }, `${emitter.slug}.issue.created`),
          );
        }),
      ),
    { timeout: 240_000 },
  );
});

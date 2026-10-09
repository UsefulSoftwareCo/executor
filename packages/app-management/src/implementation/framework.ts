/** Framework lookups over the reference this server ships. No app evaluation or account is involved. */
import { Effect, Layer, Schema } from "effect";
import type { HttpApiMiddleware } from "effect/http-api";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import { appsVersion } from "@executor-js/app-templates";
import {
  FrameworkDocumentation,
  FrameworkReference,
  FrameworkVersionMismatch,
  type frameworkApi,
} from "../contracts/framework.ts";

/**
 * Decode the packaged `framework-reference.json` from a host's authoring assets and keep it.
 * Concurrent first lookups each decode their own copy instead of waiting on one another: on
 * Workers a waiter resumed by another request's fiber runs in that request's I/O context, and
 * its response then fails.
 */
export const frameworkDocumentation = (
  files: Effect.Effect<readonly { readonly path: string; readonly content: string }[]>,
) =>
  Layer.sync(FrameworkDocumentation, () => {
    let kept: FrameworkReference | undefined;
    const load = Effect.gen(function* () {
      const file = (yield* files).find((item) => item.path === "framework-reference.json");
      if (file === undefined) return yield* Effect.die(new Error("Framework reference missing"));
      return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(FrameworkReference))(
        file.content,
      ).pipe(Effect.orDie);
    });
    return Effect.suspend(() =>
      kept === undefined
        ? Effect.map(load, (reference) => (kept ??= reference))
        : Effect.succeed(kept),
    );
  });

const identity = (reference: FrameworkReference) => ({
  version: reference.version,
  digest: reference.digest,
});

/** Reject a lookup that names another build, so stale references are never answered silently. */
const select = (
  reference: FrameworkReference,
  selection: { readonly version?: string | undefined; readonly digest?: string | undefined },
) =>
  (selection.version !== undefined && selection.version !== reference.version) ||
  (selection.digest !== undefined && selection.digest !== reference.digest)
    ? Effect.fail(
        new FrameworkVersionMismatch({
          served: identity(reference),
          message:
            "This server serves a different framework build. For an app pinned to another apps version, read that package's framework-reference.json.",
        }),
      )
    : Effect.void;

/** Exact symbols rank first, then name matches, then documentation matches. */
const rank = (reference: FrameworkReference, text: string) => {
  const terms = text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return reference.entries
    .map((entry) => ({
      entry,
      score:
        entry.symbol === text
          ? 10000
          : terms.reduce(
              (score, term) =>
                score +
                (entry.symbol.toLowerCase().includes(term) ? 4 : 0) +
                ((entry.summary + " " + entry.docs).toLowerCase().includes(term) ? 1 : 0),
              0,
            ),
    }))
    .filter(({ score }) => terms.length === 0 || score > 0)
    .sort((a, b) => b.score - a.score || a.entry.symbol.localeCompare(b.entry.symbol));
};

const pageSize = 12;

export const frameworkHandlers = <I extends HttpApiMiddleware.AnyId, S, Id extends string>(
  api: ReturnType<typeof frameworkApi<I, S>>,
  apiId: Id,
) =>
  HttpApiBuilder.group(HttpApi.make(apiId).addHttpApi(api), "framework", (handlers) =>
    Effect.gen(function* () {
      // Read on the first lookup and kept; later lookups never touch I/O.
      const documentation = yield* FrameworkDocumentation;
      // The apps release this host runs; builds that do not declare it name the same version.
      return handlers
        .handle("release", () => Effect.succeed({ version: appsVersion }))
        .handle("search", ({ query }) =>
          Effect.gen(function* () {
            const reference = yield* documentation;
            yield* select(reference, query);
            const offset = Math.max(0, query.offset ?? 0);
            const ranked = rank(reference, query.text ?? "");
            return {
              reference: identity(reference),
              items: ranked.slice(offset, offset + pageSize).map(({ entry }) => ({
                symbol: entry.symbol,
                kind: entry.kind,
                summary: entry.summary,
                docs: entry.docs,
              })),
              remaining: Math.max(0, ranked.length - offset - pageSize),
            };
          }),
        )
        .handle("describe", ({ query }) =>
          Effect.gen(function* () {
            const reference = yield* documentation;
            yield* select(reference, query);
            const suffixed = reference.entries.filter((entry) =>
              [".", "/"].some((separator) => entry.symbol.endsWith(separator + query.symbol)),
            );
            const entry =
              reference.entries.find((candidate) => candidate.symbol === query.symbol) ??
              (suffixed.length === 1 ? suffixed[0] : undefined);
            if (entry === undefined)
              return {
                reference: identity(reference),
                types: [],
                examples: [],
                matches: [
                  ...new Set([
                    ...suffixed,
                    ...rank(reference, query.symbol).map((item) => item.entry),
                  ]),
                ]
                  .slice(0, 8)
                  .map(({ symbol, kind, summary }) => ({ symbol, kind, summary })),
              };
            return {
              reference: identity(reference),
              entry,
              types: reference.entries.filter((candidate) =>
                entry.related.includes(candidate.symbol),
              ),
              examples: reference.examples.filter((example) => entry.examples.includes(example.id)),
              matches: [],
            };
          }),
        );
    }),
  );

/** Standalone routes for hosts that serve this group as its own HttpApi, as local does. */
export const frameworkRoutes = <I extends HttpApiMiddleware.AnyId, S>(
  api: ReturnType<typeof frameworkApi<I, S>>,
) => HttpApiBuilder.layer(api).pipe(Layer.provide(frameworkHandlers(api, api.identifier)));

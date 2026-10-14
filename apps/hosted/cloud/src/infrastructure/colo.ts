/** The data center an isolate runs in, for spans that compare where two of Executor's isolates ran. */
import { Effect } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";

/** The colo code of the data center this request runs in, or `unknown`. */
export const lookupColo = HttpClient.get("https://cloudflare.com/cdn-cgi/trace").pipe(
  Effect.flatMap((response) => response.text),
  Effect.map((trace) => /^colo=([A-Z]+)$/m.exec(trace)?.[1] ?? "unknown"),
  Effect.timeout("5 seconds"),
  Effect.catchCause(() => Effect.succeed("unknown")),
  Effect.provide(FetchHttpClient.layer),
);

// oxlint-disable-next-line executor/no-module-level-mutable-state -- one colo code per isolate; it carries no request data
let isolateColo: string | undefined;
// oxlint-disable-next-line executor/no-module-level-mutable-state -- whether this isolate's one lookup has started
let looking = false;

/**
 * This isolate's colo once known, else `pending`. The first call starts one lookup, run by
 * `background` so no caller waits on it. An isolate never moves, so it is looked up once, and a
 * failed lookup reads `unknown` for the isolate's life. Callers start the lookup as their isolate
 * starts work and read it as late as they can; `pending` is then left only on a fresh isolate's
 * first replies, and a query by colo counts it as its own bucket, never as a data center.
 */
export const coloOf = (background: (lookup: Effect.Effect<void>) => void): string => {
  if (isolateColo !== undefined) return isolateColo;
  if (!looking) {
    looking = true;
    background(
      lookupColo.pipe(
        Effect.map((colo) => {
          isolateColo = colo;
        }),
      ),
    );
  }
  return "pending";
};

import { Effect } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";

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

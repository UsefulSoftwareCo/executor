import { Effect } from "effect";
import type { InteractionFaults, Kv } from "./mcp-interaction-faults.ts";

const header = "x-executor-test-fault";
const refusal = "Interaction record write refused by a test fault";
const lost = "Session object request lost by a test fault";

export const interactionFaultMarkers = [header, refusal, lost];

export const interactionFaults = (kv: Kv): InteractionFaults => {
  let refusing = 0;
  return {
    kv: {
      get: (key) => kv.get(key),
      list: (options) => kv.list(options),
      put: (key, value) => {
        if (refusing > 0) throw new Error(refusal);
        kv.put(key, value);
      },
      delete: (key) => kv.delete(key),
    },
    during: (request, work) =>
      request.headers[header] === "request-lost"
        ? Effect.die(new Error(lost))
        : request.headers[header] === "interaction-writes"
          ? Effect.suspend(() => {
              refusing += 1;
              return work;
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  refusing -= 1;
                }),
              ),
            )
          : work,
  };
};

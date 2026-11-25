import { Effect } from "effect";
import { createServer, connect, type Socket } from "node:net";
import type { AddressInfo } from "node:net";

type Pair = { readonly client: Socket; readonly upstream: Socket; dropped: boolean };

export interface HalfOpenProxy {
  readonly port: number;
  readonly dropAll: () => number;
  readonly dropOne: () => number;
  readonly healthyClosed: () => number;
  readonly refuse: (refusing: boolean) => void;
  readonly opened: () => number;
  readonly peak: () => number;
  readonly resetPeak: () => void;
}

export const halfOpenProxy = (target: { readonly host: string; readonly port: number }) =>
  Effect.acquireRelease(
    Effect.callback<HalfOpenProxy & { readonly close: () => void }>((resume) => {
      const pairs = new Set<Pair>();
      let refusing = false;
      let opened = 0;
      let open = 0;
      let peak = 0;
      let healthyClosed = 0;
      const server = createServer((client) => {
        opened++;
        open++;
        peak = Math.max(peak, open);
        client.once("close", () => {
          open--;
        });
        if (refusing) {
          client.destroy();
          return;
        }
        const upstream = connect(target.port, target.host);
        const pair: Pair = { client, upstream, dropped: false };
        pairs.add(pair);
        client.on("data", (chunk) => {
          if (pair.dropped) client.destroy();
          else upstream.write(chunk);
        });
        upstream.on("data", (chunk) => {
          if (!pair.dropped) client.write(chunk);
        });
        upstream.on("close", () => {
          if (!pair.dropped) client.destroy();
        });
        upstream.on("error", () => undefined);
        client.on("error", () => undefined);
        client.on("close", () => {
          if (!pair.dropped && pairs.has(pair)) healthyClosed++;
          pairs.delete(pair);
          upstream.destroy();
        });
      });
      server.listen(0, "127.0.0.1", () =>
        resume(
          Effect.succeed({
            port: (server.address() as AddressInfo).port,
            dropAll: () => {
              let dropped = 0;
              for (const pair of pairs)
                if (!pair.dropped) {
                  pair.dropped = true;
                  pair.upstream.destroy();
                  dropped++;
                }
              return dropped;
            },
            dropOne: () => {
              for (const pair of [...pairs].reverse())
                if (!pair.dropped) {
                  pair.dropped = true;
                  pair.upstream.destroy();
                  return 1;
                }
              return 0;
            },
            healthyClosed: () => healthyClosed,
            refuse: (value) => {
              refusing = value;
            },
            opened: () => opened,
            peak: () => peak,
            resetPeak: () => {
              peak = open;
              healthyClosed = 0;
            },
            close: () => {
              for (const pair of pairs) {
                pair.client.destroy();
                pair.upstream.destroy();
              }
              server.close();
            },
          }),
        ),
      );
    }),
    ({ close }) => Effect.sync(close),
  );

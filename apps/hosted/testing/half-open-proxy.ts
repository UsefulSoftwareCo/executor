/**
 * A TCP proxy in front of a database that can drop its connections the way a far end does in
 * production: the server side goes away while the client's socket stays open and says nothing,
 * so the client learns only when it next writes. It can also refuse every new connection, for a
 * database that cannot be reached at all.
 */
import { Effect } from "effect";
import { createServer, connect, type Socket } from "node:net";
import type { AddressInfo } from "node:net";

type Pair = { readonly client: Socket; readonly upstream: Socket; dropped: boolean };

export interface HalfOpenProxy {
  readonly port: number;
  /** Ends every current connection's server side; each client socket closes on its next write. */
  readonly dropAll: () => number;
  /** Ends one current connection's server side, the newest still open. */
  readonly dropOne: () => number;
  /** Connections not dropped that the client closed since the last `resetPeak`. */
  readonly healthyClosed: () => number;
  /** While set, every new connection is closed as soon as it opens. */
  readonly refuse: (refusing: boolean) => void;
  /** Connections opened through the proxy so far. */
  readonly opened: () => number;
  /** The most client connections open at once since the last `resetPeak`, dropped ones included. */
  readonly peak: () => number;
  readonly resetPeak: () => void;
}

/** Listens on a free local port until the caller's scope closes. */
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
          // The far end is gone: the bytes reach nothing, and the client learns now.
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

/** Synthetic authored app used by the runtime walkthrough. No real credentials. */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  query,
  array,
  decodeJson,
  defineApp,
  defineProvider,
  number,
  object,
  secrets,
  string,
  type Infer,
} from "apps";

const service = defineProvider({
  name: "Runtime fixture",
  auth: {
    apiKey: secrets({
      label: "Fixture token",
      fields: object({
        endpoint: string(),
        token: string(),
        region: string().default("test-region"),
      }),
    }),
  },
});
const Catalog = object({ names: array(string()), label: string() });
const Input = object({ count: number().default(2), suffix: string().optional() });

export default defineApp(
  { accounts: { service, extras: service.many() } },
  async ({ accounts }) => {
    const response = await fetch(`${accounts.service.fields.endpoint}/catalog`, {
      headers: { authorization: `Bearer ${accounts.service.fields.token}` },
    });
    if (!response.ok)
      throw new Error(`Synthetic evaluation failure ${accounts.service.fields.token}`);
    const catalog = await decodeJson(response, Catalog);
    return {
      queries: {
        ...Object.fromEntries(
          catalog.names.map((name) => [
            name,
            query(
              { description: `Fixture ${name}`, input: Input },
              async (_context: unknown, input: Infer<typeof Input>) => ({
                account: accounts.service.id,
                label: catalog.label,
                count: input.count,
                suffix: input.suffix ?? "",
                region: accounts.service.fields.region,
                extras: accounts.extras.length,
              }),
            ),
          ]),
        ),
        fail: query({ description: "Synthetic tool failure", input: object({}) }, async () => {
          throw new Error(`Synthetic tool failure ${accounts.service.fields.token}`);
        }),
        invalidOutput: query(
          { description: "Synthetic non-JSON result", input: object({}) },
          async () => undefined,
        ),
        node: query(
          { description: "Run a Node child process through Effect", input: object({}) },
          async () =>
            Effect.runPromise(
              Effect.gen(function* () {
                const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
                const child = yield* spawner.spawn(
                  ChildProcess.make("node", ["-e", 'console.log("node-ok")'], {
                    stdin: "ignore",
                    stdout: "pipe",
                    stderr: "ignore",
                  }),
                );
                const output = yield* Stream.mkString(Stream.decodeText(child.stdout));
                const code = yield* child.exitCode;
                if (code !== 0) return yield* Effect.fail(new Error("Fixture child failed"));
                return output.trim();
              }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
            ),
        ),
      },
    };
  },
);

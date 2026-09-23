/**
 * The library side: everything a package author ships.
 */
import { Effect } from "effect";
import { fumadb, type InferFumaDB } from "fumadb-effect";
import { v1, v2 } from "./schema.ts";

export const ChatDB = fumadb({ namespace: "example-chat", schemas: [v1, v2] });

export const chat = (client: InferFumaDB<typeof ChatDB>) => ({
  post: (name: string, content: string) =>
    Effect.gen(function* () {
      const version = yield* client.version;
      const orm = client.orm(version);
      return yield* orm.transaction(
        Effect.gen(function* () {
          const user = yield* orm.upsert("users", {
            where: (b) => b("name", "=", name),
            create: { name },
            update: {},
            returning: true,
          });
          yield* orm.create("messages", { user: user.id, content });
          return user;
        }),
      );
    }),
  timeline: () =>
    Effect.gen(function* () {
      const version = yield* client.version;
      const orm = client.orm(version);
      return yield* orm.findMany("users", {
        orderBy: ["name", "asc"],
        join: (b) => b.messages({ select: ["content"] }),
      });
    }),
});

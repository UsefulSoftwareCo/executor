import { Schema } from "effect";
import { column, idColumn, schema, table } from "fumadb-effect/schema";

export const UserId = Schema.String.pipe(Schema.brand("UserId"));

export const v1 = schema({
  version: "1.0.0",
  tables: {
    users: table("users", {
      id: idColumn("id", UserId).generated(),
      name: column("name", Schema.String),
      createdAt: column("created_at", Schema.DateTimeUtcFromDate).now(),
    }),
    messages: table("messages", {
      id: idColumn("id", Schema.String).generated(),
      user: column("user", UserId),
      content: column("content", Schema.String),
    }),
  },
  relations: {
    users: ({ many }) => ({ messages: many("messages") }),
    messages: ({ one }) => ({
      author: one("users", ["user", "id"]).foreignKey({ onDelete: "CASCADE" }),
    }),
  },
});

export const v2 = schema({
  version: "2.0.0",
  tables: {
    users: table("users", {
      id: idColumn("id", UserId).generated(),
      name: column("name", Schema.String),
      email: column("email", Schema.NullOr(Schema.String.check(Schema.isMaxLength(255)))).unique(),
      createdAt: column("created_at", Schema.DateTimeUtcFromDate).now(),
      preferences: column(
        "preferences",
        Schema.Struct({ theme: Schema.Literals(["light", "dark"]) }),
      ).default({ theme: "light" }),
    }),
    messages: table("messages", {
      id: idColumn("id", Schema.String).generated(),
      user: column("user", UserId),
      content: column("content", Schema.String),
    }),
  },
  relations: {
    users: ({ many }) => ({ messages: many("messages") }),
    messages: ({ one }) => ({
      author: one("users", ["user", "id"]).foreignKey({ onDelete: "CASCADE" }),
    }),
  },
});

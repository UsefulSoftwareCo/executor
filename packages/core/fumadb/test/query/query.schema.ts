import { column, idColumn, schema, table } from "../../src/schema";

export const v1 = schema({
  version: "1.0.0",
  tables: {
    users: table("users", {
      id: idColumn("id", "varchar(255)").defaultTo$("auto"),
      name: column("name", "string"),
    }),
    messages: table("messages", {
      id: idColumn("id", "varchar(255)").defaultTo$("auto"),
      user: column("user", "varchar(255)"),
      content: column("content", "string").defaultTo("default content."),
      parent: column("parent", "varchar(255)").nullable(),
      image: column("image", "binary").nullable(),

      // for testing one-to-one
      mentionId: column("mention_id", "varchar(255)").nullable().unique(),
    }),
    posts: table("posts", {
      id: idColumn("id", "uuid"),
      title: column("title", "string"),
      metadata: column("metadata", "json"),
    }),
  },
  relations: {
    users: ({ many }) => ({
      messages: many("messages"),
    }),
    messages: ({ one }) => ({
      author: one("users", ["user", "id"]).foreignKey(),
      mentioning: one("messages", ["mentionId", "id"])
        .foreignKey()
        .imply("mentionedBy"),
      mentionedBy: one("messages"),
    }),
  },
});

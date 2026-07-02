import { column, idColumn, schema, table } from "../../src/schema";

const users = table("users", {
  id: idColumn("id", "varchar(255)").defaultTo$("auto"),
  name: column("name", "string"),
});

const posts = table("posts", {
  id: idColumn("id", "varchar(255)").defaultTo$("auto"),
  authorId: column("author_id", "varchar(255)"),
  content: column("content", "string").defaultTo("default content."),
  relyTo: column("rely_to", "varchar(255)").nullable(),
  attachmentUrl: column("attachment_url", "varchar(255)").nullable().unique(),
});

const attachments = table("attachments", {
  id: idColumn("id", "varchar(255)").defaultTo$("auto"),
  url: column("url", "varchar(255)").unique(),
  data: column("data", "binary").nullable(),
});

const likes = table("likes", {
  id: idColumn("id", "varchar(255)").defaultTo$("auto"),
  userId: column("user_id", "varchar(255)"),
  postId: column("post_id", "varchar(255)"),
}).unique("user_post_uk", ["userId", "postId"]);

export const v1 = schema({
  version: "1.0.0",
  tables: {
    users,
    posts,
    attachments,
    likes,
  },
  relations: {
    users: ({ many }) => ({
      posts: many("posts"),
      likes: many("likes"),
    }),
    posts: ({ one, many }) => ({
      author: one("users", ["authorId", "id"]).foreignKey({
        // if you set it on primary keys, id columns cannot be updated, it should be always `RESTRICT`.
        onUpdate: "RESTRICT",
        onDelete: "CASCADE",
      }),
      relies: many("posts"),
      relying: one("posts", ["relyTo", "id"]).foreignKey(),
      attachment: one("attachments"),
      likes: many("likes"),
    }),
    likes: ({ one }) => ({
      user: one("users", ["userId", "id"]).foreignKey(),
      post: one("posts", ["postId", "id"]).foreignKey(),
    }),
    attachments: ({ one }) => ({
      post: one("posts", ["url", "attachmentUrl"]).foreignKey({
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      }),
    }),
  },
});

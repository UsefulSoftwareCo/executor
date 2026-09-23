/**
 * Schema fixtures ported from upstream fumadb's test suite.
 */
import { column, idColumn, schema, table, variantSchema } from "../../src/schema.ts";
import { Schema } from "effect";

/** upstream test/query/query.schema.ts */
export const queryV1 = schema({
  version: "1.0.0",
  tables: {
    users: table("users", {
      id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))).generated(),
      name: column("name", Schema.String),
    }),
    messages: table("messages", {
      id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))).generated(),
      user: column("user", Schema.String.check(Schema.isMaxLength(255))),
      content: column("content", Schema.String).default("default content."),
      parent: column("parent", Schema.NullOr(Schema.String.check(Schema.isMaxLength(255)))),
      image: column("image", Schema.NullOr(Schema.Uint8Array)),
      // for testing one-to-one
      mentionId: column(
        "mention_id",
        Schema.NullOr(Schema.String.check(Schema.isMaxLength(255))),
      ).unique(),
    }),
    posts: table("posts", {
      id: idColumn("id", Schema.String.check(Schema.isUUID())),
      title: column("title", Schema.String),
      metadata: column("metadata", Schema.Unknown),
    }),
  },
  relations: {
    users: ({ many }) => ({
      messages: many("messages"),
    }),
    messages: ({ one }) => ({
      author: one("users", ["user", "id"]).foreignKey(),
      mentioning: one("messages", ["mentionId", "id"]).foreignKey().imply("mentionedBy"),
      mentionedBy: one("messages"),
    }),
  },
});

/** upstream test/query/relations.schema.ts */
const relationUsers = table("users", {
  id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))).generated(),
  name: column("name", Schema.String),
});

const relationPosts = table("posts", {
  id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))).generated(),
  authorId: column("author_id", Schema.String.check(Schema.isMaxLength(255))),
  content: column("content", Schema.String).default("default content."),
  relyTo: column("rely_to", Schema.NullOr(Schema.String.check(Schema.isMaxLength(255)))),
  attachmentUrl: column(
    "attachment_url",
    Schema.NullOr(Schema.String.check(Schema.isMaxLength(255))),
  ).unique(),
});

const relationAttachments = table("attachments", {
  id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))).generated(),
  url: column("url", Schema.String.check(Schema.isMaxLength(255))).unique(),
  data: column("data", Schema.NullOr(Schema.Uint8Array)),
});

const relationLikes = table("likes", {
  id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))).generated(),
  userId: column("user_id", Schema.String.check(Schema.isMaxLength(255))),
  postId: column("post_id", Schema.String.check(Schema.isMaxLength(255))),
}).unique("user_post_uk", ["userId", "postId"]);

export const relationsV1 = schema({
  version: "1.0.0",
  tables: {
    users: relationUsers,
    posts: relationPosts,
    attachments: relationAttachments,
    likes: relationLikes,
  },
  relations: {
    users: ({ many }) => ({
      posts: many("posts"),
      likes: many("likes"),
    }),
    posts: ({ many, one }) => ({
      author: one("users", ["authorId", "id"]).foreignKey({
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

/** upstream test/migrate.test.ts v1..v4 */
export const migrateV1 = schema({
  version: "1.0.0",
  tables: {
    users: table("users", {
      id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))).generated(),
      image: column("image", Schema.NullOr(Schema.String.check(Schema.isMaxLength(200)))).default(
        "my-avatar",
      ),
      data: column("data", Schema.NullOr(Schema.Uint8Array)),
    }),
    accounts: table("accounts", {
      id: idColumn("secret_id", Schema.String.check(Schema.isMaxLength(255))),
    }),
  },
});

export const migrateV2 = schema({
  version: "2.0.0",
  tables: {
    users: table("users", {
      id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))).generated(),
      name: column("name", Schema.String.check(Schema.isMaxLength(255))),
      email: column("email", Schema.String.check(Schema.isMaxLength(255))).unique(),
      image: column("image", Schema.NullOr(Schema.String)).default("another-avatar"),
      stringColumn: column("string", Schema.NullOr(Schema.String)),
      bigintColumn: column("bigint", Schema.NullOr(Schema.BigInt)),
      integerColumn: column("integer", Schema.NullOr(Schema.Int)),
      decimalColumn: column("decimal", Schema.NullOr(Schema.Number)),
      boolColumn: column("bool", Schema.NullOr(Schema.Boolean)),
      jsonColumn: column("json", Schema.NullOr(Schema.Unknown)),
      binaryColumn: column("binary", Schema.NullOr(Schema.Uint8Array)),
      dateColumn: column("date", Schema.NullOr(Schema.Date), { type: "date" }),
      timestampColumn: column("timestamp", Schema.NullOr(Schema.Date)),
      fatherId: column(
        "fatherId",
        Schema.NullOr(Schema.String.check(Schema.isMaxLength(255))),
      ).unique(),
    }),
    accounts: table("accounts", {
      id: idColumn("secret_id", Schema.String.check(Schema.isMaxLength(255))),
      email: column("email", Schema.String.check(Schema.isMaxLength(255)))
        .unique()
        .default("test"),
    }),
  },
  relations: {
    users: (b) => ({
      account: b.one("accounts", ["email", "id"]).foreignKey({ onDelete: "CASCADE" }).imply("user"),
      father: b.one("users", ["fatherId", "id"]).foreignKey().imply("son"),
      son: b.one("users"),
    }),
    accounts: (b) => ({
      user: b.one("users"),
    }),
  },
});

export const migrateV3 = schema({
  version: "3.0.0",
  tables: {
    users: table("users", {
      id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))).generated(),
      name: column("name", Schema.String.check(Schema.isMaxLength(255))),
      email: column("email", Schema.String.check(Schema.isMaxLength(255))),
      image: column("image", Schema.NullOr(Schema.String)),
    }),
    accounts: table("accounts", {
      id: idColumn("secret_id", Schema.String.check(Schema.isMaxLength(255))),
      email: column("email", Schema.String.check(Schema.isMaxLength(255))),
    }).unique("id_email_uk", ["id", "email"]),
  },
});

export const migrateV4 = schema({
  version: "4.0.0",
  tables: {
    users: table("users", {
      id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))).generated(),
      name: column("name", Schema.String),
      image: column("image", Schema.NullOr(Schema.Int)),
    }),
  },
});

/** upstream test/query/variants.schema.ts */
export const variantBase = schema({
  version: "1.0.0",
  tables: {
    users: table("users", {
      name: column("name", Schema.String),
      id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
    }),
  },
});

export const variantAdmin = variantSchema("admin", variantBase, {
  tables: {
    role: table("role", {
      userId: idColumn("user_id", Schema.String.check(Schema.isMaxLength(255))),
      role: column("role", Schema.String.check(Schema.isMaxLength(255))),
      description: column({ sql: "Description" }, Schema.String),
    }),
  },
  relations: {
    users: ({ one }) => ({
      role: one("role"),
    }),
    role: ({ one }) => ({
      user: one("users", ["userId", "id"]).foreignKey(),
    }),
  },
});

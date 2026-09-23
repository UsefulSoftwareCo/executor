/**
 * Schema construction, relation resolution, validation, variants, cloning, and
 * column defaults.
 *
 * The first block ports the non-code-generator assertions of upstream
 * `test/uuid.test.ts`; the rest checks behaviour of upstream
 * `src/schema/create.ts` and `src/schema/validate.ts`.
 */
import { it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect } from "vitest";
import { SchemaDefinitionError } from "../src/contracts/errors.ts";
import { type Provider, providers } from "../src/contracts/provider.ts";
import type { AnyColumn, StorageType } from "../src/contracts/schema/column.ts";
import { schemaForStorageType } from "../src/contracts/schema/storage.ts";
import {
  dbToSchemaType,
  deserialize as deserializeResult,
  schemaToDbType,
  serialize as serializeResult,
  supportsLiteralDefault,
} from "../src/implementation/schema-codec.ts";
import { column, idColumn, schema, table, variantSchema } from "../src/schema.ts";
import { queryV1, relationsV1, variantAdmin, variantBase } from "./support/schemas.ts";

/** Identity comparison that does not depend on the two sides having the same static type. */
const isSame = (a: unknown, b: unknown): boolean => a === b;

/** `deserialize` unwrapped: the codec tests assert values, the Decode failure has its own test. */
const deserialize = (
  value: unknown,
  col: Parameters<typeof deserializeResult>[1],
  provider: Parameters<typeof deserializeResult>[2],
): unknown => Result.getOrThrow(deserializeResult(value, col, provider));

/** `serialize` unwrapped: the codec tests assert values, the InvalidInput failure has its own test. */
const serialize = (
  value: unknown,
  col: Parameters<typeof serializeResult>[1],
  provider: Parameters<typeof serializeResult>[2],
): unknown => Result.getOrThrow(serializeResult(value, col, provider));

describe("uuid columns (upstream test/uuid.test.ts)", () => {
  it("idColumn accepts uuid type", () => {
    const col = idColumn("id", Schema.String.check(Schema.isUUID()));
    expect(col.type).toBe("uuid");
    expect(col.id).toBe(true);
  });

  it("column accepts uuid type", () => {
    expect(column("token", Schema.String.check(Schema.isUUID())).type).toBe("uuid");
  });

  it("schema with UUID id column", () => {
    const s = schema({
      version: "1.0.0",
      tables: {
        users: table("users", {
          id: idColumn("id", Schema.String.check(Schema.isUUID())),
          name: column("name", Schema.String),
        }),
      },
    });
    expect(s.tables.users.getIdColumn().type).toBe("uuid");
  });

  it("schema with UUID regular column", () => {
    const s = schema({
      version: "1.0.0",
      tables: {
        sessions: table("sessions", {
          id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))).generated(),
          sessionToken: column(
            "session_token",
            Schema.NullOr(Schema.String.check(Schema.isUUID())),
          ),
        }),
      },
    });
    expect(s.tables.sessions.columns.sessionToken.type).toBe("uuid");
  });

  it("schema can mix UUID and CUID2 IDs", () => {
    const mixed = schema({
      version: "1.0.0",
      tables: {
        users: table("users", {
          id: idColumn("id", Schema.String.check(Schema.isUUID())),
          name: column("name", Schema.String),
        }),
        posts: table("posts", {
          id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))).generated(),
          authorId: column("author_id", Schema.String.check(Schema.isUUID())),
          content: column("content", Schema.String),
        }),
      },
    });
    expect(mixed.tables.users.getIdColumn().type).toBe("uuid");
    expect(mixed.tables.posts.getIdColumn().type).toBe("varchar(255)");
    expect(mixed.tables.posts.columns.authorId.type).toBe("uuid");
  });
});

describe("table()", () => {
  it("requires an id column", () => {
    expect(() => table("users", { name: column("name", Schema.String) })).toThrow(
      SchemaDefinitionError,
    );
    expect(() => table("users", { name: column("name", Schema.String) })).toThrow(/no id column/);
  });

  it("rejects more than one id column", () => {
    expect(() =>
      table("users", {
        id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
        other: idColumn("other", Schema.String.check(Schema.isUUID())),
      }),
    ).toThrow(SchemaDefinitionError);
  });

  it("links ORM names and the owning table to every column", () => {
    const users = table("users", {
      id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
      name: column("full_name", Schema.String),
    });
    expect(users.columns.name.ormName).toBe("name");
    expect(users.columns.name.names.sql).toBe("full_name");
    expect(isSame(users.columns.name.table, users)).toBe(true);
    expect(isSame(users.getIdColumn(), users.columns.id)).toBe(true);
  });

  it("defaults a name variant object to the ORM name", () => {
    const s = schema({
      version: "1.0.0",
      tables: {
        posts: table(
          {},
          {
            id: idColumn({}, Schema.String.check(Schema.isMaxLength(255))),
            body: column({ sql: "Body" }, Schema.String),
          },
        ),
      },
    });
    expect(s.tables.posts.names.sql).toBe("posts");
    expect(s.tables.posts.columns.id.names.sql).toBe("id");
    expect(s.tables.posts.columns.body.names.sql).toBe("Body");
  });

  it("reports unique constraints per level", () => {
    const likes = relationsV1.tables.likes;
    expect(likes.getUniqueConstraints("table").map((c) => c.name)).toEqual(["user_post_uk"]);
    expect(likes.getUniqueConstraints("column")).toEqual([]);
    expect(likes.getUniqueConstraints().map((c) => c.name)).toEqual(["user_post_uk"]);

    const attachments = relationsV1.tables.attachments;
    expect(attachments.getUniqueConstraints("column").map((c) => c.name)).toEqual([
      "unique_c_attachments_url",
    ]);
    expect(attachments.columns.url.getUniqueConstraintName()).toBe("unique_c_attachments_url");
  });

  it("looks a column up by SQL name", () => {
    const messages = queryV1.tables.messages;
    expect(isSame(messages.getColumnBySqlName("mention_id"), messages.columns.mentionId)).toBe(
      true,
    );
    expect(messages.getColumnBySqlName("mentionId")).toBeUndefined();
  });

  it("rejects an unknown column in unique()", () => {
    const users = table("users", {
      id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
    });
    expect(() => users.unique("uk", ["nope" as "id"])).toThrow(SchemaDefinitionError);
  });
});

describe("relations", () => {
  it("resolves an implicit relation against the single explicit relation pointing back", () => {
    const messages = queryV1.tables.messages;
    const users = queryV1.tables.users;
    const author = messages.relations.author;
    const list = users.relations.messages;

    expect(author.implied).toBe(false);
    expect(author.type).toBe("one");
    expect(author.on).toEqual([["user", "id"]]);
    expect(list.implied).toBe(true);
    expect(list.type).toBe("many");
    // the implied side swaps the column pairs
    expect(list.on).toEqual([["id", "user"]]);
    expect(isSame(list.impliedBy, author)).toBe(true);
    expect(isSame(author.implying, list)).toBe(true);
    expect(list.id).toBe(author.id);
    expect(author.id).toBe("messages_users");
  });

  it("uses imply() to pick the implicit relation when several point at the same table", () => {
    const messages = queryV1.tables.messages;
    expect(messages.relations.mentioning.id).toBe("messages_messages_mentionedBy");
    expect(isSame(messages.relations.mentioning.implying, messages.relations.mentionedBy)).toBe(
      true,
    );
    expect(messages.relations.mentionedBy.implied).toBe(true);
  });

  it("fails when an implied relation has no explicit counterpart", () => {
    expect(() =>
      schema({
        version: "1.0.0",
        tables: {
          users: table("users", {
            id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
          }),
          posts: table("posts", {
            id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
            authorId: column("author_id", Schema.String.check(Schema.isMaxLength(255))),
          }),
        },
        relations: {
          users: ({ many }) => ({ posts: many("posts") }),
        },
      }),
    ).toThrow(/Cannot resolve implied relation posts in table "users"/);
  });

  it("fails when several explicit relations could imply the same one", () => {
    expect(() =>
      schema({
        version: "1.0.0",
        tables: {
          users: table("users", {
            id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
          }),
          posts: table("posts", {
            id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
            authorId: column("author_id", Schema.String.check(Schema.isMaxLength(255))),
            editorId: column("editor_id", Schema.String.check(Schema.isMaxLength(255))),
          }),
        },
        relations: {
          users: ({ many }) => ({ posts: many("posts") }),
          posts: ({ one }) => ({
            author: one("users", ["authorId", "id"]).foreignKey(),
            editor: one("users", ["editorId", "id"]).foreignKey(),
          }),
        },
      }),
    ).toThrow(/you may want to specify `imply\(\)`/);
  });

  it("names a foreign key <referencer>_<referenced>_<relation>_fk", () => {
    expect(queryV1.tables.messages.foreignKeys.map((key) => key.name)).toEqual([
      "messages_users_author_fk",
      "messages_messages_mentioning_fk",
    ]);
    const author = queryV1.tables.messages.foreignKeys[0];
    expect(author?.columns.map((col) => col.names.sql)).toEqual(["user"]);
    expect(author?.referencedColumns.map((col) => col.names.sql)).toEqual(["id"]);
    expect(author?.onDelete).toBe("RESTRICT");
    expect(author?.onUpdate).toBe("RESTRICT");
    expect(isSame(author?.referencedTable, queryV1.tables.users)).toBe(true);
  });

  it("honours an explicit foreign key name and actions", () => {
    const post = relationsV1.tables.attachments.foreignKeys[0];
    expect(post?.name).toBe("attachments_posts_post_fk");
    expect(post?.onDelete).toBe("CASCADE");
    expect(post?.onUpdate).toBe("CASCADE");

    const s = schema({
      version: "1.0.0",
      tables: {
        users: table("users", { id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))) }),
        posts: table("posts", {
          id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
          authorId: column("author_id", Schema.String.check(Schema.isMaxLength(255))),
        }),
      },
      relations: {
        posts: ({ one }) => ({
          author: one("users", ["authorId", "id"]).foreignKey({ name: "my_fk" }),
        }),
      },
    });
    expect(s.tables.posts.foreignKeys.map((key) => key.name)).toEqual(["my_fk"]);
  });

  it("rejects a relation to an unknown table", () => {
    expect(() =>
      schema({
        version: "1.0.0",
        tables: {
          users: table("users", {
            id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
          }),
        },
        relations: {
          users: ({ many }) => ({ posts: many("posts" as "users") }),
        },
      }),
    ).toThrow(SchemaDefinitionError);
  });
});

describe("validateSchema", () => {
  /** `users` plus a `posts` table with a required and an optional author column. */
  const twoTables = () => ({
    users: table("users", { id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))) }),
    posts: table("posts", {
      id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
      authorId: column("author_id", Schema.String.check(Schema.isMaxLength(255))),
      optionalAuthorId: column(
        "optional_author_id",
        Schema.NullOr(Schema.String.check(Schema.isMaxLength(255))),
      ),
    }),
  });

  it("rejects an invalid version", () => {
    expect(() =>
      schema({
        version: "1.0",
        tables: {
          users: table("users", {
            id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
          }),
        },
      }),
    ).toThrow("the version 1.0 is invalid.");
  });

  it("requires foreignKey() on every explicit relation", () => {
    expect(() =>
      schema({
        version: "1.0.0",
        tables: twoTables(),
        relations: {
          posts: ({ one }) => ({ author: one("users", ["authorId", "id"]) }),
        },
      }),
    ).toThrow(/\[author\] You must define a foreign key for explicit relations\./);
  });

  it("requires the referenced columns to be unique", () => {
    expect(() =>
      schema({
        version: "1.0.0",
        tables: {
          users: table("users", {
            id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
            email: column("email", Schema.String.check(Schema.isMaxLength(255))),
          }),
          posts: table("posts", {
            id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
            authorEmail: column("author_email", Schema.String.check(Schema.isMaxLength(255))),
          }),
        },
        relations: {
          posts: ({ one }) => ({ author: one("users", ["authorEmail", "email"]).foreignKey() }),
        },
      }),
    ).toThrow(/the referenced columns must be unique or primary key/);
  });

  it("requires a unique referencer column for a one-to-one relation", () => {
    expect(() =>
      schema({
        version: "1.0.0",
        tables: twoTables(),
        relations: {
          posts: ({ one }) => ({ author: one("users", ["authorId", "id"]).foreignKey() }),
          users: ({ one }) => ({ post: one("posts") }),
        },
      }),
    ).toThrow(/one-to-one relations require both sides to be unique or primary key/);
  });

  it("accepts a one-to-one relation when the referencer column is unique", () => {
    expect(() =>
      schema({
        version: "1.0.0",
        tables: {
          users: table("users", {
            id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
          }),
          posts: table("posts", {
            id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
            authorId: column("author_id", Schema.String.check(Schema.isMaxLength(255))).unique(),
          }),
        },
        relations: {
          posts: ({ one }) => ({ author: one("users", ["authorId", "id"]).foreignKey() }),
          users: ({ one }) => ({ post: one("posts") }),
        },
      }),
    ).not.toThrow();
  });

  it("rejects SET NULL on a non-nullable column", () => {
    expect(() =>
      schema({
        version: "1.0.0",
        tables: twoTables(),
        relations: {
          posts: ({ one }) => ({
            author: one("users", ["authorId", "id"]).foreignKey({ onDelete: "SET NULL" }),
          }),
        },
      }),
    ).toThrow(/"SET NULL" as foreign key action, but some columns are non-nullable/);

    expect(() =>
      schema({
        version: "1.0.0",
        tables: twoTables(),
        relations: {
          posts: ({ one }) => ({
            author: one("users", ["optionalAuthorId", "id"]).foreignKey({ onUpdate: "SET NULL" }),
          }),
        },
      }),
    ).not.toThrow();
  });

  it("rejects a non-RESTRICT action on a self-referencing foreign key", () => {
    const selfReference = (onDelete: "CASCADE" | "RESTRICT") =>
      schema({
        version: "1.0.0",
        tables: {
          messages: table("messages", {
            id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
            parentId: column(
              "parent_id",
              Schema.NullOr(Schema.String.check(Schema.isMaxLength(255))),
            ),
          }),
        },
        relations: {
          messages: ({ one }) => ({
            parent: one("messages", ["parentId", "id"]).foreignKey({ onDelete }),
          }),
        },
      });

    expect(() => selfReference("CASCADE")).toThrow(
      /Self-referencing foreign keys only support the "RESTRICT" action/,
    );
    expect(() => selfReference("RESTRICT")).not.toThrow();
  });
});

describe("variantSchema", () => {
  it("appends the variant to the version", () => {
    expect(variantBase.version).toBe("1.0.0");
    expect(variantAdmin.version).toBe("1.0.0-admin");
  });

  it("adds tables and relations without touching the original", () => {
    expect(Object.keys(variantAdmin.tables).sort()).toEqual(["role", "users"]);
    expect(Object.keys(variantBase.tables)).toEqual(["users"]);
    expect(isSame(variantAdmin.tables.users, variantBase.tables.users)).toBe(false);
    expect(Object.keys(variantBase.tables.users.relations)).toEqual([]);
    expect(variantAdmin.tables.users.relations.role.implied).toBe(true);
    expect(variantAdmin.tables.role.relations.user.implied).toBe(false);
    expect(variantAdmin.tables.role.foreignKeys.map((key) => key.name)).toEqual([
      "role_users_user_fk",
    ]);
    expect(variantAdmin.tables.role.columns.description.names.sql).toBe("Description");
  });

  it("registers each foreign key exactly once", () => {
    expect(variantAdmin.tables.role.foreignKeys).toHaveLength(1);
  });

  it("replacing a table drops its original relations", () => {
    const base = schema({
      version: "2.0.0",
      tables: {
        users: table("users", { id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))) }),
        posts: table("posts", {
          id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
          authorId: column("author_id", Schema.String.check(Schema.isMaxLength(255))),
        }),
      },
      relations: {
        posts: ({ one }) => ({ author: one("users", ["authorId", "id"]).foreignKey() }),
      },
    });
    const variant = variantSchema("slim", base, {
      tables: {
        posts: table("posts", { id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))) }),
      },
    });

    expect(variant.version).toBe("2.0.0-slim");
    expect(Object.keys(variant.tables.posts.relations)).toEqual([]);
    expect(variant.tables.posts.foreignKeys).toEqual([]);
    expect(variant.tables.posts.columns).not.toHaveProperty("authorId");
    // the original is untouched
    expect(Object.keys(base.tables.posts.relations)).toEqual(["author"]);
  });

  /** base: `posts.author -> users`, plus the implicit `users.posts`. */
  const relatedBase = () =>
    schema({
      version: "2.0.0",
      tables: {
        users: table("users", { id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))) }),
        posts: table("posts", {
          id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
          authorId: column("author_id", Schema.String.check(Schema.isMaxLength(255))),
        }),
      },
      relations: {
        posts: ({ one }) => ({ author: one("users", ["authorId", "id"]).foreignKey() }),
        users: ({ many }) => ({ posts: many("posts") }),
      },
    });

  it("re-points a relation that targeted a replaced table at the replacement", () => {
    const base = relatedBase();
    const variant = variantSchema("admin", base, {
      tables: {
        users: table("app_users", {
          id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
          role: column("role", Schema.String),
        }),
      },
    });

    const key = variant.tables.posts.foreignKeys[0];
    expect(key?.name).toBe("posts_users_author_fk");
    // the foreign key must name the table the migration actually creates
    expect(key?.referencedTable.names.sql).toBe("app_users");
    expect(isSame(key?.referencedTable, variant.tables.users)).toBe(true);
    expect(isSame(key?.referencedColumns[0], variant.tables.users.columns.id)).toBe(true);
    expect(isSame(variant.tables.posts.relations.author.table, variant.tables.users)).toBe(true);
    // and the base is untouched
    expect(base.tables.posts.foreignKeys[0]?.referencedTable.names.sql).toBe("users");
  });

  it("agrees with its own clone about every foreign key target", () => {
    const variant = variantSchema("admin", relatedBase(), {
      tables: {
        users: table("app_users", {
          id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
          role: column("role", Schema.String),
        }),
      },
    });
    const targets = (s: typeof variant) =>
      Object.values(s.tables).flatMap((t) =>
        t.foreignKeys.map((k) => `${k.name}->${k.referencedTable.names.sql}`),
      );

    expect(targets(variant)).toEqual(["posts_users_author_fk->app_users"]);
    expect(targets(variant.clone())).toEqual(targets(variant));
  });

  it("drops an implicit relation whose explicit side lived on a replaced table", () => {
    const variant = variantSchema("slim", relatedBase(), {
      tables: {
        posts: table("posts", { id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))) }),
      },
    });
    expect(Object.keys(variant.tables.posts.relations)).toEqual([]);
    expect(Object.keys(variant.tables.users.relations)).toEqual([]);
    expect(Object.values(variant.tables).flatMap((t) => t.foreignKeys)).toEqual([]);
  });

  it("rejects a replacement that drops a referenced column", () => {
    const base = relatedBase();
    expect(() =>
      variantSchema("broken", base, {
        // the replacement has no `id`-named column for `posts.author` to reference
        tables: {
          users: table("app_users", {
            key: idColumn("key", Schema.String.check(Schema.isMaxLength(255))),
          }),
        },
      }),
    ).toThrow(SchemaDefinitionError);
  });
});

describe("clone()", () => {
  it("copies tables and columns so the original cannot be mutated", () => {
    const cloned = relationsV1.clone();
    expect(isSame(cloned, relationsV1)).toBe(false);
    expect(isSame(cloned.tables.posts, relationsV1.tables.posts)).toBe(false);
    expect(
      isSame(cloned.tables.posts.columns.content, relationsV1.tables.posts.columns.content),
    ).toBe(false);

    cloned.tables.posts.names = { sql: "renamed_posts" };
    cloned.tables.posts.columns.content.names = { sql: "renamed_content" };

    expect(cloned.tables.posts.names.sql).toBe("renamed_posts");
    expect(cloned.tables.posts.columns.content.names.sql).toBe("renamed_content");
    expect(relationsV1.tables.posts.names.sql).toBe("posts");
    expect(relationsV1.tables.posts.columns.content.names.sql).toBe("content");
  });

  it("keeps a name override when the clone is cloned again", () => {
    const first = relationsV1.clone();
    first.tables.posts.names = { sql: "renamed_posts" };
    expect(first.clone().tables.posts.names.sql).toBe("renamed_posts");
  });

  it("rebuilds relations against the cloned tables", () => {
    const cloned = queryV1.clone();
    expect(Object.keys(cloned.tables.messages.relations).sort()).toEqual([
      "author",
      "mentionedBy",
      "mentioning",
    ]);
    expect(isSame(cloned.tables.messages.relations.author.table, cloned.tables.users)).toBe(true);
    expect(isSame(cloned.tables.messages.relations.author.table, queryV1.tables.users)).toBe(false);
    expect(cloned.tables.messages.foreignKeys.map((key) => key.name)).toEqual([
      "messages_users_author_fk",
      "messages_messages_mentioning_fk",
    ]);
    expect(
      isSame(cloned.tables.messages.foreignKeys[0]?.referencedTable, cloned.tables.users),
    ).toBe(true);
  });

  it("keeps the relations a variant inherited from its base schema", () => {
    const base = schema({
      version: "3.0.0",
      tables: {
        users: table("users", { id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))) }),
        posts: table("posts", {
          id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
          authorId: column("author_id", Schema.String.check(Schema.isMaxLength(255))),
        }),
      },
      relations: {
        posts: ({ one }) => ({ author: one("users", ["authorId", "id"]).foreignKey() }),
        users: ({ many }) => ({ posts: many("posts") }),
      },
    });
    const variant = variantSchema("admin", base, {
      tables: {
        role: table("role", {
          id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
          userId: column("user_id", Schema.String.check(Schema.isMaxLength(255))),
        }),
      },
      relations: { role: ({ one }) => ({ user: one("users", ["userId", "id"]).foreignKey() }) },
    });

    const cloned = variant.clone();
    expect(Object.keys(cloned.tables.posts.relations)).toEqual(["author"]);
    expect(Object.keys(cloned.tables.users.relations)).toEqual(["posts"]);
    expect(cloned.tables.posts.foreignKeys.map((key) => key.name)).toEqual([
      "posts_users_author_fk",
    ]);
    expect(cloned.tables.role.foreignKeys.map((key) => key.name)).toEqual(["role_users_user_fk"]);
    // the copies reference the cloned tables and columns
    expect(isSame(cloned.tables.posts.relations.author.table, cloned.tables.users)).toBe(true);
    expect(
      isSame(cloned.tables.posts.foreignKeys[0]?.columns[0], cloned.tables.posts.columns.authorId),
    ).toBe(true);
    expect(
      isSame(cloned.tables.users.relations.posts.impliedBy, cloned.tables.posts.relations.author),
    ).toBe(true);
    expect(
      isSame(cloned.tables.posts.relations.author.implying, cloned.tables.users.relations.posts),
    ).toBe(true);
    // and nothing is registered twice
    expect(cloned.clone().tables.posts.foreignKeys).toHaveLength(1);
  });

  it("keeps column flags, defaults, and unique constraints", () => {
    const cloned = relationsV1.clone();
    expect(cloned.tables.posts.columns.relyTo.isNullable).toBe(true);
    expect(cloned.tables.posts.columns.attachmentUrl.isUnique).toBe(true);
    expect(cloned.tables.posts.columns.content.defaultValue).toEqual({
      _tag: "Value",
      value: "default content.",
      encoded: "default content.",
    });
    expect(cloned.tables.likes.getUniqueConstraints("table").map((c) => c.name)).toEqual([
      "user_post_uk",
    ]);
    expect(
      cloned.tables.likes.getUniqueConstraints("table")[0]?.columns.map((c) => c.ormName),
    ).toEqual(["userId", "postId"]);
    // the constraint refers to the cloned columns
    expect(
      isSame(
        cloned.tables.likes.getUniqueConstraints("table")[0]?.columns[0],
        cloned.tables.likes.columns.userId,
      ),
    ).toBe(true);
  });
});

describe("column defaults", () => {
  it.effect('generates a cuid for "auto"', () =>
    Effect.gen(function* () {
      const col = column("id", Schema.String.check(Schema.isMaxLength(255))).generated();
      const first = yield* col.generateDefault();
      const second = yield* col.generateDefault();
      expect(typeof first).toBe("string");
      expect(first).toMatch(/^[a-z][a-z0-9]{8,}$/);
      expect(first).not.toBe(second);
    }),
  );

  it.effect('reads the Clock for "now"', () =>
    Effect.gen(function* () {
      const col = column("created_at", Schema.Date).now();
      expect(yield* col.generateDefault()).toEqual(new Date(0));
      yield* TestClock.setTime(1_700_000_000_000);
      expect(yield* col.generateDefault()).toEqual(new Date(1_700_000_000_000));
    }),
  );

  it.effect("calls a plain function", () =>
    Effect.gen(function* () {
      let calls = 0;
      const col = column("counter", Schema.Int).generate(Effect.sync(() => ++calls));
      expect(yield* col.generateDefault()).toBe(1);
      expect(yield* col.generateDefault()).toBe(2);
    }),
  );

  it.effect("runs an Effect", () =>
    Effect.gen(function* () {
      const col = column("counter", Schema.Int).generate(Effect.sync(() => 42));
      expect(yield* col.generateDefault()).toBe(42);
    }),
  );

  it.effect("returns a constant default and undefined when there is none", () =>
    Effect.gen(function* () {
      const withDefault = column("content", Schema.String).default("default content.");
      expect(withDefault.defaultValue).toEqual({
        _tag: "Value",
        value: "default content.",
        encoded: "default content.",
      });
      expect(yield* withDefault.generateDefault()).toBe("default content.");
      expect(yield* column("content", Schema.String).generateDefault()).toBeUndefined();
    }),
  );

  it("records the nullable and unique flags", () => {
    const col = column("name", Schema.String.check(Schema.isMaxLength(255)));
    expect(col.isNullable).toBe(false);
    expect(column("name", Schema.NullOr(Schema.String)).isNullable).toBe(true);
    expect(col.unique().isUnique).toBe(true);
    expect(col.unique(false).isUnique).toBe(false);
    // unbounded text cannot be indexed on MySQL or SQL Server
    expect(() => column("bio", Schema.String).unique()).toThrow(SchemaDefinitionError);
  });
});

describe("value codec: schemaToDbType", () => {
  /**
   * The SQL type each FumaDB type is created with, per provider. Compared with
   * upstream `schema/serialize.ts` `schemaToDBType` and with the
   * `create table` lines of the upstream migration snapshots.
   *
   * Deviations from upstream (docs/DESIGN.md 15): `decimal` gets a precision
   * and scale on MySQL and MSSQL (a bare `decimal` rounds fractions away);
   * MSSQL text is `nvarchar` (`varchar` destroys non-Latin1 text); timestamps
   * are `datetime(3)` on MySQL and `datetime2(3)` on MSSQL (millisecond exact,
   * time-zone independent, no 1970 to 2038 range).
   */
  const expected: Record<StorageType, Record<Provider, string>> = {
    string: {
      sqlite: "text",
      mssql: "nvarchar(max)",
      postgresql: "text",
      cockroachdb: "text",
      mysql: "text",
    },
    bigint: {
      sqlite: "blob",
      mssql: "bigint",
      postgresql: "bigint",
      cockroachdb: "bigint",
      mysql: "bigint",
    },
    integer: {
      sqlite: "integer",
      mssql: "int",
      postgresql: "integer",
      cockroachdb: "integer",
      mysql: "integer",
    },
    decimal: {
      sqlite: "real",
      mssql: "decimal(38,19)",
      postgresql: "decimal",
      cockroachdb: "decimal",
      mysql: "decimal(65,30)",
    },
    bool: {
      sqlite: "integer",
      mssql: "bit",
      postgresql: "boolean",
      cockroachdb: "boolean",
      mysql: "boolean",
    },
    json: {
      sqlite: "text",
      mssql: "nvarchar(max)",
      postgresql: "json",
      cockroachdb: "json",
      mysql: "json",
    },
    binary: {
      sqlite: "blob",
      mssql: "varbinary(max)",
      postgresql: "bytea",
      cockroachdb: "bytea",
      mysql: "longblob",
    },
    date: {
      sqlite: "integer",
      mssql: "date",
      postgresql: "date",
      cockroachdb: "date",
      mysql: "date",
    },
    timestamp: {
      sqlite: "integer",
      mssql: "datetime2(3)",
      postgresql: "timestamp",
      cockroachdb: "timestamp",
      mysql: "datetime(3)",
    },
    uuid: {
      sqlite: "text",
      mssql: "uniqueidentifier",
      postgresql: "uuid",
      cockroachdb: "uuid",
      mysql: "char(36)",
    },
    "varchar(255)": {
      sqlite: "text",
      mssql: "nvarchar(255)",
      postgresql: "varchar(255)",
      cockroachdb: "varchar(255)",
      mysql: "varchar(255)",
    },
  };

  for (const provider of providers) {
    it(`maps every column type on ${provider}`, () => {
      for (const [type, byProvider] of Object.entries(expected)) {
        expect(schemaToDbType({ type: type as StorageType }, provider)).toBe(byProvider[provider]);
      }
    });
  }

  it("gives `decimal` a precision and a scale where the provider's default rounds", () => {
    // A bare `decimal` is DECIMAL(10, 0) on MySQL and DECIMAL(18, 0) on SQL
    // Server, so 1.5 is stored as 2. Verified live: the round-trip assertions
    // in test/sql-migration.test.ts read 1.5 back on every provider.
    expect(schemaToDbType({ type: "decimal" }, "mysql")).toBe("decimal(65,30)");
    expect(schemaToDbType({ type: "decimal" }, "mssql")).toBe("decimal(38,19)");
    // `decimal` is arbitrary precision on PostgreSQL and CockroachDB, and
    // SQLite has no fixed-point type at all.
    expect(schemaToDbType({ type: "decimal" }, "postgresql")).toBe("decimal");
    expect(schemaToDbType({ type: "decimal" }, "cockroachdb")).toBe("decimal");
    expect(schemaToDbType({ type: "decimal" }, "sqlite")).toBe("real");
  });
});

describe("value codec: supportsLiteralDefault", () => {
  /** The types MySQL keeps in a `text`, `json`, or `blob` column. */
  const unsupportedOnMysql: ReadonlyArray<StorageType> = ["string", "json", "binary"];

  const everyType: ReadonlyArray<StorageType> = [
    "string",
    "bigint",
    "integer",
    "decimal",
    "bool",
    "json",
    "binary",
    "date",
    "timestamp",
    "uuid",
    "varchar(255)",
  ];

  it("rejects a literal default for text, json, and blob columns on MySQL", () => {
    for (const type of everyType) {
      expect([type, supportsLiteralDefault({ type }, "mysql")]).toEqual([
        type,
        !unsupportedOnMysql.includes(type),
      ]);
    }
  });

  it("accepts a literal default for every type on every other provider", () => {
    for (const provider of providers) {
      if (provider === "mysql") continue;
      for (const type of everyType) {
        expect([provider, type, supportsLiteralDefault({ type }, provider)]).toEqual([
          provider,
          type,
          true,
        ]);
      }
    }
  });
});

describe("value codec: dbToSchemaType", () => {
  it("prefers varchar with a known length, and falls back to string", () => {
    expect(dbToSchemaType("varchar", "postgresql", { length: 255 })).toEqual(["varchar(255)"]);
    expect(dbToSchemaType("varchar", "postgresql", {})).toEqual(["varchar(n)", "string"]);
    expect(dbToSchemaType("VARCHAR", "mysql", { length: 10 })).toEqual(["varchar(10)"]);
    // mssql reports `varchar(max)` as length -1
    expect(dbToSchemaType("nvarchar", "mssql", { length: -1 })).toEqual(["string", "json"]);
  });

  it("maps a mysql char(36) to uuid", () => {
    expect(dbToSchemaType("char", "mysql", { length: 36 })).toEqual(["uuid", "varchar(36)"]);
    expect(dbToSchemaType("char", "mysql", { length: 2 })).toEqual(["varchar(2)"]);
  });

  it("lists every candidate for an overloaded sqlite storage class", () => {
    expect(dbToSchemaType("INTEGER", "sqlite", {})).toEqual([
      "integer",
      "bigint",
      "bool",
      "timestamp",
      "date",
    ]);
    expect(dbToSchemaType("text", "sqlite", {})).toEqual([
      "string",
      "varchar(n)",
      "uuid",
      "json",
      "bigint",
    ]);
    expect(dbToSchemaType("blob", "sqlite", {})).toEqual(["bigint", "binary"]);
    expect(dbToSchemaType("real", "sqlite", {})).toEqual(["decimal"]);
  });

  it("keeps an unknown type as-is", () => {
    expect(dbToSchemaType("hstore", "postgresql", {})).toEqual(["hstore"]);
  });

  it("round-trips every schemaToDbType result back to its own type", () => {
    const types: ReadonlyArray<StorageType> = [
      "string",
      "bigint",
      "integer",
      "decimal",
      "bool",
      "json",
      "binary",
      "date",
      "timestamp",
      "uuid",
    ];
    for (const provider of providers) {
      for (const type of types) {
        const dbType = schemaToDbType({ type }, provider);
        // `nvarchar(max)` / `varbinary(max)` / `decimal(38,19)` carry the
        // length, precision, and scale inline; the catalogue reports them
        // separately from the type name.
        const bare = dbType.replace(/\((max|[\d,]+)\)$/, "");
        const length = dbType === "char(36)" ? { length: 36 } : {};
        expect(dbToSchemaType(bare, provider, length)).toContain(type);
      }
    }
  });
});

describe("value codec: deserialize", () => {
  const col = (type: StorageType): AnyColumn =>
    table("t", {
      id: idColumn("id", Schema.String),
      c: column("c", schemaForStorageType(type, true), { type }),
    }).columns.c as AnyColumn;
  /** Providers whose driver already parsed a `json` column. */
  const parsed: ReadonlyArray<Provider> = ["postgresql", "cockroachdb", "mysql"];
  const text: ReadonlyArray<Provider> = ["sqlite", "mssql"];

  it("treats null and undefined as null on every provider", () => {
    for (const provider of providers) {
      expect(deserialize(null, col("json"), provider)).toBeNull();
      expect(deserialize(undefined, col("string"), provider)).toBeNull();
    }
  });

  it("does not parse a json column the driver already parsed", () => {
    // Verified against the live drivers: a stored JSON string comes back as a
    // JavaScript string on postgresql, cockroachdb, and mysql. Parsing it
    // again threw a SyntaxError for `"hello"` and silently turned the string
    // '{"a":1}' into an object.
    for (const provider of parsed) {
      expect(deserialize("hello", col("json"), provider)).toBe("hello");
      expect(deserialize('{"a":1}', col("json"), provider)).toBe('{"a":1}');
      expect(deserialize({ x: 1 }, col("json"), provider)).toEqual({ x: 1 });
      expect(deserialize(42, col("json"), provider)).toBe(42);
      expect(deserialize(true, col("json"), provider)).toBe(true);
    }
  });

  it("parses a json column stored as text", () => {
    for (const provider of text) {
      expect(deserialize('"hello"', col("json"), provider)).toBe("hello");
      expect(deserialize('{"a":1}', col("json"), provider)).toEqual({ a: 1 });
      expect(deserialize("42", col("json"), provider)).toBe(42);
      expect(deserialize("[1,2]", col("json"), provider)).toEqual([1, 2]);
      // an already-parsed value still passes through
      expect(deserialize({ x: 1 }, col("json"), provider)).toEqual({ x: 1 });
    }
  });

  it("normalises bool from every driver representation", () => {
    for (const provider of providers) {
      expect(deserialize(1, col("bool"), provider)).toBe(true);
      expect(deserialize(0, col("bool"), provider)).toBe(false);
      expect(deserialize(1n, col("bool"), provider)).toBe(true);
      expect(deserialize(0n, col("bool"), provider)).toBe(false);
      expect(deserialize("1", col("bool"), provider)).toBe(true);
      expect(deserialize("true", col("bool"), provider)).toBe(true);
      expect(deserialize("0", col("bool"), provider)).toBe(false);
      expect(deserialize(true, col("bool"), provider)).toBe(true);
    }
  });

  it("normalises bigint from a string, a number, and an 8-byte blob", () => {
    const big = 9_007_199_254_740_993n;
    for (const provider of providers) {
      expect(deserialize("12", col("bigint"), provider)).toBe(12n);
      expect(deserialize(12, col("bigint"), provider)).toBe(12n);
      expect(deserialize(big, col("bigint"), provider)).toBe(big);
      expect(deserialize(big.toString(), col("bigint"), provider)).toBe(big);
    }
    const blob = serialize(big, col("bigint"), "sqlite");
    expect(blob).toBeInstanceOf(Uint8Array);
    expect(deserialize(blob, col("bigint"), "sqlite")).toBe(big);
    expect(deserialize(serialize(-big, col("bigint"), "sqlite"), col("bigint"), "sqlite")).toBe(
      -big,
    );
    expect(deserialize(serialize(0n, col("bigint"), "sqlite"), col("bigint"), "sqlite")).toBe(0n);
  });

  it("normalises integer and decimal to a number", () => {
    for (const provider of providers) {
      expect(deserialize(5n, col("integer"), provider)).toBe(5);
      expect(deserialize("5", col("integer"), provider)).toBe(5);
      expect(deserialize(5, col("integer"), provider)).toBe(5);
      expect(deserialize("1.5", col("decimal"), provider)).toBe(1.5);
      expect(deserialize(2n, col("decimal"), provider)).toBe(2);
      expect(deserialize(1.5, col("decimal"), provider)).toBe(1.5);
    }
  });

  it("returns a plain Uint8Array for binary, including an empty one", () => {
    for (const provider of providers) {
      const buffer = Buffer.from([1, 2, 3]);
      const out = deserialize(buffer, col("binary"), provider);
      expect(out).toBeInstanceOf(Uint8Array);
      expect(out?.constructor).toBe(Uint8Array);
      expect(Array.from(out as Uint8Array)).toEqual([1, 2, 3]);

      const empty = deserialize(new Uint8Array(0), col("binary"), provider);
      expect(empty).toBeInstanceOf(Uint8Array);
      expect((empty as Uint8Array).length).toBe(0);
    }
  });

  it("normalises date and timestamp to a Date", () => {
    for (const provider of providers) {
      for (const type of ["date", "timestamp"] as const) {
        expect(deserialize(0, col(type), provider)).toEqual(new Date(0));
        expect(deserialize(1_700_000_000_000, col(type), provider)).toEqual(
          new Date(1_700_000_000_000),
        );
        expect(deserialize(0n, col(type), provider)).toEqual(new Date(0));
        expect(deserialize("2024-01-02", col(type), provider)).toEqual(
          new Date("2024-01-02T00:00:00Z"),
        );
        // text without a zone is UTC, because that is how the codec writes it
        expect(deserialize("2024-01-02 03:04:05.678", col(type), provider)).toEqual(
          new Date("2024-01-02T03:04:05.678Z"),
        );
        const date = new Date(123);
        if (provider === "mysql") {
          // mysql2 parses the stored UTC text with local components; the codec reads them back as UTC
          const local = new Date(2024, 0, 2, 3, 4, 5, 678);
          expect(deserialize(local, col(type), provider)).toEqual(
            new Date("2024-01-02T03:04:05.678Z"),
          );
        } else {
          expect(deserialize(date, col(type), provider)).toBe(date);
        }
      }
    }
  });

  it("leaves textual types alone", () => {
    for (const provider of providers) {
      expect(deserialize("abc", col("string"), provider)).toBe("abc");
      expect(deserialize("abc", col("varchar(255)"), provider)).toBe("abc");
      // SQL Server reports uniqueidentifier in upper case; the codec lower-cases it
      const upper = "0A8F1E2B-3C4D-4E6F-8A8B-9C0D1E2F3A4B";
      expect(deserialize(upper, col("uuid"), provider)).toBe(
        provider === "mssql" ? upper.toLowerCase() : upper,
      );
    }
  });
});

describe("value codec: serialize", () => {
  const col = (type: StorageType): AnyColumn =>
    table("t", {
      id: idColumn("id", Schema.String),
      c: column("c", schemaForStorageType(type, true), { type }),
    }).columns.c as AnyColumn;

  it("keeps undefined, so a caller can omit the column", () => {
    for (const provider of providers) {
      expect(serialize(undefined, col("string"), provider)).toBeUndefined();
      expect(serialize(null, col("string"), provider)).toBeNull();
    }
  });

  it("always sends json as text", () => {
    for (const provider of providers) {
      expect(serialize("hello", col("json"), provider)).toBe('"hello"');
      expect(serialize({ x: 1 }, col("json"), provider)).toBe('{"x":1}');
      expect(serialize(42, col("json"), provider)).toBe("42");
      expect(serialize([1, 2], col("json"), provider)).toBe("[1,2]");
    }
  });

  it("converts dates, bools, and bigints for sqlite only", () => {
    const date = new Date(1_700_000_000_000);
    expect(serialize(date, col("timestamp"), "sqlite")).toBe(1_700_000_000_000);
    expect(serialize(true, col("bool"), "sqlite")).toBe(1);
    expect(serialize(false, col("bool"), "sqlite")).toBe(0);
    expect(serialize(7n, col("bigint"), "sqlite")).toBeInstanceOf(Uint8Array);

    for (const provider of providers.filter((p) => p !== "sqlite")) {
      // dates travel as UTC text everywhere except sqlite (epoch ms) and the
      // binary PostgreSQL protocol, which takes the Date itself
      expect(serialize(date, col("date"), provider)).toBe("2023-11-14");
      if (provider === "mysql" || provider === "mssql") {
        expect(serialize(date, col("timestamp"), provider)).toBe("2023-11-14 22:13:20.000");
      } else {
        expect(serialize(date, col("timestamp"), provider)).toBe(date);
      }
      expect(serialize(true, col("bool"), provider)).toBe(true);
      expect(serialize(7n, col("bigint"), provider)).toBe(7n);
    }
    // decimals travel as text on the providers that would otherwise bind a float
    expect(serialize(0.1 + 0.2, col("decimal"), "postgresql")).toBe("0.30000000000000004");
    expect(serialize(0.1 + 0.2, col("decimal"), "sqlite")).toBe(0.1 + 0.2);
  });

  it("sends binary as a plain Uint8Array", () => {
    for (const provider of providers) {
      const out = serialize(Buffer.from([4, 5]), col("binary"), provider);
      expect(out?.constructor).toBe(Uint8Array);
      expect(Array.from(out as Uint8Array)).toEqual([4, 5]);
    }
  });

  it("round-trips through the representation the driver returns", () => {
    // `json` is the one type where the database, not the codec, parses the
    // text on postgresql, cockroachdb, and mysql. Model that here; the live
    // round trip is covered by the SQL query tests.
    const values: ReadonlyArray<unknown> = ["hello", '{"a":1}', { x: 1 }, 42, [1, 2], true];
    for (const provider of providers) {
      for (const value of values) {
        const stored = serialize(value, col("json"), provider);
        const fromDriver =
          provider === "sqlite" || provider === "mssql"
            ? stored
            : (JSON.parse(stored as string) as unknown);
        expect(deserialize(fromDriver, col("json"), provider)).toEqual(value);
      }
    }
  });
});

describe("value codec: decode failures", () => {
  it("malformed stored JSON text is a typed Decode failure on providers that store JSON as text", () => {
    const payload = schema({
      version: "1.0.0",
      tables: {
        t: table("t", {
          id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
          payload: column("payload", Schema.Unknown),
        }),
      },
    }).tables.t.columns.payload;
    for (const provider of ["sqlite", "mssql"] as const) {
      const result = deserializeResult("{not json", payload, provider);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.reason).toBe("Decode");
        expect(result.failure.column).toBe("payload");
        expect(result.failure.table).toBe("t");
      }
    }
  });
});

describe("schema() does not mutate its input", () => {
  /** Two versions built from one set of `table()` objects, the natural way to add a relation. */
  const sharedTables = () => ({
    users: table("users", {
      id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
    }),
    posts: table("posts", {
      id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
      authorId: column("author_id", Schema.String.check(Schema.isMaxLength(255))),
    }),
  });

  it("reuses one table object across two versions without duplicating a foreign key", () => {
    const tables = sharedTables();
    const v1 = schema({ version: "1.0.0", tables });
    const v2 = schema({
      version: "2.0.0",
      tables,
      relations: {
        posts: ({ one }) => ({
          author: one("users", ["authorId", "id"]).foreignKey({
            onUpdate: "RESTRICT",
            onDelete: "RESTRICT",
          }),
        }),
      },
    });

    // the caller's objects are untouched, so v1 never learns about v2's key
    expect(tables.posts.foreignKeys).toEqual([]);
    expect(tables.posts.ormName).toBe("");
    expect(v1.tables.posts.foreignKeys).toEqual([]);
    expect(v2.tables.posts.foreignKeys).toHaveLength(1);
    // and the schemas hold their own copies
    expect(isSame(v1.tables.posts, v2.tables.posts)).toBe(false);
    expect(isSame(v1.tables.posts, tables.posts)).toBe(false);
  });

  it("building the same version twice produces the same single foreign key", () => {
    const tables = sharedTables();
    const build = () =>
      schema({
        version: "1.0.0",
        tables,
        relations: {
          posts: ({ one }) => ({
            author: one("users", ["authorId", "id"]).foreignKey({
              onUpdate: "RESTRICT",
              onDelete: "RESTRICT",
            }),
          }),
        },
      });
    expect(build().tables.posts.foreignKeys).toHaveLength(1);
    expect(build().tables.posts.foreignKeys).toHaveLength(1);
  });

  it("carries the relations of an inherited table into the next version", () => {
    const tables = sharedTables();
    const v1 = schema({
      version: "1.0.0",
      tables,
      relations: {
        posts: ({ one }) => ({
          author: one("users", ["authorId", "id"]).foreignKey({
            onUpdate: "RESTRICT",
            onDelete: "RESTRICT",
          }),
        }),
      },
    });
    const v2 = schema({ version: "2.0.0", tables: v1.tables });
    expect(v2.tables.posts.foreignKeys).toHaveLength(1);
    expect(v1.tables.posts.foreignKeys).toHaveLength(1);
    expect(isSame(v2.tables.posts.foreignKeys[0], v1.tables.posts.foreignKeys[0])).toBe(false);
  });

  it("variantSchema leaves the replacement tables reusable", () => {
    const replacement = table("users", {
      id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
      nickname: column("nickname", Schema.NullOr(Schema.String.check(Schema.isMaxLength(255)))),
    });
    const a = variantSchema("a", variantBase, { tables: { users: replacement } });
    const b = variantSchema("b", variantBase, { tables: { users: replacement } });
    expect(replacement.foreignKeys).toEqual([]);
    expect(isSame(a.tables.users, replacement)).toBe(false);
    expect(isSame(a.tables.users, b.tables.users)).toBe(false);
  });
});

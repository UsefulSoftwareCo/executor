import { mysqlTable, varchar, foreignKey, text, customType } from "drizzle-orm/mysql-core"
import { createId } from "@executor-js/fumadb/cuid"
import { relations } from "drizzle-orm"

export const users = mysqlTable("users", {
  id: varchar("id", { length: 255 }).primaryKey().notNull().$defaultFn(() => createId()),
  name: varchar("name", { length: 255 }).notNull(),
  email: varchar("email", { length: 255 }).notNull(),
  image: varchar("image", { length: 200 }).default("my-avatar")
}, (table) => [
  foreignKey({
    columns: [table.id],
    foreignColumns: [accounts.id],
    name: "users_accounts_account_fk"
  }).onUpdate("restrict").onDelete("restrict")
])

export const usersRelations = relations(users, ({ one, many }) => ({
  account: one(accounts, {
    relationName: "users_accounts",
    fields: [users.id],
    references: [accounts.id]
  }),
  posts: many(posts, {
    relationName: "posts_users"
  })
}));

export const accounts = mysqlTable("accounts", {
  id: varchar("id", { length: 255 }).primaryKey().notNull()
})

export const accountsRelations = relations(accounts, ({ one, many }) => ({
  user: one(users, {
    relationName: "users_accounts",
    fields: [accounts.id],
    references: [users.id]
  })
}));

const customBinary = customType<
  {
    data: Uint8Array;
    driverData: Buffer;
  }
>({
  dataType() {
    return "longblob";
  },
  fromDriver(value) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  },
  toDriver(value) {
    return value instanceof Buffer? value : Buffer.from(value)
  }
});

export const posts = mysqlTable("posts", {
  id: varchar("id", { length: 255 }).primaryKey().notNull().$defaultFn(() => createId()),
  authorId: varchar("author_id", { length: 255 }).notNull(),
  content: text("content").notNull(),
  image: customBinary("image")
}, (table) => [
  foreignKey({
    columns: [table.authorId],
    foreignColumns: [users.id],
    name: "posts_users_author_fk"
  }).onUpdate("restrict").onDelete("restrict")
])

export const postsRelations = relations(posts, ({ one, many }) => ({
  author: one(users, {
    relationName: "posts_users",
    fields: [posts.authorId],
    references: [users.id]
  })
}));
import { sqliteTable, text } from "drizzle-orm/sqlite-core"

export const users = sqliteTable("users", {
  id: text("id").primaryKey().notNull(),
  email: text("email", { length: 255 }).notNull(),
  sessionToken: text("session_token")
})
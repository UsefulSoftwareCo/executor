import { mysqlTable, char, varchar } from "drizzle-orm/mysql-core"

export const users = mysqlTable("users", {
  id: char("id", { length: 36 }).primaryKey().notNull(),
  email: varchar("email", { length: 255 }).notNull(),
  sessionToken: char("session_token", { length: 36 })
})
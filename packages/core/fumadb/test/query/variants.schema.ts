import {
  column,
  idColumn,
  schema,
  table,
  variantSchema,
} from "../../src/schema";

export const base = schema({
  version: "1.0.0",
  tables: {
    users: table("users", {
      name: column("name", "string"),
      id: idColumn("id", "varchar(255)"),
    }),
  },
});

export const admin = variantSchema("admin", base, {
  tables: {
    role: table("role", {
      userId: idColumn("user_id", "varchar(255)"),
      role: column("role", "varchar(255)"),
      description: column(
        {
          prisma: "Description",
        },
        "string"
      ),
    }),
  },
  relations: {
    users: ({ one }) => ({
      role: one("role"),
    }),
    role: ({ one }) => ({
      user: one("users", ["userId", "id"]),
    }),
  },
});

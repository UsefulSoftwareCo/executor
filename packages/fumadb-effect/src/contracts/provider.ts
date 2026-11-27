import type { Statement } from "effect/sql";

export const providers = ["postgresql", "cockroachdb", "mysql", "sqlite", "mssql"] as const;

export type Provider = (typeof providers)[number];

export const isProvider = (value: unknown): value is Provider =>
  typeof value === "string" && (providers as ReadonlyArray<string>).includes(value);

export const dialectOf = (provider: Provider): Statement.Dialect => {
  switch (provider) {
    case "postgresql":
    case "cockroachdb":
      return "pg";
    case "mysql":
      return "mysql";
    case "sqlite":
      return "sqlite";
    case "mssql":
      return "mssql";
  }
};

export type RelationMode = "foreign-keys" | "fumadb";

export const defaultRelationMode = (provider: Provider): RelationMode =>
  provider === "mssql" ? "fumadb" : "foreign-keys";

export const sqlProviders = [
  "sqlite",
  "cockroachdb",
  "mysql",
  "postgresql",
  "mssql",
] as const;

export const noSqlProviders = ["mongodb"] as const;

export const providers = [...sqlProviders, ...noSqlProviders] as const;

export type Provider = (typeof providers)[number];

export type SQLProvider = (typeof sqlProviders)[number];
export type NoSQLProvider = (typeof noSqlProviders)[number];

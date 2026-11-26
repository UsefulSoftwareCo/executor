import { Option, Result } from "effect";
import { Statement } from "effect/sql";
import type { SqlClient } from "effect/sql/SqlClient";
import type { Condition, Operator } from "../../contracts/condition.ts";
import type { Provider } from "../../contracts/provider.ts";
import { type AnyColumn, isColumn } from "../../contracts/schema/column.ts";
import { QueryError } from "../../contracts/errors.ts";
import { serialize } from "../schema-codec.ts";
import type { AnyTable } from "../../contracts/schema/table.ts";

export type TableAlias = (table: AnyTable) => string;

export const defaultAlias: TableAlias = (table) => table.names.sql;

export const qualifiedName = (column: AnyColumn, aliasOf: TableAlias): string =>
  `${aliasOf(column.table)}.${column.names.sql}`;

export const escapeLikeValue = (value: string, provider: Provider): string =>
  value.replace(provider === "mssql" ? /[\\%_[]/g : /[\\%_]/g, (match) => `\\${match}`);

const escapeClause = (provider: Provider): string =>
  provider === "mysql" ? " ESCAPE '\\\\'" : " ESCAPE '\\'";

const sqlOperator: Record<string, string> = {
  "=": "=",
  "!=": "<>",
  ">": ">",
  ">=": ">=",
  "<": "<",
  "<=": "<=",
};

const concat = (
  sql: SqlClient,
  provider: Provider,
  parts: ReadonlyArray<Statement.Fragment>,
): Statement.Fragment => {
  if (provider === "mysql") return sql`CONCAT(${sql.csv(parts)})`;
  if (provider === "mssql") return Statement.join(" + ", true, "''")(parts);
  return Statement.join(" || ", true, "''")(parts);
};

export const valueOrNull = (sql: SqlClient, value: unknown): Statement.Fragment =>
  value === null || value === undefined ? sql.literal("NULL") : sql`${value}`;

export const buildWhere = (
  condition: Condition,
  sql: SqlClient,
  provider: Provider,
  aliasOf: TableAlias = defaultAlias,
): Result.Result<Statement.Fragment, QueryError> => {
  switch (condition._tag) {
    case "And": {
      if (condition.items.length === 0) return Result.succeed(sql.literal("1=1"));
      return Result.map(
        Result.all(condition.items.map((item) => buildWhere(item, sql, provider, aliasOf))),
        (items) => sql.and(items),
      );
    }
    case "Or": {
      if (condition.items.length === 0) return Result.succeed(sql.literal("1=0"));
      return Result.map(
        Result.all(condition.items.map((item) => buildWhere(item, sql, provider, aliasOf))),
        (items) => sql.or(items),
      );
    }
    case "Not":
      return Result.map(
        buildWhere(condition.item, sql, provider, aliasOf),
        (inner) => sql`NOT ${inner}`,
      );
    case "Compare":
      return buildCompare(
        condition.column,
        condition.operator,
        condition.value,
        sql,
        provider,
        aliasOf,
      );
  }
};

const unwrapNone = (value: unknown): unknown =>
  Option.isOption(value) && Option.isNone(value) ? null : value;

const buildCompare = (
  column: AnyColumn,
  operator: Operator,
  rawValue: unknown,
  sql: SqlClient,
  provider: Provider,
  aliasOf: TableAlias,
): Result.Result<Statement.Fragment, QueryError> => {
  const value = unwrapNone(rawValue);
  const comparable = (item: AnyColumn): Statement.Fragment => {
    const reference = sql(qualifiedName(item, aliasOf));
    return (provider === "postgresql" || provider === "cockroachdb") && item.type === "json"
      ? sql`CAST(${reference} AS jsonb)`
      : sql`${reference}`;
  };
  const left = comparable(column);
  const right = isColumn(value) ? comparable(value) : undefined;

  switch (operator) {
    case "in":
    case "not in": {
      const items = Array.isArray(value) ? value.map(unwrapNone) : [];
      if (items.length === 0) return Result.succeed(sql.literal(operator === "in" ? "1=0" : "1=1"));
      return Result.map(
        Result.all(items.map((item) => serialize(item, column, provider))),
        (values) => {
          const list = sql`(${sql.csv(values.map((item) => valueOrNull(sql, item ?? null)))})`;
          return operator === "in" ? sql`${left} IN ${list}` : sql`${left} NOT IN ${list}`;
        },
      );
    }
    case "contains":
    case "not contains":
    case "starts with":
    case "not starts with":
    case "ends with":
    case "not ends with": {
      const negated = operator.startsWith("not ");
      const keyword = sql.literal(negated ? " NOT LIKE " : " LIKE ");
      const prefix = operator.endsWith("contains") || operator.endsWith("ends with");
      const suffix = operator.endsWith("contains") || operator.endsWith("starts with");
      const escape = sql.literal(escapeClause(provider));
      if (right !== undefined) {
        const pattern = concat(sql, provider, [
          ...(prefix ? [sql.literal("'%'")] : []),
          sql`${right}`,
          ...(suffix ? [sql.literal("'%'")] : []),
        ]);
        return Result.succeed(sql`${left}${keyword}${pattern}${escape}`);
      }
      return Result.map(asText(value, column, provider), (text) => {
        const pattern = `${prefix ? "%" : ""}${escapeLikeValue(text, provider)}${suffix ? "%" : ""}`;
        return sql`${left}${keyword}${pattern}${escape}`;
      });
    }
    case "json contains": {
      const target = unwrapNone(rawValue);
      if (column.type !== "json" || typeof target !== "string")
        return Result.fail(
          new QueryError({
            reason: "InvalidInput",
            message: `operator "json contains" requires a JSON column and an exact string.`,
            column: column.ormName,
          }),
        );
      const reference = sql(qualifiedName(column, aliasOf));
      if (provider === "postgresql" || provider === "cockroachdb") {
        const value = sql`CAST(${JSON.stringify(target)} AS jsonb)`;
        return Result.succeed(
          sql`EXISTS (SELECT 1 FROM jsonb_each(CAST(${reference} AS jsonb)) AS entries WHERE entries.value = ${value} OR (jsonb_typeof(entries.value) = 'array' AND entries.value @> jsonb_build_array(${value})))`,
        );
      }
      if (provider === "mysql") {
        return Result.succeed(
          sql`EXISTS (SELECT 1 FROM JSON_TABLE(${reference}, '$.*' COLUMNS (entry JSON PATH '$')) AS entries WHERE (JSON_TYPE(entries.entry) = 'STRING' AND entries.entry = ${valueOrNull(sql, target)}) OR (JSON_TYPE(entries.entry) = 'ARRAY' AND EXISTS (SELECT 1 FROM JSON_TABLE(CASE WHEN JSON_TYPE(entries.entry) = 'ARRAY' THEN entries.entry ELSE JSON_ARRAY() END, '$[*]' COLUMNS (value JSON PATH '$')) AS item WHERE JSON_TYPE(item.value) = 'STRING' AND item.value = ${valueOrNull(sql, target)})))`,
        );
      }
      if (provider === "sqlite") {
        return Result.succeed(
          sql`EXISTS (SELECT 1 FROM json_each(${reference}) AS entries WHERE (entries.type = 'text' AND entries.value = ${valueOrNull(sql, target)}) OR (entries.type = 'array' AND EXISTS (SELECT 1 FROM json_each(CASE WHEN entries.type = 'array' THEN entries.value ELSE '[]' END) AS item WHERE item.type = 'text' AND item.value = ${valueOrNull(sql, target)})))`,
        );
      }
      if (provider === "mssql")
        return Result.succeed(
          sql`EXISTS (SELECT 1 FROM OPENJSON(${reference}) AS entries WHERE (entries.type = 1 AND entries.value = ${valueOrNull(sql, target)}) OR (entries.type = 4 AND EXISTS (SELECT 1 FROM OPENJSON(CASE WHEN entries.type = 4 THEN entries.value ELSE N'[]' END) AS item WHERE item.type = 1 AND item.value = ${valueOrNull(sql, target)})))`,
        );
      return Result.fail(
        new QueryError({ reason: "InvalidInput", message: "unsupported JSON provider." }),
      );
    }
    case "is":
    case "is not": {
      if (value === null)
        return Result.succeed(
          sql`${left}${sql.literal(operator === "is" ? " IS NULL" : " IS NOT NULL")}`,
        );
      return compareValue(
        sql,
        left,
        operator === "is" ? "=" : "<>",
        right,
        value,
        column,
        provider,
      );
    }
    default:
      return compareValue(sql, left, sqlOperator[operator] ?? "=", right, value, column, provider);
  }
};

const compareValue = (
  sql: SqlClient,
  left: Statement.Fragment,
  operator: string,
  right: Statement.Fragment | undefined,
  value: unknown,
  column: AnyColumn,
  provider: Provider,
): Result.Result<Statement.Fragment, QueryError> => {
  const op = sql.literal(` ${operator} `);
  if (right !== undefined) return Result.succeed(sql`${left}${op}${right}`);
  return Result.map(
    serialize(value, column, provider),
    (encoded) => sql`${left}${op}${valueOrNull(sql, encoded)}`,
  );
};

const asText = (
  value: unknown,
  column: AnyColumn,
  provider: Provider,
): Result.Result<string, QueryError> => {
  if (typeof value === "string") return Result.succeed(value);
  return Result.map(serialize(value, column, provider), (encoded) => {
    if (encoded === null || encoded === undefined) return "";
    return typeof encoded === "string" ? encoded : String(encoded);
  });
};

import { Data } from "effect";
import { QueryError } from "./errors.ts";
import type { AnyColumn } from "./schema/column.ts";

export const stringOperators = [
  "contains",
  "starts with",
  "ends with",
  "not contains",
  "not starts with",
  "not ends with",
] as const;

export const arrayOperators = ["in", "not in"] as const;

export const valueOperators = ["=", "!=", ">", ">=", "<", "<=", "is", "is not"] as const;

export const jsonOperators = ["json contains"] as const;
export const operators = [
  ...valueOperators,
  ...arrayOperators,
  ...stringOperators,
  ...jsonOperators,
] as const;

export type Operator = (typeof operators)[number];
export type StringOperator = (typeof stringOperators)[number];
export type ArrayOperator = (typeof arrayOperators)[number];
export type ValueOperator = (typeof valueOperators)[number];

const isOperator = (value: string): value is Operator =>
  (operators as ReadonlyArray<string>).includes(value);

export type Condition = Data.TaggedEnum<{
  Compare: { readonly column: AnyColumn; readonly operator: Operator; readonly value: unknown };
  And: { readonly items: ReadonlyArray<Condition> };
  Or: { readonly items: ReadonlyArray<Condition> };
  Not: { readonly item: Condition };
}>;

export const Condition = Data.taggedEnum<Condition>();

export type ConditionResult = Condition | boolean;

export type ConditionBuilder<Columns extends Record<string, AnyColumn>> = {
  <ColName extends keyof Columns>(
    column: ColName,
    operator: ValueOperator,
    value: Columns[ColName]["schema"]["Type"] | null,
  ): Condition;
  <ColName extends keyof Columns>(
    column: ColName,
    operator: StringOperator | (typeof jsonOperators)[number],
    value: string,
  ): Condition;
  <ColName extends keyof Columns>(
    column: ColName,
    operator: ArrayOperator,
    value: ReadonlyArray<Columns[ColName]["schema"]["Type"]>,
  ): Condition;
  <ColName extends keyof Columns>(column: ColName): Condition;

  readonly and: (...items: ReadonlyArray<ConditionResult>) => ConditionResult;
  readonly or: (...items: ReadonlyArray<ConditionResult>) => ConditionResult;
  readonly not: (item: ConditionResult) => ConditionResult;
  readonly isNull: (column: keyof Columns) => Condition;
  readonly isNotNull: (column: keyof Columns) => Condition;
};

export const createBuilder = <Columns extends Record<string, AnyColumn>>(
  columns: Columns,
): ConditionBuilder<Columns> => {
  const col = (name: keyof Columns): AnyColumn => {
    const out = columns[name];
    if (out === undefined) {
      throw new QueryError({
        reason: "UnknownColumn",
        message: `Invalid column name ${String(name)}`,
        column: String(name),
      });
    }
    return out;
  };

  const builder = ((...args: ReadonlyArray<unknown>): Condition => {
    if (args.length === 3) {
      const [a, operator, value] = args as [keyof Columns, string, unknown];
      if (!isOperator(operator)) {
        throw new QueryError({
          reason: "InvalidInput",
          message: `Unsupported operator: ${operator}`,
        });
      }
      if (
        (stringOperators as ReadonlyArray<string>).includes(operator) &&
        (value === null || value === undefined)
      ) {
        throw new QueryError({
          reason: "InvalidInput",
          message: `"${operator}" needs a string value; use isNull / isNotNull to test for NULL.`,
          column: String(a),
        });
      }
      return Condition.Compare({ column: col(a), operator, value });
    }
    return Condition.Compare({ column: col(args[0] as keyof Columns), operator: "=", value: true });
  }) as ConditionBuilder<Columns>;

  const mutable = builder as {
    -readonly [K in keyof ConditionBuilder<Columns>]: ConditionBuilder<Columns>[K];
  };
  mutable.isNull = (a) => builder(a, "is", null);
  mutable.isNotNull = (a) => builder(a, "is not", null);
  mutable.not = (item) => (typeof item === "boolean" ? !item : Condition.Not({ item }));
  mutable.or = (...items) => {
    const out: Array<Condition> = [];
    for (const item of items) {
      if (item === true) return true;
      if (item === false) continue;
      out.push(item);
    }
    return out.length === 0 ? false : Condition.Or({ items: out });
  };
  mutable.and = (...items) => {
    const out: Array<Condition> = [];
    for (const item of items) {
      if (item === true) continue;
      if (item === false) return false;
      out.push(item);
    }
    return out.length === 0 ? true : Condition.And({ items: out });
  };
  return builder;
};

export const buildCondition = <T, Columns extends Record<string, AnyColumn>>(
  columns: Columns,
  input: (builder: ConditionBuilder<Columns>) => T,
): T => input(createBuilder(columns));

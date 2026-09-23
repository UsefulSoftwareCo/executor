/** Query contracts, condition builders, and adapter helpers. */
export type * from "./contracts/query.ts";
export {
  arrayOperators,
  buildCondition,
  Condition,
  type ConditionBuilder,
  type ConditionResult,
  createBuilder,
  type Operator,
  operators,
  stringOperators,
  valueOperators,
} from "./contracts/condition.ts";
export type {
  CompiledFindOptions,
  CompiledJoin,
  CompiledUpsert,
  OrmAdapter,
  Row,
} from "./contracts/query-adapter.ts";
export { toOrm } from "./implementation/query/orm.ts";
export { createSoftForeignKey } from "./implementation/query/soft-foreign-key.ts";

import { scopeDbConformance } from "../seams/scope-db.conformance";
import { makeLibsqlScopeDb } from "./libsql-scope-db";

scopeDbConformance("libsql (in-memory)", () => makeLibsqlScopeDb({ root: ":memory:" }));

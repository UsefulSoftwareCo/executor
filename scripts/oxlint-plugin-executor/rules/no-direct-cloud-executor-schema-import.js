import { getPropertyName, isIdentifier, toRepoRelative, unwrapExpression } from "../utils.js";

const message =
  "Do not access cloud executor tables directly outside DB schema wiring. Executor-domain table access must go through the scoped SDK adapter so scope_id filtering cannot be skipped.";

const allowedFiles = new Set(["apps/cloud/src/db/db.ts", "apps/cloud/src/db/db.schema.test.ts"]);

const isCloudSource = (filename) => toRepoRelative(filename).startsWith("apps/cloud/src/");

const isDirectExecutorSchemaImport = (specifier) =>
  specifier === "./executor-schema" ||
  specifier === "./executor-schema.ts" ||
  specifier.endsWith("/db/executor-schema") ||
  specifier.endsWith("/db/executor-schema.ts");

const coreTableNames = new Set([
  "source",
  "tool",
  "definition",
  "secret",
  "connection",
  "oauth2_session",
  "tool_policy",
]);

const pluginTablePrefixes = ["openapi_", "graphql_", "mcp_"];

const isExecutorTableName = (name) =>
  coreTableNames.has(name) || pluginTablePrefixes.some((prefix) => name.startsWith(prefix));

const isDbQueryExecutorTableAccess = (node) => {
  const tableName = getPropertyName(node.property);
  if (!tableName || !isExecutorTableName(tableName)) return false;

  const object = unwrapExpression(node.object);
  if (object?.type !== "MemberExpression") return false;
  return getPropertyName(object.property) === "query";
};

const isCombinedSchemaExecutorTableAccess = (node) => {
  const tableName = getPropertyName(node.property);
  if (!tableName || !isExecutorTableName(tableName)) return false;
  return isIdentifier(unwrapExpression(node.object), "combinedSchema");
};

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow direct imports of cloud executor-schema outside sanctioned DB wiring.",
    },
  },
  create(context) {
    const filename = toRepoRelative(context.filename);
    if (!isCloudSource(context.filename) || allowedFiles.has(filename)) return {};

    return {
      ImportDeclaration(node) {
        const specifier = node.source.value;
        if (typeof specifier !== "string") return;
        if (!isDirectExecutorSchemaImport(specifier)) return;

        context.report({ node: node.source, message });
      },
      MemberExpression(node) {
        if (isDbQueryExecutorTableAccess(node) || isCombinedSchemaExecutorTableAccess(node)) {
          context.report({ node, message });
        }
      },
    };
  },
};

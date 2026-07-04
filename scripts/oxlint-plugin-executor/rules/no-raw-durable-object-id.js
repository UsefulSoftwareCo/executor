import { getPropertyName, toRepoRelative, unwrapExpression } from "../utils.js";

const message =
  "Do not resolve Durable Object IDs directly with idFromName/idFromString. Use the canonical helper for that Durable Object namespace.";

const allowedFiles = new Set([
  "packages/hosts/cloudflare/src/mcp/session-stub.ts",
  "packages/hosts/cloudflare/src/mcp/execution-owner-directory.ts",
  "apps/cloud/src/engine/execution-rate-limit.ts",
]);

const shouldCheck = (filename) => !allowedFiles.has(toRepoRelative(filename));

const isRawDurableObjectIdCall = (callee) => {
  const expression = unwrapExpression(callee);
  if (expression?.type !== "MemberExpression") return false;
  const property = getPropertyName(expression.property);
  return property === "idFromName" || property === "idFromString";
};

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow raw Durable Object id resolution outside canonical helpers.",
    },
  },
  create(context) {
    if (!shouldCheck(context.filename)) return {};

    return {
      CallExpression(node) {
        if (isRawDurableObjectIdCall(node.callee)) {
          context.report({ node: node.callee, message });
        }
      },
    };
  },
};

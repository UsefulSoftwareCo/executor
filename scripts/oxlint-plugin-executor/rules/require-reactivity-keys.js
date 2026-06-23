import {
  getCallName,
  hasObjectProperty,
  isConfigOrTooling,
  isDeclarationFile,
  unwrapExpression,
} from "../utils.js";

const readOnlyMutations = new Set([
  "probeMcpEndpoint",
  "startMcpOAuth",
  "probeGoogleDiscovery",
  "startGoogleDiscoveryOAuth",
  "previewOpenApiSpec",
  "startOpenApiOAuth",
  "startOAuth",
  "resolveSecret",
  "detectSource",
  "getDomainVerificationLink",
  // Health-check probes: they hit the live upstream and return a result, but
  // persist nothing, so there is no cached query for them to invalidate.
  "validateConnection",
  "checkConnectionHealth",
]);

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Require write mutation calls to pass reactivityKeys.",
    },
  },
  create(context) {
    if (isConfigOrTooling(context.filename) || isDeclarationFile(context.filename)) return {};

    const mutationCalls = new Map();

    return {
      VariableDeclarator(node) {
        const binding = node.id?.type === "Identifier" ? node.id.name : undefined;
        if (!binding) return;

        const call = unwrapExpression(node.init);
        if (call?.type !== "CallExpression" || getCallName(call.callee) !== "useAtomSet") return;
        if (!isPromiseMode(call.arguments[1])) return;

        const mutationName = getMutationName(call.arguments[0]);
        if (!mutationName || readOnlyMutations.has(mutationName)) return;

        mutationCalls.set(binding, { mutationName, node });
      },
      AwaitExpression(node) {
        const call = unwrapExpression(node.argument);
        if (call?.type !== "CallExpression") return;

        const binding = getCallName(call.callee);
        const mutation = mutationCalls.get(binding);
        if (!mutation) return;
        if (hasObjectProperty(call.arguments[0], "reactivityKeys")) return;

        context.report({
          node: call,
          message: `Mutation ${mutation.mutationName} must pass reactivityKeys at the call site. Skill: wrdn-effect-atom-reactivity-keys.`,
        });
      },
    };
  },
};

function isPromiseMode(options) {
  const object = unwrapExpression(options);
  if (object?.type !== "ObjectExpression") return false;

  return object.properties.some((property) => {
    if (property.type === "SpreadElement") return false;
    if (property.key?.type !== "Identifier" || property.key.name !== "mode") return false;
    const mode = unwrapExpression(property.value);
    return (
      (mode?.type === "Literal" || mode?.type === "StringLiteral") &&
      (mode.value === "promise" || mode.value === "promiseExit")
    );
  });
}

function getMutationName(atomExpression) {
  const expression = unwrapExpression(atomExpression);
  if (expression?.type === "Identifier") return expression.name;
  if (expression?.type === "CallExpression") return getCallName(expression.callee);
  return undefined;
}

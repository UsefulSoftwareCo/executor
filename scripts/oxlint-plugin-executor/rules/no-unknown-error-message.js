import {
  getCallName,
  getPropertyName,
  isIdentifier,
  nodeName,
  unwrapExpression,
} from "../utils.js";

const stringMessage =
  "Do not stringify unknown errors. Keep typed failures in Effect or normalize at a typed boundary. Skill: wrdn-effect-typed-errors.";
const messagePropertyMessage =
  "Do not read .message from unknown errors. Preserve typed failures with Effect tagged-error handling. Skill: wrdn-effect-typed-errors.";
const destructuredMessage =
  "Do not destructure .message from unknown errors. Preserve typed failures with Effect tagged-error handling. Skill: wrdn-effect-typed-errors.";

const errorLikeNames = new Set(["cause", "e", "err", "error", "reason", "unknownError"]);

const isErrorLikeIdentifier = (node) => {
  const name = nodeName(unwrapExpression(node));
  return errorLikeNames.has(name);
};

const parameterName = (node) => {
  const unwrapped = unwrapExpression(node);
  return isIdentifier(unwrapped) ? unwrapped.name : undefined;
};

const isCatchTagHandler = (node) => {
  if (node?.type !== "ArrowFunctionExpression" && node?.type !== "FunctionExpression") {
    return false;
  }

  const parent = node.parent;
  if (
    parent?.type === "CallExpression" &&
    parent.arguments?.[1] === node &&
    getCallName(parent.callee) === "catchTag"
  ) {
    return true;
  }

  const objectExpression = parent?.type === "Property" ? parent.parent : undefined;
  const callExpression =
    objectExpression?.type === "ObjectExpression" ? objectExpression.parent : undefined;
  return (
    callExpression?.type === "CallExpression" && getCallName(callExpression.callee) === "catchTags"
  );
};

const isCatchTagHandlerIdentifier = (node) => {
  const name = nodeName(unwrapExpression(node));
  if (!name) return false;

  let current = node?.parent;
  while (current) {
    if (current.type === "ArrowFunctionExpression" || current.type === "FunctionExpression") {
      return isCatchTagHandler(current) && parameterName(current.params?.[0]) === name;
    }
    current = current.parent;
  }
  return false;
};

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow common unknown-error string and message normalization patterns.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!isIdentifier(unwrapExpression(node.callee), "String")) return;
        if (node.arguments.some(isErrorLikeIdentifier)) {
          context.report({ node, message: stringMessage });
        }
      },
      MemberExpression(node) {
        if (getPropertyName(node.property) !== "message") return;
        if (isCatchTagHandlerIdentifier(node.object)) return;
        if (isErrorLikeIdentifier(node.object)) {
          context.report({ node, message: messagePropertyMessage });
        }
      },
      VariableDeclarator(node) {
        if (node.id?.type !== "ObjectPattern" || !isErrorLikeIdentifier(node.init)) return;
        if (isCatchTagHandlerIdentifier(node.init)) return;
        for (const property of node.id.properties ?? []) {
          if (property.type !== "Property") continue;
          if (getPropertyName(property.key) === "message") {
            context.report({ node: property, message: destructuredMessage });
          }
        }
      },
    };
  },
};

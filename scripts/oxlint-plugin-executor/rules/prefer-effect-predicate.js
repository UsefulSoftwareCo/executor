import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.js";

const message =
  "Use Predicate.isNotNull/isNotUndefined/isNotNullish from effect instead of hand-rolled nullish predicates.";

const nullishOperators = new Set(["!==", "!=", "===", "=="]);

const isNullLiteral = (node) => node?.type === "Literal" && node.value === null;
const isUndefinedIdentifier = (node) => isIdentifier(node, "undefined");
const isNullishLiteral = (node) => isNullLiteral(node) || isUndefinedIdentifier(node);

const isNullishComparison = (node, identifierName) => {
  const expression = unwrapExpression(node);
  if (expression?.type !== "BinaryExpression" || !nullishOperators.has(expression.operator)) {
    return false;
  }

  const left = unwrapExpression(expression.left);
  const right = unwrapExpression(expression.right);
  return (
    (isIdentifier(left, identifierName) && isNullishLiteral(right)) ||
    (isIdentifier(right, identifierName) && isNullishLiteral(left))
  );
};

const getSingleIdentifierParamName = (params) => {
  if (params.length !== 1) return undefined;
  const param = unwrapExpression(params[0]);
  return param?.type === "Identifier" ? param.name : undefined;
};

const isNullishPredicateFunction = (node) => {
  const name = getSingleIdentifierParamName(node.params ?? []);
  return name !== undefined && isNullishComparison(node.body, name);
};

const isFilterCall = (node) => {
  const callee = unwrapExpression(node.callee);
  return callee?.type === "MemberExpression" && getPropertyName(callee.property) === "filter";
};

const importsEffect = (node) => {
  const source = node.source;
  return source?.type === "Literal" && source.value === "effect";
};

export default {
  meta: {
    type: "problem",
    docs: {
      description: message,
    },
  },
  create(context) {
    let hasEffectImport = false;

    return {
      ImportDeclaration(node) {
        if (importsEffect(node)) {
          hasEffectImport = true;
        }
      },
      VariableDeclarator(node) {
        if (!hasEffectImport) return;
        const init = unwrapExpression(node.init);
        if (init?.type === "ArrowFunctionExpression" && isNullishPredicateFunction(init)) {
          context.report({ node: init, message });
        }
      },
      FunctionDeclaration(node) {
        if (!hasEffectImport) return;
        if (isNullishPredicateFunction(node)) {
          context.report({ node, message });
        }
      },
      CallExpression(node) {
        if (!hasEffectImport || !isFilterCall(node)) return;
        const predicate = unwrapExpression(node.arguments[0]);
        if (
          (predicate?.type === "ArrowFunctionExpression" ||
            predicate?.type === "FunctionExpression") &&
          isNullishPredicateFunction(predicate)
        ) {
          context.report({ node: predicate, message });
        }
      },
    };
  },
};

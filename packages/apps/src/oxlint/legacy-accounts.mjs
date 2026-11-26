import { createBindings, propertyName, unwrapExpression, walkAst } from "./ast.mjs";
import { ruleMeta } from "./rule-meta.mjs";

function objectPropertyName(property) {
  return propertyName(property.key, property.computed);
}

function findTopLevelAccounts(expression, bindings, seen = new Set()) {
  const node = unwrapExpression(expression);
  if (node?.type === "ObjectExpression") {
    for (const property of node.properties ?? []) {
      if (
        ["ObjectProperty", "Property", "ObjectMethod"].includes(property.type) &&
        objectPropertyName(property) === "accounts"
      ) {
        return property;
      }
      if (property.type === "SpreadElement") {
        const found = findTopLevelAccounts(property.argument, bindings, seen);
        if (found) return found;
      }
    }
    return null;
  }
  if (node?.type !== "Identifier") return null;
  const variable = bindings.variableOf(node);
  if (!variable || seen.has(variable)) return null;
  const initializer = bindings.localInitializer(variable);
  if (!initializer) return null;
  seen.add(variable);
  const found = findTopLevelAccounts(initializer, bindings, seen);
  seen.delete(variable);
  return found;
}

function parameterPattern(parameter) {
  let node = parameter;
  while (node && ["AssignmentPattern", "RestElement", "TSParameterProperty"].includes(node.type)) {
    node = node.left ?? node.argument ?? node.parameter;
  }
  return node;
}

function parameterType(parameter) {
  let node = parameter;
  while (node && ["AssignmentPattern", "RestElement", "TSParameterProperty"].includes(node.type)) {
    node = node.left ?? node.argument ?? node.parameter;
  }
  return node?.typeAnnotation?.typeAnnotation ?? null;
}

function accountsProperty(pattern) {
  if (pattern?.type !== "ObjectPattern") return null;
  return (
    pattern.properties?.find(
      (property) =>
        ["ObjectProperty", "Property"].includes(property.type) &&
        objectPropertyName(property) === "accounts",
    ) ?? null
  );
}

function isContextVariable(variable, bindings, marked, seen = new Set()) {
  if (!variable || seen.has(variable)) return false;
  if (marked.has(variable)) return true;
  seen.add(variable);
  const initializer = unwrapExpression(bindings.localInitializer(variable));
  const result =
    initializer?.type === "Identifier"
      ? isContextVariable(bindings.variableOf(initializer), bindings, marked, seen)
      : false;
  seen.delete(variable);
  return result;
}

function isFrameworkContextType(type, bindings, seen = new Set()) {
  if (!type) return false;
  if (type.type === "TSParenthesizedType")
    return isFrameworkContextType(type.typeAnnotation, bindings, seen);
  if (type.type === "TSIntersectionType") {
    return (type.types ?? []).some((part) => isFrameworkContextType(part, bindings, seen));
  }
  if (type.type !== "TSTypeReference") return false;
  const name = type.typeName;
  if (name?.type === "Identifier") {
    const symbol = bindings.resolveSymbol(name);
    if (symbol === "QueryContext" || symbol === "MutationContext") return true;
    const variable = bindings.variableOf(name);
    if (!variable || seen.has(variable)) return false;
    seen.add(variable);
    const alias = bindings.typeAlias(variable);
    const result = isFrameworkContextType(alias, bindings, seen);
    seen.delete(variable);
    return result;
  }
  if (name?.type === "TSQualifiedName") {
    const object = name.left;
    return (
      bindings.resolveSymbol(object) === "namespace" &&
      ["QueryContext", "MutationContext"].includes(name.right?.name)
    );
  }
  return false;
}

function noLegacyAccounts(context, program) {
  const bindings = createBindings(context);
  const contextVariables = new WeakSet();
  const reportedPatterns = new WeakSet();

  function reportContextPattern(pattern) {
    const property = accountsProperty(pattern);
    if (property && !reportedPatterns.has(property)) {
      reportedPatterns.add(property);
      context.report({ node: property, messageId: "legacyContext" });
    }
  }

  walkAst(program, (node) => {
    if (
      ["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"].includes(node.type)
    ) {
      for (const parameter of node.params ?? []) {
        if (!isFrameworkContextType(parameterType(parameter), bindings)) continue;
        const pattern = parameterPattern(parameter);
        if (pattern?.type === "Identifier") {
          const variable = bindings.variableOf(pattern);
          if (variable) contextVariables.add(variable);
        } else {
          reportContextPattern(pattern);
        }
      }
    }
    if (node.type !== "CallExpression") return;
    const symbol = bindings.resolveSymbol(node.callee);
    if (symbol === "defineApp") {
      const property = findTopLevelAccounts(node.arguments?.[0], bindings);
      if (property) context.report({ node: property, messageId: "legacyRequirements" });
    }
    const handlerIndex =
      symbol === "defineApp" || symbol === "query" || symbol === "mutation" ? 1 : -1;
    if (handlerIndex < 0) return;
    const handler = bindings.resolveFunctionNode(node.arguments?.[handlerIndex]);
    const first = parameterPattern(handler?.params?.[0]);
    if (first?.type === "Identifier") {
      const variable = bindings.variableOf(first);
      if (variable) contextVariables.add(variable);
    } else {
      reportContextPattern(first);
    }
  });

  walkAst(program, (node) => {
    const memberObject = node.type === "MemberExpression" ? unwrapExpression(node.object) : null;
    if (
      node.type === "MemberExpression" &&
      memberObject?.type === "Identifier" &&
      propertyName(node.property, node.computed) === "accounts" &&
      isContextVariable(bindings.variableOf(memberObject), bindings, contextVariables)
    ) {
      context.report({ node, messageId: "legacyContext" });
    }
    if (
      node.type === "VariableDeclarator" &&
      node.id?.type === "ObjectPattern" &&
      unwrapExpression(node.init)?.type === "Identifier" &&
      isContextVariable(
        bindings.variableOf(unwrapExpression(node.init)),
        bindings,
        contextVariables,
      )
    ) {
      const property = accountsProperty(node.id);
      if (property && !reportedPatterns.has(property)) {
        reportedPatterns.add(property);
        context.report({ node: property, messageId: "legacyContext" });
      }
    }
    if (
      node.type === "AssignmentExpression" &&
      node.left?.type === "ObjectPattern" &&
      unwrapExpression(node.right)?.type === "Identifier" &&
      isContextVariable(
        bindings.variableOf(unwrapExpression(node.right)),
        bindings,
        contextVariables,
      )
    ) {
      const property = accountsProperty(node.left);
      if (property && !reportedPatterns.has(property)) {
        reportedPatterns.add(property);
        context.report({ node: property, messageId: "legacyContext" });
      }
    }
  });
}

export const noLegacyAccountsRule = {
  meta: ruleMeta(
    "Reject legacy account requirements and direct account access from framework contexts.",
  ),
  create(context) {
    return { Program: (program) => noLegacyAccounts(context, program) };
  },
};

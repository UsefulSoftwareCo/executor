const expressionWrappers = new Set([
  "ChainExpression",
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "TSInstantiationExpression",
]);

export const frameworkFunctions = new Set(["defineApp", "mutation", "query", "decodeJson"]);

export function unwrapExpression(node) {
  while (node && expressionWrappers.has(node.type)) node = node.expression;
  return node;
}

export function walkAst(root, visit) {
  const seen = new WeakSet();
  function walk(node) {
    if (!node || typeof node !== "object" || typeof node.type !== "string" || seen.has(node))
      return;
    seen.add(node);
    visit(node);
    for (const [key, value] of Object.entries(node)) {
      if (key === "parent") continue;
      if (Array.isArray(value)) {
        for (const child of value) walk(child);
      } else {
        walk(value);
      }
    }
  }
  walk(root);
}

export function propertyName(key, computed = false) {
  if (!computed && key?.type === "Identifier") return key.name;
  if (["Literal", "StringLiteral"].includes(key?.type) && typeof key.value === "string")
    return key.value;
  if (key?.type === "TemplateLiteral" && key.expressions?.length === 0) {
    return key.quasis?.[0]?.value?.cooked ?? key.quasis?.[0]?.value?.raw;
  }
  return undefined;
}

export function createBindings(context) {
  const sourceCode = context.sourceCode;
  const variableCache = new WeakMap();

  function variableOf(identifier) {
    if (!identifier || identifier.type !== "Identifier") return null;
    if (variableCache.has(identifier)) return variableCache.get(identifier);
    let variable = null;
    try {
      let scope = sourceCode.getScope(identifier);
      while (scope && !variable) {
        variable = scope.set?.get(identifier.name) ?? null;
        scope = scope.upper;
      }
    } catch {
      variable = null;
    }
    variableCache.set(identifier, variable);
    return variable;
  }

  function isUnmodified(variable) {
    if (!variable || !Array.isArray(variable.references)) return false;
    if (variable.references.some((reference) => typeof reference.isWrite !== "function"))
      return false;
    return variable.references.filter((reference) => reference.isWrite()).length <= 1;
  }

  function variableDeclarator(variable) {
    if (!variable || variable.defs?.length !== 1) return null;
    const definition = variable.defs[0];
    const declarator = definition.node;
    const kind = definition.parent?.kind;
    if (definition.type !== "Variable" || !["const", "let", "var"].includes(kind)) return null;
    if (declarator?.type !== "VariableDeclarator" || declarator.id?.type !== "Identifier")
      return null;
    if (declarator.id.name !== variable.name) return null;
    return { declarator, kind };
  }

  function possibleValues(variable) {
    const definition = variableDeclarator(variable);
    if (!definition) return [];
    const values = new Set();
    if (definition.declarator.init) values.add(definition.declarator.init);
    for (const reference of variable.references ?? []) {
      if (reference.isWrite() && reference.writeExpr) values.add(reference.writeExpr);
    }
    return [...values];
  }

  function localInitializer(variable) {
    const values = possibleValues(variable);
    return isUnmodified(variable) && values.length === 1 ? values[0] : null;
  }

  function typeAlias(variable) {
    for (const definition of variable?.defs ?? []) {
      if (definition.node?.type === "TSTypeAliasDeclaration") return definition.node.typeAnnotation;
    }
    return null;
  }

  // Framework identities have one supported source. The plain-bindings rule rejects
  // escaping these imports, so helpers never need a second binding resolver.
  function resolveSymbol(expression) {
    const node = unwrapExpression(expression);
    if (node?.type !== "Identifier") return null;
    const variable = variableOf(node);
    if (variable?.defs?.length !== 1) return null;
    const definition = variable.defs[0];
    if (definition.type !== "ImportBinding" || definition.node?.type !== "ImportSpecifier")
      return null;
    const declaration = definition.parent ?? definition.node.parent;
    if (declaration?.type !== "ImportDeclaration" || declaration.source.value !== "apps")
      return null;
    const imported = propertyName(definition.node.imported);
    const contextType = ["QueryContext", "MutationContext"].includes(imported);
    if (
      (declaration.importKind === "type" || definition.node.importKind === "type") &&
      !contextType
    )
      return null;
    return contextType || frameworkFunctions.has(imported) ? imported : null;
  }

  function resolveFunctionNode(expression, seen = new Set()) {
    const node = unwrapExpression(expression);
    if (["ArrowFunctionExpression", "FunctionExpression"].includes(node?.type)) return node;
    if (node?.type !== "Identifier") return null;
    const variable = variableOf(node);
    if (!variable || seen.has(variable)) return null;
    seen.add(variable);
    const initializer = unwrapExpression(localInitializer(variable));
    if (initializer) return resolveFunctionNode(initializer, seen);
    for (const definition of variable.defs ?? []) {
      if (definition.type === "FunctionName" && definition.node?.type === "FunctionDeclaration") {
        return definition.node;
      }
    }
    return null;
  }

  return {
    variableOf,
    localInitializer,
    typeAlias,
    resolveSymbol,
    resolveFunctionNode,
  };
}

import { createBindings, propertyName, unwrapExpression, walkAst } from "./ast.mjs";

const globalObjects = new Set(["globalThis", "global", "window", "self"]);

function variableValues(variable) {
  const values = [];
  for (const definition of variable?.defs ?? []) {
    if (definition.node?.type === "VariableDeclarator" && definition.node.id?.type === "Identifier")
      values.push(definition.node.init);
  }
  for (const reference of variable?.references ?? []) {
    if (reference.isWrite() && reference.writeExpr) values.push(reference.writeExpr);
  }
  return values;
}

export const noGlobalFetchRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Require context HTTP rather than fetch reached through a global object alias.",
    },
    schema: [],
    messages: {
      globalFetch:
        "HTTP must use ctx.fetch or its destructured value; this fetch comes from a global object.",
    },
  },
  create(context) {
    const bindings = createBindings(context);
    function isGlobalObject(expression, seen = new Set()) {
      const node = unwrapExpression(expression);
      if (node?.type === "Identifier") {
        const variable = bindings.variableOf(node);
        if (globalObjects.has(node.name) && !variable?.defs?.length) return true;
        if (!variable || seen.has(variable)) return false;
        seen.add(variable);
        const result = variableValues(variable).some((value) => isGlobalObject(value, seen));
        seen.delete(variable);
        return result;
      }
      return (
        node?.type === "MemberExpression" &&
        globalObjects.has(propertyName(node.property, node.computed)) &&
        isGlobalObject(node.object, seen)
      );
    }
    function inspectPattern(pattern, expression) {
      if (pattern?.type !== "ObjectPattern" || !isGlobalObject(expression)) return;
      for (const property of pattern.properties ?? []) {
        if (propertyName(property.key, property.computed) === "fetch")
          context.report({ node: property, messageId: "globalFetch" });
      }
    }
    return {
      Program(program) {
        walkAst(program, (node) => {
          if (
            node.type === "MemberExpression" &&
            propertyName(node.property, node.computed) === "fetch" &&
            isGlobalObject(node.object)
          )
            context.report({ node, messageId: "globalFetch" });
          if (node.type === "VariableDeclarator") inspectPattern(node.id, node.init);
          if (node.type === "AssignmentExpression") inspectPattern(node.left, node.right);
        });
      },
    };
  },
};

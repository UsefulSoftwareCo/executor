import {
  createBindings,
  frameworkFunctions,
  propertyName,
  unwrapExpression,
  walkAst,
} from "./ast.mjs";

const contextTypes = new Set(["QueryContext", "MutationContext"]);
const guardedExports = new Set([...frameworkFunctions, ...contextTypes]);

// Inspect each shipped module at its imports. Rejecting escapes here also covers
// consumers of local barrels, default exports and dynamic helper imports, without
// reading another module or inferring what an arbitrary helper returns.
export const plainFrameworkBindingsRule = {
  meta: {
    type: "problem",
    docs: { description: "Keep guarded framework functions as direct named-import calls." },
    schema: [],
    messages: {
      plainBinding:
        "Unsupported framework binding. Use named imports from `apps` and call `defineApp`, `mutation`, `query` and `decodeJson` directly. Do not create local aliases, destructure, re-export or pass these functions. Import `QueryContext` and `MutationContext` directly too; do not re-export these types or their local aliases.",
    },
  },
  create(context) {
    return {
      Program(program) {
        const bindings = createBindings(context);
        let unsupported = null;

        function isContextType(node, seen = new Set()) {
          if (!node) return false;
          if (node.type === "TSParenthesizedType") return isContextType(node.typeAnnotation, seen);
          if (node.type === "TSIntersectionType")
            return node.types.some((part) => isContextType(part, seen));
          const name = node.type === "TSTypeReference" ? node.typeName : node;
          if (name.type !== "Identifier") return false;
          if (contextTypes.has(bindings.resolveSymbol(name))) return true;
          const variable = bindings.variableOf(name);
          if (!variable || seen.has(variable)) return false;
          seen.add(variable);
          return isContextType(bindings.typeAlias(variable), seen);
        }

        function checkImport(node) {
          if (node.source.value !== "apps") return;
          for (const specifier of node.specifiers) {
            if (specifier.type !== "ImportSpecifier") {
              unsupported = specifier;
              return;
            }
            if (node.importKind === "type" || specifier.importKind === "type") continue;
            if (!frameworkFunctions.has(propertyName(specifier.imported))) continue;
            const variable = bindings.variableOf(specifier.local);
            if (!Array.isArray(variable?.references)) {
              unsupported = specifier;
              return;
            }
            for (const reference of variable.references) {
              let value = reference.identifier;
              // A type query observes the signature; it cannot forward the function.
              if (value.parent?.type === "TSTypeQuery") continue;
              while (
                value.parent?.expression === value &&
                unwrapExpression(value.parent) !== value.parent
              )
                value = value.parent;
              const call = value.parent;
              if (
                reference.isWrite() ||
                call?.type !== "CallExpression" ||
                call.callee !== value ||
                call.optional
              ) {
                unsupported = reference.identifier;
                return;
              }
            }
          }
        }

        walkAst(program, (node) => {
          if (unsupported) return;
          if (node.type === "ImportDeclaration") checkImport(node);
          if (node.type === "ExportAllDeclaration" && node.source?.value === "apps")
            unsupported = node;
          if (node.type === "ExportNamedDeclaration" && node.source?.value === "apps") {
            if (node.specifiers.some((item) => guardedExports.has(propertyName(item.local))))
              unsupported = node;
          }
          if (node.type === "ExportNamedDeclaration" && !node.source) {
            if (
              node.specifiers.some((item) => isContextType(item.local)) ||
              (node.declaration?.type === "TSTypeAliasDeclaration" &&
                isContextType(node.declaration.typeAnnotation))
            )
              unsupported = node;
          }
          const source =
            node.type === "ImportExpression"
              ? node.source
              : node.type === "CallExpression" && node.callee.type === "Import"
                ? node.arguments[0]
                : null;
          if (propertyName(unwrapExpression(source), true) === "apps") unsupported = node;
        });
        if (unsupported) context.report({ node: unsupported, messageId: "plainBinding" });
      },
    };
  },
};

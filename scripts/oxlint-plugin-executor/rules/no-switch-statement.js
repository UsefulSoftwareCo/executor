const message =
  "Do not use JavaScript switch statements. Use Effect's Match module (Match.value(...).pipe(Match.tag(...), Match.exhaustive)) for type-safe, exhaustive pattern matching.";

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow switch statements; use Effect's Match module instead.",
    },
  },
  create(context) {
    return {
      SwitchStatement(node) {
        context.report({ node, message });
      },
    };
  },
};

/** Real authored app for the external conformance lane. Deploy through product authorization. */
import { defineApp, mutation, query, router, object, string, privateCanonicalJson } from "apps";

export default defineApp(
  { privateInvocation: true },
  {
    tools: router({
      dispatch: mutation(
        { input: object({ operationId: string(), value: string() }) },
        async (ctx, input) => {
          const principal = ctx.user?.id;
          if (!principal) throw new Error("Authenticated user required");
          const bytes = await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(privateCanonicalJson(input)),
          );
          const digest = Array.from(new Uint8Array(bytes), (n) =>
            n.toString(16).padStart(2, "0"),
          ).join("");
          const prior = ctx.sql.transaction((tx) => {
            const rows = tx
              .exec("SELECT * FROM operations WHERE id = ?", input.operationId)
              .toArray();
            if (rows.length) return rows[0];
            // Unknown is durable BEFORE the private host may enter HTTP. A lost response stays unknown.
            tx.exec(
              "INSERT INTO operations(id, principal, digest, outcome) VALUES (?, ?, ?, 'unknown')",
              input.operationId,
              principal,
              digest,
            );
            return undefined;
          });
          if (prior) {
            if (prior.principal !== principal || prior.digest !== digest)
              throw new Error("Operation binding refused");
            if (prior.outcome !== "observed" || typeof prior.result !== "string")
              throw new Error("Operation unknown; reconcile independently");
            return JSON.parse(prior.result);
          }
          const permit = await ctx.invocation.require(input.operationId);
          const result = await permit.forward("conformance", input);
          ctx.sql.exec(
            "UPDATE operations SET outcome = 'observed', result = ? WHERE id = ? AND principal = ?",
            privateCanonicalJson(result),
            input.operationId,
            principal,
          );
          return result;
        },
      ),
      status: query({ input: object({ operationId: string() }) }, async (ctx, { operationId }) => {
        const row = ctx.sql
          .exec(
            "SELECT id, digest, outcome FROM operations WHERE id = ? AND principal = ?",
            operationId,
            ctx.user?.id ?? "",
          )
          .toArray()[0];
        if (!row) throw new Error("Operation unavailable");
        return row;
      }),
    }),
  },
);

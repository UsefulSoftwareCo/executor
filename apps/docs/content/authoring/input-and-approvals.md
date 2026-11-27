---
title: Input prompts and tool approvals
description: "Ask a person for input mid-tool with ctx.elicit and declare per-tool approval rules with always, never, Approval, withApproval, and withApprovals."
slug: "/build/input-and-approvals"
---

A tool can pause for review or input in two ways: declare an `approval` rule (`always()`, `never()`, or a custom `Approval<Input>` function) to gate execution, or call `ctx.elicit` mid-tool to collect form input. Both work on **Local**, **Self-host**, and **Cloud**.

Add `approval` to each operation that needs a rule, or wrap an imported router with `withApprovals`. Ordinary authorization and validation still apply when a rule is omitted. Query classification and read-only hints do not select an approval policy.

**Prerequisites:** an app you can edit and deploy ([Build an app](/docs/build)) and an MCP client configured for the [approval mode](/docs/mcp-clients#choosing-where-approvals-appear) you want.

**You'll know it worked when…** `deleteArchive` pauses for approval in the dashboard **Tools** tab or MCP, and `issueRefund` pauses for approval and then form input through an interactive MCP connection or CLI session.

## How to use it

Approval declarations and `ctx.elicit` code are identical across **Local**, **Self-host**, and **Cloud**. How an approval request is answered depends on where the tool runs:

- **Dashboard Tools tab:** has its own before-run flow for tool approvals, such as `deleteArchive`.
- **Interactive MCP connections:** handle both before-run approvals and mid-tool `ctx.elicit` forms according to the connection's approval mode (**In your browser**, **Through your agent** (`model`), **Native**, or **Automatic**; see [Choosing where approvals appear](/docs/mcp-clients#choosing-where-approvals-appear)).
- **Per-user schedules (`userCron`, `userInterval`):** can pause for before-run tool approvals on the [Approvals](/docs/approvals) page when configured for **Browser approvals**. The default **Skip approvals** accepts requests and preserves explicit denials.

### 1. Declare approval rules on queries and mutations

Import `always` and `never` from `apps/operations/approval` and set `approval` on an operation:

- `approval: always()` returns `"user-approval"` for every new invocation. Your connection's approval mode or schedule setting determines whether Executor prompts a person, relays the decision through the client, or accepts the request automatically.
- `approval: never()` returns `"approved"` without asking (organization, app, and account access checks, schema validation, and any `ctx.elicit` prompts still apply).
- A custom `Approval<Input>` function `async ({ toolName, toolInput, signal }) => ...` inspects the decoded input and returns `"approved"`, `"denied"`, or `"user-approval"`. An explicit `"denied"` always blocks the call.

### 2. Reuse rules or wrap imported routers

- Share a typed `Approval<Input>` function across operations, or attach a rule to an existing operation with `withApproval(operation, rule)`.
- Attach rules to imported MCP, OpenAPI, or GraphQL routers with `withApprovals(router, (operation, name) => rule)`. The picker receives the operation (`operation.kind` and `toolAnnotations(operation)`) and its relative `name` as the second argument, and returns an `Approval` or `undefined` to keep the operation's existing rule.

### 3. Ask for input mid-tool with `ctx.elicit`

Call `ctx.elicit({ mode: "form", message, requestedSchema })` inside a tool handler to collect missing values or confirmation details mid-call:

- `requestedSchema` is a flat JSON Schema object (`type: "object"`) with `string` (including `enum`, `oneOf`, and `format: "email" | "uri" | "date" | "date-time"`), enumerated `array`, `number`, `integer`, or `boolean` properties.
- Check `response.action`: `"accept"` carries validated values in `response.content`; if someone selects `"decline"` or `"cancel"`, the tool receives that action and your code decides how to finish.
- Catch `ElicitationFailed` (exported from `apps`) when the host supplies no interactive delivery handler.

## Example

Both actions below return simulated results and call no refund or archive service. Save these files in `./review-refunds` (replacing `0.0.1-beta.148` with the `version` reported by `executor apps framework` if your host reports a different release):

```json review-refunds/package.json
{
  "name": "review-refunds",
  "private": true,
  "dependencies": {
    "apps": "0.0.1-beta.148"
  }
}
```

```ts review-refunds/index.ts
import {
  defineApp,
  ElicitationFailed,
  mutation,
  number,
  object,
  router,
  string,
  type Approval,
} from "apps";
import { always } from "apps/operations/approval";

const refundApproval: Approval<{ amountCents: number }> = async ({ toolInput }) =>
  toolInput.amountCents > 10_000 ? "user-approval" : "approved";

const issueRefund = mutation(
  {
    description: "Issue a customer refund",
    input: object({
      orderId: string(),
      amountCents: number(),
    }),
    output: object({ status: string(), reason: string().optional() }),
    approval: refundApproval,
  },
  async ({ elicit }, { orderId, amountCents }) => {
    try {
      const reply = await elicit({
        mode: "form",
        message: `Enter a refund reason for order ${orderId} ($${(amountCents / 100).toFixed(2)}).`,
        requestedSchema: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              title: "Reason",
              enum: ["damaged", "duplicate", "customer_request"],
            },
          },
          required: ["reason"],
        },
      });
      if (reply.action !== "accept") {
        return { status: "cancelled" };
      }
      return { status: "refunded", reason: String(reply.content?.reason ?? "") };
    } catch (error) {
      if (error instanceof ElicitationFailed) {
        return { status: `elicit_failed:${error.reason}` };
      }
      throw error;
    }
  },
);

const deleteArchive = mutation(
  {
    description: "Permanently delete archived records",
    input: object({ archiveId: string() }),
    output: object({ deleted: string() }),
    approval: always(),
  },
  async (_ctx, { archiveId }) => ({ deleted: archiveId }),
);

export default defineApp({}, { tools: router({ issueRefund, deleteArchive }) });
```

Create and deploy `./review-refunds` as **Review Refunds** on **Local** (where the bare Local CLI runs in `model` mode by default when no hosted sign-in is active):

```bash
APP_ID=$(executor apps create --name "Review Refunds" --files ./review-refunds | node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).id')
executor apps deploy --app "$APP_ID" --files ./review-refunds
```

Exercise the approval and mid-tool form flow with `executor call` and `executor resume`:

```bash
APPROVAL_ID=$(executor call 'tools["review-refunds"].issueRefund' --input '{"orderId":"ORDER-TEST","amountCents":20000}' | node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).requestId')
INPUT_ID=$(executor resume "$APPROVAL_ID" --action accept | node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).requestId')
executor resume "$INPUT_ID" --action accept --content '{"reason":"duplicate"}'
```

The first call returns `approval-required`, the first `resume` returns `input-required`, and the second `resume` completes. Check `execution.value.value` for `{"status":"refunded","reason":"duplicate"}`.

Make a fresh `deleteArchive` call and decline it:

```bash
APPROVAL_ID=$(executor call 'tools["review-refunds"].deleteArchive' --input '{"archiveId":"arch-1"}' | node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).requestId')
executor resume "$APPROVAL_ID" --action decline
```

Check `execution.value.error.message` for `ApprovalDenied`. You can also run `deleteArchive` from the dashboard **Tools** tab to see its before-run approval prompt.

## Limits

- **MCP approval expiry:** MCP approval requests expire after 15 minutes.
- **Mid-tool forms:** call `ctx.elicit` before or after a SQL transaction. A `ctx.sql.transaction` callback is synchronous. In **Automatic** mode, approval requests are accepted without a separate Executor prompt, while mid-tool forms still go through the agent.
- **App-wide schedules:** mutations referenced by `appCron` or `appInterval` cannot declare an `approval` rule.
- **Delivery modes and saved versions:** **Automatic** accepts app approval requests without a separate Executor prompt; **Through your agent** (`model`) accepts the decision from the client; **Native** sends forms to the client on `execute` and uses the client-approved path on `call` (Executor cannot verify a client confirmation happened); **In your browser** requires the credential owner's hosted browser session or a paired Local browser. A paused call can resume on its saved, retained version after a new deploy, and Executor rechecks the saved invocation and applicable access.
- **Declined tool approvals:** declining or cancelling a before-run approval prevents the tool call from running. An unhandled tool failure can end the program. Earlier external effects remain in place.
- **Scope of approvals:** the app factory can run before the tool's approval rule. Skill `allowed-tools` metadata grants no permissions. Tool calls still use the connection's authorization and the tool's approval rule.
- **App web UI calls:** a call from an app's own served web page fails if the tool's rule requests approval.

## Related

- [Approvals](/docs/approvals)
- [Tools, routers, and schemas](/docs/build/tools)
- [Import MCP, OpenAPI, and GraphQL](/docs/build/import)
- [Tools and approvals](/docs/concepts/tools-and-approvals)

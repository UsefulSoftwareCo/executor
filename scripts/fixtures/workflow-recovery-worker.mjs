/** The same workflow behavior is exercised against both local engine packages. */
export const recoveryWorker = `
    import { WorkflowEntrypoint } from "cloudflare:workers";
    export class RecoveryProbe extends WorkflowEntrypoint {
      async run(event, step) {
        const id = event.instanceId;
        const record = async (name) => {
          const response = await fetch(this.env.UPSTREAM + "/" + id + "/" + name);
          if (!response.ok) throw new Error("Synthetic retry");
          return response.json();
        };
        const first = await step.do("first", () => record("first"));
        if (id === "complete") return first;
        if (id === "retry" || id === "active") {
          await step.do("work", {
            retries: { limit: 2, delay: "4 seconds", backoff: "constant" },
            timeout: "4 seconds",
          }, () => record("work"));
        } else if (id === "event" || id === "timeout") {
          try {
            await step.waitForEvent("approval", {
              type: "approval", timeout: id === "event" ? "30 seconds" : "4 seconds",
            });
          } catch (error) {
            if (id !== "timeout") throw error;
            await step.do("last", () => record("last"));
            return { first, timeoutMessage: error.message };
          }
        } else if (id === "until") {
          await step.sleepUntil("deadline", event.timestamp.getTime() + 4000);
        } else {
          await step.sleep("sleep", "4 seconds");
        }
        await step.do("last", () => record("last"));
        return first;
      }
    }
    export default {
      async fetch(request, env) {
        const { pathname, searchParams } = new URL(request.url);
        const id = searchParams.get("id");
        if (pathname === "/create") {
          return Response.json({ id: (await env.PROBE.create({ id })).id });
        }
        const run = await env.PROBE.get(id);
        if (pathname === "/pause") await run.pause();
        else if (pathname === "/resume") await run.resume();
        else if (pathname === "/terminate") await run.terminate();
        else if (pathname === "/event") {
          await run.sendEvent({ type: "approval", payload: { approved: true } });
        }
        return Response.json(await run.status());
      }
    };
`;

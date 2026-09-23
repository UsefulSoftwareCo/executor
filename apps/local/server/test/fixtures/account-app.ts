import {
  mutation,
  defineApp,
  defineProvider,
  object,
  secrets,
  string,
  type OperationContext,
  type Infer,
} from "apps";

const service = defineProvider({
  name: "MCP test service",
  auth: {
    apiKey: secrets({ label: "Test key", fields: object({ token: string({ minLength: 1 }) }) }),
  },
});

const slots = { service };
const WaitInput = object({ url: string() });

export default defineApp({ accounts: slots }, async ({ accounts }) => {
  const identity = accounts.service.fields.token === "synthetic-first-key" ? "first" : "second";
  const identify = mutation(
    {
      description: "Identify the selected account without returning its credential",
      input: object({ message: string(), suffix: string().default("!") }),
    },
    async () => ({ account: accounts.service.id, identity }),
  );
  return {
    webhooks: {
      events: {
        account: "service",
        config: object({}),
        state: object({}),
        setup: {
          instructions: "Paste the callback URL into the provider.",
          signingSecret: "executor",
        },
        async handle() {
          return new Response(null, { status: 204 });
        },
      },
    },
    mutations: {
      identify,
      [`${identity}Only`]: identify,
      // Exercise discovery beyond the SDK's first page.
      ...Object.fromEntries(Array.from({ length: 105 }, (_, index) => [`page${index}`, identify])),
      wait: mutation(
        { description: "Wait on a test HTTP service; forward cancellation", input: WaitInput },
        async (context: OperationContext, { url }: Infer<typeof WaitInput>) => {
          const response = await fetch(
            url,
            context.signal === undefined ? {} : { signal: context.signal },
          );
          return { status: response.status };
        },
      ),
    },
  };
});

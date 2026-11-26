import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

const project = 7;
const flagKey = "onboarding-order-v1";

interface Flag {
  id: number;
  key: string;
  active: boolean;
  ensure_experience_continuity: unknown;
  filters: unknown;
}
interface Experiment {
  id: number;
  name: string;
  description: string;
  start_date: string | null;
  end_date: string | null;
  version: number;
  flag: number;
  fields: Record<string, unknown>;
}

const fakePostHog = () => {
  const flags = new Map<number, Flag>();
  const experiments = new Map<number, Experiment>();
  const events = new Set<string>();
  const writes: Array<string> = [];
  let next = 100;
  const view = (experiment: Experiment) => {
    const flag = flags.get(experiment.flag)!;
    return {
      ...experiment.fields,
      id: experiment.id,
      name: experiment.name,
      description: experiment.description,
      start_date: experiment.start_date,
      end_date: experiment.end_date,
      version: experiment.version,
      feature_flag: { id: flag.id, key: flag.key },
    };
  };
  const create = (body: Record<string, unknown>) => {
    const { feature_flag_key, feature_flag, name, description, ...fields } = body;
    const config = feature_flag as { ensure_experience_continuity: unknown; filters: unknown };
    const flag: Flag = { id: next++, key: String(feature_flag_key), active: false, ...config };
    flags.set(flag.id, flag);
    const experiment: Experiment = {
      id: next++,
      name: String(name),
      description: String(description),
      start_date: null,
      end_date: null,
      version: 1,
      flag: flag.id,
      fields,
    };
    experiments.set(experiment.id, experiment);
    return experiment;
  };
  const act = (experiment: Experiment, action: string): string | undefined => {
    const flag = flags.get(experiment.flag)!;
    if (action === "launch") {
      if (experiment.start_date !== null) return "Experiment has already been launched.";
      flag.active = true;
      experiment.start_date = new Date().toISOString();
      return undefined;
    }
    if (experiment.start_date === null) return "Experiment has not been launched yet.";
    if (experiment.end_date !== null) return "Experiment has already ended.";
    if (action === "pause") {
      if (!flag.active) return "Experiment is already paused.";
      flag.active = false;
    } else if (action === "resume") {
      if (flag.active) return "Experiment is not paused.";
      flag.active = true;
    } else if (action === "end") experiment.end_date = new Date().toISOString();
    else return `Unsupported action ${action}`;
    experiment.version += 1;
    return undefined;
  };
  const handle = (
    method: string,
    route: string,
    query: URLSearchParams,
    body: Record<string, unknown>,
  ): readonly [number, unknown] => {
    if (method !== "GET") writes.push(`${method} ${route}`);
    const parts = route.split("/").filter((part) => part !== "");
    const experiment = parts[1] === undefined ? undefined : experiments.get(Number(parts[1]));
    if (parts[0] === "experiments" && parts.length === 1 && method === "GET")
      return [
        200,
        { results: [...experiments.values()].map(view), next: null } satisfies Record<
          string,
          unknown
        >,
      ];
    if (parts[0] === "experiments" && parts.length === 1 && method === "POST")
      return [201, view(create(body))];
    if (parts[0] === "experiments" && experiment !== undefined && parts.length === 2) {
      if (method === "GET") return [200, view(experiment)];
      if (method === "PATCH") {
        if (experiment.start_date !== null) return [400, { detail: "Launched" }];
        const {
          feature_flag_key: _key,
          feature_flag,
          name,
          description,
          version,
          ...fields
        } = body;
        if (version !== experiment.version) return [409, { detail: "Stale version" }];
        Object.assign(flags.get(experiment.flag)!, feature_flag);
        experiment.name = String(name);
        experiment.description = String(description);
        experiment.fields = fields;
        experiment.version += 1;
        return [200, view(experiment)];
      }
    }
    if (
      parts[0] === "experiments" &&
      experiment !== undefined &&
      parts.length === 3 &&
      method === "POST"
    ) {
      const refused = act(experiment, parts[2]!);
      return refused === undefined ? [200, view(experiment)] : [400, { detail: refused }];
    }
    if (parts[0] === "feature_flags" && parts.length === 1 && method === "GET")
      return [
        200,
        {
          results: [...flags.values()].filter((flag) =>
            flag.key.includes(query.get("search") ?? ""),
          ),
        },
      ];
    if (parts[0] === "feature_flags" && parts.length === 2 && method === "GET") {
      const flag = flags.get(Number(parts[1]));
      return flag === undefined ? [404, {}] : [200, flag];
    }
    if (parts[0] === "event_definitions" && method === "GET")
      return [
        200,
        {
          results: [...events]
            .filter((name) => name === query.get("names"))
            .map((name) => ({ name })),
        },
      ];
    if (parts[0] === "event_definitions" && method === "POST") {
      events.add(String(body.name));
      return [201, { name: body.name }];
    }
    return [404, { detail: `No route ${method} ${route}` }];
  };
  const listener = (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://posthog.test");
      const prefix = `/api/projects/${project}/`;
      const text = Buffer.concat(chunks).toString();
      const [status, payload] = url.pathname.startsWith(prefix)
        ? handle(
            request.method ?? "GET",
            url.pathname.slice(prefix.length),
            url.searchParams,
            text === "" ? {} : (JSON.parse(text) as Record<string, unknown>),
          )
        : ([404, {}] as const);
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    });
  };
  const state = () =>
    [...experiments.values()].map((experiment) => ({
      name: experiment.name,
      started: experiment.start_date !== null,
      ended: experiment.end_date !== null,
      flagActive: flags.get(experiment.flag)!.active,
    }));
  return { listener, create, writes, state, experiments, flags };
};

const server = Effect.acquireRelease(
  Effect.callback<{
    readonly origin: string;
    readonly posthog: ReturnType<typeof fakePostHog>;
    readonly close: () => void;
  }>((resume) => {
    const posthog = fakePostHog();
    const listening = createServer(posthog.listener);
    listening.listen(0, "127.0.0.1", () => {
      const { port } = listening.address() as AddressInfo;
      resume(
        Effect.succeed({
          origin: `http://127.0.0.1:${port}`,
          posthog,
          close: () => listening.close(),
        }),
      );
    });
  }),
  ({ close }) => Effect.sync(close),
);

const stack = `import * as Alchemy from "alchemy";
import { retain } from "alchemy/RemovalPolicy";
import { Effect } from "effect";
import { postHogProviderCredentials } from "../../src/infrastructure/posthog-provider.ts";
import {
  onboardingExperimentDefinition,
  PostHogExperiment,
  postHogExperimentProvider,
} from "../../src/infrastructure/posthog-experiment.ts";

const declared = JSON.parse(process.env.DECLARED_EXPERIMENT ?? "null");
export default Alchemy.Stack(
  "posthog-experiment-lifecycle",
  { providers: postHogProviderCredentials(postHogExperimentProvider()), state: Alchemy.localState() },
  Effect.gen(function* () {
    if (declared === null) return {};
    const experiment = yield* PostHogExperiment("Experiment", {
      projectId: ${project},
      definition: { ...onboardingExperimentDefinition, ...declared.definition },
      status: declared.status,
    }).pipe(retain());
    return { id: experiment.id };
  }),
);
`;

type Declared = {
  readonly status: "draft" | "running" | "paused" | "stopped";
  readonly definition?: { readonly name: string };
} | null;

const deployer = (origin: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const parent = path.resolve("apps/hosted/cloud/.local");
    yield* fs.makeDirectory(parent, { recursive: true });
    const dir = yield* fs.makeTempDirectoryScoped({
      directory: parent,
      prefix: "posthog-experiment-",
    });
    yield* fs.writeFileString(path.join(dir, "stack.ts"), stack);
    return (declared: Declared) =>
      Effect.gen(function* () {
        const child = yield* processes.spawn(
          ChildProcess.make(
            "bun",
            [
              "x",
              "--no-install",
              "alchemy",
              "deploy",
              "stack.ts",
              "--stage",
              "e2e-lifecycle",
              "--no-input",
              "--yes",
            ],
            {
              cwd: dir,
              env: {
                CI: "true",
                POSTHOG_HOST: origin,
                POSTHOG_PERSONAL_API_KEY: "phx_synthetic_lifecycle_key",
                DECLARED_EXPERIMENT: JSON.stringify(declared),
              },
              extendEnv: true,
            },
          ),
        );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            child.stdout.pipe(Stream.decodeText(), Stream.mkString),
            child.stderr.pipe(Stream.decodeText(), Stream.mkString),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        return { ok: exitCode === 0, output: `${stdout}\n${stderr}` };
      }).pipe(Effect.scoped);
  });

const applied = (
  deploy: Effect.Success<ReturnType<typeof deployer>>,
  posthog: ReturnType<typeof fakePostHog>,
  declared: Declared,
) =>
  Effect.gen(function* () {
    const before = posthog.writes.length;
    const result = yield* deploy(declared);
    expect(result.ok, result.output).toBe(true);
    return posthog.writes.slice(before);
  });

const refused = (
  deploy: Effect.Success<ReturnType<typeof deployer>>,
  posthog: ReturnType<typeof fakePostHog>,
  declared: Declared,
  message: string,
) =>
  Effect.gen(function* () {
    const before = posthog.writes.length;
    const state = posthog.state();
    const result = yield* deploy(declared);
    expect(result.ok, result.output).toBe(false);
    expect(result.output).toContain(message);
    expect(posthog.writes.slice(before)).toEqual([]);
    expect(posthog.state()).toEqual(state);
  });

layer(NodeServices.layer, { excludeTestServices: true })("PostHog experiment lifecycle", (it) => {
  it.effect(
    "deploys create a draft, launch, pause, resume and end it, and refuse to go back",
    () =>
      Effect.gen(function* () {
        const { origin, posthog } = yield* server;
        const deploy = yield* deployer(origin);
        const name = "Onboarding order: accounts or assistant first";

        const created = yield* applied(deploy, posthog, { status: "draft" });
        expect(created.filter((write) => write.startsWith("POST experiments"))).toEqual([
          "POST experiments/",
        ]);
        expect(posthog.state()).toEqual([
          { name, started: false, ended: false, flagActive: false },
        ]);
        const [id] = posthog.experiments.keys();

        expect(yield* applied(deploy, posthog, { status: "running" })).toEqual([
          `POST experiments/${id}/launch/`,
        ]);
        expect(posthog.state()).toEqual([{ name, started: true, ended: false, flagActive: true }]);

        expect(yield* applied(deploy, posthog, { status: "running" })).toEqual([]);

        yield* refused(
          deploy,
          posthog,
          { status: "running", definition: { name: "Renamed while running" } },
          "Use a new experiment key to change a launched experiment",
        );
        yield* refused(
          deploy,
          posthog,
          { status: "draft" },
          `The ${flagKey} experiment cannot move from running to draft`,
        );

        expect(yield* applied(deploy, posthog, { status: "paused" })).toEqual([
          `POST experiments/${id}/pause/`,
        ]);
        expect(posthog.state()).toEqual([{ name, started: true, ended: false, flagActive: false }]);

        expect(yield* applied(deploy, posthog, { status: "running" })).toEqual([
          `POST experiments/${id}/resume/`,
        ]);
        expect(posthog.state()).toEqual([{ name, started: true, ended: false, flagActive: true }]);

        expect(yield* applied(deploy, posthog, { status: "stopped" })).toEqual([
          `POST experiments/${id}/end/`,
        ]);
        expect(posthog.state()).toEqual([{ name, started: true, ended: true, flagActive: true }]);

        yield* refused(
          deploy,
          posthog,
          { status: "running" },
          `The ${flagKey} experiment cannot move from stopped to running`,
        );

        expect(yield* applied(deploy, posthog, null)).toEqual([]);
        expect(posthog.state()).toEqual([{ name, started: true, ended: true, flagActive: true }]);
      }).pipe(Effect.scoped),
    180_000,
  );

  it.effect(
    "a first deploy declared running creates and launches the experiment",
    () =>
      Effect.gen(function* () {
        const { origin, posthog } = yield* server;
        const deploy = yield* deployer(origin);
        const writes = yield* applied(deploy, posthog, { status: "running" });
        const [id] = posthog.experiments.keys();
        expect(writes.filter((write) => write.startsWith("POST experiments"))).toEqual([
          "POST experiments/",
          `POST experiments/${id}/launch/`,
        ]);
        expect(posthog.state()).toEqual([
          {
            name: "Onboarding order: accounts or assistant first",
            started: true,
            ended: false,
            flagActive: true,
          },
        ]);
      }).pipe(Effect.scoped),
    60_000,
  );

  it.effect(
    "a deploy refuses a draft it cannot launch from, and an experiment it does not own",
    () =>
      Effect.gen(function* () {
        const { origin, posthog } = yield* server;
        const deploy = yield* deployer(origin);
        yield* refused(
          deploy,
          posthog,
          { status: "paused" },
          `The ${flagKey} experiment cannot move from absent to paused`,
        );
        yield* refused(
          deploy,
          posthog,
          { status: "stopped" },
          `The ${flagKey} experiment cannot move from absent to stopped`,
        );
        posthog.create({
          name: "Someone else's experiment",
          description: "Created in PostHog.",
          feature_flag_key: flagKey,
          feature_flag: {
            ensure_experience_continuity: false,
            filters: { groups: [], multivariate: { variants: [] } },
          },
          metrics: [],
          metrics_secondary: [],
          exposure_criteria: { filterTestAccounts: false, multiple_variant_handling: "exclude" },
          only_count_matured_users: false,
        });
        yield* refused(
          deploy,
          posthog,
          { status: "running" },
          `The ${flagKey} experiment is not owned here`,
        );
        expect(posthog.state()[0]).toMatchObject({ started: false, flagActive: false });
      }).pipe(Effect.scoped),
    120_000,
  );
});

/** HTTP adapters call the same native operations as the in-process SDK. */
import { Layer } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ExecutorApi } from "../contracts/http.ts";
import type { Executor } from "../contracts/executor.ts";

/** Mount the SDK contract with one supplied executor; the host provides transport and access control. */
export const executorHandlers = (executor: Executor) =>
  Layer.mergeAll(
    HttpApiBuilder.group(ExecutorApi, "skills", (handlers) =>
      handlers
        .handle("bundle", ({ params, query }) => executor.skills.bundle({ ...params, ...query }))
        .handle("list", ({ params, query }) => executor.skills.list({ ...params, ...query }))
        .handle("read", ({ params, query }) => executor.skills.read({ ...params, ...query })),
    ),
    HttpApiBuilder.group(ExecutorApi, "schedules", (handlers) =>
      handlers
        .handle("definitions", ({ params, query }) =>
          executor.schedules.definitions({ ...params, ...query }),
        )
        .handle("list", ({ params, query }) => executor.schedules.list({ ...params, ...query }))
        .handle("configure", ({ params, payload }) =>
          executor.schedules.configure({ ...params, ...payload }),
        )
        .handle("runNow", ({ params, payload }) =>
          executor.schedules.runNow({ ...params, ...payload }),
        )
        .handle("runs", ({ query }) => executor.schedules.runs(query))
        .handle("approval", ({ params, query }) =>
          executor.schedules.approval({ ...params, ...query }),
        )
        .handle("answer", ({ params, payload }) =>
          executor.schedules.answer({ ...params, ...payload }),
        ),
    ),
    HttpApiBuilder.group(ExecutorApi, "accounts", (handlers) =>
      handlers
        .handle("add", ({ payload }) => executor.accounts.add(payload))
        .handle("update", ({ params, query, payload }) =>
          executor.accounts.update({ ...params, ...query, ...payload }),
        )
        .handle("provider", ({ params, query }) =>
          executor.accounts.provider({ ...params, ...query }),
        )
        .handle("replaceCredentials", ({ params, query, payload }) =>
          executor.accounts.replaceCredentials({ ...params, ...query, ...payload }),
        )
        .handle("remove", ({ params, query }) => executor.accounts.remove({ ...params, ...query }))
        .handle("get", ({ params, query }) => executor.accounts.get({ ...params, ...query }))
        .handle("list", ({ query }) => executor.accounts.list(query)),
    ),
    HttpApiBuilder.group(ExecutorApi, "accountConnections", (handlers) =>
      handlers
        .handle("create", ({ payload }) => executor.accountConnections.create(payload))
        .handle("get", ({ params, query }) =>
          executor.accountConnections.get({ ...params, ...query }),
        )
        .handle("cancel", ({ params, query }) =>
          executor.accountConnections.cancel({ ...params, ...query }),
        )
        .handle("submit", ({ payload }) => executor.accountConnections.submit(payload))
        .handle("oauthSetup", ({ payload }) => executor.accountConnections.oauthSetup(payload))
        .handle("startOAuth", ({ payload }) => executor.accountConnections.startOAuth(payload))
        .handle("completeOAuth", ({ payload }) =>
          executor.accountConnections.completeOAuth(payload),
        ),
    ),
    HttpApiBuilder.group(ExecutorApi, "apps", (handlers) =>
      handlers
        .handle("create", ({ payload }) => executor.apps.create(payload))
        .handle("workspace", ({ params, query }) =>
          executor.apps.workspace({ ...params, ...query }),
        )
        .handle("commit", ({ params, payload }) => executor.apps.commit({ ...params, ...payload }))
        .handle("copy", ({ payload }) => executor.apps.copy(payload))
        .handle("deploy", ({ payload }) => executor.apps.deploy(payload))
        .handle("get", ({ params, query }) => executor.apps.get({ ...params, ...query }))
        .handle("list", ({ query }) => executor.apps.list(query))
        .handle("remove", ({ params, query }) => executor.apps.remove({ ...params, ...query }))
        .handle("rename", ({ params, query, payload }) =>
          executor.apps.rename({ ...params, ...query, ...payload }),
        )
        .handle("update", ({ params, payload }) => executor.apps.update({ ...params, ...payload }))
        .handle("activate", ({ params, query, payload }) =>
          executor.apps.activate({ ...params, ...query, ...payload }),
        )
        .handle("deployments", ({ params, query }) =>
          executor.apps.deployments({ ...params, ...query }),
        )
        .handle("deployment", ({ params, query }) =>
          executor.apps.deployment({ ...params, ...query }),
        )
        .handle("source", ({ params, query }) => executor.apps.source({ ...params, ...query })),
    ),
    HttpApiBuilder.group(ExecutorApi, "owners", (handlers) =>
      handlers.handle("remove", ({ params }) => executor.owners.remove(params)),
    ),
    HttpApiBuilder.group(ExecutorApi, "appWorkflows", (handlers) =>
      handlers.handle("list", ({ params }) => executor.apps.workflows.list(params)),
    ),
    HttpApiBuilder.group(ExecutorApi, "appWorkflowRuns", (handlers) =>
      handlers
        .handle("start", ({ params, payload }) =>
          executor.apps.workflowRuns.start({ ...params, ...payload }),
        )
        .handle("get", ({ params }) => executor.apps.workflowRuns.get(params))
        .handle("list", ({ params, query }) =>
          executor.apps.workflowRuns.list({ ...params, ...query }),
        )
        .handle("terminate", ({ params }) => executor.apps.workflowRuns.terminate(params)),
    ),
    HttpApiBuilder.group(ExecutorApi, "webhooks", (handlers) =>
      handlers
        .handle("get", ({ params }) => executor.webhooks.get(params))
        .handle("confirmRemoval", ({ params }) => executor.webhooks.confirmRemoval(params))
        .handle("definitions", ({ params }) => executor.webhooks.definitions(params))
        .handle("list", ({ params }) => executor.webhooks.list(params))
        .handle("create", ({ params, payload }) =>
          executor.webhooks.create({ ...params, ...payload }),
        )
        .handle("reconcile", ({ params }) => executor.webhooks.reconcile(params))
        .handle("remove", ({ params }) => executor.webhooks.remove(params))
        .handle("deliver", ({ params, payload }) =>
          executor.webhooks.deliver({ ...params, ...payload }),
        ),
    ),
    HttpApiBuilder.group(ExecutorApi, "appData", (handlers) =>
      handlers
        .handle("subscribe", ({ payload }) => executor.appData.subscribe(payload))
        .handle("query", ({ payload }) => executor.appData.query(payload))
        .handle("mutate", ({ payload }) => executor.appData.mutate(payload)),
    ),
    HttpApiBuilder.group(ExecutorApi, "tools", (handlers) =>
      handlers
        .handle("list", ({ query }) => executor.tools.list(query))
        .handle("call", ({ payload }) => executor.tools.call(payload))
        .handle("resume", ({ payload }) => executor.tools.resume(payload))
        .handle("pruneApprovals", ({ payload }) => executor.tools.pruneApprovals(payload)),
    ),
  );

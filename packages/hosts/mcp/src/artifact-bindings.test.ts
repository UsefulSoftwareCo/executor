import { describe, expect, it } from "@effect/vitest";
import { ConnectionName, IntegrationSlug, type ArtifactBinding } from "@executor-js/sdk";

import {
  extractArtifactRoles,
  oldStyleAddressRejection,
  resolveArtifactBindings,
  resolveCallAddress,
  type BindableConnection,
} from "./artifact-bindings";

const connection = (
  integration: string,
  owner: "user" | "org",
  name: string,
): BindableConnection => ({ integration, owner, name });

const binding = (integration: string, owner: "user" | "org", name: string): ArtifactBinding => ({
  integration: IntegrationSlug.make(integration),
  owner,
  connection: ConnectionName.make(name),
});

describe("extractArtifactRoles", () => {
  it("reads the implicit role from a bare integration reference", () => {
    const roles = extractArtifactRoles(
      `function App(){ const q = useQuery(tools.vercel.domains.getDomains.queryOptions({ limit: 100 })); return null; }`,
    );
    expect(roles).toEqual([{ role: "vercel", integration: "vercel" }]);
  });

  it("collapses repeated references to one role", () => {
    const roles = extractArtifactRoles(
      `useQuery(tools.linear.issues.list.queryOptions({}));
       useMutation(tools.linear.issues.create.mutationOptions({}));
       queryClient.invalidateQueries(tools.linear.issues.list.queryFilter({}));`,
    );
    expect(roles).toEqual([{ role: "linear", integration: "linear" }]);
  });

  it("reads explicit roles from the call form, both quote flavours", () => {
    const roles = extractArtifactRoles(
      `useQuery(tools.linear("prod").issues.list.queryOptions({}));
       useQuery(tools.linear('staging').issues.list.queryOptions({}));`,
    );
    expect(roles).toEqual([
      { role: "prod", integration: "linear" },
      { role: "staging", integration: "linear" },
    ]);
  });

  it("mixes implicit and explicit roles across integrations", () => {
    const roles = extractArtifactRoles(
      `useQuery(tools.vercel.domains.getDomains.queryOptions({}));
       useQuery(tools.linear("prod").issues.list.queryOptions({}));
       useQuery(tools.github.issues.list.queryOptions({}));`,
    );
    expect(roles).toEqual([
      { role: "vercel", integration: "vercel" },
      { role: "prod", integration: "linear" },
      { role: "github", integration: "github" },
    ]);
  });

  it("ignores executor's own system tool roots", () => {
    const roles = extractArtifactRoles(
      `tools.search({ query: "x" }); tools.describe.tool({ path: "y" });
       tools.executor.coreTools.connections.list({});
       useQuery(tools.stripe.charges.list.queryOptions({}));`,
    );
    expect(roles).toEqual([{ role: "stripe", integration: "stripe" }]);
  });

  it("ignores references inside comments", () => {
    const roles = extractArtifactRoles(
      `// useQuery(tools.github.issues.list.queryOptions({}))
       /* tools.slack.chat.post */
       useQuery(tools.vercel.domains.getDomains.queryOptions({}));`,
    );
    expect(roles).toEqual([{ role: "vercel", integration: "vercel" }]);
  });

  it("does not read a property access that merely ends in tools", () => {
    expect(extractArtifactRoles(`const x = myTools.github.list();`)).toEqual([]);
    expect(extractArtifactRoles(`const x = a.tools.github.list();`)).toEqual([]);
  });

  it("finds nothing in code that calls no integration", () => {
    expect(extractArtifactRoles(`function App(){ return <div>hi</div>; }`)).toEqual([]);
  });
});

describe("oldStyleAddressRejection", () => {
  it("rejects a user-tier address and explains the short form", () => {
    const message = oldStyleAddressRejection(
      `useQuery(tools.vercel.user.personalVercel.domains.getDomains.queryOptions({}));`,
    );
    expect(message).toContain("tools.vercel.user.");
    expect(message).toContain("tools.vercel.<tool>(args)");
    expect(message).toContain("connections:");
  });

  it("rejects an org-tier address", () => {
    expect(
      oldStyleAddressRejection(`useQuery(tools.inventory.org.main.listItems.queryOptions({}));`),
    ).toContain("tools.inventory.org.");
  });

  it("accepts the short form", () => {
    expect(
      oldStyleAddressRejection(`useQuery(tools.vercel.domains.getDomains.queryOptions({}));`),
    ).toBeNull();
  });

  it("accepts the role form", () => {
    expect(
      oldStyleAddressRejection(`useQuery(tools.linear("prod").issues.list.queryOptions({}));`),
    ).toBeNull();
  });

  it("accepts a tool path whose later segments happen to be user or org", () => {
    expect(
      oldStyleAddressRejection(`useQuery(tools.acme.admin.user.get.queryOptions({}));`),
    ).toBeNull();
  });

  it("ignores an old-style address left in a comment", () => {
    expect(
      oldStyleAddressRejection(`// old: tools.vercel.user.personalVercel.domains.getDomains`),
    ).toBeNull();
  });
});

describe("resolveArtifactBindings", () => {
  it("binds a role silently when the author has exactly one connection", () => {
    const result = resolveArtifactBindings({
      roles: [{ role: "vercel", integration: "vercel" }],
      available: [connection("vercel", "user", "personalVercel")],
    });
    expect(result).toEqual({
      ok: true,
      bindings: { vercel: { integration: "vercel", owner: "user", connection: "personalVercel" } },
    });
  });

  it("infers each integration independently", () => {
    const result = resolveArtifactBindings({
      roles: [
        { role: "vercel", integration: "vercel" },
        { role: "linear", integration: "linear" },
      ],
      available: [
        connection("vercel", "user", "personalVercel"),
        connection("linear", "org", "workspaceLinear"),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bindings.linear).toEqual({
      integration: "linear",
      owner: "org",
      connection: "workspaceLinear",
    });
  });

  it("refuses an ambiguous integration and lists the candidates", () => {
    const result = resolveArtifactBindings({
      roles: [{ role: "linear", integration: "linear" }],
      available: [
        connection("linear", "org", "linearProd"),
        connection("linear", "org", "linearStaging"),
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("linear.org.linearProd");
    expect(result.message).toContain("linear.org.linearStaging");
    expect(result.message).toContain("connections");
  });

  it("refuses when the integration has no connection at all", () => {
    const result = resolveArtifactBindings({
      roles: [{ role: "stripe", integration: "stripe" }],
      available: [connection("vercel", "user", "personalVercel")],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("No stripe connection");
  });

  it("takes a supplied connection over inference", () => {
    const result = resolveArtifactBindings({
      roles: [{ role: "linear", integration: "linear" }],
      connections: { linear: "linear.org.linearStaging" },
      available: [
        connection("linear", "org", "linearProd"),
        connection("linear", "org", "linearStaging"),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bindings.linear).toEqual({
      integration: "linear",
      owner: "org",
      connection: "linearStaging",
    });
  });

  it("accepts a supplied address that carries the tools. prefix", () => {
    const result = resolveArtifactBindings({
      roles: [{ role: "linear", integration: "linear" }],
      connections: { linear: "tools.linear.org.linearProd" },
      available: [connection("linear", "org", "linearProd")],
    });
    expect(result.ok).toBe(true);
  });

  it("binds two roles of one integration to different connections", () => {
    const result = resolveArtifactBindings({
      roles: [
        { role: "prod", integration: "linear" },
        { role: "staging", integration: "linear" },
      ],
      connections: { prod: "linear.org.linearProd", staging: "linear.user.myLinear" },
      available: [
        connection("linear", "org", "linearProd"),
        connection("linear", "user", "myLinear"),
      ],
    });
    expect(result).toEqual({
      ok: true,
      bindings: {
        prod: { integration: "linear", owner: "org", connection: "linearProd" },
        staging: { integration: "linear", owner: "user", connection: "myLinear" },
      },
    });
  });

  it("refuses a connections key that names no role in the code", () => {
    const result = resolveArtifactBindings({
      roles: [{ role: "vercel", integration: "vercel" }],
      connections: { linear: "linear.org.linearProd" },
      available: [connection("vercel", "user", "personalVercel")],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('role "linear"');
    expect(result.message).toContain('"vercel"');
  });

  it("refuses a supplied connection that does not exist, with candidates", () => {
    const result = resolveArtifactBindings({
      roles: [{ role: "linear", integration: "linear" }],
      connections: { linear: "linear.org.gone" },
      available: [connection("linear", "org", "linearProd")],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("linear.org.gone");
    expect(result.message).toContain("linear.org.linearProd");
  });

  it("refuses a supplied connection belonging to another integration", () => {
    const result = resolveArtifactBindings({
      roles: [{ role: "prod", integration: "linear" }],
      connections: { prod: "vercel.user.personalVercel" },
      available: [
        connection("vercel", "user", "personalVercel"),
        connection("linear", "org", "linearProd"),
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("vercel");
  });

  it("refuses a malformed connection address", () => {
    const result = resolveArtifactBindings({
      roles: [{ role: "linear", integration: "linear" }],
      connections: { linear: "linearProd" },
      available: [connection("linear", "org", "linearProd")],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("not a connection address");
  });

  it("refuses one role used for two integrations", () => {
    const result = resolveArtifactBindings({
      roles: [
        { role: "prod", integration: "linear" },
        { role: "prod", integration: "vercel" },
      ],
      available: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("two different integrations");
  });

  it("binds nothing for code that calls no integration", () => {
    expect(resolveArtifactBindings({ roles: [], available: [] })).toEqual({
      ok: true,
      bindings: {},
    });
  });
});

describe("resolveCallAddress", () => {
  const bindings = {
    vercel: binding("vercel", "user", "personalVercel"),
    prod: binding("linear", "org", "linearProd"),
    staging: binding("linear", "user", "myLinear"),
  };

  it("expands a short path through the implicit role", () => {
    const result = resolveCallAddress({
      path: ["vercel", "domains", "getDomains"],
      bindings,
    });
    expect(result).toEqual({
      ok: true,
      path: ["vercel", "user", "personalVercel", "domains", "getDomains"],
    });
  });

  it("routes each explicit role to its own connection", () => {
    expect(
      resolveCallAddress({ path: ["linear", "issues", "list"], role: "prod", bindings }),
    ).toEqual({ ok: true, path: ["linear", "org", "linearProd", "issues", "list"] });
    expect(
      resolveCallAddress({ path: ["linear", "issues", "list"], role: "staging", bindings }),
    ).toEqual({ ok: true, path: ["linear", "user", "myLinear", "issues", "list"] });
  });

  it("passes system tools through untouched", () => {
    expect(resolveCallAddress({ path: ["search"], bindings })).toEqual({
      ok: true,
      path: ["search"],
    });
    expect(resolveCallAddress({ path: ["describe", "tool"], bindings })).toEqual({
      ok: true,
      path: ["describe", "tool"],
    });
  });

  it("fails with binding_unresolved when the role is not bound", () => {
    const result = resolveCallAddress({ path: ["stripe", "charges", "list"], bindings });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("binding_unresolved");
    expect(result.role).toBe("stripe");
    expect(result.integration).toBe("stripe");
    expect(result.message).toContain('"vercel"');
  });

  it("fails when a tagged role was never bound", () => {
    const result = resolveCallAddress({ path: ["linear", "issues", "list"], role: "qa", bindings });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.role).toBe("qa");
  });

  // Grandfather path: artifacts saved before bindings existed stored
  // five-segment paths and carry `bindings: null`.
  it("executes an old five-segment path when the artifact has no bindings", () => {
    expect(
      resolveCallAddress({
        path: ["inventory", "org", "main", "listItems"],
        bindings: null,
      }),
    ).toEqual({ ok: true, path: ["inventory", "org", "main", "listItems"] });
  });

  it("does not grandfather a short path", () => {
    const result = resolveCallAddress({ path: ["vercel", "getDomains"], bindings: null });
    expect(result.ok).toBe(false);
  });

  it("does not grandfather once the artifact has bindings", () => {
    const result = resolveCallAddress({
      path: ["inventory", "org", "main", "listItems"],
      bindings: { vercel: binding("vercel", "user", "personalVercel") },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("binding_unresolved");
  });

  it("does not grandfather a role-tagged call", () => {
    const result = resolveCallAddress({
      path: ["inventory", "org", "main", "listItems"],
      role: "inv",
      bindings: null,
    });
    expect(result.ok).toBe(false);
  });
});

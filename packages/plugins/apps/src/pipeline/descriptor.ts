export const DESCRIPTOR_VERSION = 6 as const;

export interface ModuleSourceRef {
  readonly path: string;
  readonly sourceHash: string;
}

export interface ToolchainRef {
  readonly bundler: {
    readonly name: string;
    readonly version: string;
  };
  readonly executor: {
    readonly name: string;
    readonly version: string;
  };
  readonly target: string;
}

export interface IntegrationDecl {
  readonly slug: string;
  readonly mode: "one" | "many";
  readonly all: boolean;
  readonly description?: string;
}

export interface ToolDescriptor {
  readonly name: string;
  readonly sourcePath: string;
  readonly bundleKey: string;
  readonly source: ModuleSourceRef;
  readonly description: string;
  readonly integrations: Readonly<Record<string, IntegrationDecl>>;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly annotations?: {
    readonly readOnly?: boolean;
    readonly destructive?: boolean;
    readonly requiresApproval?: boolean;
  };
}

export interface DeferredDescriptor {
  readonly path: string;
  readonly reason: "not supported yet";
}

export interface AppDescriptor {
  readonly version: typeof DESCRIPTOR_VERSION;
  readonly app: string;
  readonly sourceRef: string;
  readonly descriptorKey: string;
  readonly publishedAt: number;
  readonly toolchain: ToolchainRef;
  readonly tools: readonly ToolDescriptor[];
  readonly workflows: readonly DeferredDescriptor[];
  readonly ui: readonly DeferredDescriptor[];
  readonly skills: readonly DeferredDescriptor[];
  readonly skipped: readonly DeferredDescriptor[];
}

export const stableStringify = (value: unknown): string => {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v)) return "[Circular]";
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>).sort()) {
      const inner = (v as Record<string, unknown>)[key];
      if (inner !== undefined) out[key] = walk(inner);
    }
    return out;
  };
  return JSON.stringify(walk(value));
};

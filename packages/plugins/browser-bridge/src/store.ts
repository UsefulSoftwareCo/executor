/**
 * In-process reverse browser-bridge sessions.
 *
 * Extension (path B) opens a session and long-polls for jobs.
 * Agents enqueue tools via plugin tools or POST /call and wait for results.
 */

export type BridgeJob = {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  createdAt: number;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  delivered: boolean;
};

export type BridgeSession = {
  id: string;
  userId: string;
  organizationId?: string;
  kind: string;
  transport: string;
  client?: Record<string, unknown>;
  capabilities?: unknown;
  connection?: Record<string, unknown>;
  createdAt: number;
  lastSeenAt: number;
  /** Jobs waiting to be picked up by the extension */
  pending: BridgeJob[];
  /** Jobs delivered, waiting for result */
  inflight: Map<string, BridgeJob>;
  /** Waiters blocked on empty queue (long-poll) */
  waiters: Array<{
    resolve: (jobs: BridgeJob[]) => void;
    timer: ReturnType<typeof setTimeout>;
  }>;
};

const SESSION_TTL_MS = 15 * 60 * 1000;
const DEFAULT_CALL_TIMEOUT_MS = 45_000;

const sessions = new Map<string, BridgeSession>();

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function touch(session: BridgeSession): void {
  session.lastSeenAt = Date.now();
}

function gc(): void {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastSeenAt > SESSION_TTL_MS) {
      for (const j of s.pending) j.reject(new Error("session expired"));
      for (const j of s.inflight.values()) j.reject(new Error("session expired"));
      for (const w of s.waiters) {
        clearTimeout(w.timer);
        w.resolve([]);
      }
      sessions.delete(id);
    }
  }
}

export type CreateSessionInput = {
  userId: string;
  organizationId?: string;
  kind?: string;
  transport?: string;
  client?: Record<string, unknown>;
  capabilities?: unknown;
  connection?: Record<string, unknown>;
};

export function createSession(input: CreateSessionInput): BridgeSession {
  gc();
  // One live desktop session per user (replace prior)
  for (const [id, s] of sessions) {
    if (s.userId === input.userId) {
      for (const j of s.pending) j.reject(new Error("session replaced"));
      for (const j of s.inflight.values()) j.reject(new Error("session replaced"));
      for (const w of s.waiters) {
        clearTimeout(w.timer);
        w.resolve([]);
      }
      sessions.delete(id);
    }
  }

  const session: BridgeSession = {
    id: newId("bbs"),
    userId: input.userId,
    organizationId: input.organizationId,
    kind: input.kind || "chrome-extension",
    transport: input.transport || "reverse-longpoll",
    client: input.client,
    capabilities: input.capabilities,
    connection: input.connection,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    pending: [],
    inflight: new Map(),
    waiters: [],
  };
  sessions.set(session.id, session);
  return session;
}

export function getSession(id: string): BridgeSession | undefined {
  gc();
  const s = sessions.get(id);
  if (s) touch(s);
  return s;
}

export function listSessionsForUser(userId: string): BridgeSession[] {
  gc();
  return [...sessions.values()].filter((s) => s.userId === userId);
}

export function deleteSession(id: string, userId?: string): boolean {
  const s = sessions.get(id);
  if (!s) return false;
  if (userId && s.userId !== userId) return false;
  for (const j of s.pending) j.reject(new Error("session closed"));
  for (const j of s.inflight.values()) j.reject(new Error("session closed"));
  for (const w of s.waiters) {
    clearTimeout(w.timer);
    w.resolve([]);
  }
  sessions.delete(id);
  return true;
}

/** Extension long-poll: wait up to waitMs for jobs. */
export function takeJobs(
  sessionId: string,
  userId: string,
  waitMs = 25_000,
): Promise<Array<{ id: string; tool: string; args: Record<string, unknown> }>> {
  const s = getSession(sessionId);
  if (!s || s.userId !== userId) {
    return Promise.reject(new Error("session not found"));
  }
  touch(s);

  if (s.pending.length > 0) {
    return Promise.resolve(drainPending(s));
  }

  const ms = Math.min(Math.max(waitMs, 0), 30_000);
  if (ms === 0) return Promise.resolve([]);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      s.waiters = s.waiters.filter((w) => w.resolve !== resolveJobs);
      resolve([]);
    }, ms);

    const resolveJobs = (jobs: BridgeJob[]) => {
      clearTimeout(timer);
      // jobs already moved to inflight by notifyWaiters or drain
      resolve(
        jobs.map((j) => ({
          id: j.id,
          tool: j.tool,
          args: j.args,
        })),
      );
    };

    s.waiters.push({ resolve: resolveJobs, timer });
  });
}

function drainPending(
  s: BridgeSession,
): Array<{ id: string; tool: string; args: Record<string, unknown> }> {
  const batch = s.pending.splice(0, s.pending.length);
  for (const j of batch) {
    j.delivered = true;
    s.inflight.set(j.id, j);
  }
  return batch.map((j) => ({ id: j.id, tool: j.tool, args: j.args }));
}

function notifyWaiters(s: BridgeSession): void {
  if (s.waiters.length === 0 || s.pending.length === 0) return;
  const waiter = s.waiters.shift();
  if (!waiter) return;
  clearTimeout(waiter.timer);
  const jobs = s.pending.splice(0, s.pending.length);
  for (const j of jobs) {
    j.delivered = true;
    s.inflight.set(j.id, j);
  }
  waiter.resolve(jobs);
}

export function postResult(
  sessionId: string,
  userId: string,
  jobId: string,
  result: unknown,
): boolean {
  const s = getSession(sessionId);
  if (!s || s.userId !== userId) return false;
  touch(s);
  const job = s.inflight.get(jobId);
  if (!job) {
    // maybe still pending (race)
    const idx = s.pending.findIndex((j) => j.id === jobId);
    if (idx >= 0) {
      const j = s.pending.splice(idx, 1)[0]!;
      j.resolve(result);
      return true;
    }
    return false;
  }
  s.inflight.delete(jobId);
  job.resolve(result);
  return true;
}

export type CallToolInput = {
  userId: string;
  sessionId?: string;
  tool: string;
  args?: Record<string, unknown>;
  timeoutMs?: number;
};

/** Agent path: enqueue tool, wait for extension result. */
export function callTool(input: CallToolInput): Promise<unknown> {
  gc();
  let s: BridgeSession | undefined;
  if (input.sessionId) {
    s = getSession(input.sessionId);
    if (s && s.userId !== input.userId) s = undefined;
  } else {
    s = listSessionsForUser(input.userId)[0];
  }
  if (!s) {
    return Promise.reject(
      new Error(
        "No live browser bridge session. Open Executor Browser extension → Connect (path B reverse).",
      ),
    );
  }
  touch(s);

  const timeoutMs = input.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const jobId = newId("job");

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      s!.pending = s!.pending.filter((j) => j.id !== jobId);
      s!.inflight.delete(jobId);
      reject(new Error(`browser tool timeout after ${timeoutMs}ms (${input.tool})`));
    }, timeoutMs);

    const job: BridgeJob = {
      id: jobId,
      tool: input.tool,
      args: input.args || {},
      createdAt: Date.now(),
      delivered: false,
      resolve: (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    };

    s!.pending.push(job);
    notifyWaiters(s!);
  });
}

export function sessionPublicView(s: BridgeSession) {
  return {
    sessionId: s.id,
    kind: s.kind,
    transport: s.transport,
    createdAt: s.createdAt,
    lastSeenAt: s.lastSeenAt,
    pending: s.pending.length,
    inflight: s.inflight.size,
    client: s.client,
    capabilities: s.capabilities,
  };
}

/** Test helper */
export function _resetStoreForTests(): void {
  for (const id of [...sessions.keys()]) deleteSession(id);
}

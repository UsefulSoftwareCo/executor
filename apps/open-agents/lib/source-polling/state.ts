import "server-only";

import type Redis from "ioredis";
import { createRedisClient, isRedisConfigured } from "@/lib/redis";

const SOURCE_POLLING_KEY_PREFIX = "open-agents:source-polling";

let redisClient: Redis | null = null;

function getRedisClient(): Redis {
  redisClient ??= createRedisClient("source-polling");
  return redisClient;
}

function sourcePollingKey(...parts: string[]): string {
  return [SOURCE_POLLING_KEY_PREFIX, ...parts.map(encodeURIComponent)].join(
    ":",
  );
}

export function isSourcePollingStateConfigured(): boolean {
  return isRedisConfigured();
}

export async function claimSourcePollingLease(
  runId: string,
  ttlMs: number,
): Promise<boolean> {
  const result = await getRedisClient().set(
    sourcePollingKey("lease"),
    runId,
    "PX",
    ttlMs,
    "NX",
  );
  return result === "OK";
}

export async function refreshSourcePollingLease(
  runId: string,
  ttlMs: number,
): Promise<boolean> {
  const client = getRedisClient();
  const result = await client.eval(
    `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("PEXPIRE", KEYS[1], ARGV[2])
      end
      return 0
    `,
    1,
    sourcePollingKey("lease"),
    runId,
    String(ttlMs),
  );
  return result === 1;
}

export async function clearSourcePollingLease(runId: string): Promise<void> {
  const client = getRedisClient();
  await client.eval(
    `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
      end
      return 0
    `,
    1,
    sourcePollingKey("lease"),
    runId,
  );
}

export async function getSourcePollingState<TState>(
  source: string,
): Promise<TState | null> {
  const raw = await getRedisClient().get(sourcePollingKey("source", source));
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as TState;
  } catch {
    return null;
  }
}

export async function setSourcePollingState<TState>(
  source: string,
  state: TState,
): Promise<void> {
  await getRedisClient().set(
    sourcePollingKey("source", source),
    JSON.stringify(state),
  );
}

export async function hasSourcePollingItemProcessed(params: {
  source: string;
  itemKey: string;
  marker: string;
}): Promise<boolean> {
  const exists = await getRedisClient().exists(
    sourcePollingKey("processed", params.source, params.itemKey, params.marker),
  );
  return exists > 0;
}

export async function markSourcePollingItemProcessed(params: {
  source: string;
  itemKey: string;
  marker: string;
  ttlMs: number;
}): Promise<boolean> {
  const result = await getRedisClient().set(
    sourcePollingKey("processed", params.source, params.itemKey, params.marker),
    "1",
    "PX",
    params.ttlMs,
    "NX",
  );
  return result === "OK";
}

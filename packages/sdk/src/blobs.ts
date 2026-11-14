/** Binary storage contracts and an explicit ephemeral adapter. */
export * from "./contracts/blobs.ts";
export { memoryBlobStore } from "./implementation/memory-blobs.ts";
/** Streaming helpers for host blob adapters. */
export {
  bufferedBody,
  pageOf,
  rangeWindow,
  removeEach,
  windowed,
} from "./implementation/blob-streams.ts";

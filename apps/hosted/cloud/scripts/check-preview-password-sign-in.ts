import assert from "node:assert/strict";
import { previewEmailAndPassword } from "../src/infrastructure/stage.ts";

const disabled = { enabled: false } as const;
const enabled = { enabled: true, disableSignUp: true } as const;

assert.deepEqual(previewEmailAndPassword("v2", true), disabled);
assert.deepEqual(previewEmailAndPassword("test-preview-123", true), enabled);
assert.deepEqual(previewEmailAndPassword("test-preview-123", false), disabled);
assert.deepEqual(previewEmailAndPassword("staging", true), disabled);
assert.deepEqual(previewEmailAndPassword(undefined, true), disabled);

console.log("Preview password sign-in stays off outside opted-in test stages.");

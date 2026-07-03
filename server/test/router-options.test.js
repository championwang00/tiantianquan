import assert from "node:assert/strict";
import test from "node:test";
import { __testHooks } from "../src/router.js";

test("normalizes legacy candidateId and scalar candidateIds", () => {
  assert.deepEqual(__testHooks.normalizeCandidateIds({ candidateId: "legacy" }), ["legacy"]);
  assert.deepEqual(__testHooks.normalizeCandidateIds({ candidateIds: "scalar" }), ["scalar"]);
  assert.deepEqual(__testHooks.normalizeCandidateIds({ candidateIds: ["a", 2, "b"] }), ["a", "b"]);
});

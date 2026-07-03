import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSourceUrl } from "../src/utils/webpage.js";

test("removes known tracking parameters from a source URL", () => {
  assert.equal(
    normalizeSourceUrl("https://pangram.com/blog/arrows?ref=sidebar&utm_source=x"),
    "https://pangram.com/blog/arrows"
  );
});

test("retains functional and unknown source URL parameters", () => {
  assert.equal(
    normalizeSourceUrl("https://example.com/search?q=arrows&page=2"),
    "https://example.com/search?q=arrows&page=2"
  );
});

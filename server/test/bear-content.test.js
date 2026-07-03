import assert from "node:assert/strict";
import test from "node:test";
import { __resetBearTestHooks, __setBearTestHooks, __testBuildBearDraftParts, confirmBearWrite } from "../src/adapters/bear.js";

test.afterEach(() => __resetBearTestHooks());

test("places structured article markdown before description and summary", () => {
  const payload = {
    url: "https://example.com/story",
    title: "Pangram",
    pageMeta: { description: "Publisher description" },
    pageContent: { articleHtml: "<article><h2>Actual body</h2><p>The quick brown fox.</p></article>" }
  };
  const draft = __testBuildBearDraftParts(payload, { summary: "Generated summary" }, null).full;

  assert.match(draft, /## Actual body/);
  assert.ok(draft.indexOf("## Actual body") < draft.indexOf("Publisher description"));
  assert.ok(draft.indexOf("Publisher description") < draft.indexOf("Generated summary"));
});

test("materializes selected candidates in candidate order and writes all into one note", async () => {
  const events = [];
  __setBearTestHooks({
    resolveCandidate: async (candidate) => ({ filePath: `/tmp/${candidate.id}`, filename: `${candidate.id}.jpg`, label: candidate.id }),
    append: async (text) => events.push(["append", text]),
    addFile: async (_path, filename) => events.push(["file", filename]),
    indent: async () => {},
    wait: async () => {},
    verify: async () => ({ count: 1, imageRefCount: 2 })
  });
  const task = bearTask([candidate("first"), candidate("second"), candidate("third")]);

  const result = await confirmBearWrite(task, { candidateIds: ["third", "first"], includeScreenshot: true });

  assert.deepEqual(events.filter(([kind]) => kind === "file").map(([, value]) => value), ["first.jpg", "third.jpg"]);
  assert.equal(events.filter(([kind]) => kind === "append").length, 2);
  assert.equal(result.status, "success");
  assert.equal(result.succeeded, 2);
  assert.equal(result.failed, 0);
  assert.deepEqual(result.items.map((item) => item.id), ["first", "third"]);
});

test("continues after one attachment fails and reports per-item outcome", async () => {
  const files = [];
  __setBearTestHooks({
    resolveCandidate: async (candidate) => {
      if (candidate.id === "bad") throw new Error("download failed");
      return { filePath: `/tmp/${candidate.id}`, filename: `${candidate.id}.jpg` };
    },
    append: async () => {}, addFile: async (_path, filename) => files.push(filename), indent: async () => {}, wait: async () => {},
    verify: async () => ({ count: 1, imageRefCount: 1 })
  });
  const task = bearTask([candidate("good"), candidate("bad")]);

  const result = await confirmBearWrite(task, { candidateIds: ["bad", "good"] });

  assert.deepEqual(files, ["good.jpg"]);
  assert.equal(result.status, "success");
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.items.map(({ id, status }) => [id, status]), [["good", "success"], ["bad", "failed"]]);
});

function candidate(id) { return { id, kind: "asset-url", assetUrl: `https://example.com/${id}.jpg`, selected: true }; }
function bearTask(candidates) {
  const payload = { url: "https://example.com/story", title: "Story", pageMeta: {}, pageContent: {} };
  const metadata = { summary: "Summary" };
  return { payload, results: { bear: { draft: "draft", draftNoScreenshot: "draft", metadata, writePlan: { metadata, candidates } } } };
}

import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import test from 'node:test';

test('the queue preserves unverified status and does not dispatch the same task twice', async () => {
  const records = [];
  const noop = async () => {};
  const context = vm.createContext({
    fs: {mkdir: noop, appendFile: async (_file, content) => records.push(JSON.parse(content))},
    os: {homedir: () => '/tmp/isolated-queue'}, path,
    runEagleAdapter: noop, runBearAdapter: noop, runObsidianAdapter: noop,
    formatDateInShanghai: () => '2026-11-08', nowStampForId: () => 'test'
  });
  const source = fs.readFileSync(new URL('../src/queue.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
  vm.runInContext(source, context);
  const task = await context.createTask({url:'https://example.com/note', targets:['bear']});
  let writes = 0;
  const writer = async () => { writes += 1; return {status:'unverified', reason:'Check Bear'}; };
  const first = await context.confirmTaskTarget(task.id, 'bear', writer);
  assert.equal(first.status, 'unverified');
  const second = await context.confirmTaskTarget(task.id, 'bear', writer);
  assert.equal(second.results.bear.status, 'unverified');
  assert.equal(writes, 1);
  assert.equal(records.at(-1).status, 'unverified');
});

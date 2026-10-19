import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { parseHTML } from 'linkedom';

function popup() {
  const html = fs.readFileSync(new URL('../../extension/popup.html', import.meta.url), 'utf8');
  const source = fs.readFileSync(new URL('../../extension/popup.js', import.meta.url), 'utf8').replace('init();', '');
  const { document } = parseHTML(html);
  const frames = [];
  document.scrollingElement = document.documentElement;
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
  const context = vm.createContext({ document, console, Set, Map, confirmObsidian: () => {}, requestAnimationFrame: (fn) => frames.push(fn), window: { innerHeight: 600, scrollY: 0, scrollTo(_x, y) { document.documentElement.scrollTop = y; } } });
  vm.runInContext(source, context);
  return { document, frames, run: (js) => vm.runInContext(js, context) };
}

test('Bear toggle preserves selected images and the visible grid without preparing a new task', () => {
  const { document, run } = popup();
  run(`persistCurrentOptions = () => {}; refreshIfOpen = () => { throw Error('unexpected prepare'); };
    currentTasks.bear = { id: 'task1', results: { bear: { status: 'needs_review', candidates: [{id:'one',selected:true},{id:'two'}] } } };
    syncCandidatesFromResult('bear', currentTasks.bear.results.bear);
    renderTargetCandidates('bear', currentTasks.bear.results.bear);`);
  const grid = document.querySelector('[data-target="bear"] .candidate-grid');
  document.querySelector('#bearScreenshotToggle').checked = false;
  run('handleBearMediaToggleChange()');
  assert.equal(run('selectedBearCandidateIds.join()'), 'one');
  assert.equal(document.querySelector('[data-target="bear"] .candidate-grid'), grid);
  assert.equal(run('getBearCandidateIds().length'), 0);
  document.querySelector('#bearScreenshotToggle').checked = true;
  run('handleBearMediaToggleChange()');
  assert.equal(run('getBearCandidateIds().join()'), 'one');
});

test('cleared Bear selection stays empty when the same task is rendered again', () => {
  const { run } = popup();
  run(`currentTasks.bear = {id:'task1'}; const result = {status:'needs_review', candidates:[{id:'one',selected:true}]};
    syncCandidatesFromResult('bear', result); selectedBearCandidateIds = [];
    syncCandidatesFromResult('bear', result);`);
  assert.equal(run('getSelectedCandidateIds("bear").length'), 0);
  assert.equal(run('selectedBearCandidateIds.length'), 0);
});

test('scroll preservation respects an explicit zero and never replays stale positions in later frames', () => {
  const { document, frames, run } = popup();
  run('lastScrollTop = 220; withScrollPreserved(() => {})');
  assert.equal(document.documentElement.scrollTop, 0);
  document.documentElement.scrollTop = 80;
  while (frames.length) frames.shift()();
  assert.equal(document.documentElement.scrollTop, 80);
});

test('Bear requires a selection only when writing media, even when discovery found nothing', () => {
  const { document, run } = popup();
  run(`currentTasks.bear = {id:'task1', results:{bear:{status:'needs_review',candidates:[]}}}; setCardConfirmState('bear');`);
  const button = document.querySelector('[data-target="bear"] [data-role="confirm"]');
  assert.equal(button.disabled, true);
  assert.match(document.querySelector('[data-role="selection-hint"]').textContent, /至少选择/);
  document.querySelector('#bearScreenshotToggle').checked = false;
  run('setCardConfirmState("bear")');
  assert.equal(button.disabled, false);
  assert.equal(document.querySelector('[data-role="selection-hint"]').textContent, '');
});

test('repeated clicks update the same media button without stale selection state', () => {
  const { document, run } = popup();
  run(`currentTasks.bear = {id:'task1', results:{bear:{status:'needs_review', candidates:[{id:'one',selected:true}]}}};
    syncCandidatesFromResult('bear', currentTasks.bear.results.bear); renderTargetCandidates('bear',currentTasks.bear.results.bear);`);
  const button = document.querySelector('[data-candidate-id="one"]');
  button.click();
  assert.equal(run('selectedBearCandidateIds.length'), 0);
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  button.click();
  assert.equal(run('selectedBearCandidateIds.join()'), 'one');
  assert.equal(document.querySelector('[data-candidate-id="one"]'), button);
  assert.equal(button.getAttribute('aria-pressed'), 'true');
});

test('Bear discovers screenshots and page images even when media writing starts off', async () => {
  const { document, run } = popup();
  document.querySelector('#bearScreenshotToggle').checked = false;
  run(`activeTab = {id:1,url:'https://example.com/article',title:'Article'};
    withTimeout = (promise) => promise;
    captureVisibleTabSafely = async () => 'data:image/jpeg;base64,preview';
    collectPageContext = async (_tab, options) => ({capture:{title:'Article'},meta:{},content:{},assets:{deep:options.deepAssets}});
    verifyPageCapture = async () => {};`);
  const payload = await run('buildPayload("bear")');
  assert.equal(payload.screenshotDataUrl, 'data:image/jpeg;base64,preview');
  assert.equal(payload.pageAssets.deep, true);
  assert.equal(payload.options.bear.noScreenshot, true);
});

test('reopening a prepared channel keeps its preview and selections instead of starting over', () => {
  const { run } = popup();
  run(`currentTasks.bear = {id:'task1',results:{bear:{status:'needs_review',candidates:[]}}};
    prepareTarget = () => { throw Error('prepared channel should not be regenerated'); };`);
  assert.doesNotThrow(() => run('toggleCard("bear")'));
});

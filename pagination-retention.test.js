'use strict';

const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const process = require('node:process');
const test = require('node:test');
const {setImmediate} = require('node:timers/promises');

const refreshes = 64;

async function refreshPages(hubkitPath) {
  const Hubkit = require(hubkitPath);
  const hubkit = new Hubkit({allPages: false, autoQueryRateLimit: false});
  const pages = [], tasks = [];
  let firstPageResponses = 0, finalPageResponses = 0;
  globalThis.fetch = async url => {
    const headers = {'cache-control': 'max-age=60'};
    if (url.searchParams.has('page')) {
      finalPageResponses++;
      return globalThis.Response.json([{last: true}], {headers});
    }
    headers.link = '<https://api.github.com/pages?page=2>; rel="next"';
    return globalThis.Response.json([{version: ++firstPageResponses}], {headers});
  };

  for (let i = 0; i < refreshes; i++) {
    const task = {sends: 0};
    const scoped = hubkit.scope({event: task, onSend: () => {task.sends++;}});
    const page = await scoped.request('/pages', {fresh: true});
    assert.equal(page[0].version, i + 1);
    pages.push(new WeakRef(page[0]));
    tasks.push(new WeakRef(task));
    const last = await page.next();
    assert.equal(last[0].last, true);
    assert.equal(task.sends, 2);
  }

  return {firstPageResponses, finalPageResponses, cache: hubkit.defaultOptions.cache, pages, tasks};
}

async function measureRetention(hubkitPath) {
  const {firstPageResponses, finalPageResponses, cache, pages, tasks} =
    await refreshPages(hubkitPath);

  // Move past the turn that created the last WeakRefs before forcing collection.
  await setImmediate();
  globalThis.gc();
  await setImmediate();
  globalThis.gc();

  process.stdout.write(`${JSON.stringify({
    firstPageResponses, finalPageResponses, cacheEntries: cache.size,
    retainedFirstPagePayloads: pages.filter(ref => ref.deref()).length,
    retainedTasks: tasks.filter(ref => ref.deref()).length
  })}\n`);
}

if (process.argv[2] === '--measure-retention') {
  measureRetention(process.argv[3]);
} else {
  test('refreshing cached manual REST pages releases obsolete payloads and tasks', () => {
    const output = execFileSync(process.execPath, [
      '--expose-gc', require.resolve('./pagination-retention.test.js'),
      '--measure-retention', require.resolve('./index.js')
    ], {encoding: 'utf8'});
    assert.deepEqual(JSON.parse(output), {
      firstPageResponses: refreshes, finalPageResponses: refreshes, cacheEntries: 2,
      retainedFirstPagePayloads: 1, retainedTasks: 0
    });
  });
}

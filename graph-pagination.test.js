'use strict';
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const query = `query($after: String) {
  viewer { issues(first: 1, after: $after) { nodes { number } pageInfo { hasNextPage endCursor } } }
}`;

function buildPage(nodes, endCursor, errors) {
  const body = {data: {viewer: {issues: {nodes, pageInfo: {
    hasNextPage: !!endCursor, endCursor: endCursor ?? null
  }}}}};
  if (errors) body.errors = errors;
  return body;
}

function createHubkit(pages) {
  const cursors = [];
  const browser = {
    self: {}, lrucache: require('lru-cache'), URL, AbortController, DOMException,
    setTimeout, clearTimeout,
    fetch: async (url, init) => {
      const {after} = JSON.parse(init.body).variables || {};
      cursors.push(after);
      return new globalThis.Response(JSON.stringify(pages[cursors.length - 1]), {
        status: 200, headers: {'content-type': 'application/json'}
      });
    }
  };
  vm.runInNewContext(readFileSync(require.resolve('./hubkit.js'), 'utf8'), browser);
  return {Hubkit: browser.self.Hubkit, cursors};
}

const forbidden = [{type: 'FORBIDDEN', message: 'Resource not accessible', path: ['viewer']}];

for (const [name, pages, numbers] of [
  ['a later page', [
    buildPage([{number: 1}], 'c1'),
    buildPage([null], 'c2', forbidden),
    buildPage([{number: 3}])
  ], [1, null, 3]],
  ['the first page', [
    buildPage([null], 'c1', forbidden),
    buildPage([{number: 2}])
  ], [null, 2]]
]) {
  for (const [recovery, recover] of [
    ['the data itself', error => error.data],
    ['a copy of the data', error => JSON.parse(JSON.stringify(error.data))]
  ]) {
    test(`${recovery} recovered on ${name} keeps paginating`, async () => {
      const {Hubkit, cursors} = createHubkit(pages);
      let errors = 0;
      const result = await new Hubkit().graph(query, {
        onError: error => {
          errors++;
          return recover(error);
        }
      });
      assert.equal(errors, 1);
      assert.deepEqual(cursors, [undefined, 'c1', 'c2'].slice(0, pages.length));
      assert.deepEqual([...result.viewer.issues.nodes].map(node => node && node.number), numbers);
      assert.equal(result.viewer.issues.pageInfo, undefined);
      assert.equal(result.next, undefined);
    });
  }
}

test('a value that is not a page resolves the paginated query after one more onError', async () => {
  const {Hubkit, cursors} = createHubkit([
    buildPage([{number: 1}], 'c1'),
    buildPage([null], 'c2', forbidden),
    buildPage([{number: 3}])
  ]);
  const errors = [];
  const result = await new Hubkit().graph(query, {
    onError: error => {
      errors.push(error);
      return 'recovered';
    }
  });
  assert.equal(result, 'recovered');
  assert.deepEqual(cursors, [undefined, 'c1']);
  assert.equal(errors.length, 2);
  assert.ok('data' in errors[0]);
  assert.ok(!('data' in errors[1]));
  assert.match(errors[1].message, /unable to concatenate paged results/);
});

test('partial GraphQL data with an incompatible shape is reported to onError', async () => {
  const {Hubkit} = createHubkit([
    buildPage([{number: 1}], 'c1'),
    {data: {viewer: null}, errors: forbidden}
  ]);
  const messages = [];
  await assert.rejects(new Hubkit().graph(query, {
    onError: error => {
      messages.push(error.message);
      return error.data ?? Hubkit.DONT_RETRY;
    }
  }), /unable to concatenate paged results/);
  assert.equal(messages.length, 2);
});

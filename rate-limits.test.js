'use strict';

const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const NOW = 1_800_000_000_000;

function quotaHeaders(resource = 'core', remaining = 4500) {
  return {
    'x-ratelimit-resource': resource, 'x-ratelimit-limit': '5000',
    'x-ratelimit-remaining': String(remaining), 'x-ratelimit-used': String(5000 - remaining),
    'x-ratelimit-reset': String(NOW / 1000 + 3600)
  };
}

function createHubkit(responses) {
  const state = {now: NOW, requests: []};
  const browser = {
    self: {}, lrucache: require('lru-cache'), URL, AbortController,
    Date: class extends Date { static now() {return state.now;} },
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: (...args) => clearTimeout(...args),
    fetch: async (url, options) => {
      const response = responses[state.requests.length];
      state.requests.push({url: String(url), options});
      assert.ok(response, 'unexpected network request');
      if (response instanceof Error) throw response;
      if (response.now !== undefined) state.now = response.now;
      const status = response.status ?? 200;
      return new globalThis.Response(status === 304 ? null : JSON.stringify(response.body ?? []), {
        status, headers: {'content-type': 'application/json', ...response.headers}
      });
    }
  };
  vm.runInNewContext(readFileSync(require.resolve('./hubkit.js'), 'utf8'), browser);
  return {Hubkit: browser.self.Hubkit, state};
}

for (const [resource, prefix, path] of [
  ['core', 'rateLimit', '/repos/o/r'],
  ['search', 'searchRateLimit', '/search/issues'],
  ['graphql', 'graphRateLimit', 'POST /graphql']
]) {
  for (const status of [200, 403, 429]) {
    test(`${resource} quota metadata is available after HTTP ${status}`, async () => {
      const {Hubkit} = createHubkit([{
        status, headers: quotaHeaders(resource),
        body: status === 200 ? {data: {ok: true}} : {message: 'API rate limit exceeded'}
      }]);
      const metadata = {};
      const expected = {
        [prefix]: 5000, [`${prefix}Remaining`]: 4500,
        [`${prefix}ResetTimestamp`]: NOW + 3_600_000, [`${prefix}Timestamp`]: NOW,
        contentType: 'application/json'
      };
      const request = new Hubkit({metadata}).request(path, {onError: () => {
        assert.deepEqual(metadata, expected);
        return Hubkit.DONT_RETRY;
      }});
      if (status === 200) await request;
      else await assert.rejects(request, error => error.status === status);
      assert.deepEqual(metadata, expected);
    });
  }
}

test('resource headers select the bucket, falling back to the URL only when absent', async () => {
  const {Hubkit} = createHubkit([
    {headers: quotaHeaders('search')},
    {headers: {...quotaHeaders('graphql'), 'x-ratelimit-resource': ''}},
    {headers: quotaHeaders('integration_manifest')}
  ]);
  const metadata = {};
  const gh = new Hubkit({metadata});
  await gh.request('/custom/search');
  assert.equal(metadata.searchRateLimit, 5000);
  assert.equal(metadata.rateLimit, undefined);
  await gh.request('POST /graphql');
  assert.equal(metadata.graphRateLimit, 5000);
  const previous = {...metadata};
  await gh.request('/custom/resource');
  assert.deepEqual(metadata, previous);
});

test('observations for core and GraphQL keep independent timestamps', async () => {
  const {Hubkit} = createHubkit([
    {headers: quotaHeaders('core')},
    {headers: quotaHeaders('graphql'), now: NOW + 1000}
  ]);
  const metadata = {};
  const gh = new Hubkit({metadata});
  await gh.request('/repos/o/r');
  await gh.request('POST /graphql');
  assert.equal(metadata.rateLimitTimestamp, NOW);
  assert.equal(metadata.graphRateLimitTimestamp, NOW + 1000);
});

test('invalid headers and transport errors do not refresh observations', async () => {
  const {Hubkit} = createHubkit([
    {headers: quotaHeaders()},
    {now: NOW + 1000},
    {headers: {
      'x-ratelimit-limit': 'Infinity', 'x-ratelimit-remaining': '-1',
      'x-ratelimit-reset': '123invalid'
    }, now: NOW + 2000},
    new Error('connection reset')
  ]);
  const metadata = {};
  const gh = new Hubkit({metadata, cache: null, maxTries: 1});
  await gh.request('/repos/o/r');
  const previous = {...metadata};
  await gh.request('/repos/o/r');
  assert.deepEqual(metadata, previous);
  await gh.request('/repos/o/r');
  assert.deepEqual(metadata, previous);
  await assert.rejects(gh.request('/repos/o/r'), /connection reset/);
  assert.deepEqual(metadata, previous);
});

test('a partial new observation does not inherit fields from an older quota window', async () => {
  const {Hubkit} = createHubkit([
    {headers: quotaHeaders()},
    {headers: {'x-ratelimit-remaining': '0'}, now: NOW + 1000}
  ]);
  const metadata = {};
  const gh = new Hubkit({metadata});
  await gh.request('/repos/o/r');
  await gh.request('/repos/o/r');
  assert.equal(metadata.rateLimitRemaining, 0);
  assert.equal(metadata.rateLimit, undefined);
  assert.equal(metadata.rateLimitResetTimestamp, undefined);
  assert.equal(metadata.rateLimitTimestamp, NOW + 1000);
});

for (const revalidate of [false, true]) {
  test(`${revalidate ? '304 revalidation' : 'cache hit'} cannot replay cached quota headers`,
    async () => {
      const {Hubkit, state} = createHubkit([
        {headers: {
          ...quotaHeaders(), etag: 'test-etag', 'cache-control': 'max-age=600',
          'x-oauth-scopes': 'repo, read:org'
        }},
        {status: 304, headers: {'cache-control': 'max-age=600'}, now: NOW + 1000}
      ]);
      const metadata = {};
      const gh = new Hubkit({metadata});
      await gh.request('/repos/o/r');
      const previous = {...metadata};
      state.now += 1000;
      await gh.request('/repos/o/r', {fresh: revalidate});
      assert.deepEqual(metadata, previous);
      const otherMetadata = {};
      await gh.request('/repos/o/r', {metadata: otherMetadata, fresh: false});
      assert.equal(otherMetadata.rateLimitTimestamp, undefined);
      assert.equal(otherMetadata.rateLimitRemaining, undefined);
      assert.equal(state.requests.length, revalidate ? 2 : 1);
      if (revalidate) {
        assert.equal(state.requests[1].options.headers['If-None-Match'], 'test-etag');
      }
    });
}

test('304 revalidation restores scopes but uses only the current response for quota', async () => {
  const {Hubkit} = createHubkit([
    {headers: {...quotaHeaders(), etag: 'test-etag', 'x-oauth-scopes': 'repo'}},
    {status: 304, headers: quotaHeaders('core', 4000), now: NOW + 1000},
    {status: 304, now: NOW + 2000}
  ]);
  const gh = new Hubkit();
  await gh.request('/repos/o/r');
  const metadata = {};
  await gh.request('/repos/o/r', {fresh: true, metadata});
  assert.equal(metadata.oAuthScopes.join(','), 'repo');
  assert.equal(metadata.rateLimitRemaining, 4000);
  assert.equal(metadata.rateLimitTimestamp, NOW + 1000);
  const otherMetadata = {};
  await gh.request('/repos/o/r', {fresh: true, metadata: otherMetadata});
  assert.equal(otherMetadata.oAuthScopes.join(','), 'repo');
  assert.equal(otherMetadata.rateLimitRemaining, undefined);
  assert.equal(otherMetadata.rateLimitTimestamp, undefined);
});

test('automatic pagination leaves the final page quota observation in metadata', async () => {
  const {Hubkit, state} = createHubkit([
    {body: [1], headers: {
      ...quotaHeaders(), link: '<https://api.github.com/repos/o/r/issues?page=2>; rel="next"'
    }},
    {body: [2], headers: quotaHeaders('core', 4499), now: NOW + 1000}
  ]);
  const metadata = {};
  const result = await new Hubkit({metadata}).request('/repos/o/r/issues');
  assert.equal(result.join(','), '1,2');
  assert.equal(state.requests.length, 2);
  assert.equal(metadata.rateLimitRemaining, 4499);
  assert.equal(metadata.rateLimitTimestamp, NOW + 1000);
});

for (const status of [403, 429]) {
  for (const source of ['retry-after', 'quota-reset']) {
    const headers = {
      ...quotaHeaders('core', 0), 'x-ratelimit-reset': String(NOW / 1000 + 4),
      ...source === 'retry-after' && {'retry-after': '2'}
    };
    const delay = source === 'retry-after' ? 2000 : 4000;

    test(`HTTP ${status} retries after ${source} and updates metadata`, async t => {
      t.mock.timers.enable({apis: ['setTimeout']});
      const {Hubkit, state} = createHubkit([
        {status, headers, body: {message: 'API rate limit exceeded'}},
        {headers: quotaHeaders('core', 4999), now: NOW + delay}
      ]);
      const metadata = {};
      const failed = Promise.withResolvers();
      const request = new Hubkit({metadata}).request('/repos/o/r', {
        timeout: 10_000, onError: error => {failed.resolve(error);}
      });
      const error = await failed.promise;
      assert.equal(error.retryDelay, delay);
      assert.equal(metadata.rateLimitRemaining, 0);
      t.mock.timers.tick(delay - 1);
      assert.equal(state.requests.length, 1);
      t.mock.timers.tick(1);
      await request;
      assert.equal(state.requests.length, 2);
      assert.equal(metadata.rateLimitRemaining, 4999);
      assert.equal(metadata.rateLimitTimestamp, NOW + delay);
    });

    for (const options of [{timeout: delay}, {maxTries: 1}]) {
      test(`HTTP ${status} exposes ${source} delay when ${JSON.stringify(options)} prevents retry`,
        async () => {
          const {Hubkit, state} = createHubkit([{status, headers}]);
          await assert.rejects(new Hubkit(options).request('/repos/o/r'), error => {
            assert.equal(error.status, status);
            assert.equal(error.retryDelay, delay);
            return true;
          });
          assert.equal(state.requests.length, 1);
        });
    }
  }

  test(`HTTP ${status} respects onError overrides and does not retry without delay headers`,
    async () => {
      for (const override of ['reject', 'resolve', 'none']) {
        const headers = override === 'none' ? {} : {'retry-after': '2'};
        const {Hubkit, state} = createHubkit([{status, headers}]);
        const options = override === 'none' ? {} : {
          onError: () => override === 'reject' ? Hubkit.DONT_RETRY : 'fallback'
        };
        const request = new Hubkit().request('/repos/o/r', options);
        if (override === 'resolve') assert.equal(await request, 'fallback');
        else await assert.rejects(request, error => error.status === status);
        assert.equal(state.requests.length, 1);
      }
    });
}

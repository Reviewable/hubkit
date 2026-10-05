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
      if (response.wait) await response.wait;
      if (response.now !== undefined) state.now = response.now;
      const status = response.status ?? 200;
      const result = new globalThis.Response(
        status === 304 ? null : JSON.stringify(response.body ?? []), {
          status, headers: {'content-type': 'application/json', ...response.headers}
        });
      if (response.bodyWait) {
        const readText = result.text.bind(result);
        result.text = async () => {
          response.reading.resolve();
          await response.bodyWait;
          return readText();
        };
      }
      return result;
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

  test(`${resource} quota headers require decimal digits`, async () => {
    for (const value of ['0x10', '0b10', '0o10', '1e2', '1.0', '+1']) {
      const headers = {
        'x-ratelimit-resource': resource, 'x-ratelimit-limit': value,
        'x-ratelimit-remaining': value, 'x-ratelimit-reset': value
      };
      const {Hubkit} = createHubkit([
        {headers: quotaHeaders(resource)},
        {headers, now: NOW + 1000},
        {headers: {...headers, 'x-ratelimit-remaining': ' \t0012 '}, now: NOW + 2000}
      ]);
      const metadata = {};
      const gh = new Hubkit({metadata, cache: null});
      await gh.request(path);
      const previous = {...metadata};
      await gh.request(path);
      assert.deepEqual(metadata, previous, value);
      await gh.request(path);
      assert.equal(metadata[prefix], undefined, value);
      assert.equal(metadata[`${prefix}Remaining`], 12, value);
      assert.equal(metadata[`${prefix}ResetTimestamp`], undefined, value);
      assert.equal(metadata[`${prefix}Timestamp`], NOW + 2000, value);
    }
  });
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

for (const status of [200, 429]) {
  for (const sameMillisecond of [false, true]) {
    const timing = sameMillisecond ? 'same-millisecond' : 'later';
    test(`delayed HTTP ${status} bodies preserve ${timing} quota`,
      async () => {
        const delayed = Promise.withResolvers(), reading = Promise.withResolvers();
        const {Hubkit, state} = createHubkit([
          {status, headers: quotaHeaders('core', 100), bodyWait: delayed.promise, reading},
          {headers: quotaHeaders('core', 99), now: NOW + (sameMillisecond ? 0 : 1000)}
        ]);
        const metadata = {};
        const gh = new Hubkit({metadata, cache: null, maxTries: 1});
        const olderRequest = gh.request('/repos/o/r');
        const older = status === 200 ? olderRequest :
          assert.rejects(olderRequest, error => error.status === status);
        await reading.promise;
        await gh.request('/repos/o/r');
        const newer = {...metadata};
        assert.equal(metadata.rateLimitRemaining, 99);
        assert.equal(metadata.rateLimitTimestamp, state.now);
        state.now = NOW + 2000;
        delayed.resolve();
        await older;
        assert.deepEqual(metadata, newer);
      });
  }
}

for (const failBody of [false, true]) {
  test(`quota is observed before a slow body ${failBody ? 'fails' : 'completes'}`, async () => {
    const delayed = Promise.withResolvers(), reading = Promise.withResolvers();
    const {Hubkit, state} = createHubkit([
      {headers: quotaHeaders(), bodyWait: delayed.promise, reading}
    ]);
    const metadata = {};
    const request = new Hubkit({metadata, maxTries: 1}).request('/repos/o/r');
    const completed = failBody ? assert.rejects(request, /body read failed/) : request;
    await reading.promise;
    state.now = NOW + 1000;
    if (failBody) delayed.reject(new Error('body read failed'));
    else delayed.resolve();
    await completed;
    assert.equal(metadata.rateLimitRemaining, 4500);
    assert.equal(metadata.rateLimitTimestamp, NOW);
  });
}

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

test('a delayed 304 cannot overwrite a newer concurrent response in the cache', async () => {
  const delayed = Promise.withResolvers();
  const headers = {etag: 'old-etag', 'cache-control': 'max-age=600'};
  const {Hubkit, state} = createHubkit([
    {body: {version: 1}, headers},
    {status: 304, headers, wait: delayed.promise},
    {body: {version: 2}, headers: {...headers, etag: 'new-etag'}}
  ]);
  const gh = new Hubkit();
  await gh.request('/repos/o/r');
  const older = gh.request('/repos/o/r', {fresh: true});
  assert.equal(state.requests.length, 2);
  assert.equal(state.requests[1].options.headers['If-None-Match'], 'old-etag');
  assert.equal((await gh.request('/repos/o/r', {fresh: true})).version, 2);
  delayed.resolve();
  assert.equal((await older).version, 1);
  assert.equal((await gh.request('/repos/o/r')).version, 2);
  assert.equal(state.requests.length, 3);
});

test('a delayed 304 cannot change the expiry of a newer revalidation', async () => {
  const delayed = Promise.withResolvers();
  const headers = {etag: 'test-etag', 'cache-control': 'max-age=600'};
  const {Hubkit, state} = createHubkit([
    {body: {version: 1}, headers},
    {status: 304, headers, wait: delayed.promise},
    {status: 304, headers: {...headers, 'cache-control': 'max-age=0'}},
    {body: {version: 2}, headers}
  ]);
  const gh = new Hubkit();
  await gh.request('/repos/o/r');
  let older;
  // Start a second request before the first installs its in-flight entry, so both pin the body.
  await gh.request('/repos/o/r', {fresh: true, onSend: () => {
    older = gh.request('/repos/o/r', {fresh: true});
  }});
  assert.equal(state.requests.length, 3);
  assert.equal(state.requests[1].options.headers['If-None-Match'], 'test-etag');
  assert.equal(state.requests[2].options.headers['If-None-Match'], 'test-etag');
  delayed.resolve();
  await older;
  assert.equal((await gh.request('/repos/o/r')).version, 2);
  assert.equal(state.requests.length, 4);
});

for (const status of [403, 429]) {
  test(`HTTP ${status} recognizes only decimal zero as exhausted remaining quota`, async () => {
    for (const remaining of ['00', ' \t000 ', '', ' ', '+0', '-0', '0e0', '0x0', '0.0', '0001']) {
      const {Hubkit, state} = createHubkit([{status, headers: {
        'x-ratelimit-remaining': remaining, 'x-ratelimit-reset': String(NOW / 1000 + 4)
      }}]);
      await assert.rejects(new Hubkit({maxTries: 1}).request('/repos/o/r'), error => {
        assert.equal(error.status, status);
        assert.equal(error.retryDelay, ['00', ' \t000 '].includes(remaining) ? 4000 : undefined,
          remaining);
        return true;
      });
      assert.equal(state.requests.length, 1);
    }
  });

  for (const source of ['retry-after', 'quota-reset']) {
    test(`HTTP ${status} rejects invalid ${source} delay headers without retrying`, async t => {
      t.mock.timers.enable({apis: ['setTimeout']});
      const header = source === 'retry-after' ? 'retry-after' : 'x-ratelimit-reset';
      const tooLong = source === 'retry-after' ? 2_147_484 : NOW / 1000 + 2_147_484;
      for (const value of [
        'invalid', new Date(NOW + 2000).toUTCString(), '-1', '1.5', '2seconds',
        'NaN', 'Infinity', '9'.repeat(400), String(tooLong), '9007199254740992', '0x10', '1e2'
      ]) {
        const {Hubkit, state} = createHubkit([
          {status, headers: {...quotaHeaders('core', 0), [header]: value}}, {}
        ]);
        const failed = Promise.withResolvers();
        const request = new Hubkit().request('/repos/o/r', {
          onError: error => {failed.resolve(error);}
        });
        const rejected = assert.rejects(request, error => error.status === status, value);
        const error = await failed.promise;
        t.mock.timers.runAll();
        await rejected;
        assert.equal(error.retryDelay, undefined, value);
        assert.equal(state.requests.length, 1, value);
      }
    });

    test(`HTTP ${status} accepts a zero ${source} delay`, async () => {
      const headers = source === 'retry-after' ? {'retry-after': '0'} : {
        'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(NOW / 1000 - 1)
      };
      const {Hubkit, state} = createHubkit([{status, headers}, {}]);
      let delay;
      await new Hubkit().request('/repos/o/r', {onError: error => {delay = error.retryDelay;}});
      assert.equal(delay, 0);
      assert.equal(state.requests.length, 2);
    });

    const headers = {
      ...quotaHeaders('core', 0), 'x-ratelimit-reset': String(NOW / 1000 + 4),
      ...source === 'retry-after' && {'retry-after': '2'}
    };
    const delay = source === 'retry-after' ? 2000 : 4000;

    test(`HTTP ${status} exposes ${source} delay before onError overrides`, async () => {
      for (const override of ['reject', 'resolve']) {
        const {Hubkit, state} = createHubkit([{status, headers}]);
        let callbackDelay;
        const request = new Hubkit().request('/repos/o/r', {onError: error => {
          callbackDelay = error.retryDelay;
          return override === 'reject' ? Hubkit.DONT_RETRY : 'fallback';
        }});
        if (override === 'reject') {
          await assert.rejects(request, error => {
            assert.equal(error.status, status);
            assert.equal(error.retryDelay, delay);
            return true;
          });
        } else {
          assert.equal(await request, 'fallback');
        }
        assert.equal(callbackDelay, delay);
        assert.equal(state.requests.length, 1);
      }
    });

    test(`HTTP ${status} retries after ${source} and updates metadata`, async t => {
      t.mock.timers.enable({apis: ['setTimeout']});
      const {Hubkit, state} = createHubkit([
        {status, headers: {...headers, 'x-ratelimit-remaining': '00'},
          body: {message: 'API rate limit exceeded'}},
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

'use strict';

const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const process = require('node:process');
const test = require('node:test');
const {setImmediate} = require('node:timers');
const vm = require('node:vm');

function createHubkit(environment, fetch, globals = {}) {
  const context = {
    self: {}, lrucache: require('lru-cache'), URL, Headers, AbortController, DOMException, Date,
    setTimeout, clearTimeout, fetch, ...globals
  };
  if (environment === 'Node') Object.assign(context, {process, module: {exports: {}}});
  vm.runInNewContext(readFileSync(require.resolve('./hubkit.js'), 'utf8'), context);
  const Hubkit = environment === 'Node' ? context.module.exports : context.self.Hubkit;
  return new Hubkit({autoQueryRateLimit: false});
}

function json(value, status = 200, headers = {}) {
  return new globalThis.Response(JSON.stringify(value), {
    status, headers: {'content-type': 'application/json', ...headers}
  });
}

for (const environment of ['Node', 'browser']) {
  for (const api of ['core', 'graph']) {
    test(`${environment}: unshared ${api} responses parse only once with onReceive`, async t => {
      const parse = t.mock.fn(JSON.parse);
      const fetch = t.mock.fn(async () => json(api === 'graph' ?
        {data: {viewer: {login: 'user'}, rateLimit: {cost: 3}}} : {login: 'user'}));
      const hubkit = createHubkit(environment, fetch, {JSON: {parse, stringify: JSON.stringify}});
      const onReceive = t.mock.fn();
      const result = api === 'graph' ?
        await hubkit.graph('query { viewer { login } }', {onReceive}) :
        await hubkit.request('/user', {onReceive});
      assert.equal((api === 'graph' ? result.viewer : result).login, 'user');
      assert.equal(parse.mock.callCount(), 1);
      assert.equal(onReceive.mock.callCount(), 1);
      assert.equal(onReceive.mock.calls[0].arguments[0].cost, api === 'graph' ? 3 : 1);
    });

    test(`${environment}: malformed ${api} JSON still reports the completed fetch`, async t => {
      const fetch = t.mock.fn(async () => new globalThis.Response('invalid JSON', {
        headers: {'content-type': 'application/json'}
      }));
      const hubkit = createHubkit(environment, fetch);
      const onReceive = t.mock.fn();
      const request = api === 'graph' ?
        hubkit.graph('query { viewer { login } }', {onReceive}) :
        hubkit.request('/user', {onReceive});
      await assert.rejects(request, {name: 'SyntaxError'});
      assert.equal(fetch.mock.callCount(), 1);
      assert.equal(onReceive.mock.callCount(), 1);
      const [call, latency] = onReceive.mock.calls[0].arguments;
      assert.equal(call.api, api);
      assert.equal(call.cost, api === 'graph' ? undefined : 1);
      assert.equal(typeof latency, 'number');
    });
  }

  test(`${environment}: shared callers prepare separately and receive isolated data and metadata`,
    async t => {
      const fetch = t.mock.fn(async () => json({items: [1]}, 200, {
        'x-ratelimit-remaining': '42', 'cache-control': 'max-age=60'
      }));
      const parse = t.mock.fn(JSON.parse);
      const hubkit = createHubkit(environment, fetch, {JSON: {parse, stringify: JSON.stringify}});
      const callbacks = [0, 1].map(() => ({
        onRequest: t.mock.fn(), onSend: t.mock.fn(async () => 1000),
        onReceive: t.mock.fn(), metadata: {}
      }));
      const values = await Promise.all(callbacks.map(options =>
        hubkit.request('/shared', options)));
      assert.equal(fetch.mock.callCount(), 1);
      assert.equal(parse.mock.callCount(), 2);
      assert.equal(hubkit.defaultOptions.stats.hitRate, 0.5);
      assert.equal(hubkit.defaultOptions.stats.hitSizeRate, 0.5);
      for (const [i, options] of callbacks.entries()) {
        assert.equal(options.onRequest.mock.callCount(), 1);
        assert.equal(options.onSend.mock.calls[0].arguments[0], 'initial');
        assert.equal(options.onReceive.mock.callCount(), i ? 0 : 1);
        assert.equal(options.metadata.rateLimitRemaining, 42);
      }
      const [call, latency] = callbacks[0].onReceive.mock.calls[0].arguments;
      assert.equal(call.cost, 1);
      assert.equal(call.api, 'core');
      assert.equal(typeof latency, 'number');
      values[0].items.push(2);
      assert.equal(values[1].items.length, 1);
    });

  for (const bodyFails of [false, true]) {
    test(`${environment}: shared quota arrives before the body ${bodyFails ? 'fails' : 'finishes'}`,
      async t => {
        let now = 1000;
        t.mock.method(Date, 'now', () => now);
        const headersReady = Promise.withResolvers();
        const bodyReady = Promise.withResolvers();
        const fetch = t.mock.fn(() => headersReady.promise);
        const hubkit = createHubkit(environment, fetch);
        const metadata = [{}, {}, {}];
        const receive = t.mock.fn();
        const calls = metadata.slice(0, 2).map(value => hubkit.request('/quota-body', {
          metadata: value, maxTries: 1,
          onReceive: receive,
          onError() {assert.equal(value.rateLimitRemaining, 42);}
        }));
        const response = json({ok: true}, 200, {
          'x-ratelimit-remaining': '42', 'x-oauth-scopes': 'repo'
        });
        response.text = () => bodyReady.promise;
        headersReady.resolve(response);
        await new Promise(setImmediate);
        for (const value of metadata.slice(0, 2)) {
          assert.equal(value.rateLimitRemaining, 42);
          assert.equal(value.rateLimitTimestamp, 1000);
          assert.equal(value.oAuthScopes.join(','), 'repo');
          assert.equal(value.oAuthScopesTimestamp, 1000);
        }
        assert.equal(receive.mock.callCount(), 0);
        now = 2000;
        calls.push(hubkit.request('/quota-body', {metadata: metadata[2], maxTries: 1}));
        const results = Promise.allSettled(calls);
        await new Promise(setImmediate);
        assert.equal(metadata[2].rateLimitRemaining, 42);
        assert.equal(metadata[2].rateLimitTimestamp, 1000);
        assert.equal(metadata[2].oAuthScopes.join(','), 'repo');
        assert.equal(metadata[2].oAuthScopesTimestamp, 1000);
        if (bodyFails) bodyReady.reject(new Error('Body failed'));
        else bodyReady.resolve('{"ok":true}');
        for (const result of await results) {
          if (bodyFails) assert.match(result.reason.message, /Body failed/);
          else assert.equal(result.value.ok, true);
        }
        for (const value of metadata) {
          assert.equal(value.rateLimitTimestamp, 1000);
          assert.equal(value.oAuthScopesTimestamp, 1000);
        }
        assert.equal(receive.mock.callCount(), 1);
        assert.equal(receive.mock.calls[0].arguments[1], 1000);
        assert.equal(receive.mock.calls[0].arguments[0]?.cost, bodyFails ? undefined : 1);
        assert.equal(fetch.mock.callCount(), 1);
      });
  }

  for (const timestamp of [1000, 2000]) {
    test(`${environment}: late joiners preserve metadata at ${timestamp}`, async t => {
      let now = 1000;
      t.mock.method(Date, 'now', () => now);
      const bodyReady = Promise.withResolvers();
      const fetch = t.mock.fn(async url => {
        const response = json({}, 200, {
          'x-ratelimit-remaining': url.pathname === '/older' ? '42' : '41',
          'x-oauth-scopes': url.pathname === '/older' ? 'repo' : 'public_repo'
        });
        if (url.pathname === '/older') response.text = () => bodyReady.promise;
        return response;
      });
      const hubkit = createHubkit(environment, fetch);
      const metadata = {};
      const original = hubkit.request('/older', {metadata});
      await new Promise(setImmediate);
      now = timestamp;
      await hubkit.request('/newer', {metadata});
      const joining = hubkit.request('/older', {metadata});
      await new Promise(setImmediate);
      assert.equal(metadata.rateLimitRemaining, 41);
      assert.equal(metadata.rateLimitTimestamp, timestamp);
      assert.equal(metadata.oAuthScopes.join(','), 'public_repo');
      assert.equal(metadata.oAuthScopesTimestamp, timestamp);
      bodyReady.resolve('{}');
      await Promise.all([original, joining]);
      assert.equal(metadata.rateLimitRemaining, 41);
      assert.equal(metadata.rateLimitTimestamp, timestamp);
      assert.equal(metadata.oAuthScopes.join(','), 'public_repo');
      assert.equal(metadata.oAuthScopesTimestamp, timestamp);
      assert.equal(fetch.mock.callCount(), 2);
    });
  }

  for (const outcome of ['zero', 'throw', 'positive']) {
    test(`${environment}: an async joining onSend can return ${outcome} independently`, async t => {
      let releaseResponse, releaseCallback;
      const response = new Promise(resolve => {releaseResponse = resolve;});
      const callback = new Promise(resolve => {releaseCallback = resolve;});
      const fetch = t.mock.fn(() => response);
      const hubkit = createHubkit(environment, fetch);
      const original = hubkit.request('/prepare');
      await new Promise(setImmediate);
      const onReceive = t.mock.fn();
      const onError = t.mock.fn();
      const waiter = hubkit.request('/prepare', {
        timeout: 0, onReceive, onError,
        async onSend() {
          await callback;
          if (outcome === 'throw') throw new Error('Own preparation failed');
          return outcome === 'zero' ? 0 : 1000;
        }
      });
      const settled = Promise.allSettled([original, waiter]);
      releaseCallback();
      await new Promise(setImmediate);
      assert.equal(fetch.mock.callCount(), 1);
      releaseResponse(json({ok: true}));
      const [first, second] = await settled;
      assert.equal(first.value.ok, true);
      if (outcome === 'positive') {
        assert.equal(second.value.ok, true);
      } else {
        assert.equal(second.reason.name, outcome === 'zero' ? 'TimeoutError' : 'Error');
        assert.equal(onReceive.mock.callCount(), 0);
      }
      assert.equal(onReceive.mock.callCount(), 0);
      assert.equal(onError.mock.callCount(), outcome === 'zero' ? 1 : 0);
    });
  }

  test(`${environment}: the initiating caller can time out while a joiner succeeds`, async t => {
    t.mock.timers.enable({apis: ['setTimeout']});
    let now = 1000;
    t.mock.method(Date, 'now', () => now);
    let releaseResponse, signal;
    const response = new Promise(resolve => {releaseResponse = resolve;});
    const fetch = t.mock.fn((url, config) => {signal = config.signal; return response;});
    const hubkit = createHubkit(environment, fetch);
    const firstReceive = t.mock.fn();
    const secondReceive = t.mock.fn();
    const thirdReceive = t.mock.fn();
    const first = hubkit.request('/deadline', {timeout: 10, maxTries: 1, onReceive: firstReceive});
    const second = hubkit.request('/deadline', {timeout: 100, onReceive: secondReceive});
    const third = hubkit.request('/deadline', {timeout: 100, onReceive: thirdReceive});
    const rejected = assert.rejects(first, {name: 'TimeoutError', networkFailure: true});
    await new Promise(setImmediate);
    now = 1010;
    t.mock.timers.tick(10);
    await rejected;
    assert.equal(signal.aborted, false);
    assert.equal(firstReceive.mock.callCount(), 0);
    now = 1050;
    releaseResponse(json({ok: true}, 200, {'cache-control': 'max-age=60'}));
    assert.equal((await second).ok, true);
    assert.equal((await third).ok, true);
    assert.equal(firstReceive.mock.callCount(), 1);
    assert.equal(firstReceive.mock.calls[0].arguments[0].cost, 1);
    assert.equal(firstReceive.mock.calls[0].arguments[1], 50);
    assert.equal(secondReceive.mock.callCount(), 0);
    assert.equal(thirdReceive.mock.callCount(), 0);
    assert.equal((await hubkit.request('/deadline')).ok, true);
    assert.equal(fetch.mock.callCount(), 1);
  });

  for (const firstCallback of ['absent', 'throwing']) {
    test(`${environment}: only the initiating onReceive runs when it is ${firstCallback}`,
      async t => {
        const fetch = t.mock.fn(async () => json({ok: true}));
        const hubkit = createHubkit(environment, fetch);
        const receive = t.mock.fn();
        const onReceive = firstCallback === 'throwing' ? (...args) => {
          receive(...args);
          throw new Error('Callback failed');
        } : undefined;
        const results = await Promise.allSettled([
          hubkit.request('/cost', {onReceive}),
          hubkit.request('/cost', {onReceive: receive}),
          hubkit.request('/cost', {onReceive: receive})
        ]);
        for (const result of results) {
          if (firstCallback === 'throwing') {
            assert.equal(result.status, 'rejected');
            assert.equal(result.reason.originalMessage, 'Callback failed');
          } else {
            assert.equal(result.value.ok, true);
          }
        }
        assert.deepEqual(receive.mock.calls.map(call => call.arguments[0].cost),
          firstCallback === 'throwing' ? [1] : []);
        assert.equal(fetch.mock.callCount(), 1);
      });
  }

  test(`${environment}: a timed-out initiator's onReceive can fail remaining callers`, async t => {
    t.mock.timers.enable({apis: ['setTimeout']});
    const response = Promise.withResolvers();
    const fetch = t.mock.fn(() => response.promise);
    const hubkit = createHubkit(environment, fetch);
    const receive = t.mock.fn(() => {throw new Error('Callback failed');});
    const original = hubkit.request('/late-callback', {
      timeout: 10, maxTries: 1, onReceive: receive
    });
    const joining = hubkit.request('/late-callback');
    const expired = assert.rejects(original, {name: 'TimeoutError'});
    const failed = assert.rejects(joining, {originalMessage: 'Callback failed'});
    await new Promise(setImmediate);
    t.mock.timers.tick(10);
    await expired;
    assert.equal(receive.mock.callCount(), 0);
    response.resolve(json({ok: true}));
    await failed;
    assert.equal(receive.mock.callCount(), 1);
    assert.equal(fetch.mock.callCount(), 1);
  });

  test(`${environment}: an onReceive error preserves each caller's recovery and retry policy`,
    async t => {
      const fetch = t.mock.fn(async () => json({ok: true}));
      const hubkit = createHubkit(environment, fetch);
      const receive = t.mock.fn(() => {throw new Error('Callback failed');});
      const retryReceive = t.mock.fn();
      const retrySend = t.mock.fn();
      const errors = [];
      const results = await Promise.allSettled([
        hubkit.request('/callback-policy', {onReceive: receive, onError(error) {
          errors.push(error);
          error.handled = true;
        }}),
        hubkit.request('/callback-policy', {onError(error) {
          errors.push(error);
          return 'recovered';
        }}),
        hubkit.request('/callback-policy', {
          onSend: retrySend, onReceive: retryReceive,
          onError(error) {errors.push(error); return hubkit.constructor.RETRY;}
        })
      ]);
      assert.equal(results[0].reason.originalMessage, 'Callback failed');
      assert.equal(results[1].value, 'recovered');
      assert.equal(results[2].value.ok, true);
      assert.equal(new Set(errors).size, 3);
      for (const error of errors.slice(1)) assert.equal(error.handled, undefined);
      assert.equal(receive.mock.callCount(), 1);
      assert.equal(retryReceive.mock.callCount(), 1);
      assert.equal(retryReceive.mock.calls[0].arguments[0].cost, 1);
      assert.deepEqual(retrySend.mock.calls.map(call => call.arguments[0]), ['initial', 'retry']);
      assert.equal(fetch.mock.callCount(), 2);
    });

  test(`${environment}: onReceive throwing after a transport failure runs only once`, async t => {
    const fetch = t.mock.fn(async () => {throw new Error('Connection failed');});
    const hubkit = createHubkit(environment, fetch);
    const receive = t.mock.fn(() => {throw new Error('Callback failed');});
    const results = await Promise.allSettled([
      hubkit.request('/failed-callback', {onReceive: receive}),
      hubkit.request('/failed-callback', {onReceive: receive})
    ]);
    for (const result of results) assert.equal(result.reason.originalMessage, 'Callback failed');
    assert.equal(receive.mock.callCount(), 1);
    assert.equal(receive.mock.calls[0].arguments[0], undefined);
    assert.equal(fetch.mock.callCount(), 1);
  });

  test(`${environment}: GraphQL cost is reported after the body finishes`, async t => {
    let now = 1000;
    t.mock.method(Date, 'now', () => now);
    const body = Promise.withResolvers();
    const fetch = t.mock.fn(async () => {
      const response = json({});
      response.text = () => body.promise;
      return response;
    });
    const hubkit = createHubkit(environment, fetch);
    const receive = t.mock.fn();
    const result = hubkit.graph('query { viewer { login } }', {
      onReceive: receive
    });
    await new Promise(setImmediate);
    assert.equal(receive.mock.callCount(), 0);
    now = 1050;
    body.resolve('{"data":{"viewer":{"login":"user"},"rateLimit":{"cost":3}}}');
    assert.equal((await result).viewer.login, 'user');
    assert.equal(receive.mock.callCount(), 1);
    const [call, latency] = receive.mock.calls[0].arguments;
    assert.equal(call.api, 'graph');
    assert.equal(call.cost, 3);
    assert.equal(latency, 50);
    assert.equal(fetch.mock.callCount(), 1);
  });

  test(`${environment}: the last timeout aborts the fetch and clears pending state`, async t => {
    t.mock.timers.enable({apis: ['setTimeout']});
    let now = 1000;
    t.mock.method(Date, 'now', () => now);
    const receive = t.mock.fn();
    let signal;
    const fetch = t.mock.fn((url, config) => {
      signal = config.signal;
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {once: true});
      });
    });
    const hubkit = createHubkit(environment, fetch);
    const first = hubkit.request('/abandon', {timeout: 10, maxTries: 1, onReceive: receive});
    const second = hubkit.request('/abandon', {timeout: 20, maxTries: 1, onReceive: receive});
    const rejected = [first, second].map(p => assert.rejects(p, {name: 'TimeoutError'}));
    await new Promise(setImmediate);
    now = 1010;
    t.mock.timers.tick(10);
    await rejected[0];
    assert.equal(signal.aborted, false);
    assert.equal(receive.mock.callCount(), 0);
    now = 1020;
    t.mock.timers.tick(10);
    await rejected[1];
    assert.equal(signal.aborted, true);
    assert.equal(receive.mock.callCount(), 1);
    assert.deepEqual(Array.from(receive.mock.calls[0].arguments), [undefined, 20]);
    assert.equal(hubkit.defaultOptions.cache.size, 0);
    fetch.mock.mockImplementation(async () => json({ok: true}));
    assert.equal((await hubkit.request('/abandon')).ok, true);
    assert.equal(fetch.mock.callCount(), 2);
  });

  test(`${environment}: one caller's HTTP recovery and mutations cannot change another's error`,
    async t => {
      const fetch = t.mock.fn(async () => json({message: 'Forbidden', detail: {value: 1}}, 403));
      const hubkit = createHubkit(environment, fetch);
      let firstError, secondError;
      const first = hubkit.request('/recover', {onError(error) {
        firstError = error;
        error.response.data.detail.value = 2;
        error.handled = true;
        return null;
      }});
      const second = hubkit.request('/recover', {onError(error) {secondError = error;}});
      const results = await Promise.allSettled([first, second]);
      assert.equal(results[0].value, null);
      assert.equal(results[1].reason, secondError);
      assert.notEqual(firstError, secondError);
      assert.equal(secondError.handled, undefined);
      assert.equal(secondError.response.data.detail.value, 1);
      assert.equal(fetch.mock.callCount(), 1);
      assert.equal(hubkit.defaultOptions.cache.size, 0);
    });

  for (const [status, option] of [[404, 'ifNotFound'], [410, 'ifGone']]) {
    test(`${environment}: ${option} and cache stats are evaluated for each caller`, async t => {
      const fetch = t.mock.fn(async () => json({message: 'Missing'}, status));
      const hubkit = createHubkit(environment, fetch);
      const results = await Promise.allSettled([
        hubkit.request('/missing'), hubkit.request('/missing', {[option]: null})
      ]);
      assert.equal(results[0].reason.status, status);
      assert.equal(results[1].value, null);
      assert.equal(fetch.mock.callCount(), 1);
      assert.equal(hubkit.defaultOptions.stats.hitRate, 0.5);
    });
  }

  for (const maxTries of [1, 2]) {
    test(`${environment}: shared rejected 500 responses count reuse across ${maxTries} attempts`,
      async t => {
        const fetch = t.mock.fn(async () => json({message: 'Server error'}, 500));
        const hubkit = createHubkit(environment, fetch);
        const results = await Promise.allSettled([
          hubkit.request('/shared-failure', {maxTries}),
          hubkit.request('/shared-failure', {maxTries})
        ]);
        for (const result of results) {
          assert.equal(result.status, 'rejected');
          assert.equal(result.reason.status, 500);
        }
        const stats = hubkit.defaultOptions.stats;
        assert.equal(fetch.mock.callCount(), maxTries);
        assert.equal(stats.hits, maxTries);
        assert.equal(stats.misses, maxTries);
        assert.equal(stats.hitRate, 0.5);
        assert.equal(stats.hitSizeRate, 0.5);
        assert.equal(hubkit.defaultOptions.cache.size, 0);
      });
  }

  test(`${environment}: shared ArrayBuffer responses reuse the original buffer`, async t => {
    const buffer = new Uint8Array([1, 2, 3]).buffer;
    const arrayBuffer = t.mock.fn(async () => buffer);
    const fetch = t.mock.fn(async () => ({
      status: 200, headers: new globalThis.Headers(), arrayBuffer
    }));
    const hubkit = createHubkit(environment, fetch);
    const values = await Promise.all([
      hubkit.request('/buffer', {responseType: 'arraybuffer'}),
      hubkit.request('/buffer', {responseType: 'arraybuffer'})
    ]);
    assert.equal(fetch.mock.callCount(), 1);
    assert.equal(arrayBuffer.mock.callCount(), 1);
    assert.equal(values[0], buffer);
    assert.equal(values[1], buffer);
  });

  test(`${environment}: a throwing error handler rejects only its caller once`, async t => {
    const fetch = t.mock.fn(async () => json({message: 'Forbidden'}, 403));
    const hubkit = createHubkit(environment, fetch);
    const onError = t.mock.fn(() => {throw new Error('Handler failed');});
    const results = await Promise.allSettled([
      hubkit.request('/handler', {onError}),
      hubkit.request('/handler', {onError: () => 'recovered'})
    ]);
    assert.equal(results[0].reason.message, 'Handler failed');
    assert.equal(results[1].value, 'recovered');
    assert.equal(onError.mock.callCount(), 1);
    assert.equal(fetch.mock.callCount(), 1);
  });

  test(`${environment}: different request headers cannot share a fetch`, async t => {
    const fetch = t.mock.fn(async (url, {headers}) =>
      json({version: headers['X-GitHub-Api-Version']}));
    const hubkit = createHubkit(environment, fetch);
    const values = await Promise.all(['2022-11-28', '2026-03-10'].map(apiVersion =>
      hubkit.request('/versions', {apiVersion})));
    assert.equal(values[0].version, '2022-11-28');
    assert.equal(values[1].version, '2026-03-10');
    assert.equal(fetch.mock.callCount(), 2);
  });

  for (const bothRetry of [false, true]) {
    const policies = bothRetry ? 'both' : 'independent';
    test(`${environment}: shared errors preserve ${policies} retry policies`,
      async t => {
        let sends = 0;
        const fetch = t.mock.fn(async () => ++sends === 1 ?
          json({message: 'Try again'}, 500) : json({ok: true}));
        const hubkit = createHubkit(environment, fetch);
        const firstSend = t.mock.fn();
        const secondSend = t.mock.fn();
        const results = await Promise.allSettled([
          hubkit.request('/retry', {maxTries: bothRetry ? 2 : 1, onSend: firstSend}),
          hubkit.request('/retry', {maxTries: 2, onSend: secondSend})
        ]);
        if (bothRetry) assert.equal(results[0].value.ok, true);
        else assert.equal(results[0].reason.status, 500);
        assert.equal(results[1].value.ok, true);
        assert.equal(firstSend.mock.callCount(), bothRetry ? 2 : 1);
        assert.deepEqual(
          secondSend.mock.calls.map(call => call.arguments[0]), ['initial', 'retry']);
        assert.equal(fetch.mock.callCount(), 2);
      });
  }

  test(`${environment}: callers annotate their own copies of transport errors`, async t => {
    const error = new TypeError('Failed to fetch');
    const fetch = t.mock.fn(async () => {throw error;});
    const hubkit = createHubkit(environment, fetch);
    const receive = t.mock.fn();
    const results = await Promise.allSettled([
      hubkit.request('/network', {maxTries: 1, onReceive: receive,
        onError(e) {e.handled = true;}}),
      hubkit.request('/network', {maxTries: 1, onReceive: receive})
    ]);
    assert.notEqual(results[0].reason, results[1].reason);
    assert.equal(results[1].reason.handled, undefined);
    assert.equal(results[1].reason.originalMessage, 'Failed to fetch');
    assert.equal(results[1].reason instanceof TypeError, true);
    assert.equal(error.message, 'Failed to fetch');
    assert.equal(receive.mock.callCount(), 1);
    assert.equal(receive.mock.calls[0].arguments[0], undefined);
    assert.equal(typeof receive.mock.calls[0].arguments[1], 'number');
    assert.equal(fetch.mock.callCount(), 1);
  });

  for (const allPages of [false, true]) {
    const paging = allPages ? 'automatic' : 'manual';
    test(`${environment}: shared ${paging} pages retain caller callbacks`,
      async t => {
        const fetch = t.mock.fn(async url => url.searchParams.has('page') ? json([2]) :
          json([1], 200, {link: '<https://api.github.com/pages?page=2>; rel="next"'}));
        const hubkit = createHubkit(environment, fetch);
        const sends = [t.mock.fn(), t.mock.fn()];
        let values = await Promise.all(sends.map(onSend =>
          hubkit.request('/pages', {allPages, onSend})));
        if (!allPages) values = await Promise.all(values.map(value => value.next()));
        assert.notEqual(values[0], values[1]);
        for (const value of values) assert.deepEqual(Array.from(value), allPages ? [1, 2] : [2]);
        for (const onSend of sends) {
          assert.deepEqual(onSend.mock.calls.map(call => call.arguments[0]), ['initial', 'page']);
        }
        assert.equal(fetch.mock.callCount(), 2);
      });
  }

  test(`${environment}: callers on different automatic pages cannot share the wrong page`,
    async t => {
      let releaseCallback, releasePage;
      const callback = new Promise(resolve => {releaseCallback = resolve;});
      const page = new Promise(resolve => {releasePage = resolve;});
      const fetch = t.mock.fn(async url => url.searchParams.has('page') ? page :
        json([1], 200, {link: '<https://api.github.com/pages?page=2>; rel="next"'}));
      const hubkit = createHubkit(environment, fetch);
      const first = hubkit.request('/pages', {allPages: true});
      const second = hubkit.request('/pages', {
        allPages: true, onSend: cause => cause === 'initial' ? callback : undefined
      });
      await new Promise(setImmediate);
      assert.equal(fetch.mock.callCount(), 2);
      releaseCallback();
      await new Promise(setImmediate);
      assert.equal(fetch.mock.callCount(), 3);
      releasePage(json([2]));
      for (const value of await Promise.all([first, second])) {
        assert.deepEqual(Array.from(value), [1, 2]);
      }
    });

  test(`${environment}: shared conditional requests retain the pinned 304 response`, async t => {
    let sends = 0;
    const fetch = t.mock.fn(async (url, config) => {
      if (++sends === 1) return json({ok: true}, 200, {etag: 'one', 'cache-control': 'max-age=0'});
      assert.equal(config.headers['If-None-Match'], 'one');
      return new globalThis.Response(null, {status: 304, headers: {'cache-control': 'max-age=60'}});
    });
    const hubkit = createHubkit(environment, fetch);
    await hubkit.request('/conditional');
    const values = await Promise.all([
      hubkit.request('/conditional'), hubkit.request('/conditional')
    ]);
    for (const value of values) assert.equal(value.ok, true);
    assert.equal((await hubkit.request('/conditional')).ok, true);
    assert.equal(fetch.mock.callCount(), 2);
  });

  for (const invalidate of ['fresh', 'clear']) {
    test(`${environment}: ${invalidate} isolates and protects a newer fetch`, async t => {
      const releases = [];
      const fetch = t.mock.fn(() => new Promise(resolve => releases.push(resolve)));
      const hubkit = createHubkit(environment, fetch);
      const old = hubkit.request('/replace');
      await new Promise(setImmediate);
      if (invalidate === 'clear') hubkit.defaultOptions.cache.clear();
      const newer = hubkit.request('/replace', {fresh: invalidate === 'fresh'});
      await new Promise(setImmediate);
      assert.equal(fetch.mock.callCount(), 2);
      releases[1](json({value: 'new'}, 200, {'cache-control': 'max-age=60'}));
      await newer;
      releases[0](json({value: 'old'}, 200, {'cache-control': 'max-age=60'}));
      assert.equal((await old).value, 'old');
      assert.equal((await hubkit.request('/replace')).value, 'new');
    });
  }
}

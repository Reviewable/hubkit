'use strict';

const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const process = require('node:process');
const test = require('node:test');
const {setImmediate} = require('node:timers');
const vm = require('node:vm');

function createHubkit(environment, fetch) {
  const context = {
    self: {}, lrucache: require('lru-cache'), URL, AbortController, DOMException, Date,
    setTimeout, clearTimeout, fetch
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
  test(`${environment}: shared callers run their callbacks and receive isolated data and metadata`,
    async t => {
      const fetch = t.mock.fn(async () => json({items: [1]}, 200, {
        'x-ratelimit-remaining': '42', 'cache-control': 'max-age=60'
      }));
      const hubkit = createHubkit(environment, fetch);
      const callbacks = [0, 1].map(() => ({
        onRequest: t.mock.fn(), onSend: t.mock.fn(async () => 1000),
        onReceive: t.mock.fn(), metadata: {}
      }));
      const values = await Promise.all(callbacks.map(options =>
        hubkit.request('/shared', options)));
      assert.equal(fetch.mock.callCount(), 1);
      assert.equal(hubkit.defaultOptions.stats.hitRate, 0.5);
      assert.equal(hubkit.defaultOptions.stats.hitSizeRate, 0.5);
      for (const [i, options] of callbacks.entries()) {
        assert.equal(options.onRequest.mock.callCount(), 1);
        assert.equal(options.onSend.mock.calls[0].arguments[0], 'initial');
        assert.equal(options.onReceive.mock.callCount(), 1);
        const [call, shared] = options.onReceive.mock.calls[0].arguments;
        assert.equal(shared, !!i);
        assert.equal(call.cost, i ? 0 : 1);
        assert.equal(call.api, 'core');
        assert.equal(options.metadata.rateLimitRemaining, 42);
      }
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
        const calls = metadata.slice(0, 2).map(value => hubkit.request('/quota-body', {
          metadata: value, maxTries: 1,
          onError() {assert.equal(value.rateLimitRemaining, 42);}
        }));
        const response = json({ok: true}, 200, {'x-ratelimit-remaining': '42'});
        response.text = () => bodyReady.promise;
        headersReady.resolve(response);
        await new Promise(setImmediate);
        for (const value of metadata.slice(0, 2)) {
          assert.equal(value.rateLimitRemaining, 42);
          assert.equal(value.rateLimitTimestamp, 1000);
        }
        now = 2000;
        calls.push(hubkit.request('/quota-body', {metadata: metadata[2], maxTries: 1}));
        const results = Promise.allSettled(calls);
        await new Promise(setImmediate);
        assert.equal(metadata[2].rateLimitRemaining, 42);
        assert.equal(metadata[2].rateLimitTimestamp, 1000);
        if (bodyFails) bodyReady.reject(new Error('Body failed'));
        else bodyReady.resolve('{"ok":true}');
        for (const result of await results) {
          if (bodyFails) assert.match(result.reason.message, /Body failed/);
          else assert.equal(result.value.ok, true);
        }
        for (const value of metadata) assert.equal(value.rateLimitTimestamp, 1000);
        assert.equal(fetch.mock.callCount(), 1);
      });
  }

  test(`${environment}: joining after headers cannot replace newer quota metadata`, async t => {
    let now = 1000;
    t.mock.method(Date, 'now', () => now);
    const bodyReady = Promise.withResolvers();
    const fetch = t.mock.fn(async url => {
      const response = json({}, 200, {
        'x-ratelimit-remaining': url.pathname === '/older' ? '42' : '41'
      });
      if (url.pathname === '/older') response.text = () => bodyReady.promise;
      return response;
    });
    const hubkit = createHubkit(environment, fetch);
    const original = hubkit.request('/older');
    await new Promise(setImmediate);
    now = 2000;
    const metadata = {};
    await hubkit.request('/newer', {metadata});
    const joining = hubkit.request('/older', {metadata});
    await new Promise(setImmediate);
    assert.equal(metadata.rateLimitRemaining, 41);
    assert.equal(metadata.rateLimitTimestamp, 2000);
    bodyReady.resolve('{}');
    await Promise.all([original, joining]);
    assert.equal(metadata.rateLimitRemaining, 41);
    assert.equal(metadata.rateLimitTimestamp, 2000);
    assert.equal(fetch.mock.callCount(), 2);
  });

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
        assert.equal(onReceive.mock.calls[0].arguments[1], true);
      } else {
        assert.equal(second.reason.name, outcome === 'zero' ? 'TimeoutError' : 'Error');
        assert.equal(onReceive.mock.callCount(), 0);
      }
      assert.equal(onError.mock.callCount(), outcome === 'zero' ? 1 : 0);
    });
  }

  test(`${environment}: the initiating caller can time out while a joiner succeeds`, async t => {
    t.mock.timers.enable({apis: ['setTimeout']});
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
    t.mock.timers.tick(10);
    await rejected;
    assert.equal(signal.aborted, false);
    assert.deepEqual(Array.from(firstReceive.mock.calls[0].arguments), [undefined, false]);
    releaseResponse(json({ok: true}, 200, {'cache-control': 'max-age=60'}));
    assert.equal((await second).ok, true);
    assert.equal((await third).ok, true);
    assert.equal(secondReceive.mock.calls[0].arguments[1], true);
    assert.equal(thirdReceive.mock.calls[0].arguments[1], true);
    assert.equal(secondReceive.mock.calls[0].arguments[0].cost, 1);
    assert.equal(thirdReceive.mock.calls[0].arguments[0].cost, 0);
    assert.equal((await hubkit.request('/deadline')).ok, true);
    assert.equal(fetch.mock.callCount(), 1);
  });

  for (const firstCallback of ['absent', 'throwing']) {
    test(`${environment}: quota cost is reported once when the first callback is ${firstCallback}`,
      async t => {
        const fetch = t.mock.fn(async () => json({ok: true}));
        const hubkit = createHubkit(environment, fetch);
        const receive = t.mock.fn();
        const onReceive = firstCallback === 'throwing' ? call => {
          receive(call);
          throw new Error('Callback failed');
        } : undefined;
        const results = await Promise.allSettled([
          hubkit.request('/cost', {onReceive}),
          hubkit.request('/cost', {onReceive: receive}),
          hubkit.request('/cost', {onReceive: receive})
        ]);
        if (firstCallback === 'throwing') {
          assert.equal(results[0].reason.originalMessage, 'Callback failed');
        } else {
          assert.equal(results[0].value.ok, true);
        }
        assert.equal(results[1].value.ok, true);
        assert.equal(results[2].value.ok, true);
        assert.deepEqual(receive.mock.calls.map(call => call.arguments[0].cost),
          firstCallback === 'throwing' ? [1, 0, 0] : [1, 0]);
        assert.equal(fetch.mock.callCount(), 1);
      });
  }

  test(`${environment}: the last timeout aborts the fetch and clears pending state`, async t => {
    t.mock.timers.enable({apis: ['setTimeout']});
    let signal;
    const fetch = t.mock.fn((url, config) => {
      signal = config.signal;
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {once: true});
      });
    });
    const hubkit = createHubkit(environment, fetch);
    const first = hubkit.request('/abandon', {timeout: 10, maxTries: 1});
    const second = hubkit.request('/abandon', {timeout: 20, maxTries: 1});
    const rejected = [first, second].map(p => assert.rejects(p, {name: 'TimeoutError'}));
    await new Promise(setImmediate);
    t.mock.timers.tick(10);
    await rejected[0];
    assert.equal(signal.aborted, false);
    t.mock.timers.tick(10);
    await rejected[1];
    assert.equal(signal.aborted, true);
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
    const results = await Promise.allSettled([
      hubkit.request('/network', {maxTries: 1, onError(e) {e.handled = true;}}),
      hubkit.request('/network', {maxTries: 1})
    ]);
    assert.notEqual(results[0].reason, results[1].reason);
    assert.equal(results[1].reason.handled, undefined);
    assert.equal(results[1].reason.originalMessage, 'Failed to fetch');
    assert.equal(results[1].reason instanceof TypeError, true);
    assert.equal(error.message, 'Failed to fetch');
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

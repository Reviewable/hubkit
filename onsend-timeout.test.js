'use strict';

const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const process = require('node:process');
const test = require('node:test');
const vm = require('node:vm');

function createHubkit(environment, fetch) {
  const context = {
    self: {}, lrucache: require('lru-cache'), URL, AbortController, DOMException,
    setTimeout, clearTimeout, fetch
  };
  if (environment === 'Node') Object.assign(context, {process, module: {exports: {}}});
  vm.runInNewContext(readFileSync(require.resolve('./hubkit.js'), 'utf8'), context);
  const Hubkit = environment === 'Node' ? context.module.exports : context.self.Hubkit;
  return new Hubkit({autoQueryRateLimit: false});
}

for (const environment of ['Node', 'browser']) {
  for (const [description, options, expected] of [
    ['zero option', {timeout: 0}, {name: 'TimeoutError'}],
    ['zero callback', {onSend: () => 0}, {name: 'TimeoutError'}],
    ['async zero callback', {onSend: async () => 0}, {name: 'TimeoutError'}],
    ['throwing callback', {onSend() {throw new Error('Callback failed');}},
      {message: 'Callback failed'}]
  ]) {
    test(`${environment}: cached requests recover after ${description}`, async t => {
      const fetch = t.mock.fn(async () => new globalThis.Response('{"ok":true}', {headers: {
        'content-type': 'application/json', 'cache-control': 'max-age=60'
      }}));
      const hubkit = createHubkit(environment, fetch);
      await assert.rejects(hubkit.request('/recover', options), expected);
      assert.equal(fetch.mock.callCount(), 0);
      assert.equal(hubkit.defaultOptions.cache.size, 0);

      assert.equal((await hubkit.request('/recover', {timeout: 1000})).ok, true);
      assert.equal((await hubkit.request('/recover')).ok, true);
      assert.equal(fetch.mock.callCount(), 1);
    });
  }

  for (const completed of [false, true]) {
    const state = completed ? 'response' : 'promise';
    test(`${environment}: a pre-send rejection preserves a newer ${state}`,
      async t => {
        let releaseTimeout, releaseResponse;
        const timeout = new Promise(resolve => {releaseTimeout = resolve;});
        const response = new Promise(resolve => {releaseResponse = resolve;});
        const fetch = t.mock.fn(() => response);
        const hubkit = createHubkit(environment, fetch);
        const rejected = assert.rejects(hubkit.request('/concurrent', {
          onSend: () => timeout
        }), {name: 'TimeoutError'});
        const newer = hubkit.request('/concurrent', {fresh: true});
        const result = new globalThis.Response('{"ok":true}', {headers: {
          'content-type': 'application/json', 'cache-control': 'max-age=60'
        }});
        if (completed) {
          releaseResponse(result);
          await newer;
        }
        const cache = hubkit.defaultOptions.cache;
        const [key] = cache.keys();
        const replacement = cache.get(key);
        releaseTimeout(0);
        await rejected;
        assert.equal(cache.get(key), replacement);
        if (!completed) releaseResponse(result);
        await newer;
        assert.equal((await hubkit.request('/concurrent')).ok, true);
        assert.equal(fetch.mock.callCount(), 1);
      });
  }

  for (const onSend of [() => 0, async () => 0]) {
    for (const timeout of [undefined, 1000]) {
      test(`${environment}: ${onSend.constructor.name} zero stops sends with timeout ${timeout}`,
        async t => {
          const fetch = t.mock.fn(async () => new globalThis.Response('{}'));
          const hubkit = createHubkit(environment, fetch);
          const onError = t.mock.fn(() => {throw new Error('Must not retry a pre-send timeout');});
          const onReceive = t.mock.fn();
          await assert.rejects(hubkit.request('/zero', {timeout, onSend, onError, onReceive}), {
            name: 'TimeoutError'
          });
          assert.equal(fetch.mock.callCount(), 0);
          assert.equal(onError.mock.callCount(), 0);
          assert.equal(onReceive.mock.callCount(), 0);
        });
    }
  }

  test(`${environment}: zero stops a retry after a network failure`, async t => {
    const fetch = t.mock.fn(async () => {throw new TypeError('Failed to fetch');});
    const hubkit = createHubkit(environment, fetch);
    const causes = [];
    await assert.rejects(hubkit.request('/retry', {
      timeout: 1000,
      onSend(cause) {
        causes.push(cause);
        return cause === 'retry' ? 0 : 1000;
      }
    }), {name: 'TimeoutError'});
    assert.equal(fetch.mock.callCount(), 1);
    assert.deepEqual(causes, ['initial', 'retry']);
  });

  test(`${environment}: zero stops an automatic next-page send`, async t => {
    let sends = 0;
    const fetch = t.mock.fn(async () => {
      const headers = {'content-type': 'application/json'};
      if (++sends === 1) {
        headers.link = '<https://api.github.com/items?page=2>; rel="next"';
      }
      return new globalThis.Response('[1]', {headers});
    });
    const hubkit = createHubkit(environment, fetch);
    const causes = [];
    await assert.rejects(hubkit.request('/items', {
      timeout: 1000, allPages: true,
      async onSend(cause) {
        causes.push(cause);
        return cause === 'page' ? 0 : 1000;
      }
    }), {name: 'TimeoutError'});
    assert.equal(fetch.mock.callCount(), 1);
    assert.deepEqual(causes, ['initial', 'page']);
  });

  for (const result of [undefined, null, 1]) {
    test(`${environment}: onSend ${result} retains a working request timeout`, async t => {
      const fetch = t.mock.fn((url, {signal}) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {once: true});
      }));
      const hubkit = createHubkit(environment, fetch);
      await assert.rejects(hubkit.request('/timeout', {
        timeout: result === 1 ? 0 : 1, maxTries: 1, onSend: async () => result
      }), {name: 'TimeoutError'});
      assert.equal(fetch.mock.callCount(), 1);
    });
  }

  for (const [description, onSend] of [
    ['no callback', undefined], ['undefined callback result', () => undefined],
    ['async null callback result', async () => null]
  ]) {
    test(`${environment}: options.timeout zero stops sends with ${description}`, async t => {
      const fetch = t.mock.fn(async () => new globalThis.Response('{}'));
      const hubkit = createHubkit(environment, fetch);
      const onError = t.mock.fn();
      const onReceive = t.mock.fn();
      await assert.rejects(hubkit.request('/zero-option', {
        timeout: 0, onSend, onError, onReceive
      }), {name: 'TimeoutError'});
      assert.equal(fetch.mock.callCount(), 0);
      assert.equal(onError.mock.callCount(), 0);
      assert.equal(onReceive.mock.callCount(), 0);
    });
  }

  test(`${environment}: an omitted timeout sends the request without a timer`, async t => {
    const fetch = t.mock.fn(async (url, {signal}) => {
      assert.equal(signal, undefined);
      return new globalThis.Response('{}', {headers: {'content-type': 'application/json'}});
    });
    const hubkit = createHubkit(environment, fetch);
    await hubkit.request('/no-timeout');
    assert.equal(fetch.mock.callCount(), 1);
  });
}

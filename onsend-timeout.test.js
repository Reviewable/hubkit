'use strict';

const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const process = require('node:process');
const test = require('node:test');
const {setImmediate} = require('node:timers');
const vm = require('node:vm');

function createHubkit(environment, fetch, timers = {setTimeout, clearTimeout}) {
  const context = {
    self: {}, lrucache: require('lru-cache'), URL, AbortController, DOMException,
    ...timers, fetch
  };
  if (environment === 'Node') Object.assign(context, {process, module: {exports: {}}});
  vm.runInNewContext(readFileSync(require.resolve('./hubkit.js'), 'utf8'), context);
  const Hubkit = environment === 'Node' ? context.module.exports : context.self.Hubkit;
  return new Hubkit({autoQueryRateLimit: false});
}

for (const environment of ['Node', 'browser']) {
  for (const policy of ['recover', 'retry', 'exhaust', 'throw']) {
    test(`${environment}: zero timeouts honor the ${policy} error policy`, async t => {
      const fetch = t.mock.fn(async () => new globalThis.Response('{"ok":true}', {
        headers: {'content-type': 'application/json'}
      }));
      const hubkit = createHubkit(environment, fetch);
      const onSend = t.mock.fn(cause => policy === 'retry' && cause === 'retry' ? 1000 : undefined);
      const onReceive = t.mock.fn();
      const onError = t.mock.fn(error => {
        assert.equal(error.name, 'TimeoutError');
        assert.equal(error.networkFailure, undefined);
        if (policy === 'throw') throw new Error('Handler failed');
        return policy === 'recover' ? 'recovered' : hubkit.constructor.RETRY;
      });
      const request = hubkit.request('/zero-policy', {
        timeout: 0, maxTries: 2, onSend, onReceive, onError
      });
      if (policy === 'recover') {
        assert.equal(await request, 'recovered');
      } else if (policy === 'retry') {
        assert.equal((await request).ok, true);
      } else {
        await assert.rejects(request, policy === 'throw' ?
          {message: 'Handler failed'} : {name: 'TimeoutError'});
      }
      const retries = policy === 'retry' || policy === 'exhaust';
      assert.deepEqual(onSend.mock.calls.map(call => call.arguments[0]),
        retries ? ['initial', 'retry'] : ['initial']);
      assert.equal(onError.mock.callCount(), policy === 'exhaust' ? 2 : 1);
      assert.equal(fetch.mock.callCount(), policy === 'retry' ? 1 : 0);
      assert.equal(onReceive.mock.callCount(), policy === 'retry' ? 1 : 0);
      assert.equal(hubkit.defaultOptions.cache.size, 0);
    });
  }

  for (const timeout of [0, 10]) {
    for (const useDefault of [false, true]) {
      const source = useDefault ? 'default' : 'explicit';
      test(`${environment}: shared requests honor ${source} timeout ${timeout}`,
        async t => {
          t.mock.timers.enable({apis: ['setTimeout']});
          let releaseResponse, signal;
          const response = new Promise(resolve => {releaseResponse = resolve;});
          const fetch = t.mock.fn((url, config) => {
            signal = config.signal;
            return response;
          });
          const hubkit = createHubkit(environment, fetch);
          t.after(() => releaseResponse(new globalThis.Response('{"ok":true}', {headers: {
            'content-type': 'application/json', 'cache-control': 'max-age=60'
          }})));
          const original = hubkit.request('/shared', {timeout: 1000});
          await new Promise(setImmediate);
          const cache = hubkit.defaultOptions.cache;
          const [key] = cache.keys();
          const entry = cache.get(key);
          const onSend = t.mock.fn();
          const onReceive = t.mock.fn();
          const onError = t.mock.fn();
          let outcome;
          const caller = useDefault ? hubkit.scope({timeout}) : hubkit;
          const waiter = caller.request('/shared', {
            ...!useDefault && {timeout}, maxTries: 1, onSend, onReceive, onError
          }).then(value => {outcome = value;}, error => {outcome = error;});
          const untimed = hubkit.request('/shared');
          await new Promise(setImmediate);
          t.mock.timers.tick(timeout);
          await new Promise(setImmediate);
          assert.equal(outcome?.name, 'TimeoutError');
          assert.equal(signal.aborted, false);
          assert.equal(cache.get(key), entry);
          assert.equal(fetch.mock.callCount(), 1);
          assert.equal(onSend.mock.callCount(), 1);
          assert.equal(onReceive.mock.callCount(), timeout ? 1 : 0);
          assert.equal(onError.mock.callCount(), 1);

          const later = hubkit.request('/shared', {timeout: 100});
          releaseResponse(new globalThis.Response('{"ok":true}', {headers: {
            'content-type': 'application/json', 'cache-control': 'max-age=60'
          }}));
          for (const value of await Promise.all([original, untimed, later])) {
            assert.equal(value.ok, true);
          }
          await waiter;
          assert.equal((await hubkit.request('/shared', {timeout: 0})).ok, true);
          assert.equal(fetch.mock.callCount(), 1);
        });
    }
  }

  for (const fail of [false, true]) {
    test(`${environment}: shared ${fail ? 'rejection' : 'response'} clears the caller's timer`,
      async t => {
        t.mock.timers.enable({apis: ['setTimeout']});
        const timers = {setTimeout: t.mock.fn(setTimeout), clearTimeout: t.mock.fn(clearTimeout)};
        let resolveResponse, rejectResponse;
        const response = new Promise((resolve, reject) => {
          resolveResponse = resolve;
          rejectResponse = reject;
        });
        const fetch = t.mock.fn(() => response);
        const hubkit = createHubkit(environment, fetch, timers);
        const original = hubkit.request('/settle', {maxTries: 1});
        const onError = t.mock.fn();
        const waiter = hubkit.request('/settle', {timeout: 100, maxTries: 1, onError});
        const results = Promise.allSettled([original, waiter]);
        const error = new Error('Connection failed');
        if (fail) {
          rejectResponse(error);
        } else {
          resolveResponse(new globalThis.Response('{"ok":true}', {
            headers: {'content-type': 'application/json'}
          }));
        }
        const settled = await results;
        for (const result of settled) {
          if (fail) {
            assert.notEqual(result.reason, error);
            assert.equal(result.reason.originalMessage, error.message);
          } else {
            assert.equal(result.value.ok, true);
          }
        }
        assert.equal(timers.setTimeout.mock.callCount(), 1);
        assert.equal(timers.clearTimeout.mock.callCount(), 1);
        assert.equal(
          timers.clearTimeout.mock.calls[0].arguments[0], timers.setTimeout.mock.calls[0].result);
        assert.equal(onError.mock.callCount(), fail ? 1 : 0);
        assert.equal(fetch.mock.callCount(), 1);
      });
  }

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
          const onError = t.mock.fn();
          const onReceive = t.mock.fn();
          await assert.rejects(hubkit.request('/zero', {timeout, onSend, onError, onReceive}), {
            name: 'TimeoutError'
          });
          assert.equal(fetch.mock.callCount(), 0);
          assert.equal(onError.mock.callCount(), 1);
          assert.equal(onError.mock.calls[0].arguments[0].networkFailure, undefined);
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
      assert.equal(onError.mock.callCount(), 1);
      assert.equal(onReceive.mock.callCount(), 0);
    });
  }

  test(`${environment}: an omitted timeout sends the request without a timer`, async t => {
    const fetch = t.mock.fn(async (url, {signal}) => {
      assert.equal(signal.aborted, false);
      return new globalThis.Response('{}', {headers: {'content-type': 'application/json'}});
    });
    const hubkit = createHubkit(environment, fetch);
    await hubkit.request('/no-timeout');
    assert.equal(fetch.mock.callCount(), 1);
  });
}

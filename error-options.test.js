'use strict';

const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const process = require('node:process');
const test = require('node:test');
const vm = require('node:vm');

function createHubkit(environment, fetch) {
  const context = {
    self: {}, lrucache: require('lru-cache'), URL, Headers, AbortController, DOMException,
    setTimeout, clearTimeout, fetch
  };
  if (environment === 'Node') Object.assign(context, {process, module: {exports: {}}});
  vm.runInNewContext(readFileSync(require.resolve('./hubkit.js'), 'utf8'), context);
  return environment === 'Node' ? context.module.exports : context.self.Hubkit;
}

function unauthorized() {
  return new globalThis.Response('{"message":"Bad credentials"}', {
    status: 401, headers: {'content-type': 'application/json'}
  });
}

for (const environment of ['Node', 'browser']) {
  test(`${environment}: composed handlers receive non-enumerable options`, async () => {
    const Hubkit = createHubkit(environment, async () => unauthorized());
    const seen = [];
    Hubkit.defaults.onError = error => {seen.push(error);};
    const hubkit = new Hubkit({token: 'default-token', owner: 'owner'});
    await assert.rejects(hubkit.request('/repos/:owner/:repo', {
      repo: 'repo', token: 'initial-token',
      onRequest: options => {options.token = 'request-token';},
      onError: error => {
        seen.push(error);
        assert.equal(error.options.token, 'request-token');
        assert.equal(error.options.owner, 'owner');
        assert.equal(error.options.repo, 'repo');
        assert.equal(error.options.method, 'GET');
        assert.equal(Object.getOwnPropertyDescriptor(error, 'options').enumerable, false);
        assert.equal(Object.hasOwn({...error}, 'options'), false);
        assert.equal(JSON.stringify(error).includes('request-token'), false);
      }
    }), error => {
      assert.equal(error.status, 401);
      assert.equal(error.options.token, 'request-token');
      assert.equal(seen.length, 2);
      assert.ok(seen.every(value => value === error));
      return true;
    });
  });

  for (const transportFailure of [false, true]) {
    test(`${environment}: isolates ${transportFailure ? 'transport' : 'HTTP'} options per caller`,
      async () => {
        let fetches = 0;
        const requestOptions = [];
        const sourceError = new TypeError('Failed to fetch');
        const Hubkit = createHubkit(environment, async () => {
          fetches++;
          if (transportFailure) throw sourceError;
          return unauthorized();
        });
        const hubkit = new Hubkit({
          token: 'shared-token', maxTries: 1,
          onRequest: options => {requestOptions.push(options);},
          onReceive: () => {
            for (const options of requestOptions) options.token = 'changed-after-send';
          }
        });
        const results = await Promise.allSettled(['first', 'second'].map(caller =>
          hubkit.request('/user', {caller})));
        assert.equal(fetches, 1);
        assert.ok(results.every(result => result.status === 'rejected'));
        const errors = results.map(result => result.reason);
        assert.notEqual(errors[0], errors[1]);
        assert.notEqual(errors[0].options, errors[1].options);
        assert.equal(errors[0].options.caller, 'first');
        assert.equal(errors[1].options.caller, 'second');
        assert.equal(errors[0].options.token, 'shared-token');
        assert.equal(errors[1].options.token, 'shared-token');
        assert.equal(Object.hasOwn(sourceError, 'options'), false);
      });
  }

  test(`${environment}: options remain a snapshot when a request retries with a different token`,
    async () => {
      const tokens = [], errors = [];
      const Hubkit = createHubkit(environment, async (url, options) => {
        tokens.push(options.headers.Authorization);
        return unauthorized();
      });
      let requestOptions;
      const hubkit = new Hubkit({token: 'first-token', maxTries: 2});
      await assert.rejects(hubkit.request('/user', {
        onRequest: options => {requestOptions = options;},
        onError: error => {
          errors.push(error);
          requestOptions.token = 'second-token';
          return Hubkit.RETRY;
        }
      }), {status: 401});
      assert.deepEqual(tokens, ['token first-token', 'token second-token']);
      assert.deepEqual(errors.map(error => error.options.token), ['first-token', 'second-token']);
    });

  test(`${environment}: captures each attempt after onSend and before onReceive`, async () => {
    const tokens = [], errors = [];
    const Hubkit = createHubkit(environment, async (url, options) => {
      tokens.push(options.headers.Authorization);
      return unauthorized();
    });
    let requestOptions;
    const hubkit = new Hubkit({token: 'initial-token', maxTries: 2});
    await assert.rejects(hubkit.request('/user', {
      onRequest: options => {requestOptions = options;},
      onSend: async cause => {requestOptions.token = `${cause}-token`;},
      onReceive: () => {requestOptions.token = 'changed-after-send';},
      onError: error => {
        errors.push(error);
        return Hubkit.RETRY;
      }
    }), {status: 401});
    assert.deepEqual(tokens, ['token initial-token', 'token retry-token']);
    assert.deepEqual(errors.map(error => error.options.token), ['initial-token', 'retry-token']);
  });

  for (const graph of [false, true]) {
    for (const hook of ['onRequest', 'onSend', 'onReceive', 'onError']) {
      const method = graph ? 'graph' : 'request';
      test(`${environment}: ${method} decorates ${hook} exceptions`, async () => {
        let fetches = 0, handled = 0, requestOptions;
        const Hubkit = createHubkit(environment, async () => {
          fetches++;
          return unauthorized();
        });
        const failure = new Error(`${hook} failed`);
        failure.options = {token: 'unrelated-token'};
        const hubkit = new Hubkit({
          token: 'sent-token', cache: null, onRequest: opts => {requestOptions = opts;}
        });
        const options = {onError: () => {handled++;}};
        options[hook] = opts => {
          if (hook === 'onRequest') requestOptions = opts;
          if (hook === 'onError') handled++;
          requestOptions.token = 'changed-token';
          throw failure;
        };
        const request = graph ? hubkit.graph('query { viewer { login } }', options) :
          hubkit.request('/user', options);
        const beforeSend = ['onRequest', 'onSend'].includes(hook);
        await assert.rejects(request, error => {
          // Shared transports clone exceptions before caller-specific error processing.
          if (hook !== 'onReceive') assert.equal(error, failure);
          assert.equal(error.options.token, beforeSend ? 'changed-token' : 'sent-token');
          assert.equal(Object.getOwnPropertyDescriptor(error, 'options').enumerable, false);
          assert.equal(JSON.stringify(error).includes('sent-token'), false);
          return true;
        });
        assert.equal(fetches, beforeSend ? 0 : 1);
        assert.equal(handled, beforeSend ? 0 : 1);
      });
    }
  }

  for (const stage of [
    'path interpolation', 'GraphQL preprocessing', 'cache lookup', 'cache cleanup'
  ]) {
    test(`${environment}: decorates errors in ${stage}`, async () => {
      let fetches = 0, handled = 0;
      const Hubkit = createHubkit(environment, async () => {
        fetches++;
        return unauthorized();
      });
      const cache = Hubkit.defaults.cache;
      if (stage === 'cache lookup') cache.get = () => {throw new Error('cache lookup');};
      if (stage === 'cache cleanup') cache.delete = () => {throw new Error('cache cleanup');};
      const hubkit = new Hubkit({token: 'request-token', onError: () => {handled++;}});
      const request = stage === 'GraphQL preprocessing' ? hubkit.graph('query { #unknown(test) }') :
        hubkit.request(stage === 'path interpolation' ? '/repos/:missing' : '/user');
      await assert.rejects(request, error => {
        assert.equal(error.options.token, 'request-token');
        assert.equal(Object.getOwnPropertyDescriptor(error, 'options').enumerable, false);
        return true;
      });
      assert.equal(fetches, stage === 'cache cleanup' ? 1 : 0);
      assert.equal(handled, stage === 'cache cleanup' ? 1 : 0);
    });
  }

  test(`${environment}: preserves frozen errors and non-object rejection reasons`, async () => {
    const Hubkit = createHubkit(environment, () => assert.fail('Unexpected fetch'));
    const hubkit = new Hubkit({token: 'request-token'});
    const failure = Object.freeze(new TypeError('frozen failure', {cause: new Error('cause')}));
    await assert.rejects(hubkit.request('/user', {onRequest: () => {throw failure;}}), error => {
      assert.notEqual(error, failure);
      assert.ok(error instanceof TypeError);
      assert.equal(error.message, failure.message);
      assert.equal(error.stack, failure.stack);
      assert.equal(error.cause, failure.cause);
      assert.equal(error.options.token, 'request-token');
      assert.equal(Object.hasOwn(failure, 'options'), false);
      return true;
    });
    for (const reason of [null, undefined, 'failure', 42]) {
      await hubkit.request('/user', {onRequest: () => {throw reason;}}).then(
        () => assert.fail('Expected rejection'), error => assert.equal(error, reason));
    }
  });
}

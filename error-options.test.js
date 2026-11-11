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
        const sourceError = new TypeError('Failed to fetch');
        const Hubkit = createHubkit(environment, async () => {
          fetches++;
          if (transportFailure) throw sourceError;
          return unauthorized();
        });
        const hubkit = new Hubkit({token: 'shared-token', maxTries: 1});
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
}

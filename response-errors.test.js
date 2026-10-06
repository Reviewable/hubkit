'use strict';
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function createHubkit(status, body, contentType = 'application/json', headers = {}) {
  let requests = 0;
  const browser = {
    self: {}, lrucache: require('lru-cache'), URL, AbortController, DOMException,
    setTimeout, clearTimeout,
    fetch: async () => {
      requests++;
      return new globalThis.Response(body, {status, headers: {
        'content-type': contentType, 'x-ratelimit-remaining': '0', 'x-github-request-id': 'test-id',
        ...headers
      }});
    }
  };
  vm.runInNewContext(readFileSync(require.resolve('./hubkit.js'), 'utf8'), browser);
  return {Hubkit: browser.self.Hubkit, requests: () => requests};
}

for (const [message, expectedStatus] of [
  ['An internal error occurred, please try again.', 500],
  ['an internal error occurred', 500],
  ['Something went wrong while executing your query.', 500],
  ['Merging stacked PRs via this endpoint is not supported.', 400],
  ['Field does not exist on type Query.', 400]
]) {
  test(`GraphQL error classification: ${message}`, async () => {
    const errors = [{message}];
    const {Hubkit, requests} = createHubkit(200, JSON.stringify({errors}));
    await assert.rejects(new Hubkit().graph('query { viewer { login } }', {
      onError: () => Hubkit.DONT_RETRY
    }), error => {
      assert.equal(error.status, expectedStatus);
      assert.equal(error.response.status, 200);
      assert.equal(error.errors[0].message, message);
      assert.ok(error.message.includes(message));
      return true;
    });
    assert.equal(requests(), 1);
  });
}

for (const {name, type, message = name, status, headers, attempts, retryDelay} of [
  {name: 'server failure', message: 'Something went wrong', status: 500, attempts: 3},
  {
    name: 'secondary rate limit', type: 'RATE_LIMITED', status: 403,
    headers: {'retry-after': '0'}, attempts: 3, retryDelay: 0
  },
  {
    name: 'exhausted quota', type: 'RATE_LIMIT', status: 403,
    headers: {'x-ratelimit-reset': '1'}, attempts: 3, retryDelay: 0
  },
  {name: 'forbidden without retry headers', type: 'FORBIDDEN', status: 403, attempts: 1},
  {name: 'not found', type: 'NOT_FOUND', status: 404, attempts: 1},
  {name: 'validation failure', status: 400, attempts: 1}
]) {
  test(`GraphQL ${name} uses its synthesized status for retries`, async () => {
    const body = JSON.stringify({errors: [{type, message}]});
    const {Hubkit, requests} = createHubkit(200, body, 'application/json', headers);
    let callbacks = 0;
    await assert.rejects(new Hubkit().graph('query { viewer { login } }', {
      onError: error => {
        callbacks++;
        assert.equal(error.status, status);
        assert.equal(error.response.status, 200);
      }
    }), error => {
      assert.equal(error.status, status);
      assert.equal(error.response.status, 200);
      assert.equal(error.response.rawData, body);
      assert.equal(error.retryDelay, retryDelay);
      return true;
    });
    assert.equal(requests(), attempts);
    assert.equal(callbacks, attempts);
  });
}

for (const [type, message, status] of [
  [undefined, 'Something went wrong', 500], ['RATE_LIMITED', 'Rate limit exceeded', 403]
]) {
  test(`GraphQL ${status} retries honor onError overrides`, async () => {
    const body = JSON.stringify({errors: [{type, message}]});
    for (const recover of [false, true]) {
      const {Hubkit, requests} = createHubkit(200, body, 'application/json', {'retry-after': '0'});
      const promise = new Hubkit().graph('query { viewer { login } }', {
        onError: () => recover ? 'recovered' : Hubkit.DONT_RETRY
      });
      if (recover) assert.equal(await promise, 'recovered');
      else await assert.rejects(promise, {status});
      assert.equal(requests(), 1);
    }
  });
}

test('GraphQL rate-limit retries honor the request timeout', async () => {
  const body = JSON.stringify({errors: [{type: 'RATE_LIMITED', message: 'Rate limit exceeded'}]});
  const {Hubkit, requests} = createHubkit(200, body, 'application/json', {'retry-after': '2'});
  await assert.rejects(new Hubkit().graph('query { viewer { login } }', {timeout: 1000}), {
    status: 403, retryDelay: 2000
  });
  assert.equal(requests(), 1);
});

test('callback errors with a status need no response headers', async () => {
  const {Hubkit, requests} = createHubkit(200, '{}');
  const failure = Object.assign(new Error('Callback failed'), {status: 403});
  await assert.rejects(new Hubkit().request('/user', {
    onReceive: () => {
      throw failure;
    }
  }), error =>
    error !== failure && error.originalMessage === failure.message && error.status === 403);
  assert.equal(requests(), 1);
});

for (const options of [{}, {media: 'raw'}, {responseType: 'text'},
  {media: 'raw', responseType: 'blob'}, {responseType: 'arraybuffer'}]) {
  for (const [status, message, code] of [
    [403, 'Resource protected by organization SAML enforcement.', 'saml-enforcement'],
    [429, 'You have exceeded a secondary rate limit.', 'secondary-rate-limit'],
    [404, 'Not Found', undefined]
  ]) {
    test(`JSON HTTP ${status} retains its message with ${JSON.stringify(options)}`, async () => {
      const {Hubkit, requests} = createHubkit(status, JSON.stringify({message}));
      const metadata = {};
      let handledError;
      await assert.rejects(new Hubkit().request('/repos/o/r/git/blobs/sha', {
        ...options, metadata, onError: error => {
          handledError = error;
          return Hubkit.DONT_RETRY;
        }
      }), error => {
        assert.equal(error.status, status);
        assert.ok(error.message.includes(message));
        assert.equal(error, handledError);
        assert.equal(Hubkit.identify403Error(error)?.code, code);
        assert.equal(error.response.data.message, message);
        assert.equal(error.response.rawData, JSON.stringify({message}));
        assert.equal(error.response.headers['x-github-request-id'], 'test-id');
        return true;
      });
      assert.equal(metadata.rateLimitRemaining, 0);
      assert.equal(requests(), 1);
    });
  }
}

test('successful binary and raw JSON files retain their requested representation', async () => {
  const body = '{"message":"this is file content"}';
  for (const responseType of ['blob', 'arraybuffer', 'text']) {
    const {Hubkit} = createHubkit(200, body, 'text/plain');
    const result = await new Hubkit().request('/repos/o/r/git/blobs/sha', {
      media: 'raw', responseType
    });
    if (responseType === 'blob') {
      assert.ok(result instanceof globalThis.Blob);
      assert.equal(await result.text(), body);
    } else if (responseType === 'arraybuffer') {
      assert.ok(result instanceof ArrayBuffer);
      assert.equal(new globalThis.TextDecoder().decode(result), body);
    } else {
      assert.equal(result, body);
    }
  }
});

test('malformed JSON and non-JSON HTTP errors preserve their status and body', async () => {
  for (const [contentType, body] of [
    ['application/json', '{bad json'], ['text/html', '<h1>Unavailable</h1>'], ['text/plain', '']
  ]) {
    const {Hubkit, requests} = createHubkit(503, body, contentType);
    await assert.rejects(new Hubkit().request('/repos/o/r/git/blobs/sha', {
      media: 'raw', responseType: 'blob', onError: () => Hubkit.DONT_RETRY
    }), error => {
      assert.equal(error.status, 503);
      assert.equal(error.response.data, body);
      assert.equal(error.response.rawData, body);
      return true;
    });
    assert.equal(requests(), 1);
  }
});

// A JSON file requested as raw data must not be decoded just because of its Content-Type.
test('successful JSON responses with responseType remain raw data', async () => {
  const body = '{"message":"this is file content"}';
  for (const responseType of ['blob', 'arraybuffer', 'text']) {
    const {Hubkit} = createHubkit(200, body);
    const result = await new Hubkit().request('/repos/o/r/git/blobs/sha', {responseType});
    if (responseType === 'blob') {
      assert.ok(result instanceof globalThis.Blob);
      assert.equal(await result.text(), body);
    } else if (responseType === 'arraybuffer') {
      assert.ok(result instanceof ArrayBuffer);
      assert.equal(new globalThis.TextDecoder().decode(result), body);
    } else {
      assert.equal(result, body);
    }
  }
});

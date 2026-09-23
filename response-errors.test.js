'use strict';
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function createHubkit(status, body, contentType = 'application/json') {
  let requests = 0;
  const browser = {
    self: {}, lrucache: require('lru-cache'), URL, AbortController, setTimeout, clearTimeout,
    fetch: async () => {
      requests++;
      return new globalThis.Response(body, {status, headers: {
        'content-type': contentType, 'x-ratelimit-remaining': '0', 'x-github-request-id': 'test-id'
      }});
    }
  };
  vm.runInNewContext(readFileSync(require.resolve('./hubkit.js'), 'utf8'), browser);
  return {Hubkit: browser.self.Hubkit, requests: () => requests};
}

for (const options of [{}, {media: 'raw'}, {responseType: 'text'},
  {media: 'raw', responseType: 'blob'}, {responseType: 'arraybuffer'}]) {
  for (const [status, message, code] of [
    [403, 'Resource protected by organization SAML enforcement.', 'saml-enforcement'],
    [429, 'You have exceeded a secondary rate limit.', 'secondary-rate-limit']
  ]) {
    test(`JSON HTTP ${status} retains its message with ${JSON.stringify(options)}`, async () => {
      const {Hubkit, requests} = createHubkit(status, JSON.stringify({message}));
      const metadata = {};
      await assert.rejects(new Hubkit().request('/repos/o/r/git/blobs/sha', {
        ...options, metadata, onError: () => Hubkit.DONT_RETRY
      }), error => {
        assert.equal(error.status, status);
        assert.ok(error.message.includes(message));
        assert.equal(Hubkit.identify403Error(error).code, code);
        assert.equal(error.response.data.message, message);
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
      return true;
    });
    assert.equal(requests(), 1);
  }
});

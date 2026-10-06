'use strict';

const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(require.resolve('./hubkit.js'), 'utf8');
const query = 'query Read { viewer { login } }';
const mutation = 'mutation Write { createIssue(input: {}) { issue { id } } }';
const fragmentQuery = 'fragment F on User { login } query { viewer { ...F } }';
const partialFailure = {
  data: {createIssue: {issue: {id: 'created'}}},
  errors: [{message: 'Something went wrong'}]
};

function createHubkit(environment, failure) {
  let requests = 0;
  const sentBodies = [];
  const runtime = {
    self: {}, module: {}, lrucache: require('lru-cache'), URL, AbortController,
    setTimeout, clearTimeout,
    fetch: async (url, init) => {
      requests++;
      sentBodies.push(init.body ? JSON.parse(init.body) : Object.fromEntries(url.searchParams));
      if (failure === 'network') throw new Error('Connection closed');
      return new globalThis.Response(JSON.stringify(failure === 'graphql' ? partialFailure : {}), {
        status: failure === 'server' ? 503 : failure === 'quota' ? 403 : 200,
        headers: {'content-type': 'application/json', 'retry-after': '0'}
      });
    }
  };
  if (environment === 'Node') {
    runtime.process = {versions: {node: globalThis.process.versions.node}};
  }
  vm.runInNewContext(source, runtime);
  return {
    Hubkit: runtime.module.exports || runtime.self.Hubkit, requests: () => requests, sentBodies
  };
}

for (const environment of ['Node', 'browser']) {
  for (const useGraph of [false, true]) {
    for (const [document, idempotent, attempts] of [
      [fragmentQuery, true, 2], [query, false, 1], [fragmentQuery, 'true', 1]
    ]) {
      test(`${environment}: ${useGraph ? 'graph' : 'request'} flag ${JSON.stringify(idempotent)}`,
        async () => {
          const {Hubkit, requests, sentBodies} = createHubkit(environment, 'graphql');
          const body = Object.freeze({query: document});
          const options = Object.freeze({idempotent, body, maxTries: 2});
          const gh = new Hubkit();
          await assert.rejects(useGraph ? gh.graph(document, options) :
            gh.request('POST /graphql', options));
          assert.equal(requests(), attempts);
          for (const sentBody of sentBodies) {
            assert.equal(sentBody.query, document);
            assert.equal('idempotent' in sentBody, false);
          }
          assert.equal(options.idempotent, idempotent);
          assert.equal(body.query, document);
        });
    }
  }

  test(`${environment}: graph preserves scoped and per-call overrides`, async () => {
    const {Hubkit, requests} = createHubkit(environment, 'graphql');
    const gh = new Hubkit({idempotent: true, maxTries: 2});
    await assert.rejects(gh.graph(fragmentQuery));
    assert.equal(requests(), 2);
    await assert.rejects(gh.graph(fragmentQuery, {idempotent: false}));
    assert.equal(requests(), 3);
    await assert.rejects(gh.graph(fragmentQuery, {onError: () => Hubkit.DONT_RETRY}));
    assert.equal(requests(), 4);
    await assert.rejects(gh.graph(query, {
      idempotent: false, onError: () => Hubkit.RETRY
    }));
    assert.equal(requests(), 6);
  });

  for (const useGraph of [false, true]) {
    for (const [document, idempotent, attempts] of [
      [fragmentQuery, true, 2], [query, false, 1], [query, undefined, 2]
    ]) {
      test(`${environment}: ${useGraph ? 'graph' : 'request'} onRequest idempotent=${idempotent}`,
        async () => {
          const {Hubkit, requests} = createHubkit(environment, 'graphql');
          let callbacks = 0;
          const options = Object.freeze({
            body: Object.freeze({query: document}),
            async onRequest(requestOptions) {
              callbacks++;
              await Promise.resolve();
              requestOptions.idempotent = idempotent;
            }
          });
          const gh = new Hubkit({idempotent: idempotent === false, maxTries: 2});
          await assert.rejects(useGraph ? gh.graph(document, options) :
            gh.request('POST /graphql', options));
          assert.equal(requests(), attempts);
          assert.equal(callbacks, 1);
          assert.equal(gh.defaultOptions.idempotent, idempotent === false);
          assert.equal('idempotent' in options, false);
        });
    }
  }

  for (const path of ['/repos/o/r/issues', '/graphql']) {
    test(`${environment}: ${path} body.idempotent remains ordinary payload data`, async () => {
      const {Hubkit, requests, sentBodies} = createHubkit(environment, 'server');
      const body = Object.freeze({idempotent: true});
      await assert.rejects(new Hubkit().request(`POST ${path}`, {body, maxTries: 2}));
      assert.equal(requests(), 1);
      assert.deepEqual(sentBodies, [body]);
    });
  }

  for (const [method, idempotent, attempts] of [['POST', true, 2], ['GET', false, 1]]) {
    test(`${environment}: ${method} honors top-level idempotent=${idempotent}`, async () => {
      const {Hubkit, requests, sentBodies} = createHubkit(environment, 'server');
      await assert.rejects(new Hubkit().request(`${method} /repos/o/r/issues`, {
        idempotent, maxTries: 2
      }));
      assert.equal(requests(), attempts);
      assert.ok(sentBodies.every(body => !('idempotent' in body)));
    });
  }

  for (const failure of ['server', 'network', 'quota']) {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'TRACE', 'PUT', 'DELETE', 'POST', 'PATCH']) {
      test(`${environment}: ${method} ${failure} retries follow HTTP idempotency`, async () => {
        const {Hubkit, requests} = createHubkit(environment, failure);
        // A REST payload's "query" property must not opt a POST into retries.
        await assert.rejects(new Hubkit().request(`${method} /repos/o/r/issues`, {
          body: {query}, maxTries: 2
        }));
        assert.equal(requests(), ['POST', 'PATCH'].includes(method) ? 1 : 2);
      });
    }
  }

  for (const [name, document, operationName, retry] of [
    ['explicit query', query, undefined, true],
    ['shorthand query', '{ viewer { login } }', undefined, true],
    ['ignored prefix', '\uFEFF, # mutation Write\r\n\t' + query, undefined, true],
    ['comment before shorthand', '# mutation Write\r{ viewer { login } }', undefined, true],
    ['named query', query, 'Read', true],
    ['comment before operation name', 'query # mutation\n Read { viewer { login } }', 'Read', true],
    ['query selected from mixed document', query + '\n' + mutation, 'Read', true],
    ['mutation selected from mixed document', query + '\n' + mutation, 'Write', false],
    ['later selected query', mutation + '\n' + query, 'Read', false],
    ['mutation', mutation, undefined, false],
    ['comment before mutation', '# query Read\n' + mutation, undefined, false],
    ['subscription', 'subscription { changed { id } }', undefined, false],
    ['fragment first', 'fragment F on User { login } query { viewer { ...F } }', undefined, false],
    ['description first', '"Read the user" ' + query, undefined, false],
    ['query keyword prefix', 'querySomething { viewer { login } }', undefined, false],
    ['comment only', '# query Read { viewer { login } }', undefined, false],
    ['missing query', undefined, undefined, false]
  ]) {
    test(`${environment}: GraphQL ${name} is conservatively classified`, async () => {
      const {Hubkit, requests} = createHubkit(environment, 'graphql');
      await assert.rejects(new Hubkit().request('POST /graphql', {
        body: {query: document, operationName}, maxTries: 2
      }), error => {
        assert.equal(error.status, 500);
        assert.equal(error.response.status, 200);
        assert.equal(error.method, retry ? 'GET' : 'POST');
        assert.equal(error.data.createIssue.issue.id, 'created');
        return true;
      });
      assert.equal(requests(), retry ? 2 : 1);
    });
  }

  for (const failure of ['server', 'network', 'quota', 'graphql']) {
    test(`${environment}: mutation ${failure} retries require an explicit override`, async () => {
      for (const retry of [false, true]) {
        const {Hubkit, requests} = createHubkit(environment, failure);
        await assert.rejects(new Hubkit().graph(mutation, {
          maxTries: 2, onError: () => retry ? Hubkit.RETRY : undefined
        }));
        assert.equal(requests(), retry ? 2 : 1);
      }
    });
  }

  for (const status of [403, 500, 502, 503, 504]) {
    test(`${environment}: callback status ${status} cannot trigger retries`, async () => {
      for (const method of ['GET', 'POST']) {
        const {Hubkit, requests} = createHubkit(environment);
        const failure = Object.assign(new Error('Callback failed'), {status});
        await assert.rejects(new Hubkit().request(`${method} /repos/o/r/issues`, {
          onReceive: () => {
            throw failure;
          }
        }), error => error === failure);
        assert.equal(requests(), 1);
      }
    });
  }
}

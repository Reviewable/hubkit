'use strict';

const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const Hubkit = require('./index.js');

const browser = {self: {}, lrucache: require('lru-cache')};
vm.runInNewContext(readFileSync(require.resolve('./hubkit.js'), 'utf8'), browser);

const cases = [
  {
    message: 'Your account was suspended.',
    code: 'account-suspended', category: 'badauth', error: 'GitHub account suspended'
  },
  {
    message: 'Your email address must be verified.',
    code: 'email-unverified', category: 'badauth', error: 'Email address not verified'
  },
  {
    message: 'Resource protected by organization SAML enforcement.',
    code: 'saml-enforcement', category: 'badauth', error: 'Incomplete SAML authorization'
  },
  {
    message: 'You must have admin rights to this repository.',
    code: 'admin-required', category: 'badauth', error: 'No admin rights'
  },
  {
    message: 'You must enable two-factor authentication.',
    code: 'two-factor-required', category: 'badauth', error: 'Two-factor authentication not set up'
  },
  {
    message: 'The `example-org` organization has enabled OAuth App access restrictions.',
    code: 'oauth-app-restrictions', category: 'thirdparty',
    error: 'Third-party app restrictions in effect'
  },
  {
    message: 'Although you appear to have the correct authorization credentials, ' +
      'the `example-org` organization has an IP allow list enabled, and your IP address is not ' +
      'permitted to access this resource.',
    code: 'ip-allow-list', category: 'iprestricted', error: 'GitHub IP allow list blocks access'
  },
  {
    message: 'Repository access blocked.',
    code: 'access-blocked', category: 'notfound', error: 'Repository access blocked'
  },
  {
    message: 'You have exceeded a secondary rate limit. Please wait a few minutes.',
    code: 'secondary-rate-limit', quota: true
  },
  {
    message: 'API rate limit exceeded for user ID 1234.',
    code: 'rate-limit', quota: true
  }
];

for (const [environment, implementation] of [['Node', Hubkit], ['browser', browser.self.Hubkit]]) {
  for (const {message, ...expected} of cases) {
    test(`${environment}: identifies ${expected.code} from raw and wrapped messages`, () => {
      for (const prefix of [
        '',
        'GitHub error 403 on GET https://api.github.com/repos/first/repo: ',
        'Internal error: GitHub error 403 on POST https://ghe.example/api/graphql: '
      ]) {
        const text = prefix + message;
        for (const input of [text, new Error(text), {message: text}]) {
          assert.deepEqual({...implementation.identify403Error(input)}, expected);
        }
      }
    });
  }

  test(`${environment}: recognizes legacy quota wording and case variants`, () => {
    for (const message of [
      'API RATE LIMIT EXCEEDED', 'Your request quota is exhausted.',
      'You have triggered an abuse detection mechanism.'
    ]) {
      assert.deepEqual(
        {...implementation.identify403Error(message)}, {code: 'rate-limit', quota: true});
    }
    for (const {message, ...expected} of cases.filter(value => [
      'admin-required', 'two-factor-required', 'ip-allow-list', 'access-blocked'
    ].includes(value.code))) {
      assert.deepEqual({...implementation.identify403Error(message.toUpperCase())}, expected);
    }
  });

  test(`${environment}: preserves specific causes ahead of generic quota wording`, () => {
    for (const {message, ...expected} of cases.filter(value => value.category)) {
      assert.deepEqual(
        {...implementation.identify403Error(message + ' See rate limit documentation.')}, expected);
    }
  });

  test(`${environment}: leaves unknown causes unidentified`, () => {
    for (const message of [
      '', 'Forbidden', 'Resource not accessible by integration',
      'Your organization has an IP allow list enabled.'
    ]) {
      assert.equal(implementation.identify403Error(message), undefined);
      assert.equal(implementation.identify403Error(new Error(message)), undefined);
    }
  });

  test(`${environment}: quota failures cannot be mistaken for broad access errors`, () => {
    for (const {message} of cases.slice(-2)) {
      const reason = implementation.identify403Error(message);
      assert.equal(reason.quota, true);
      assert.equal(reason.category, undefined);
      assert.equal(reason.error, undefined);
    }
  });
}

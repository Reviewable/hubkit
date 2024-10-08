import reviewableConfigBaseline from 'reviewable-configs/eslint-config/baseline.js';

export default [
  ...reviewableConfigBaseline,
  {
    files: ['*.js'],
    languageOptions: {
      globals: {
        LRUCache: true,
        axios: true,
        Promise: false,
        setTimeout: false
      },
      ecmaVersion: 5,
      sourceType: 'script'
    },
    rules: {
      // These rules are incompatible with ES5, remove when updating ES version.
      'no-var': 'off',
      'prefer-arrow-callback': 'off',
      'object-shorthand': 'off'
    }
  },
  {
    files: ['index.js'],
    languageOptions: {
      sourceType: 'commonjs'
    }
  }
];

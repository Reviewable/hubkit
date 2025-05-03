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
      sourceType: 'script'
    }
  },
  {
    files: ['index.js'],
    languageOptions: {
      sourceType: 'commonjs'
    }
  }
];

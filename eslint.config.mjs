import reviewableConfigBaseline from 'reviewable-configs/eslint-config/baseline.js';

export default [
  ...reviewableConfigBaseline,
  {
    files: ['*.js'],
    languageOptions: {
      globals: {
        lrucache: true,
        btoa: false,
        fetch: false,
        Promise: false,
        URL: false
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

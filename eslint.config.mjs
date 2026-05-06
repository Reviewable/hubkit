import reviewableConfigBaseline from 'reviewable-configs/eslint-config/baseline.js';

export default [
  ...reviewableConfigBaseline,
  {
    files: ['*.js'],
    languageOptions: {
      globals: {
        lrucache: true,
        AbortSignal: false,
        btoa: false,
        fetch: false,
        Promise: false,
        setTimeout: false,
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

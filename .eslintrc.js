module.exports = {
  parserOptions: {
    ecmaVersion: 5
  },
  extends: ['eslint:recommended'],
  globals: {
    LRUCache: true,
    superagent: true,
    Promise: false,
    setTimeout: false
  },
  rules: {
    'accessor-pairs': 'error',
    'array-bracket-spacing': 'warn',
    'arrow-spacing': 'warn',
    'block-spacing': ['warn', 'never'],
    'brace-style': ['warn', '1tbs', {allowSingleLine: true}],
    'camelcase': 'error',
    'comma-spacing': 'warn',
    'comma-style': 'warn',
    'computed-property-spacing': 'warn',
    'curly': ['error', 'multi-line'],
    'dot-location': ['warn', 'property'],
    'dot-notation': 'warn',
    'eol-last': 'warn',
    'eqeqeq': 'error',
    'func-call-spacing': 'warn',
    'generator-star-spacing': 'warn',
    'indent': ['warn', 2, {
      SwitchCase: 1,
      MemberExpression: 'off',
      FunctionDeclaration: {parameters: 'off'},
      FunctionExpression: {parameters: 'off'}
    }],
    'key-spacing': ['warn', {mode: 'minimum'}],
    'keyword-spacing': 'warn',
    'linebreak-style': 'warn',
    'lines-between-class-members': 'warn',
    'max-len': ['warn', {code: 100, ignoreUrls: true, ignoreRegExpLiterals: true}],
    'new-cap': 'error',
    'new-parens': 'error',
    'no-alert': 'error',
    'no-array-constructor': 'error',
    'no-bitwise': ['error', {allow: ['~']}],
    'no-caller': 'error',
    'no-console': 'off',
    'no-constant-condition': ['error', {checkLoops: false}],
    'no-duplicate-imports': 'error',
    'no-else-return': 'error',
    'no-empty-function': 'error',
    'no-eval': 'error',
    'no-extend-native': 'error',
    'no-extra-bind': 'error',
    'no-extra-label': 'error',
    'no-floating-decimal': 'error',
    'no-implicit-globals': 'error',
    'no-implied-eval': 'error',
    'no-invalid-this': 'error',
    'no-iterator': 'error',
    'no-lone-blocks': 'error',
    'no-lonely-if': 'error',
    'no-loop-func': 'error',
    'no-multi-spaces': ['warn', {ignoreEOLComments: true}],
    'no-multi-str': 'warn',
    'no-multiple-empty-lines': 'warn',
    'no-new': 'error',
    'no-new-func': 'error',
    'no-new-object': 'error',
    'no-new-wrappers': 'error',
    'no-octal-escape': 'error',
    'no-proto': 'error',
    'no-script-url': 'error',
    'no-self-compare': 'error',
    'no-sequences': 'error',
    'no-shadow': 'error',
    'no-shadow-restricted-names': 'error',
    'no-tabs': 'warn',
    'no-template-curly-in-string': 'error',
    'no-throw-literal': 'error',
    'no-trailing-spaces': 'warn',
    'no-undef-init': 'error',
    'no-unexpected-multiline': 'off',
    'no-unmodified-loop-condition': 'error',
    'no-unneeded-ternary': 'error',
    'no-unused-expressions': 'error',
    'no-unused-vars': ['error', {args: 'none'}],
    'no-use-before-define': ['error', {functions: false}],
    'no-useless-call': 'error',
    'no-useless-computed-key': 'error',
    'no-useless-concat': 'error',
    'no-useless-constructor': 'error',
    'no-useless-rename': 'error',
    'no-useless-return': 'error',
    'no-whitespace-before-property': 'warn',
    'no-with': 'error',
    'nonblock-statement-body-position': 'error',
    'object-curly-spacing': 'warn',
    'operator-linebreak': ['warn', 'after'],
    // 'prefer-arrow-callback': 'error',  // turned off due to Angular
    'prefer-const': 'error',
    'prefer-numeric-literals': 'error',
    'prefer-promise-reject-errors': 'error',
    'quotes': ['error', 'single', {allowTemplateLiterals: true}],
    'radix': 'error',
    'rest-spread-spacing': 'warn',
    'semi': 'error',
    'semi-spacing': 'warn',
    'semi-style': 'warn',
    'space-before-blocks': 'warn',
    'space-before-function-paren': ['warn', 'never'],
    'space-in-parens': 'warn',
    'space-infix-ops': 'warn',
    'space-unary-ops': ['warn', {words: true, nonwords: false}],
    'spaced-comment': 'warn',
    'strict': ['error'],
    'switch-colon-spacing': 'warn',
    'template-curly-spacing': 'warn',
    'template-tag-spacing': 'warn',
    'unicode-bom': 'error',
    'yoda': 'error',
  }
};

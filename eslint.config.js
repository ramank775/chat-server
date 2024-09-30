const babelParser = require('@babel/eslint-parser');
const eslintPluginPrettier = require('eslint-plugin-prettier');
const eslintPluginNode = require('eslint-plugin-node');
const eslintConfigPrettier = require('eslint-config-prettier');
const eslintStylisticJs = require('@stylistic/eslint-plugin-js');

module.exports = [
  {
    ignores: ['node_modules/**'],
  },
  {
    languageOptions: {
      parser: babelParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        process: 'readonly',
        __dirname: 'readonly',
        module: 'readonly',
        require: 'readonly',
      },
      parserOptions: {
        requireConfigFile: false,
      },
    },
    plugins: {
      prettier: eslintPluginPrettier,
      node: eslintPluginNode,
      '@stylistic/js': eslintStylisticJs,
    },
    rules: {
      'prettier/prettier': 'error',
      'no-console': 'warn',
      'consistent-return': 'off',
      'no-process-exit': 'off',
      'no-param-reassign': 'off',
      'no-return-await': 'off',
      'no-underscore-dangle': 'off',
      'prefer-destructuring': [
        'error',
        {
          object: true,
          array: false,
        },
      ],
      'no-unused-vars': [
        'error',
        {
          ignoreRestSiblings: true,
          argsIgnorePattern: '^_',
        },
      ],
    },
    settings: {
      node: {
        tryExtensions: ['.js', '.json', '.node'],
      },
    },
  },
  eslintConfigPrettier,
];

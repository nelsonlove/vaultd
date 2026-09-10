"use strict";

const js = require("@eslint/js");
const tseslint = require("typescript-eslint");

/**
 * The TypeScript tree is linted with type information
 * (`recommendedTypeChecked`, not `recommended`). The rules that need it are the
 * ones that matter to this host: `no-floating-promises` and
 * `no-misused-promises` catch the bug class a single-FIFO async host suffers
 * from — a promise dropped on the floor, or one handed to something expecting a
 * synchronous callback — and neither can be seen without types.
 *
 * `tsconfig.test.json` is the project for the whole tree because it is the one
 * that includes `src` *and* `test`; the build config includes only `src`, and a
 * test file outside every project is a lint error rather than a lint pass.
 */
module.exports = [
  {
    ignores: ["**/dist/**", "**/node_modules/**"],
  },
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: {
        require: "readonly",
        module: "writable",
        exports: "writable",
        __dirname: "readonly",
        __filename: "readonly",
        process: "readonly",
        console: "readonly",
        // `test/fixtures/fake-vaultd.js` is a spawned Node program, so the
        // timer globals are as real for it as `process` is.
        setImmediate: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
    rules: js.configs.recommended.rules,
  },
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ["**/*.ts"],
  })),
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: ["./packages/host/tsconfig.test.json"],
        tsconfigRootDir: __dirname,
      },
    },
  },
];

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
    // `src/testing/pending/**` is excluded from `tsconfig.test.json`, and this
    // config lints the whole tree against that project — a file outside every
    // project is a lint error rather than a lint pass, so the two exclusions
    // have to move together. Each activating task drops its file from both.
    ignores: ["**/dist/**", "**/node_modules/**", "**/src/testing/pending/**"],
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

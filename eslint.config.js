if (typeof globalThis.structuredClone !== "function") {
  globalThis.structuredClone = (value) => JSON.parse(JSON.stringify(value));
}

const js = require("@eslint/js");
const importPlugin = require("eslint-plugin-import");

module.exports = [
  {
    ignores: [
      "node_modules/**",
      "logs/**",
      "tmp-*.log",
      "coverage/**",
      ".git/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    plugins: {
      import: importPlugin,
    },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: {
        __dirname: "readonly",
        Buffer: "readonly",
        clearInterval: "readonly",
        clearTimeout: "readonly",
        process: "readonly",
        require: "readonly",
        module: "readonly",
        setInterval: "readonly",
        setTimeout: "readonly",
        URL: "readonly",
      },
    },
    rules: {
      "no-console": "warn",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "import/extensions": ["error", "ignorePackages"],
    },
  },
  {
    files: ["public/**/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: {
        clearInterval: "readonly",
        clearTimeout: "readonly",
        console: "readonly",
        document: "readonly",
        fetch: "readonly",
        FormData: "readonly",
        history: "readonly",
        io: "readonly",
        localStorage: "readonly",
        location: "readonly",
        sessionStorage: "readonly",
        setInterval: "readonly",
        setTimeout: "readonly",
        URLSearchParams: "readonly",
        window: "readonly",
      },
    },
  },
  {
    files: ["tests/**/*.js", "scripts/**/*.js"],
    rules: {
      "no-console": "off",
    },
  },
];

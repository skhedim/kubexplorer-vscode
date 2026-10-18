// ESLint flat config: recommended JavaScript and TypeScript rules, plus layering rules.
// Layering: only src/vscode and src/extension.ts may use the VS Code API; the layers that also run
// in a browser (webview, preview) must not use Node.js modules.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

const vscodeImport = { name: "vscode", message: "Only src/vscode/ and src/extension.ts may import vscode." };

export default tseslint.config(
  { ignores: ["dist/", "out-test/", "media/dist/", ".vscode-test/", "node_modules/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      eqeqeq: ["error", "smart"],
      "no-restricted-imports": ["error", { paths: [vscodeImport] }],
    },
  },
  {
    files: ["src/resources/**", "src/panel/**", "src/shared/**", "src/webview/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [vscodeImport],
          patterns: [
            { group: ["node:*"], message: "These layers also run in a browser: no Node.js modules." },
            {
              group: ["**/kube/kubectl", "**/kube/helm", "**/kube/portForward"],
              allowTypeImports: true,
              message: "This module spawns processes: import types only.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/vscode/**", "src/extension.ts", "test/integration/**"],
    rules: { "no-restricted-imports": "off" },
  },
  {
    files: ["scripts/**", "*.mjs"],
    // Node.js scripts; Playwright callbacks (page.evaluate) also run in the browser.
    languageOptions: {
      globals: { process: "readonly", console: "readonly", URL: "readonly", document: "readonly", sessionStorage: "readonly" },
    },
  },
);

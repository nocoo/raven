import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  prettier,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // TODO(zhe-parity): enable to match zhe's strict tier. 34 existing
      // sites need refactor (mostly Glob.match results and protocol-known
      // arrays); tracked separately to keep this CI parallelization PR small.
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    ignores: [
      "node_modules/",
      ".next/",
      "dist/",
      "packages/proxy/data/",
      "coverage/",
    ],
  },
);

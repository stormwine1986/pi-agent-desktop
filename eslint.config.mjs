import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const eslintConfig = [
  {
    ignores: [
      ".claude/**",
      // Local agent state: skills of this machine and the scratch files a
      // session leaves behind (evidence, patch copies). Nothing here is
      // tracked; linting it only makes the gate depend on the day's leftovers.
      ".pi/**",
      ".next/**",
      ".next-desktop/**",
      "relay-shell/dist/**",
      "test-results/**",
      "src-tauri/resources/server/**",
      "src-tauri/target/**",
      // demo/ is a separate Next.js project with its own lint config.
      "demo/**",
      // Generated, minified library bundles (scripts/build-preview-runtime.mjs).
      "public/preview-runtime/**",
    ],
  },
  ...coreWebVitals,
  ...typescript,
  {
    rules: {
      "react-hooks/immutability": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
];

export default eslintConfig;

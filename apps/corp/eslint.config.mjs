import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

// eslint-config-next 16 ships real flat configs on its exports map, so they are
// imported directly. The previous setup ran them through FlatCompat, which
// pushed them back through the legacy eslintrc loader — that loader rejected
// the modern config shape and then crashed while formatting its own error
// ("Converting circular structure to JSON"), so `pnpm lint` exited 2 without
// ever linting a file. Nothing here needs the compat layer.
const eslintConfig = [
  { ignores: [".next/**", "out/**", "next-env.d.ts"] },
  ...coreWebVitals,
  ...typescript,
];

export default eslintConfig;

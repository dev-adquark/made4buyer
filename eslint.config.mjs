import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const config = [
  ...nextVitals,
  ...nextTs,
  { ignores: [".next/**", "node_modules/**", ".tmp/**", "test-results/**", "playwright-report/**", "next-env.d.ts", "docs/dry-run/**"] },
  {
    rules: {
      // Plain <img> is intentional: images come from arbitrary licensed hosts/CDNs and carry explicit width/height.
      "@next/next/no-img-element": "off",
    },
  },
];

export default config;

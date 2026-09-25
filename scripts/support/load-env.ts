import { existsSync } from "node:fs";

/** CLI scripts read the same env files as `next dev`: .env.local first, then .env (existing vars win). */
for (const file of [".env.local", ".env"]) {
  if (existsSync(file)) process.loadEnvFile(file);
}

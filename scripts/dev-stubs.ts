/**
 * LOCAL ONLY: serves the SAMPLE fixtures as a Content API, Apify/Keyword-to-Blog stubs and
 * merchant endpoints on 127.0.0.1 so the whole pipeline can run end-to-end on a
 * laptop. Loopback targets are refused by the SSRF guard unless the app is started with
 * UNSAFE_ALLOW_LOOPBACK_FOR_TESTS=true — never set that outside local development/tests.
 */
import { startStubServer } from "./support/stub-server";

async function main() {
  const stub = await startStubServer({ port: Number(process.env.STUB_PORT ?? 4010) });
  console.log(`SAMPLE stub server on ${stub.base}\n\nAdd to .env.local for a local end-to-end run:\n
CONTENT_API_URL="${stub.base}/content"
CONTENT_API_SOURCE_NAME="sample-fixture"
UNSAFE_ALLOW_LOOPBACK_FOR_TESTS="true"\n\nPress Ctrl+C to stop.`);
  process.on("SIGINT", async () => {
    await stub.close();
    process.exit(0);
  });
  await new Promise(() => undefined);
}

void main();

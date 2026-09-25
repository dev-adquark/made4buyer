/**
 * LOCAL ONLY: serves the SAMPLE fixtures as a Content API, a Sovrn-shaped offer API and
 * merchant/affiliate endpoints on 127.0.0.1 so the whole pipeline can run end-to-end on a
 * laptop. Loopback targets are refused by the SSRF guard unless the app is started with
 * UNSAFE_ALLOW_LOOPBACK_FOR_TESTS=true — never set that outside local development/tests.
 */
import { startStubServer } from "./support/stub-server";

async function main() {
  const stub = await startStubServer({ port: Number(process.env.STUB_PORT ?? 4010), sovrnKey: "local-sample-key" });
  console.log(`SAMPLE stub server on ${stub.base}\n\nAdd to .env.local for a local end-to-end run:\n
CONTENT_API_URL="${stub.base}/content"
CONTENT_API_SOURCE_NAME="sample-fixture"
SOVRN_API_URL="${stub.base}/sovrn"
SOVRN_API_KEY="local-sample-key"
UNSAFE_ALLOW_LOOPBACK_FOR_TESTS="true"\n\nPress Ctrl+C to stop.`);
  process.on("SIGINT", async () => {
    await stub.close();
    process.exit(0);
  });
  await new Promise(() => undefined);
}

void main();

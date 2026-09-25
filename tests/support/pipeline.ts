import { startStubServer } from "../../scripts/support/stub-server";
import { withEnv } from "./env";

/** Starts the SAMPLE stub and points Content API + Sovrn config at it. */
export async function sampleEnvironment(extra: Record<string, string | undefined> = {}) {
  const stub = await startStubServer({ sovrnKey: "sovrn-test" });
  const restore = withEnv({
    CONTENT_API_URL: `${stub.base}/content`,
    CONTENT_API_KEY: undefined,
    CONTENT_API_SOURCE_NAME: "sample-fixture",
    SOVRN_API_URL: `${stub.base}/sovrn`,
    SOVRN_API_KEY: "sovrn-test",
    AUTO_PUBLISH_ENABLED: undefined,
    ...extra,
  });
  return {
    stub,
    async close() {
      restore();
      await stub.close();
    },
  };
}

import { startStubServer } from "../../scripts/support/stub-server";
import { withEnv } from "./env";

/** Starts the SAMPLE stub and points the Content API and Keyword-to-Blog config at it. */
export async function sampleEnvironment(extra: Record<string, string | undefined> = {}) {
  const stub = await startStubServer();
  const restore = withEnv({
    CONTENT_API_URL: `${stub.base}/content`,
    CONTENT_API_KEY: undefined,
    CONTENT_API_SOURCE_NAME: "sample-fixture",
    KEYWORD_TO_BLOG_API_URL: `${stub.base}/ktb/v1/generate`,
    KEYWORD_TO_BLOG_API_KEY: "test-ktb-key",
    // Manual-flow tests: the automatic publish cycle is off unless a test turns it on.
    AUTO_PUBLISH_ENABLED: "false",
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

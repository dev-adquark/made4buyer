import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { forgetCategoryPhoto, loadCategoryPhotos } from "@/lib/public/category-images";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";

// SAMPLE data only: a local Pexels stub, never the real API.
// Answers like the Pexels search API (portrait + landscape renditions); 401 for any other key.
let server: Server;
let restore: () => void;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.headers.authorization !== "test-pexels-key") return void res.writeHead(401).end("{}");
    const q = new URL(req.url ?? "/", "http://x").searchParams.get("query") ?? "";
    const id = q.length * 7;
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({ photos: [{ url: `https://www.pexels.com/photo/${id}/`, alt: q, photographer: `Stub ${id}`, photographer_url: `https://www.pexels.com/@stub-${id}`, src: { portrait: `https://images.pexels.com/photos/${id}/p.jpeg`, landscape: `https://images.pexels.com/photos/${id}/l.jpeg` } }] }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  restore = withEnv({ PEXELS_API_KEY: "test-pexels-key", PEXELS_API_BASE_URL: `http://127.0.0.1:${port}/v1`, UNSAFE_ALLOW_LOOPBACK_FOR_TESTS: "true" });
});
afterAll(async () => {
  restore();
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(async () => {
  await resetDb();
  await db.automationSetting.deleteMany({ where: { key: "category-photos:last-good" } });
});

describe("category photos: last known good", () => {
  it("keeps showing the stored photo when Pexels refuses (rate limit, auth) instead of an empty slot", async () => {
    const first = await loadCategoryPhotos(["phones", "audio"]);
    expect(first.phones?.url).toMatch(/^https:\/\/images\.pexels\.com\//);
    expect(first.audio?.photographer).toBeTruthy();

    // A week later Pexels refuses every request: the stored copies are still served.
    const off = withEnv({ PEXELS_API_KEY: "wrong" });
    const later = await loadCategoryPhotos(["phones", "audio"], Date.now() + 8 * 86_400_000);
    off();
    expect(later.phones).toEqual(first.phones);
    expect(later.audio).toEqual(first.audio);
  });

  it("asks Pexels only for categories without a fresh stored photo", async () => {
    await loadCategoryPhotos(["phones"]);
    const off = withEnv({ PEXELS_API_KEY: "wrong" });
    const r = await loadCategoryPhotos(["phones", "audio"]);
    off();
    expect(r.phones).not.toBeNull();
    expect(r.audio).toBeNull();
  });

  it("forgets a photo that no longer loads so the next read fetches another", async () => {
    await loadCategoryPhotos(["phones"]);
    await forgetCategoryPhoto("phones");
    const off = withEnv({ PEXELS_API_KEY: "wrong" });
    expect((await loadCategoryPhotos(["phones"])).phones).toBeNull();
    off();
  });
});

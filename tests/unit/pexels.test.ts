import { describe, expect, it } from "vitest";
import { distinctiveTokens, pickRelevantPhoto, type PexelsPhoto } from "@/lib/pipeline/pexels";

const photo = (id: number, alt: string): PexelsPhoto => ({ id, alt, url: `https://www.pexels.com/photo/${id}/`, photographer: "P", width: 1600, height: 1000, src: { large: `https://images.pexels.com/${id}.jpg`, large2x: "", landscape: "" } });

describe("Pexels relevance", () => {
  it("extracts distinctive product tokens", () => {
    expect(distinctiveTokens("Apple MacBook Air 13 (M4)", "Apple")).toEqual(["macbook", "air"]);
    expect(distinctiveTokens("Pixel 10", "Google")).toEqual(["pixel"]);
    expect(distinctiveTokens("Laptop Pro", null)).toEqual([]);
  });
  it("accepts only photos that name the product and no other brand", () => {
    const photos = [photo(1, "A laptop on a wooden desk"), photo(2, "Dell XPS laptop next to a MacBook"), photo(3, "Close-up of a MacBook Air keyboard"), photo(4, "MacBook Air and coffee")];
    expect(pickRelevantPhoto(photos, "MacBook Air 13 (M4)", "Apple")?.photo.id).toBe(3);
    expect(pickRelevantPhoto([photos[0]], "MacBook Air 13 (M4)", "Apple")).toBeNull();
    expect(pickRelevantPhoto([photos[1]], "MacBook Air 13 (M4)", "Apple")).toBeNull();
  });
  it("requires two distinctive tokens for multi-word products", () => {
    expect(pickRelevantPhoto([photo(6, "Black screen with code")], "Visual Studio Code", "Microsoft")).toBeNull();
    expect(pickRelevantPhoto([photo(7, "Visual Studio Code open on a monitor")], "Visual Studio Code", "Microsoft")?.photo.id).toBe(7);
  });
  it("rejects photos of a different model version", () => {
    expect(pickRelevantPhoto([photo(8, "Logitech MX Master 3 wireless mouse box on a desk")], "MX Master 4", "Logitech")).toBeNull();
    expect(pickRelevantPhoto([photo(9, "Logitech MX Master 4 mouse on a desk")], "MX Master 4", "Logitech")?.photo.id).toBe(9);
    expect(pickRelevantPhoto([photo(10, "Google Pixel 9 in hand")], "Pixel 10", "Google")).toBeNull();
  });
  it("never matches on generic words alone", () => {
    expect(pickRelevantPhoto([photo(5, "Black wireless headphones on a table")], "Wireless Headphones Pro", null)).toBeNull();
  });
});

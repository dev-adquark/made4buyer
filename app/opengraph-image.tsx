import { ImageResponse } from "next/og";

export const alt = "Made4Buyers: Buy less. Buy right.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/** Default share card: the tear-sheet wordmark on paper. Pages with a real photo override it. */
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", background: "#eeebe3", color: "#18181c", padding: "72px 80px", fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center", fontSize: 44, fontWeight: 800 }}>
          Made
          <span style={{ background: "#18181c", color: "#eeebe3", padding: "0 14px", margin: "0 6px" }}>4</span>
          Buyers
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ fontSize: 120, fontWeight: 900, lineHeight: 1, letterSpacing: -4 }}>Buy less.</div>
          <div style={{ fontSize: 120, fontWeight: 900, lineHeight: 1, letterSpacing: -4 }}>Buy right.</div>
        </div>
        <div style={{ display: "flex", borderTop: "3px solid #18181c", paddingTop: 20, fontSize: 28 }}>A universal buying guide: reviews filed by what you need, offers checked before they are shown.</div>
      </div>
    ),
    size,
  );
}

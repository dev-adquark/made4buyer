/**
 * Visual quality tier for the 3D hero.
 *   0 — no WebGL (reduced motion, save-data, software renderer, weak device): static art
 *   1 — light 3D, few particles (phones / modest hardware)
 *   2 — full interactive 3D
 *   3 — full 3D + dense particles + glow halos
 * `?tier=N` in the URL overrides detection (visual QA).
 */
export type Tier = 0 | 1 | 2 | 3;

export function detectTier(): Tier {
  if (typeof window === "undefined") return 0;
  const forced = new URLSearchParams(window.location.search).get("tier");
  if (forced && /^[0-3]$/.test(forced)) return Number(forced) as Tier;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return 0;
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
  if (nav.connection?.saveData) return 0;
  let renderer = "";
  try {
    const canvas = document.createElement("canvas");
    const gl = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as WebGLRenderingContext | null;
    if (!gl) return 0;
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    renderer = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "";
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    return 0;
  }
  if (/swiftshader|llvmpipe|software|basic render/i.test(renderer)) return 0;
  const memory = nav.deviceMemory ?? 4;
  const cores = navigator.hardwareConcurrency ?? 4;
  const mobile = window.matchMedia("(pointer: coarse)").matches || window.innerWidth < 720;
  if (mobile) return memory >= 4 && cores >= 6 ? 1 : 0;
  if (cores >= 8 && memory >= 8) return 3;
  if (cores >= 4) return 2;
  return 1;
}

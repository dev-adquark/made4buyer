"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import type { Tier } from "./tier";

/**
 * Decorative procedural device constellation (laptop, phone, headphones, keyboard card).
 * Everything is generated in code: no downloaded models or textures, no licensing issues,
 * ~0 KB of assets. Rendering pauses when off-screen or when the tab is hidden.
 */

function gradientTexture(stops: string[], w = 256, h = 160, glyphs = true) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, w, h);
  stops.forEach((s, i) => grad.addColorStop(i / (stops.length - 1), s));
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  if (glyphs) {
    // Abstract UI chrome: bars and a card, not text or product claims.
    g.fillStyle = "rgba(255,255,255,0.85)";
    g.fillRect(w * 0.08, h * 0.12, w * 0.42, h * 0.07);
    g.fillStyle = "rgba(255,255,255,0.45)";
    g.fillRect(w * 0.08, h * 0.26, w * 0.62, h * 0.05);
    g.fillRect(w * 0.08, h * 0.36, w * 0.54, h * 0.05);
    g.fillStyle = "rgba(255,255,255,0.22)";
    g.fillRect(w * 0.08, h * 0.52, w * 0.38, h * 0.34);
    g.fillRect(w * 0.52, h * 0.52, w * 0.38, h * 0.34);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function haloTexture(color: string) {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, color);
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

const shell = () => new THREE.MeshPhysicalMaterial({ color: "#e9edf8", metalness: 0.55, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.2 });

function Floating({ children, speed = 1, amp = 0.12, phase = 0, spin = 0.15, hoverScale = 1.08, position }: { children: React.ReactNode; speed?: number; amp?: number; phase?: number; spin?: number; hoverScale?: number; position: [number, number, number] }) {
  const ref = useRef<THREE.Group>(null);
  const [hover, setHover] = useState(false);
  useFrame(({ clock }, dt) => {
    const g = ref.current;
    if (!g) return;
    const t = clock.elapsedTime * speed + phase;
    g.position.y = position[1] + Math.sin(t) * amp;
    g.rotation.y += dt * spin;
    g.rotation.x = Math.sin(t * 0.7) * 0.08;
    const target = hover ? hoverScale : 1;
    g.scale.setScalar(THREE.MathUtils.lerp(g.scale.x, target, 0.1));
  });
  return (
    <group ref={ref} position={position} onPointerOver={() => setHover(true)} onPointerOut={() => setHover(false)}>
      {children}
    </group>
  );
}

function Laptop() {
  const screen = useMemo(() => gradientTexture(["#0ea5e9", "#2b59ff", "#7b3ff2"]), []);
  const base = useMemo(() => new RoundedBoxGeometry(2.2, 0.09, 1.5, 3, 0.05), []);
  const lid = useMemo(() => new RoundedBoxGeometry(2.2, 1.45, 0.07, 3, 0.05), []);
  const mat = useMemo(() => shell(), []);
  return (
    <group rotation={[0.15, -0.5, 0]}>
      <mesh geometry={base} material={mat} />
      <group position={[0, 0.05, -0.72]} rotation={[-0.25, 0, 0]}>
        <mesh geometry={lid} material={mat} position={[0, 0.72, 0]} />
        <mesh position={[0, 0.74, 0.04]}>
          <planeGeometry args={[2.0, 1.25]} />
          <meshBasicMaterial map={screen} toneMapped={false} />
        </mesh>
      </group>
    </group>
  );
}

function Phone() {
  const screen = useMemo(() => gradientTexture(["#c026d3", "#7b3ff2", "#ff5a5f"], 160, 320), []);
  const body = useMemo(() => new RoundedBoxGeometry(0.75, 1.5, 0.09, 4, 0.1), []);
  const mat = useMemo(() => shell(), []);
  return (
    <group rotation={[0.1, 0.4, -0.12]}>
      <mesh geometry={body} material={mat} />
      <mesh position={[0, 0, 0.05]}>
        <planeGeometry args={[0.66, 1.38]} />
        <meshBasicMaterial map={screen} toneMapped={false} />
      </mesh>
    </group>
  );
}

function Headphones() {
  const band = useMemo(() => new THREE.TorusGeometry(0.55, 0.06, 16, 48, Math.PI), []);
  const cup = useMemo(() => new THREE.CylinderGeometry(0.24, 0.24, 0.2, 32), []);
  const mat = useMemo(() => new THREE.MeshPhysicalMaterial({ color: "#ff7a1a", metalness: 0.3, roughness: 0.35, clearcoat: 1 }), []);
  const cushion = useMemo(() => new THREE.MeshStandardMaterial({ color: "#1b1f4b", roughness: 0.8 }), []);
  return (
    <group rotation={[0.2, 0.6, 0.1]}>
      <mesh geometry={band} material={mat} />
      {[-0.55, 0.55].map((x) => (
        <group key={x} position={[x, -0.05, 0]} rotation={[0, 0, Math.PI / 2]}>
          <mesh geometry={cup} material={mat} />
          <mesh position={[0, x < 0 ? 0.11 : -0.11, 0]} geometry={cup} material={cushion} scale={[0.85, 0.2, 0.85]} />
        </group>
      ))}
    </group>
  );
}

function InterfaceCard() {
  const face = useMemo(() => gradientTexture(["#34d399", "#059669", "#0ea5e9"], 256, 160), []);
  const geo = useMemo(() => new RoundedBoxGeometry(1.3, 0.82, 0.04, 3, 0.06), []);
  return (
    <group rotation={[-0.1, -0.35, 0.08]}>
      <mesh geometry={geo}>
        <meshPhysicalMaterial color="#ffffff" transmission={0.4} roughness={0.15} thickness={0.2} transparent opacity={0.9} />
      </mesh>
      <mesh position={[0, 0, 0.025]}>
        <planeGeometry args={[1.2, 0.72]} />
        <meshBasicMaterial map={face} toneMapped={false} transparent opacity={0.92} />
      </mesh>
    </group>
  );
}

function Particles({ count }: { count: number }) {
  const ref = useRef<THREE.Points>(null);
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const palette = ["#5ee7ff", "#8fb0ff", "#cfb3ff", "#ff9ad9", "#ffe58a"].map((c) => new THREE.Color(c));
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < count; i++) {
      const r = 3 + rand() * 5;
      const th = rand() * Math.PI * 2;
      const ph = Math.acos(2 * rand() - 1);
      pos.set([r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph) * 0.6, r * Math.sin(ph) * Math.sin(th) - 2], i * 3);
      const c = palette[i % palette.length];
      col.set([c.r, c.g, c.b], i * 3);
    }
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    return g;
  }, [count]);
  useFrame((_, dt) => {
    if (ref.current) ref.current.rotation.y += dt * 0.02;
  });
  return (
    <points ref={ref} geometry={geometry}>
      <pointsMaterial size={0.035} vertexColors transparent opacity={0.8} depthWrite={false} blending={THREE.AdditiveBlending} />
    </points>
  );
}

function Halo({ color, position, scale }: { color: string; position: [number, number, number]; scale: number }) {
  const map = useMemo(() => haloTexture(color), [color]);
  return (
    <sprite position={position} scale={[scale, scale, 1]}>
      <spriteMaterial map={map} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
    </sprite>
  );
}

/** Mouse parallax + scroll drift applied to the whole constellation. */
function Rig({ children }: { children: React.ReactNode }) {
  const ref = useRef<THREE.Group>(null);
  const narrow = useThree((s) => s.size.width < 520);
  const pointer = useRef({ x: 0, y: 0 });
  const scroll = useRef(0);
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      pointer.current = { x: e.clientX / window.innerWidth - 0.5, y: e.clientY / window.innerHeight - 0.5 };
    };
    const onScroll = () => {
      scroll.current = Math.min(1, window.scrollY / 700);
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);
  useFrame(() => {
    const g = ref.current;
    if (!g) return;
    g.rotation.y = THREE.MathUtils.lerp(g.rotation.y, pointer.current.x * 0.35, 0.05);
    g.rotation.x = THREE.MathUtils.lerp(g.rotation.x, pointer.current.y * 0.2 + scroll.current * 0.25, 0.05);
    g.position.y = THREE.MathUtils.lerp(g.position.y, scroll.current * 0.8, 0.08);
  });
  return (
    <group ref={ref} scale={narrow ? 0.78 : 1}>
      {children}
    </group>
  );
}

export default function HeroScene({ tier }: { tier: Tier }) {
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting && !document.hidden), { threshold: 0 });
    io.observe(el);
    const onVis = () => setVisible(!document.hidden && el.getBoundingClientRect().bottom > 0);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);
  const particles = tier >= 3 ? 1400 : tier === 2 ? 700 : 220;
  return (
    <div ref={host} className="hero-canvas" aria-hidden="true">
      <Canvas
        frameloop={visible ? "always" : "never"}
        dpr={tier >= 2 ? [1, 1.75] : [1, 1.25]}
        camera={{ position: [0, 0, 6.6], fov: 42 }}
        gl={{ antialias: tier >= 2, alpha: true, powerPreference: tier >= 2 ? "high-performance" : "low-power" }}
        onCreated={({ gl }) => gl.setClearColor(0x000000, 0)}
      >
        <ambientLight intensity={0.55} />
        <directionalLight position={[3, 4, 5]} intensity={1.6} />
        <pointLight position={[-4, 1, 2]} color="#00c2e0" intensity={30} distance={12} />
        <pointLight position={[4, -2, 2]} color="#e6339e" intensity={30} distance={12} />
        <pointLight position={[0, 3, -2]} color="#7b3ff2" intensity={18} distance={10} />
        <Rig>
          <Floating position={[-0.4, 0.35, 0]} speed={0.8} spin={0.12}>
            <Laptop />
          </Floating>
          <Floating position={[1.9, -0.6, 0.6]} speed={1.1} phase={1.3} spin={-0.18}>
            <Phone />
          </Floating>
          {tier >= 2 && (
            <Floating position={[-2.1, -1.1, 0.4]} speed={0.95} phase={2.4} spin={0.22}>
              <Headphones />
            </Floating>
          )}
          {tier >= 2 && (
            <Floating position={[1.5, 1.55, -0.8]} speed={0.7} phase={3.1} spin={0.05} amp={0.08}>
              <InterfaceCard />
            </Floating>
          )}
          {tier >= 3 && (
            <>
              <Halo color="rgba(0,194,224,0.55)" position={[-0.4, 0.4, -1.2]} scale={4.5} />
              <Halo color="rgba(230,51,158,0.5)" position={[2, -0.6, -1]} scale={3} />
            </>
          )}
        </Rig>
        <Particles count={particles} />
      </Canvas>
    </div>
  );
}

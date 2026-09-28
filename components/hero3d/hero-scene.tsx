"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { Tier } from "./tier";

/**
 * The Made4Buyers prism: one white beam enters a glass prism and leaves as the category
 * spectrum. Fully procedural (no models or textures to license). Rendering pauses when the
 * hero is off-screen or the tab is hidden.
 */

// Category beam colours, in the order they fan out (top to bottom).
const BEAMS = ["#00b8f0", "#3d5afe", "#7c4dff", "#e6339e", "#ff6a3d", "#ffc23d"];

function beamTexture(color: string, fadeIn = false) {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 16;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 256, 0);
  const col = new THREE.Color(color);
  const rgba = (a: number) => `rgba(${Math.round(col.r * 255)},${Math.round(col.g * 255)},${Math.round(col.b * 255)},${a})`;
  grad.addColorStop(0, rgba(fadeIn ? 0 : 1));
  grad.addColorStop(fadeIn ? 0.5 : 0.25, rgba(1));
  grad.addColorStop(1, rgba(fadeIn ? 1 : 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 16);
  // Soft vertical falloff so the beam reads as light, not a bar.
  const v = g.createLinearGradient(0, 0, 0, 16);
  v.addColorStop(0, "rgba(0,0,0,1)");
  v.addColorStop(0.5, "rgba(0,0,0,0)");
  v.addColorStop(1, "rgba(0,0,0,1)");
  g.globalCompositeOperation = "destination-out";
  g.fillStyle = v;
  g.fillRect(0, 0, 256, 16);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function Beam({ color, from, angle, length, width, fadeIn = false, phase = 0 }: { color: string; from: [number, number, number]; angle: number; length: number; width: number; fadeIn?: boolean; phase?: number }) {
  const map = useMemo(() => beamTexture(color, fadeIn), [color, fadeIn]);
  const ref = useRef<THREE.MeshBasicMaterial>(null);
  useFrame(({ clock }) => {
    if (ref.current) ref.current.opacity = 0.75 + Math.sin(clock.elapsedTime * 1.4 + phase) * 0.2;
  });
  // Plane anchored at its start point, rotated to the beam angle.
  return (
    <group position={from} rotation={[0, 0, angle]}>
      <mesh position={[fadeIn ? -length / 2 : length / 2, 0, 0]}>
        <planeGeometry args={[length, width]} />
        <meshBasicMaterial ref={ref} map={map} transparent depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

function Prism({ tier }: { tier: Tier }) {
  const ref = useRef<THREE.Group>(null);
  const geo = useMemo(() => new THREE.CylinderGeometry(1.25, 1.25, 1.6, 3, 1), []);
  const edges = useMemo(() => new THREE.EdgesGeometry(geo), [geo]);
  useFrame(({ clock }) => {
    const g = ref.current;
    if (!g) return;
    g.rotation.y = Math.sin(clock.elapsedTime * 0.35) * 0.35;
  });
  return (
    <group ref={ref} rotation={[Math.PI / 2, 0, Math.PI / 6]}>
      <mesh geometry={geo}>
        {tier >= 2 ? (
          <meshPhysicalMaterial color="#e8ecff" transmission={0.92} thickness={1.1} roughness={0.06} ior={1.5} iridescence={1} iridescenceIOR={1.3} clearcoat={1} transparent opacity={0.9} />
        ) : (
          <meshStandardMaterial color="#c9d1ff" metalness={0.1} roughness={0.15} transparent opacity={0.35} />
        )}
      </mesh>
      <lineSegments geometry={edges}>
        <lineBasicMaterial color="#ffffff" transparent opacity={0.85} />
      </lineSegments>
    </group>
  );
}

function Motes({ count }: { count: number }) {
  const ref = useRef<THREE.Points>(null);
  const { geometry, seeds } = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const seeds = new Float32Array(count * 2);
    let s = 11;
    const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < count; i++) {
      const beam = i % BEAMS.length;
      const c = new THREE.Color(BEAMS[beam]);
      col.set([c.r, c.g, c.b], i * 3);
      seeds.set([beam, rand()], i * 2);
    }
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    return { geometry: g, seeds };
  }, [count]);
  useFrame(({ clock }) => {
    const pts = ref.current;
    if (!pts) return;
    const attr = pts.geometry.getAttribute("position") as THREE.BufferAttribute;
    const t = clock.elapsedTime;
    for (let i = 0; i < count; i++) {
      const beam = seeds[i * 2];
      const angle = (0.42 - beam * 0.17) as number;
      const d = ((seeds[i * 2 + 1] + t * 0.08) % 1) * 5.2;
      const jitter = Math.sin(i * 12.9898 + t) * 0.05;
      attr.setXYZ(i, 0.6 + Math.cos(angle) * d, Math.sin(angle) * d + jitter, Math.sin(i) * 0.3);
    }
    attr.needsUpdate = true;
  });
  return (
    <points ref={ref} geometry={geometry}>
      <pointsMaterial size={0.05} vertexColors transparent opacity={0.9} depthWrite={false} blending={THREE.AdditiveBlending} />
    </points>
  );
}

function Rig({ children }: { children: React.ReactNode }) {
  const ref = useRef<THREE.Group>(null);
  const narrow = useThree((s) => s.size.width < 520);
  const pointer = useRef({ x: 0, y: 0 });
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      pointer.current = { x: e.clientX / window.innerWidth - 0.5, y: e.clientY / window.innerHeight - 0.5 };
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, []);
  useFrame(() => {
    const g = ref.current;
    if (!g) return;
    g.rotation.y = THREE.MathUtils.lerp(g.rotation.y, pointer.current.x * 0.4, 0.05);
    g.rotation.x = THREE.MathUtils.lerp(g.rotation.x, pointer.current.y * 0.25, 0.05);
  });
  return (
    <group ref={ref} scale={narrow ? 0.72 : 1} position={[narrow ? -0.4 : -0.6, 0, 0]}>
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
  const motes = tier >= 3 ? 900 : tier === 2 ? 420 : 0;
  return (
    <div ref={host} className="hero-canvas" aria-hidden="true">
      <Canvas
        frameloop={visible ? "always" : "never"}
        dpr={tier >= 2 ? [1, 1.75] : [1, 1.25]}
        camera={{ position: [0, 0, 7], fov: 40 }}
        gl={{ antialias: tier >= 2, alpha: true, powerPreference: tier >= 2 ? "high-performance" : "low-power" }}
        onCreated={({ gl }) => gl.setClearColor(0x000000, 0)}
      >
        <ambientLight intensity={0.6} />
        <directionalLight position={[2, 4, 5]} intensity={2} />
        <pointLight position={[-3, 0, 2]} color="#ffffff" intensity={20} distance={10} />
        <pointLight position={[3, 1, 1]} color="#7c4dff" intensity={25} distance={10} />
        <Rig>
          <Beam color="#ffffff" from={[-0.55, -0.05, 0]} angle={-0.12} length={4.2} width={0.16} fadeIn />
          {BEAMS.map((c, i) => (
            <Beam key={c} color={c} from={[0.55, 0.02, 0]} angle={0.42 - i * 0.17} length={5.4} width={tier >= 2 ? 0.32 : 0.24} phase={i * 0.9} />
          ))}
          <Prism tier={tier} />
          {motes > 0 && <Motes count={motes} />}
        </Rig>
      </Canvas>
    </div>
  );
}

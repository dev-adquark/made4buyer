import net from "node:net";

/**
 * Address classification for SSRF protection. Anything that is not a globally routable
 * unicast address is refused: loopback, private, link-local, CGNAT, multicast,
 * documentation ranges, unique-local IPv6, IPv4-mapped/NAT64 forms of those, etc.
 */

const V4_BLOCKED: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

const V6_BLOCKED: Array<[string, number]> = [
  ["::", 128],
  ["::1", 128],
  ["100::", 64],
  ["2001:db8::", 32],
  ["2001::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
];

const blockList = new net.BlockList();
for (const [addr, prefix] of V4_BLOCKED) blockList.addSubnet(addr, prefix, "ipv4");
for (const [addr, prefix] of V6_BLOCKED) blockList.addSubnet(addr, prefix, "ipv6");

const loopback = new net.BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");

function embeddedIpv4(address: string): string | undefined {
  const lower = address.toLowerCase();
  // ::ffff:a.b.c.d, ::a.b.c.d, 64:ff9b::a.b.c.d
  const dotted = lower.match(/^(?:::ffff:|::|64:ff9b::)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) return dotted[1];
  // ::ffff:7f00:1 (hex form)
  const hex = lower.match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
  }
  return undefined;
}

export function isLoopbackAddress(address: string): boolean {
  const a = address.replace(/^\[|\]$/g, "");
  const family = net.isIP(a);
  if (family === 4) return loopback.check(a, "ipv4");
  if (family === 6) {
    const v4 = embeddedIpv4(a);
    return v4 ? loopback.check(v4, "ipv4") : loopback.check(a, "ipv6");
  }
  return false;
}

/** True when the literal IP address must never be contacted. */
export function isBlockedAddress(address: string, opts: { allowLoopback?: boolean } = {}): boolean {
  const a = address.replace(/^\[|\]$/g, "");
  const family = net.isIP(a);
  if (family === 0) return true; // not an IP: callers must resolve first
  if (opts.allowLoopback && isLoopbackAddress(a)) return false;
  if (family === 4) return blockList.check(a, "ipv4");
  const v4 = embeddedIpv4(a);
  if (v4) return blockList.check(v4, "ipv4");
  return blockList.check(a, "ipv6");
}

const INTERNAL_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home", ".corp", ".localdomain", ".home.arpa"];

/** Hostname-level checks that happen before DNS resolution. */
export function isBlockedHostname(hostname: string, opts: { allowLoopback?: boolean } = {}): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (net.isIP(host)) return isBlockedAddress(host, opts);
  if (host === "localhost") return !opts.allowLoopback;
  if (INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) return !(opts.allowLoopback && host.endsWith(".localhost"));
  // Single-label hosts (e.g. "metadata", "db") are internal names.
  if (!host.includes(".")) return true;
  // Numeric-looking hosts that are not valid dotted quads (e.g. "2130706433", "0x7f.1") are refused.
  if (/^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+))*$/i.test(host)) return true;
  return false;
}

const MULTI_LABEL_SUFFIXES = new Set(["co.uk", "org.uk", "ac.uk", "com.au", "net.au", "co.jp", "co.nz", "com.br", "co.in", "com.mx", "co.za", "com.sg"]);

/** Approximate registrable domain (eTLD+1) for redirect-mismatch comparison. */
export function registrableDomain(hostname: string): string {
  const labels = hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "").split(".");
  if (labels.length <= 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  if (MULTI_LABEL_SUFFIXES.has(lastTwo)) return labels.slice(-3).join(".");
  return lastTwo;
}

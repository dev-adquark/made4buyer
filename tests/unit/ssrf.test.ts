import { afterEach, describe, expect, it } from "vitest";
import { isBlockedAddress, isBlockedHostname, registrableDomain } from "@/lib/net/ip";
import { safeFetch, validateOutboundUrl } from "@/lib/net/safe-fetch";
import { withEnv } from "../support/env";

let restore: (() => void) | undefined;
afterEach(() => restore?.());

describe("SSRF address classification", () => {
  it.each(["127.0.0.1", "127.1.2.3", "10.0.0.1", "172.16.5.4", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:7f00:1", "64:ff9b::10.0.0.1", "2001:db8::1"])("blocks %s", (addr) => {
    expect(isBlockedAddress(addr)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])("allows public %s", (addr) => {
    expect(isBlockedAddress(addr)).toBe(false);
  });

  it("blocks internal hostnames", () => {
    for (const h of ["localhost", "foo.localhost", "db", "metadata", "printer.local", "svc.internal", "2130706433", "0x7f.1", "router.lan"]) expect(isBlockedHostname(h)).toBe(true);
    expect(isBlockedHostname("www.bestbuy.com")).toBe(false);
  });

  it("allows loopback only with the explicit test flag", () => {
    expect(isBlockedAddress("127.0.0.1", { allowLoopback: true })).toBe(false);
    expect(isBlockedAddress("10.0.0.1", { allowLoopback: true })).toBe(true);
  });
});

describe("outbound URL validation", () => {
  it("rejects unsupported protocols, credentials and private targets", () => {
    restore = withEnv({ UNSAFE_ALLOW_LOOPBACK_FOR_TESTS: undefined });
    expect(validateOutboundUrl("file:///etc/passwd").error?.kind).toBe("UNSUPPORTED_PROTOCOL");
    expect(validateOutboundUrl("gopher://x.example.com").error?.kind).toBe("UNSUPPORTED_PROTOCOL");
    expect(validateOutboundUrl("https://user:pw@x.example.com").error?.kind).toBe("INVALID_URL");
    expect(validateOutboundUrl("http://169.254.169.254/latest/meta-data").error?.kind).toBe("BLOCKED_HOST");
    expect(validateOutboundUrl("http://[::1]:8080/").error?.kind).toBe("BLOCKED_HOST");
    expect(validateOutboundUrl("https://shop.example.com:2375/", { standardPortsOnly: true }).error?.kind).toBe("BLOCKED_PORT");
    expect(validateOutboundUrl("https://www.bestbuy.com/p").url).toBeDefined();
  });

  it("safeFetch refuses a private target before connecting", async () => {
    restore = withEnv({ UNSAFE_ALLOW_LOOPBACK_FOR_TESTS: undefined });
    const res = await safeFetch("http://127.0.0.1:9/");
    expect(res.ok).toBe(false);
    expect(res.error?.kind).toBe("BLOCKED_HOST");
    expect(res.chain).toEqual([]);
  });
});

describe("registrable domain", () => {
  it("compares merchant domains", () => {
    expect(registrableDomain("www.bestbuy.com")).toBe("bestbuy.com");
    expect(registrableDomain("shop.amazon.co.uk")).toBe("amazon.co.uk");
    expect(registrableDomain("a.b.example.com")).toBe("example.com");
  });
});

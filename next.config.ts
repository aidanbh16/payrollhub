import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Cache Components (and its Partial Prerendering) is off: a nonce-based Content-Security-Policy needs every page
  // rendered per request, and a prerendered shell's scripts cannot carry the nonce (DV-44). See edge/security-headers.ts.
  experimental: {
    // Next.js buffers request bodies in memory before Proxy runs. Cap that buffer: Proxy rejects any body over its
    // route limit (all far below this) by Content-Length, so a large upload is never buffered or silently truncated.
    proxyClientMaxBodySize: "64kb",
  },
  // No "X-Powered-By: Next.js" on responses (RT-11): it only helps an attacker fingerprint the stack.
  poweredByHeader: false,
  // Every response: no Referer leaks (confirmation links carry a token in the URL), no MIME sniffing, no framing.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
        ],
      },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;

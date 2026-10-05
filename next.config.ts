import type { NextConfig } from "next";
import { networkInterfaces } from "node:os";

/**
 * 开发模式下允许从局域网地址访问页面（`npm run dev:lan`）。
 * Next 16 的 allowedDevOrigins 不接受单独的 `*`，这里列出本机实际的局域网 IP，
 * 再加上常见私有网段的模式（每个 `*` 匹配一段）。
 */
function devOrigins() {
  const local = Object.values(networkInterfaces())
    .flat()
    .filter((item): item is NonNullable<typeof item> => !!item && item.family === "IPv4" && !item.internal)
    .map((item) => item.address);
  const rfc1918_172 = Array.from({ length: 16 }, (_, index) => `172.${16 + index}.*.*`);
  return [...new Set([...local, "192.168.*.*", "10.*.*.*", ...rfc1918_172, "*.local"])];
}

const nextConfig: NextConfig = {
  poweredByHeader: false,
  allowedDevOrigins: devOrigins(),
  turbopack: {
    root: process.cwd(),
  },
  async headers() {
    return [
      {
        source: "/nnue/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
        ],
      },
      {
        source: "/:path*",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
        ],
      },
    ];
  },
};

export default nextConfig;

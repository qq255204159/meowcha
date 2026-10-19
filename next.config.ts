import path from "path";
import { readFileSync } from "fs";
import type { NextConfig } from "next";

const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8")
) as { version?: string };

const nextConfig: NextConfig = {
  output: "export",
  // 站点子路径（⚠️ 必须与 src/lib/site-path.ts 的 BASE_PATH 默认值、以及 nginx location 前缀一致）
  basePath: "/meowcha",
  trailingSlash: true,
  images: { unoptimized: true },
  reactCompiler: true,
  env: {
    NEXT_PUBLIC_APP_VERSION: pkg.version ?? "0.0.0",
  },
  webpack(config) {
    config.resolve = config.resolve || {};
    config.resolve.alias = {
      ...(config.resolve.alias || {}),
      jotai: path.resolve(__dirname, "node_modules/jotai"),
      "jotai/vanilla": path.resolve(__dirname, "node_modules/jotai/vanilla"),
    };
    config.module.rules.push({
      test: /\.mp3$/,
      type: "asset/resource",
      generator: {
        filename: "static/media/[name].[hash][ext]",
      },
    });
    return config;
  },
};

export default nextConfig;

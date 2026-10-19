import type { Metadata } from "next";
import "./globals.css";
import { Toaster } from "sonner";
import { assetPath } from "@/lib/site-path";
import { APP_TITLE, BRAND } from "@/lib/brand";

export const metadata: Metadata = {
  title: APP_TITLE,
  description: BRAND.description,
  icons: {
    icon: assetPath(BRAND.favicon),
  },
};

// 上架开源（2026-10-17）：站点备案信息改为环境变量驱动、默认留空（不渲染）——
// 公开仓库里不应写死站长的 ICP / 公安备案号。自部署时可自行填写这三个环境变量。
const ICP_NUMBER = process.env.NEXT_PUBLIC_ICP_NUMBER ?? "";
const POLICE_NUMBER = process.env.NEXT_PUBLIC_POLICE_NUMBER ?? "";
const POLICE_CODE = process.env.NEXT_PUBLIC_POLICE_CODE ?? "";
const POLICE_BADGE = process.env.NEXT_PUBLIC_POLICE_BADGE ?? "";

/**
 * 站点备案信息药丸。
 * 2026-10-17 改造：原来它由 nginx 用 sub_filter 往 `</body>` 注入，
 * React 水合时会发现 body 里多出一个自己没渲染的节点 → 每次加载都报
 * `React error #418`（Hydration failed）。改成在这里用 React 渲染，
 * 服务端与客户端的 DOM 完全一致，报错消失，备案信息照旧显示。
 */
function ShipBeian() {
  if (!ICP_NUMBER && !POLICE_NUMBER) return null;
  return (
    <div
      id="ship-beian"
      style={{
        position: "fixed",
        right: 10,
        bottom: 10,
        zIndex: 2147483647,
        display: "flex",
        alignItems: "center",
        gap: 7,
        padding: "4px 11px",
        borderRadius: 999,
        font: '11px/1.4 system-ui,"Microsoft YaHei",sans-serif',
        color: "rgba(255,255,255,.82)",
        background: "rgba(8,12,24,.62)",
        border: "1px solid rgba(255,255,255,.13)",
        backdropFilter: "blur(4px)",
        WebkitBackdropFilter: "blur(4px)",
        whiteSpace: "nowrap",
        pointerEvents: "none",
      }}
    >
      <a
        href="https://beian.miit.gov.cn/"
        target="_blank"
        rel="noopener"
        style={{ color: "inherit", textDecoration: "none", pointerEvents: "auto" }}
      >
        {ICP_NUMBER}
      </a>
      {ICP_NUMBER && POLICE_NUMBER ? <span style={{ opacity: 0.45 }}>·</span> : null}
      <a
        href={`https://beian.mps.gov.cn/#/query/webSearch?code=${POLICE_CODE || POLICE_NUMBER}`}
        target="_blank"
        rel="noopener"
        style={{
          color: "inherit",
          textDecoration: "none",
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          pointerEvents: "auto",
        }}
      >
        {POLICE_BADGE ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src={POLICE_BADGE} alt="" style={{ height: 13, display: "block" }} />
        ) : null}
        {POLICE_NUMBER}
      </a>
    </div>
  );
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <head>
        <link rel="preconnect" href="https://fonts.loli.net" crossOrigin="anonymous" />
        <link href="https://fonts.loli.net/css2?family=Cinzel:wght@700&family=Noto+Serif+SC:wght@400;700&family=IM+Fell+English:ital@0;1&display=swap" rel="stylesheet" />
        {/*
          站点配置垫片（站长的 LLM / 语音默认配置）。
          2026-10-17 改造：原来由 nginx sub_filter 注入 <head>，会破坏水合（React #418）。
          这里改用**普通 <script> 标签**而不是 next/script 的 beforeInteractive ——
          静态导出（output: "export"）下 Next 的 Script 组件在 SSR/水合两侧的插入方式不一致，
          实测仍会报 #418；普通 script 由 React 直接渲染，服务端/客户端 DOM 完全一致，
          且浏览器在解析 HTML 时就会执行它，仍然早于页面代码。
        */}
        <script src={assetPath("/prefill.js")} />
      </head>
      <body className="antialiased">
        <Toaster position="top-center" closeButton />
        {children}
        <ShipBeian />
      </body>
    </html>
  );
}

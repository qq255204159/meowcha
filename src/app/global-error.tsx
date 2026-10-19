"use client";

/**
 * 喵杀 · 全局错误兜底
 * 作用：把「整页黑屏」变成「看得见的报错」—— 渲染期抛错本来会让 React 卸载整棵树（表现为黑屏、
 * 点什么都没反应），这里接住它并把错误原文显示出来，方便定位。
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const text = [error?.message || String(error), error?.stack || "(no stack)", error?.digest ? `digest=${error.digest}` : ""]
    .filter(Boolean)
    .join("\n");

  return (
    <html lang="zh-CN">
      <body style={{ margin: 0, background: "#0b0810", color: "#ffd9de", fontFamily: 'system-ui, "Microsoft YaHei", sans-serif' }}>
        <div style={{ padding: 16, maxWidth: 760, margin: "0 auto" }}>
          <h2 style={{ fontFamily: "serif", fontSize: 18, margin: "12px 0" }}>喵杀出错了喵 —— 请把下面这段发给开发者</h2>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              background: "rgba(0,0,0,.45)",
              border: "2px solid #a83a4a",
              borderRadius: 10,
              padding: 12,
              fontSize: 12,
              lineHeight: 1.6,
            }}
          >
            {text}
          </pre>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button
              type="button"
              onClick={() => {
                try {
                  void navigator.clipboard?.writeText(text);
                } catch {
                  /* ignore */
                }
              }}
              style={{ border: "1px solid #a83a4a", borderRadius: 6, padding: "6px 10px", background: "transparent", color: "#ffd9de" }}
            >
              复制报错
            </button>
            <button
              type="button"
              onClick={reset}
              style={{ border: "1px solid #6b6b6b", borderRadius: 6, padding: "6px 10px", background: "transparent", color: "#ffd9de" }}
            >
              重试
            </button>
            <span style={{ fontSize: 12, opacity: 0.7, alignSelf: "center" }}>（也可以直接截图这一段）</span>
          </div>
        </div>
      </body>
    </html>
  );
}

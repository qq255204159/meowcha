"use client";

/**
 * 喵杀 · 联机房间大厅
 * 出示邀请码 → 朋友凭码进房 → 全员准备 → 房主开场（空座位 AI 补全）
 */
import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  Copy,
  Check,
  CrownSimple,
  Cat,
  Link as LinkIcon,
  SignOut,
  UsersThree,
  SpinnerGap,
} from "@phosphor-icons/react";
import type { MpRoomState } from "@/lib/meowroom/client";
import { buildInviteUrl, copyText, getPlayerId, MP_HOST_TIMEOUT_MS } from "@/lib/meowroom/client";

export interface MultiplayerLobbyProps {
  room: MpRoomState;
  onStart: () => Promise<boolean>;
  onLeave: () => Promise<void>;
  onSetReady: (ready: boolean) => Promise<void>;
  error?: string | null;
}

export function MultiplayerLobby({ room, onStart, onLeave, onSetReady, error }: MultiplayerLobbyProps) {
  const [copied, setCopied] = useState<"" | "code" | "link">("");
  const [copyFailed, setCopyFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const playerId = getPlayerId();
  const data = room.data;
  const isHost = data.hostId === playerId;
  const me = data.players.find((p) => p.id === playerId);
  const allReady = data.players.every((p) => p.isReady);
  const humans = data.players.length;
  const aiSeats = Math.max(0, data.seats - humans);
  const canStart = isHost && humans >= 2 && allReady;

  const inviteUrl = useMemo(() => buildInviteUrl(room.code), [room.code]);

  const copy = async (kind: "code" | "link") => {
    const ok = await copyText(kind === "code" ? room.code : inviteUrl);
    if (!ok) {
      setCopyFailed(true);
      return;
    }
    setCopyFailed(false);
    setCopied(kind);
    window.setTimeout(() => setCopied(""), 1600);
  };

  const startHint = !isHost
    ? "等房主开场喵"
    : humans < 2
      ? "至少要 2 位真人朋友才能开局（现在只有你）"
      : !allReady
        ? `还有 ${data.players.filter((p) => !p.isReady).length} 位朋友没准备`
        : "全员就位，可以开场了喵";

  return (
    <div className="fixed inset-0 z-[90] overflow-y-auto bg-[var(--bg-base,rgba(8,10,18,0.92))]">
      <div className="wc-contract-fog" aria-hidden="true" />
      <div className="relative z-10 mx-auto flex min-h-full w-full max-w-[720px] flex-col items-center px-4 py-8">
        <motion.div
          initial={{ opacity: 0, y: 14, filter: "blur(10px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          transition={{ duration: 0.5, ease: "easeOut" }}
          className="w-full"
        >
          <div className="wc-contract-paper w-full">
            <div className="wc-contract-borders" aria-hidden="true" />

            <div className="text-center">
              <div className="mb-2 flex items-center justify-center gap-2 text-[var(--color-wolf)] opacity-90">
                <UsersThree size={26} weight="fill" />
              </div>
              <div className="wc-contract-title" style={{ fontSize: "1.6rem" }}>
                房间已开喵
              </div>
              <div className="wc-contract-subtitle">把邀请码发给朋友，全员准备后就开场</div>
            </div>

            {/* 邀请码 */}
            <div className="mt-6 rounded-xl border-2 border-dashed border-[var(--color-accent)]/50 bg-[var(--bg-card)] px-4 py-4 text-center">
              <div className="text-xs uppercase tracking-widest text-[var(--text-secondary)]">邀请码</div>
              <div className="mt-1 font-mono text-3xl font-black tracking-[0.3em] text-[var(--color-gold)]">
                {room.code}
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={() => copy("code")}
                  className="inline-flex items-center gap-1.5 rounded-md border-2 border-[var(--border-color)] px-3 py-1.5 text-xs font-semibold text-[var(--text-primary)] transition-colors hover:border-[var(--color-accent)] hover:bg-[var(--color-accent-bg)]"
                >
                  {copied === "code" ? <Check size={14} /> : <Copy size={14} />}
                  {copied === "code" ? "已复制邀请码" : "复制邀请码"}
                </button>
                <button
                  type="button"
                  onClick={() => copy("link")}
                  title={inviteUrl}
                  className="inline-flex items-center gap-1.5 rounded-md border-2 border-[var(--border-color)] px-3 py-1.5 text-xs font-semibold text-[var(--text-primary)] transition-colors hover:border-[var(--color-accent)] hover:bg-[var(--color-accent-bg)]"
                >
                  {copied === "link" ? <Check size={14} /> : <LinkIcon size={14} />}
                  {copied === "link" ? "已复制链接" : "复制邀请链接"}
                </button>
              </div>
              <div className="mt-2 text-[11px] text-[var(--text-secondary)]">
                {copyFailed
                  ? "这个浏览器不让自动复制喵 —— 手动选中上面的邀请码/链接也行"
                  : "朋友点开链接即可直接进房，不需要站点通行码"}
              </div>
            </div>

            {/* 玩家列表 */}
            <div className="mt-6">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold text-[var(--text-primary)]">
                  真人玩家（{humans}/{data.seats}）
                </div>
                <div className="inline-flex items-center gap-1 text-xs text-[var(--text-secondary)]">
                  <Cat size={14} weight="fill" className="text-[var(--color-gold)]" />
                  剩余 {aiSeats} 座由 AI 猫补全
                </div>
              </div>

              <div className="mt-3 grid gap-2">
                {data.players.map((p, idx) => {
                  const offline = Date.now() - p.lastSeen > MP_HOST_TIMEOUT_MS;
                  return (
                    <div
                      key={p.id}
                      className="flex items-center justify-between rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] px-3 py-2"
                    >
                      <div className="flex items-center gap-3">
                        <span className="flex h-7 w-7 items-center justify-center rounded-full border border-[var(--border-color)] font-mono text-xs text-[var(--text-secondary)]">
                          {idx + 1}
                        </span>
                        <span className="text-sm font-semibold text-[var(--text-primary)]">
                          {p.name}
                          {p.id === playerId ? "（你）" : ""}
                        </span>
                        {p.isHost ? (
                          <span className="inline-flex items-center gap-1 rounded-full border border-[var(--color-gold)]/50 px-2 py-0.5 text-[10px] text-[var(--color-gold)]">
                            <CrownSimple size={11} weight="fill" />
                            房主
                          </span>
                        ) : null}
                        {offline ? (
                          <span className="text-[10px] text-[var(--text-secondary)] opacity-70">掉线中…</span>
                        ) : null}
                      </div>
                      <span
                        className={`text-xs font-semibold ${
                          p.isReady ? "text-[var(--color-accent)]" : "text-[var(--text-secondary)]"
                        }`}
                      >
                        {p.isReady ? "已准备" : "未准备"}
                      </span>
                    </div>
                  );
                })}
                {/* 喵杀（十七轮 · 站长反馈）：12 人房通常只来两三个朋友，原先把 10 个「AI 猫」逐行列出来
                    又长又没信息量。现在只示意前 3 行，剩下的用一行省略号概括，观感更清爽。 */}
                {Array.from({ length: Math.min(aiSeats, 3) }).map((_, i) => (
                  <div
                    key={`ai-${i}`}
                    className="flex items-center justify-between rounded-lg border border-dashed border-[var(--border-color)] px-3 py-2 opacity-60"
                  >
                    <div className="flex items-center gap-3">
                      <span className="flex h-7 w-7 items-center justify-center rounded-full border border-dashed border-[var(--border-color)] font-mono text-xs text-[var(--text-secondary)]">
                        {humans + i + 1}
                      </span>
                      <span className="text-sm text-[var(--text-secondary)]">AI 猫（开局自动补位）</span>
                    </div>
                    <Cat size={16} className="text-[var(--text-secondary)]" />
                  </div>
                ))}
                {aiSeats > 3 ? (
                  <div className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-[var(--border-color)] px-3 py-2 text-xs text-[var(--text-secondary)] opacity-70">
                    <Cat size={14} weight="fill" className="text-[var(--color-gold)]/70" />
                    …… 共 {aiSeats} 位 AI 猫开局自动补位
                  </div>
                ) : null}
              </div>
            </div>

            {/* 操作区 */}
            <div className="mt-6 flex flex-col items-center gap-3">
              <div className="wc-seal-hint">{startHint}</div>

              <div className="flex w-full flex-wrap items-center justify-center gap-2">
                {isHost ? (
                  <button
                    type="button"
                    disabled={!canStart || busy}
                    onClick={async () => {
                      setBusy(true);
                      await onStart();
                      setBusy(false);
                    }}
                    className="rounded-lg border-2 border-[var(--color-accent)] bg-[var(--color-accent-bg)] px-5 py-2.5 font-serif text-base font-bold text-[var(--color-accent)] transition-all hover:brightness-110 disabled:opacity-50"
                  >
                    {busy ? "开场中…" : "开始游戏喵"}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      await onSetReady(!(me?.isReady ?? false));
                      setBusy(false);
                    }}
                    className="inline-flex items-center gap-2 rounded-lg border-2 border-[var(--color-accent)] bg-[var(--color-accent-bg)] px-5 py-2.5 font-serif text-base font-bold text-[var(--color-accent)] transition-all hover:brightness-110 disabled:opacity-50"
                  >
                    {me?.isReady ? "取消准备" : "我准备好了喵"}
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => void onLeave()}
                  className="inline-flex items-center gap-1.5 rounded-lg border-2 border-[var(--border-color)] px-4 py-2.5 text-sm font-semibold text-[var(--text-primary)] transition-colors hover:border-[var(--color-blood)] hover:text-[var(--color-blood)]"
                >
                  <SignOut size={16} />
                  离开房间
                </button>

                {!isHost && !me?.isReady ? (
                  <span className="inline-flex items-center gap-1 text-xs text-[var(--color-gold)]">
                    <SpinnerGap size={13} className="animate-spin" />
                    等你准备
                  </span>
                ) : null}
              </div>

              {error ? <div className="text-xs text-[var(--color-blood)]">{error}</div> : null}
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  );
}

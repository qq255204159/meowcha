"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface SharePanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  referralCode: string | null;
  totalReferrals: number;
}

export function SharePanel({
  open,
  onOpenChange,
  referralCode,
  totalReferrals,
}: SharePanelProps) {
  const [copying, setCopying] = useState(false);

  const shareUrl = useMemo(() => {
    if (!referralCode || typeof window === "undefined") return "";
    return `${window.location.origin}?ref=${referralCode}`;
  }, [referralCode]);

  const handleCopy = async () => {
    if (!shareUrl) return;
    setCopying(true);
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast.success("分享链接已复制");
    } catch {
      toast.error("复制失败，请手动复制");
    } finally {
      setCopying(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>分享链接</DialogTitle>
          <DialogDescription>
            每邀请一位新用户注册可获得 3 局额度。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="rounded-md border-2 border-[var(--border-color)] bg-[var(--bg-card)] px-3 py-2 text-sm break-all">
            {shareUrl || "加载中..."}
          </div>
          <div className="flex items-center justify-between text-sm text-[var(--text-secondary)]">
            <span>已邀请人数：{totalReferrals}</span>
            <Button type="button" onClick={handleCopy} disabled={!shareUrl || copying}>
              {copying ? "复制中..." : "复制链接"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

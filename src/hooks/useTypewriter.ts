"use client";

import { useState, useEffect, useRef, useCallback } from "react";

interface UseTypewriterOptions {
  text: string;
  speed?: number; // ms per character
  enabled?: boolean;
  onComplete?: () => void;
}

export function useTypewriter({
  text,
  speed = 30,
  enabled = true,
  onComplete,
}: UseTypewriterOptions) {
  const [displayedText, setDisplayedText] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const indexRef = useRef(0);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  // 喵杀修复（2026-10-17 · 站长实测）：**速度变化不允许触发重打**。
  // 站长报的现象：一句台词先按 25ms/字 打出来（那一刻 TTS 音频还没生成好，
  // audioManager 缓存里没有时长，所以 typewriterSpeed 兜底为 25），
  // 等语音渲染完成、开始念的那一刻，typewriterSpeed 变成「按音频时长折算」的值
  // （例如 25 → 38）。speed 原本是 effect 依赖 → 打字机被清空、从头再打一遍，
  // 而语音已经在念了，看起来就是「对话框又重新打字机了一遍」。
  // 现在把 speed / onComplete 放到 ref（每次渲染同步最新值）：
  // 只有「文本真的变了」才重置重打；速度变化只影响**后续字符**的节奏。
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const reset = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    indexRef.current = 0;
    setDisplayedText("");
    setIsTyping(false);
  }, []);

  useEffect(() => {
    if (!enabled || !text) {
      const next = text || "";
      queueMicrotask(() => {
        setDisplayedText(next);
        setIsTyping(false);
      });
      return;
    }

    // If text changed, reset and start typing
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    indexRef.current = 0;
    queueMicrotask(() => {
      setDisplayedText("");
      setIsTyping(true);
    });

    const typeNextChar = () => {
      if (indexRef.current < text.length) {
        indexRef.current++;
        setDisplayedText(text.slice(0, indexRef.current));
        
        // Variable speed for more natural effect
        const char = text[indexRef.current - 1];
        let delay = speedRef.current;
        if (char === "，" || char === ",") delay = speedRef.current * 3;
        else if (char === "。" || char === ".") delay = speedRef.current * 5;
        else if (char === "！" || char === "!") delay = speedRef.current * 4;
        else if (char === "？" || char === "?") delay = speedRef.current * 4;
        else if (char === " ") delay = speedRef.current * 0.5;
        
        timeoutRef.current = setTimeout(typeNextChar, delay);
      } else {
        setIsTyping(false);
        onCompleteRef.current?.();
      }
    };

    timeoutRef.current = setTimeout(typeNextChar, speedRef.current);

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [text, enabled, reset]);

  return { displayedText, isTyping, reset };
}

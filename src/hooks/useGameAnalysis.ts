/**
 * 游戏分析生成 Hook
 * 在 GAME_END 时自动触发分析数据生成
 */

import { useEffect, useCallback } from "react";
import { useAtom, useAtomValue } from "jotai";
import {
  gameStateAtom,
  gameAnalysisAtom,
  analysisLoadingAtom,
  analysisErrorAtom,
} from "@/store/game-machine";
import {
  GAME_ANALYSIS_VERSION,
  generateGameAnalysis,
  getGameAnalysisSourceFingerprint,
} from "@/lib/game-analysis";
import { gameStatsTracker } from "@/hooks/useGameStats";
import { getReviewModel } from "@/lib/api-keys";

export function useGameAnalysis() {
  const gameState = useAtomValue(gameStateAtom);
  const [analysisData, setAnalysisData] = useAtom(gameAnalysisAtom);
  const [isLoading, setIsLoading] = useAtom(analysisLoadingAtom);
  const [error, setError] = useAtom(analysisErrorAtom);

  const triggerAnalysis = useCallback(async () => {
    if (gameState.phase !== "GAME_END" || !gameState.winner) {
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const winner = gameState.winner === "wolf" ? "wolf" : "villager";
      
      // 优先使用 GameState.startTime 计算时长，避免刷新后丢失
      let durationSeconds = 0;
      if (gameState.startTime) {
        durationSeconds = Math.round((Date.now() - gameState.startTime) / 1000);
      }
      // 兜底 1（站长反馈「时长显示 0:00」）：startTime 缺失（存档恢复/旧局/联机客人）时，
      // 用本局消息时间戳的跨度估算一个近似时长。
      if (durationSeconds <= 0) {
        const stamps = (gameState.messages || [])
          .map((m) => (m as { timestamp?: number }).timestamp)
          .filter((t): t is number => typeof t === "number" && t > 0);
        if (stamps.length >= 2) {
          let lo = stamps[0];
          let hi = stamps[0];
          for (const t of stamps) {
            if (t < lo) lo = t;
            if (t > hi) hi = t;
          }
          const approx = Math.round((hi - lo) / 1000);
          if (approx > 0) durationSeconds = approx;
        }
      }
      // 兜底 2：仍拿不到就用统计 tracker
      if (durationSeconds <= 0) {
        const statsSummary = gameStatsTracker.getSummary(winner, true);
        durationSeconds = statsSummary?.durationSeconds ?? 0;
      }
      
      const reviewModel = getReviewModel();
      const data = await generateGameAnalysis(gameState, reviewModel, durationSeconds);
      setAnalysisData(data);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "分析生成失败";
      setError(errorMessage);
      console.error("Game analysis generation failed:", err);
    } finally {
      setIsLoading(false);
    }
  }, [gameState, setAnalysisData, setIsLoading, setError]);

  useEffect(() => {
    const sourceFingerprint = gameState.phase === "GAME_END"
      ? getGameAnalysisSourceFingerprint(gameState)
      : null;

    // 触发条件：游戏结束、有胜利方、未加载中
    // 如果缓存来自旧版本或旧状态，也需要重新生成
    const needsAnalysis = gameState.phase === "GAME_END" && 
      gameState.winner && 
      !isLoading &&
      (
        !analysisData ||
        analysisData.gameId !== gameState.gameId ||
        analysisData.analysisVersion !== GAME_ANALYSIS_VERSION ||
        analysisData.sourceFingerprint !== sourceFingerprint
      );
    
    if (needsAnalysis) {
      triggerAnalysis();
    }
  }, [gameState, analysisData, isLoading, triggerAnalysis]);

  const clearAnalysis = useCallback(() => {
    setAnalysisData(null);
    setError(null);
  }, [setAnalysisData, setError]);

  return {
    analysisData,
    isLoading,
    error,
    triggerAnalysis,
    clearAnalysis,
  };
}

export function useAnalysisData() {
  return useAtomValue(gameAnalysisAtom);
}

export function useAnalysisLoading() {
  return useAtomValue(analysisLoadingAtom);
}

export function useAnalysisError() {
  return useAtomValue(analysisErrorAtom);
}

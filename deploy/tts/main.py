# -*- coding: utf-8 -*-
"""
语音合成服务（tts）· 通用版
------------------------------------------------------------------
引擎：edge-tts（微软 Edge 在线朗读，**免 API Key**）
契约：POST /  body {"text": "...", "voiceId": "..."}  →  audio/mpeg
      GET  /healthz
说明：
  · voiceId 沿用常见的 MiniMax 风格音色 ID，这里做「ID → edge-tts 音色 + 语速/音调」映射，
    让每个角色有不同嗓音；未收录的 ID 按哈希稳定分配（同一 ID 每次都同音）。
  · 需要联网：edge-tts 走微软在线朗读，**首次合成会访问网络**。
配置全部走环境变量（见 README.md）。
"""
import asyncio
import logging
import os
import re

import edge_tts
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
LOG = logging.getLogger("tts")

MAX_CHARS = int(os.environ.get("TTS_MAX_CHARS", "1500"))
DEFAULT_VOICE = os.environ.get("TTS_DEFAULT_VOICE", "zh-CN-XiaoxiaoNeural")
CONCURRENCY = int(os.environ.get("TTS_CONCURRENCY", "4"))

app = FastAPI(title="tts")
_sem = None


def sem():
    global _sem
    if _sem is None:
        _sem = asyncio.Semaphore(CONCURRENCY)
    return _sem


# 默认音色映射：MiniMax 风格 ID → (edge-tts 音色, 语速, 音调)
# 语速/音调微调用于区分「共用同一底色的角色」，可按需增删。
VOICE_MAP = {
    # ---------- 男声 ----------
    "Cantonese_PlayfulMan":                  ("zh-CN-YunxiaNeural",    "+14%", "+9Hz"),
    "Chinese (Mandarin)_Stubborn_Friend":    ("zh-CN-YunxiNeural",     "+12%", "+4Hz"),
    "Chinese (Mandarin)_Southern_Young_Man": ("zh-TW-YunJheNeural",    "+4%",  "-2Hz"),
    "Chinese (Mandarin)_Gentle_Youth":       ("zh-CN-YunjianNeural",   "-9%",  "-7Hz"),
    "male-qn-jingying":                      ("zh-CN-YunyangNeural",   "+1%",  "-5Hz"),
    "Chinese (Mandarin)_Sincere_Adult":      ("zh-CN-YunxiNeural",     "-6%",  "-9Hz"),
    "Chinese (Mandarin)_Radio_Host":         ("zh-CN-YunyangNeural",   "+10%", "-12Hz"),
    "Chinese (Mandarin)_Humorous_Elder":     ("zh-CN-YunjianNeural",   "+16%", "+8Hz"),
    # ---------- 女声 ----------
    "Chinese (Mandarin)_Cute_Spirit":        ("zh-CN-XiaoyiNeural",    "+12%", "+11Hz"),
    "Chinese (Mandarin)_Warm_Girl":          ("zh-CN-XiaoxiaoNeural",  "+5%",  "+4Hz"),
    "Chinese (Mandarin)_Soft_Girl":          ("zh-TW-HsiaoYuNeural",   "-6%",  "+9Hz"),
    "Chinese (Mandarin)_HK_Flight_Attendant": ("zh-TW-HsiaoChenNeural", "+3%",  "+2Hz"),
    "Chinese (Mandarin)_Gentle_Senior":      ("zh-CN-XiaoxiaoNeural",  "-11%", "-5Hz"),
    "Chinese (Mandarin)_Warm_Bestie":        ("zh-TW-HsiaoYuNeural",   "+2%",  "-3Hz"),
    "Chinese (Mandarin)_Kind-hearted_Antie": ("zh-CN-XiaoyiNeural",    "-8%",  "-7Hz"),
    # ---------- 英文 ----------
    "English_Trustworthy_Man":               ("en-US-GuyNeural",       "-4%",  "-2Hz"),
    "English_Gentle-voiced_man":             ("en-US-AndrewNeural",    "-7%",  "+0Hz"),
    "English_Diligent_Man":                  ("en-US-BrianNeural",     "+2%",  "-2Hz"),
}

# 未收录时的兜底池（按 ID 哈希稳定分配）
EN_MALE = ["en-US-AndrewNeural", "en-US-GuyNeural", "en-US-BrianNeural"]
EN_FEMALE = ["en-US-AvaNeural", "en-US-EmmaNeural", "en-US-JennyNeural"]


def resolve(voice_id: str):
    """把前端传来的 voiceId 解析成 (edge 音色, 语速, 音调)。"""
    vid = (voice_id or "").strip()
    if vid in VOICE_MAP:
        return VOICE_MAP[vid]
    if not vid:
        return (DEFAULT_VOICE, "+0%", "+0Hz")
    h = sum(ord(ch) for ch in vid)
    if vid.lower().startswith("english") or "en_" in vid.lower():
        female = any(k in vid for k in ("Female", "Girl", "Woman", "Bestie"))
        pool = EN_FEMALE if female else EN_MALE
        return (pool[h % len(pool)], "+0%", "+0Hz")
    # 其余中文类未知 ID：在中文女声池里稳定分配
    zh = ["zh-CN-XiaoxiaoNeural", "zh-CN-XiaoyiNeural", "zh-TW-HsiaoChenNeural", "zh-HK-HiuMaanNeural"]
    return (zh[h % len(zh)], "+0%", "+0Hz")


def clean(text: str) -> str:
    t = re.sub(r"\s+", " ", text or "").strip()
    t = re.sub(r"[*_`~#]", "", t)  # 去掉 markdown 记号，避免被读成符号
    return t[:MAX_CHARS]


async def synth(text: str, voice: str, rate: str, pitch: str) -> bytes:
    async with sem():
        last = None
        for attempt in (1, 2):
            try:
                buf = bytearray()
                comm = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch)
                async for ch in comm.stream():
                    if ch.get("type") == "audio":
                        buf.extend(ch["data"])
                if buf:
                    return bytes(buf)
                last = RuntimeError("empty audio")
            except Exception as e:  # noqa: BLE001  edge-tts 偶发抖动，重试一次
                last = e
                LOG.warning("synth attempt %d failed: %s", attempt, e)
                await asyncio.sleep(0.6)
        raise last


@app.get("/healthz")
async def healthz():
    return {"ok": True, "engine": "edge-tts", "default": DEFAULT_VOICE, "max_chars": MAX_CHARS}


async def _do_tts(request: Request):
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid json"}, status_code=400)

    text = clean(str(body.get("text") or ""))
    voice_id = str(body.get("voiceId") or body.get("voice") or "")
    if not text:
        return JSONResponse({"error": "empty text"}, status_code=400)

    voice, rate, pitch = resolve(voice_id)
    try:
        mp3 = await synth(text, voice, rate, pitch)
    except Exception as e:  # noqa: BLE001
        LOG.error("tts failed voiceId=%r: %s", voice_id, e)
        return JSONResponse({"error": "tts failed: %s" % e}, status_code=502)

    LOG.info("tts ok voice=%s chars=%d bytes=%d", voice, len(text), len(mp3))
    return Response(
        mp3,
        media_type="audio/mpeg",
        headers={"Cache-Control": "no-store", "X-TTS-Voice": voice},
    )


@app.post("/")
async def tts_root(request: Request):
    """主路由。nginx 用 `proxy_pass http://tts:8000/;` 时，/api/tts 会改写成 /。"""
    return await _do_tts(request)


@app.post("/api/tts")
async def tts_api(request: Request):
    """别名：方便 nginx 用 `proxy_pass http://tts:8000;`（不加 URI）原样透传 /api/tts。"""
    return await _do_tts(request)

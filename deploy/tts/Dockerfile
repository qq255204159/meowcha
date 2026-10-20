# 语音合成服务（tts）镜像
# ---------------------------------------------------------------------------
# 构建：docker build -t tts:latest .
# 运行：docker run -d --name tts -p 8000:8000 tts:latest
# 注意：运行期需能访问微软 edge-tts 在线服务（首次合成会联网）。
# ---------------------------------------------------------------------------
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8000 \
    TTS_MAX_CHARS=1500 \
    TTS_CONCURRENCY=4 \
    TTS_DEFAULT_VOICE=zh-CN-XiaoxiaoNeural

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY main.py .

# 无状态服务，仅需非 root 用户
RUN useradd -m -u 10001 appuser && chown -R appuser:appuser /app

USER appuser
EXPOSE 8000

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1"]

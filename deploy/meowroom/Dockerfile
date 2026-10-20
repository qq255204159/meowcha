# 联机房间服务（meowroom）镜像
# ---------------------------------------------------------------------------
# 构建：docker build -t meowroom:latest .
# 运行：docker run -d --name meowroom -p 8000:8000 -v meowroom-data:/data meowroom:latest
# 数据：SQLite 落在 /data/rooms.db，建议始终挂卷持久化（compose 里用 meowroom-data 卷）。
# ---------------------------------------------------------------------------
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8000 \
    DB_PATH=/data/rooms.db \
    ROOM_TTL_HOURS=12 \
    MAX_ROOMS=800

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY main.py .

# 数据目录 + 非 root 用户
RUN mkdir -p /data \
 && useradd -m -u 10001 appuser \
 && chown -R appuser:appuser /app /data

# 数据目录，可挂载宿主目录 / 命名卷
VOLUME ["/data"]

USER appuser
EXPOSE 8000

# ⚠️ 必须是单 worker：SSE 的进程内发布订阅依赖「所有请求在同一事件循环」（见 main.py 注释）
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1"]

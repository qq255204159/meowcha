# tts · 语音合成服务（通用版）

基于 edge-tts 的轻量 TTS：接收 `{"text","voiceId"}`，返回 `audio/mpeg`。
**edge-tts 走微软在线朗读，免 Key**；但**首次合成需要联网**（会访问微软的在线服务）。

## 与前端 / nginx 对齐（重要）

前端固定 POST 同源 `/api/tts`，所以 nginx 应这样反代：

```nginx
location = /api/tts { proxy_pass http://tts:8000/; proxy_buffering off; }
```

`proxy_pass` 带 URI `/` 会把请求路径 `/api/tts` 改写成 `/`，正好命中本服务的 **`POST /`** 主路由。
（本服务也保留了 `POST /api/tts` 别名，方便你用 `proxy_pass http://tts:8000;` 原样透传。）

## 单独运行

```bash
docker build -t tts:latest .
docker run -d --name tts -p 8000:8000 tts:latest

curl -s -X POST http://localhost:8000/ -H 'Content-Type: application/json' \
  -d '{"text":"你好","voiceId":"zh-CN-XiaoxiaoNeural"}' -o t.mp3 && ls -l t.mp3
```

或本机直跑：`pip install -r requirements.txt && uvicorn main:app --port 8000`

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/` | `{text, voiceId}` → `audio/mpeg`（别名 `/api/tts`） |
| GET | `/healthz` | 健康检查 |

## 音色与配置

`voiceId` 支持 MiniMax 风格 ID → edge-tts 音色映射（见 `main.py` 的 `VOICE_MAP`）；
未收录的 ID 按哈希稳定分配，保证同一角色每次都同音。
环境变量：`PORT`=8000 · `TTS_MAX_CHARS`=1500 · `TTS_CONCURRENCY`=4 · `TTS_DEFAULT_VOICE`=zh-CN-XiaoxiaoNeural

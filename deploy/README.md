# 部署清单（Deploy Checklist）

两条路，按你的情况二选一。约定：站点子路径 `BASE_PATH=/meowcha`（须与 `next.config.ts` 的 `basePath` 一致）。

---

## A · 一键部署（docker compose）—— 推荐先试这个

1. [ ] 装好 **Docker**（含 `docker compose` v2）。
2. [ ] `cd deploy && cp prefill.js.example prefill.js`，把里面的 `__DEEPSEEK_KEY__` 换成你的真实 Key。
       （不填也能进游戏，只是 AI 不会说话；也可稍后在网页「设置」里补。）
3. [ ] `docker compose up -d --build`，然后打开 **http://localhost:8080/meowcha/**。

这一条命令会把 **站点 + 联机房间服务 + 语音合成** 一起起好，三处路由都配好了，**不用写任何代码**。

- [ ] 首页能打开 → 能开局 → AI 猫会说话
- [ ] 点「邀请朋友喵」能建房；另一台设备用房间码能进同一桌
- [ ] AI 台词**有声音**（装好即有；语音音量在设置里可调）

> 细节、端口调整、停止方式见 [`../docs/DEPLOY.md`](../docs/DEPLOY.md) 第 16 节。
> ⚠️ 这套编排**不含 TLS 与访问控制**，是「本机 / 内网试用」用的；正式上线按下文 B 走。

---

## B · 手动部署（已有自己的 nginx）

### 1. 构建

```bash
# 用官方 Node 20 容器构建，规避宿主 Node 版本过旧的问题。
# ⚠️ 容器只挂载源码目录，**依赖必须先装好**，二选一：
#   ① 宿主已装过依赖（跑过一次 pnpm install）→ 直接复用宿主 node_modules：
docker run --rm -v $PWD:/app -w /app node:20-alpine \
  sh -c "node node_modules/next/dist/bin/next build --webpack"
#   ② 全新克隆 / 宿主没装依赖 → 让容器自己装（需要能访问 npm 源或镜像）：
docker run --rm -v $PWD:/app -w /app node:20-alpine \
  sh -c "corepack enable && pnpm install --frozen-lockfile && pnpm build"
```

- [ ] 构建成功，产物在 **`out/`**。
- [ ] 若用 ① 的方式，**先确认 `node_modules/` 已存在**，否则会报 `Cannot find module`。

### 2. 拷贝

把 `out/` 的内容 **平铺** 到 `$ROOT/meowcha/`：

```bash
mkdir -p "$ROOT/meowcha"
cp -r out/. "$ROOT/meowcha/"
```

- [ ] `$ROOT/meowcha/index.html`、`$ROOT/meowcha/_next/` 存在。

### 3. 配置垫片（prefill.js）

```bash
# 从脱敏模板复制，并填入你自己的 key（切勿提交进仓库）
cp deploy/prefill.js.example "$ROOT/meowcha/prefill.js"
```

- [ ] `$ROOT/meowcha/prefill.js` 已存在且 `llmApiKey` 已是真实值。
- [ ] 确认该文件 **不在** git 仓库内（`.gitignore` 已忽略 `prefill.js`）。

### 4. Nginx

按 [`nginx-meowcha.conf`](nginx-meowcha.conf) 写 `location /meowcha/`，按需再补两段反代：

- [ ] `try_files $uri $uri/ /meowcha/index.html;`（必需）
- [ ] （要联机）`location /meowcha/mp/ { … }` → 指向 [`meowroom/`](meowroom/README.md)，**必须带 `proxy_buffering off;` + `Connection ""` + 长 `proxy_read_timeout`**
- [ ] （要语音）`location = /api/tts { … }` → 指向 [`tts/`](tts/README.md)
- [ ] `nginx -t && nginx -s reload`

### 5. 验证

```bash
# 首页可访问
curl -s -o /dev/null -w '%{http_code}\n' "https://<your-host>/meowcha/"   # 期望 200
# 配置垫片文件本身能取到（AI 能不能说话就看它）
curl -sI "https://<your-host>/meowcha/prefill.js" | head -1               # 期望 200
# 静态资源（favicon / 背景音乐）不再静默失败
curl -sI "https://<your-host>/meowcha/brand/meowcha-favicon.png" | head -1   # 期望 200
curl -sI "https://<your-host>/meowcha/bgm/day.mp3" | head -1                  # 期望 200
# 联机（若已配置）
curl -s -X POST "https://<your-host>/meowcha/mp/rooms" -H 'Content-Type: application/json' -d '{}'   # 期望 200
# 语音（若已配置）
curl -s -X POST "https://<your-host>/api/tts" \
  -H 'Content-Type: application/json' \
  -d '{"text":"测试","voiceId":"zh-CN-XiaoxiaoNeural"}' -o /tmp/t.mp3 && ls -l /tmp/t.mp3
```

- [ ] 浏览器打开游戏：能开局、AI 会发言、（若配了）有语音。

---

## 回滚

```bash
rm -rf "$ROOT/meowcha"      # 或恢复上一版备份
```

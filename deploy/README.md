# 部署清单（Deploy Checklist）

把喵杀（MEOWCHA）二创版发布到一台静态站点服务器，按顺序执行即可。
约定：站点子路径 `BASE_PATH=/meowcha`（须与 `next.config.ts` 的 `basePath` 一致）。

---

## 0. 前置

- [ ] Node **20+** 环境（构建链要求；本地/宿主 Node 18 会失败）。
- [ ] Web 根目录（下文记作 `$ROOT`，例如 `/usr/share/nginx/html`）。
- [ ] 一份你自己的 **DeepSeek API Key**（用于 `prefill.js`，仅放在服务器，不入库）。

---

## 1. 构建（Build）

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

---

## 2. 拷贝（Copy）

把 `out/` 的内容 **平铺** 到 `$ROOT/meowcha/`：

```bash
mkdir -p "$ROOT/meowcha"
cp -r out/. "$ROOT/meowcha/"
```

- [ ] `$ROOT/meowcha/index.html`、`$ROOT/meowcha/_next/` 存在。
- [ ] 准备备案药丸图标：`$ROOT/assets/badge_police.png`（站点提供）。

---

## 3. 配置垫片（prefill.js）

```bash
# 从脱敏模板复制，并填入你自己的 key（切勿提交进仓库）
cp deploy/prefill.js.example "$ROOT/meowcha/prefill.js"
# 然后把 prefill.js 里的 __DEEPSEEK_KEY__ 替换为你的真实 key
```

- [ ] `$ROOT/meowcha/prefill.js` 已存在且 `llmApiKey` 已是真实值。
- [ ] 确认该文件 **不在** git 仓库内（`.gitignore` 已忽略 `prefill.js`）。

---

## 4. Nginx 配置（Nginx）

按 [`nginx-meowcha.conf`](nginx-meowcha.conf) 把 `location /meowcha/` 写入你的站点配置，重点：

- [ ] `try_files $uri $uri/ /meowcha/index.html;`
- [ ] `sub_filter '<head>' '<head><script src="/meowcha/prefill.js"></script>';`
- [ ] `sub_filter '"/brand/' '"/meowcha/brand/';`
- [ ] （备案药丸**不再**用 `sub_filter` 注入；改为应用读取 `NEXT_PUBLIC_ICP_NUMBER` / `NEXT_PUBLIC_POLICE_NUMBER` 等环境变量渲染，留空则不显示）
- [ ] `sub_filter_once off;`
- [ ] （可选）`location = /api/tts { … }` 指向你的 TTS 服务。

```bash
nginx -t && nginx -s reload
```

---

## 5. 验证（Verify）

```bash
# 首页可访问
curl -s -o /dev/null -w '%{http_code}\n' "https://<your-host>/meowcha/"   # 期望 200

# ⚠️ 别用 grep 'prefill.js' 来判断注入 —— 页面本来就自带该 script 标签，永远命中，测不出问题。
# 真正该验的是「垫片文件本身能取到」：
curl -sI "https://<your-host>/meowcha/prefill.js" | head -1               # 期望 200

# 静态资源（favicon / 背景音乐）不再静默失败
curl -sI "https://<your-host>/meowcha/brand/meowcha-favicon.png" | head -1   # 期望 200
curl -sI "https://<your-host>/meowcha/bgm/day.mp3" | head -1                  # 期望 200

# TTS 端点（若已配置）
curl -s -X POST "https://<your-host>/api/tts" \
  -H 'Content-Type: application/json' \
  -d '{"text":"测试","voiceId":"zh-CN-XiaoxiaoNeural"}' -o /tmp/t.mp3 && ls -l /tmp/t.mp3
```

- [ ] 浏览器打开游戏可正常开局、发言、TTS 播放。

---

## 回滚

```bash
rm -rf "$ROOT/meowcha"      # 或恢复上一版备份
```

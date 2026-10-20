# 喵杀（MEOWCHA）· 详细部署教程

> 面向**零基础**用户，从零开始把喵杀部署到你自己的服务器。
> 全程命令可直接复制，每一步都说明「**应该看到什么**」与「**报错怎么办**」。
> 约定：站点挂在子路径 **`/meowcha/`** 下（因为 `next.config.ts` 的 `basePath` 是 `/meowcha`）。

---

## 目录

> 🚀 **只想最快跑起来？** 看 **第 0 节**（一键部署）；下面 1～15 节是**手动部署**流程，已折起。

- [**0 · 最快上手 · 一键部署（docker compose）**](#0-最快上手--一键部署docker-compose) —— 推荐，三条命令
- [**手动部署全流程（1～15 节）**](#手动部署全流程115-节) —— 已折叠，需要时点开
- [附 · 一页速查（TL;DR）](#附一页速查tldr)

---

## 0. 最快上手 · 一键部署（docker compose）

**最省事的一条路**：仓库里的 [`../deploy/docker-compose.yml`](../deploy/docker-compose.yml) 会把**站点 + 联机房间服务 + 语音服务**三个一起起好，并且把 `/meowcha/`、`/meowcha/mp/`、`/api/tts` 三处路由都配好了。**先装 Docker**（Node / pnpm 都在容器里，本机不用装）：照你系统的官方教程装即可 —— Windows / macOS 见 <https://www.docker.com/products/docker-desktop/>，Linux 常用 `curl -fsSL https://get.docker.com | sh`。装好后在**本机终端**里 `docker -v` 与 `docker compose version` 都能打印版本号即可。

然后三条命令：

```bash
cd deploy
cp prefill.js.example prefill.js     # 填上你自己的 LLM Key（不填 = AI 不说话；也可以稍后在网页「设置」里补）
docker compose up -d --build         # 首次构建约几分钟
# 然后浏览器打开 http://localhost:8080/meowcha/
```

- 只对外暴露 **8080**；房间服务与语音服务只走 compose 内部网络，**不对公网开放**。
- 三个部分各自的说明与单独跑法：`deploy/meowroom/README.md`（联机房间）、`deploy/tts/README.md`（语音）、`deploy/nginx-oneclick.conf`（这套 compose 用的最小 nginx 配置）。
- 想换对外端口：改 compose 里 `8080:80` 左边的数字。
- 停掉：`docker compose down`（房间数据在 `meowroom-data` 卷里，不会丢）。

> ⚠️ **这是「本机跑通 / 内网试用」的配置**：刻意不含 TLS 与访问控制。正式上线请按第 7 / 11e 节补 HTTPS、会话保护与限流。
> ⚠️ 启动前务必先复制好 `prefill.js`；该文件不存在时，Docker 会把缺失的宿主文件当成**目录**挂上去。
> ✅ `deploy/meowroom`（6 个接口 + 409 乐观锁 + 动作幂等 + SSE 推送 + 删房 404）与 `deploy/tts`（真合成出 mp3、MiniMax 音色映射、别名路由）都已在真实服务器上**逐条冒烟验证通过**；compose 这套编排本身未在干净机器上实测，请在你自己的环境里跑一遍再对外开。

---

## 手动部署全流程（1～15 节）

> 上面的一键部署已覆盖绝大多数情况。需要**自己装 Node/pnpm、自己构建、自己挂 nginx** 时再看这里 —— 点开下面这块 👇

<details>
<summary><b>点开查看手动部署全流程（1～15 节：架构 / 环境 / 构建 / 上传 / nginx / prefill / 验证 / 语音 / 联机 / 备案 / 报错 / 回滚）</b></summary>

## 1. 它是怎么跑起来的（先看懂架构）

喵杀是一个**纯前端静态站点**，没有服务端页面：

```
玩家浏览器
   │  ① 打开 https://your-domain.example/meowcha/
   ▼
┌──────────────────────────────┐
│  nginx（你的 Web 服务器）      │
│  · 直接返回 out/ 里的静态文件  │
│  · 注入 prefill.js（写 LLM 配置）│
│  · （可选）反代 /api/tts → TTS │
│  · （可选）反代 /meowcha/mp/ → 房间后端 │
└──────────────────────────────┘
   │  ② 页面加载后，从浏览器 localStorage 读 LLM 配置
   ▼
大模型 API（默认 DeepSeek 官方）
```

- **静态文件**：`pnpm build` 产出的 `out/` 目录。
- **LLM 配置**：不是 `.env` 注入，而是部署时放一个 `prefill.js`（与页面同源），它把 LLM 地址/模型/Key 写进 **localStorage** 并锁定。
- **语音（可选）**：前端 `POST` 到 `/api/tts`，由 nginx 反代到你的 TTS 服务。
- **联机（可选/进阶）**：另有「房间后端」承载房间状态。

---

## 2. 前置要求

| 需要 | 说明 |
| --- | --- |
| 一台服务器 | 装了 nginx 的 Linux 服务器（Ubuntu / Debian / CentOS 均可）。下文以 `/usr/share/nginx/html` 作为 Web 根目录示例。 |
| Node.js ≥ 20 + pnpm 9 | **用于构建**。可以装在你的**本地**电脑，也可以在服务器上装；Node 18 太旧会失败。 |
| 一个 LLM Key | 默认用 **DeepSeek 官方**（<https://platform.deepseek.com/>）。任何兼容 OpenAI Chat Completions 的服务都行。 |
| 域名（可选） | 没有域名也能用「IP + 端口」访问，但分享/二维码体验较差，且影响剪贴板等功能。 |

> 💡 文中出现的 `your-domain.example`、`<你的服务器IP>`、`__DEEPSEEK_KEY__` 均为**占位符**，请替换为你自己的真实值。

---

## 3. 第一步 · 准备源代码

在**构建机**（本地电脑或服务器）上：

```bash
# 装 Node 20+（见 README「手动部署 ②· 在本地跑起来」第 0 步），然后启用 pnpm
corepack enable

# 获取代码（例：Git clone；也可下载 ZIP 解压）
git clone <你的仓库地址> meowcha-fork
cd meowcha-fork

# 安装依赖
pnpm install
```

**应该看到**：`pnpm install` 结束打印 `Done in xx s`，并生成 `node_modules/`。
**报错怎么办**：见 [第 14 节](#14-常见报错与排查)。

---

## 4. 第二步 · 配置环境变量

环境变量**只影响构建时写进静态文件的公开常量**（站点地址、备案号等）。

```bash
cp deploy/.env.example .env.local
# Windows PowerShell：
# Copy-Item deploy\.env.example .env.local
```

用编辑器打开 `.env.local`，至少按需填写：

```ini
# 分享海报上显示的站点地址（换成你自己的域名）
NEXT_PUBLIC_SITE_DISPLAY_URL=your-domain.example/meowcha
NEXT_PUBLIC_SITE_URL=https://your-domain.example/meowcha

# 备案（不填就不显示备案药丸，可留空跳过）
NEXT_PUBLIC_ICP_NUMBER=
NEXT_PUBLIC_POLICE_NUMBER=
NEXT_PUBLIC_POLICE_CODE=
NEXT_PUBLIC_POLICE_BADGE=

# 语音端点（不配就留空，走同源 /api/tts）
NEXT_PUBLIC_TTS_ENDPOINT=

# Supabase（可选；不填不影响单机对局与联机）
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
```

> ⚠️ 这里**不要**填 LLM Key。LLM 走 `prefill.js`（见第 8 步），不经过 `.env`。

**应该看到**：`.env.local` 已存在且内容如上。
**报错怎么办**：找不到模板 → 确认在仓库根目录执行，且 `deploy/.env.example` 存在。

---

## 5. 第三步 · 构建静态产物

```bash
pnpm build
```

**应该看到**：构建成功，终端打印若干路由信息；结束后出现 **`out/`** 目录。
**报错怎么办**：

- 若提示 Node 版本不符 → 你的构建机 Node 太旧。改用官方容器构建（无需在服务器装 Node）：

  ```bash
  docker run --rm -v "$PWD:/app" -w /app node:20-alpine \
    sh -c "corepack enable && pnpm install --frozen-lockfile && pnpm build"
  ```

  构建完成后同样会生成 `out/`。
- 其他报错 → 见 [第 14 节](#14-常见报错与排查)。

> 💡 构建产物 `out/` 是**纯静态文件**，可以放到任意静态托管（nginx、对象存储、CDN 等）。

---

## 6. 第四步 · 上传到服务器

把 `out/` 的内容**平铺**到 Web 根目录的 `meowcha/` 子目录下（关键：让 `index.html`、`_next/`、`brand/`、`bgm/` 直接位于该目录）。

**方式 A：本机构建，scp 上传**

```bash
# 在构建机上（替换 <你的服务器IP> 与用户）
ssh user@<你的服务器IP> 'mkdir -p /usr/share/nginx/html/meowcha'
scp -r out/. user@<你的服务器IP>:/usr/share/nginx/html/meowcha/
```

**方式 B：直接在服务器上构建**（服务器已装 Node 20+ / Docker）

```bash
# 在服务器上的仓库目录里
mkdir -p /usr/share/nginx/html/meowcha
cp -r out/. /usr/share/nginx/html/meowcha/
```

**应该看到**：服务器上 `/usr/share/nginx/html/meowcha/index.html` 与 `/usr/share/nginx/html/meowcha/_next/` 存在。
**报错怎么办**：权限不足 → 在命令前加 `sudo`，或确认 web 根目录路径（别硬套 `/usr/share/nginx/html`，以你的 nginx 配置为准）。

> 💡 「平铺 `out/`」的意思是：访问 `/meowcha/index.html` 就能看到首页，而不是 `/meowcha/out/index.html`。

---

## 7. 第五步 · 配置 nginx

参照仓库内的 [`../deploy/nginx-meowcha.conf`](../deploy/nginx-meowcha.conf)，把 `location /meowcha/` 写入你的站点配置。一个**最小可用**示例：

```nginx
# /etc/nginx/conf.d/meowcha.conf
server {
    listen 80;
    server_name your-domain.example;          # ← 改成你的域名

    root /usr/share/nginx/html;               # ← 你的 Web 根目录（out/ 平铺到 root/meowcha 下）

    location = /meowcha { return 301 /meowcha/; }

    location /meowcha/ {
        # 静态导出带 trailingSlash：未命中的路径回落到 index.html
        try_files $uri $uri/ /meowcha/index.html;

        add_header Cache-Control "no-store, no-cache, must-revalidate";
    }
}
```

要点说明：

| 配置 | 作用 | 不配会怎样 |
| --- | --- | --- |
| `try_files $uri $uri/ /meowcha/index.html;` | 单页回落，刷新子路由不 404 | 直接访问子路径会 404 |
| `add_header Cache-Control "no-store, …";` | 每次重验证：改版后访客立即拿到新版 | 浏览器可能缓存旧页面 |

然后检查并重载：

```bash
nginx -t && nginx -s reload
```

**应该看到**：`nginx -t` 打印 `syntax is ok` / `test is successful`。
**报错怎么办**：`nginx -t` 报错 → 按行号检查语法（多半是少分号或路径不存在）；确认 web root 路径与 `out/` 平铺位置一致。

> ⚠️ **`/meowcha` 前缀必须与 `next.config.ts` 的 `basePath` 一致**。若你改了前缀，这里所有 `/meowcha` 都要同步改。

---

## 8. 第六步 · 配置 LLM 垫片 `prefill.js`

> ⚠️ 这是让 AI 能说话的关键一步。**LLM 地址/模型/Key 不在 `.env` 里，而在 `prefill.js` 里。**

1. 把脱敏模板复制到部署目录（与页面同源）：

   ```bash
   cp deploy/prefill.js.example /usr/share/nginx/html/meowcha/prefill.js
   ```

2. 编辑 `/usr/share/nginx/html/meowcha/prefill.js`，把 `__DEEPSEEK_KEY__` 换成**你自己的** Key：

   ```js
   llmProvider: 'deepseek',
   llmBaseUrl: 'https://api.deepseek.com/v1/chat/completions',
   llmApiKey: '你的真实Key',                    // ← 替换 __DEEPSEEK_KEY__
   llmModel: 'deepseek-flash',
   ```

3. 想换服务商，只改这三行即可（`llmBaseUrl` 应为 **完整的 chat completions 地址**）：

   | 服务商 | `llmBaseUrl` | `llmModel` 示例 |
   | --- | --- | --- |
   | DeepSeek 官方 | `https://api.deepseek.com/v1/chat/completions` | `deepseek-flash` |
   | 硅基流动 | `https://api.siliconflow.cn/v1/chat/completions` | `deepseek-ai/DeepSeek-V3` |
   | OpenAI 官方 | `https://api.openai.com/v1/chat/completions` | `gpt-4o` |
   | 其它兼容接口 | 填你的地址 | 填你的模型名 |

> ⚠️ **填好 Key 的 `prefill.js` 绝不能提交进仓库**！`.gitignore` 已忽略 `prefill.js`。仓库里只放脱敏模板 `deploy/prefill.js.example`。

**应该看到**：服务器上 `/usr/share/nginx/html/meowcha/prefill.js` 存在，且 `llmApiKey` 已是真实值。
**报错怎么办**：页面加载后 AI 仍不说话 → 打开 `F12` → `Console`，执行
`JSON.parse(localStorage.getItem('meowcha_api_config'))`，确认 `llmApiKey` 是你填的值。如果返回 `null` 或 Key 为空，**先确认 `https://你的域名/meowcha/prefill.js` 能返回 200**（文件是不是放进了部署目录、文件名对不对），再看 Console 里这个脚本有没有 404 / 报错。

---

## 9. 第七步 · 验证

用 `curl` 在服务器或本地执行（替换 `your-domain.example`）：

```bash
# 1) 首页可访问
curl -s -o /dev/null -w '%{http_code}\n' "https://your-domain.example/meowcha/"   # 期望 200

# 1b) 配置垫片文件本身能取到（AI 能不能说话就看它）
curl -sI "https://your-domain.example/meowcha/prefill.js" | head -1               # 期望 200

# 2) 静态资源不再 404
curl -sI "https://your-domain.example/meowcha/brand/meowcha-favicon.png" | head -1   # 期望 200
curl -sI "https://your-domain.example/meowcha/bgm/day.mp3" | head -1                  # 期望 200
```

最后在浏览器打开站点，走一遍：

- [ ] 首页正常显示（契约页）。
- [ ] 能进入对局设置，并**成功开局**。
- [ ] AI 角色能**正常发言**（说明 LLM 配置生效）。
- [ ] 图片 / 背景音乐正常加载（说明资源前缀正确）。
- [ ] 若配了 TTS，AI 台词有语音。

**报错怎么办**：见 [第 14 节](#14-常见报错与排查)。

---

## 10. 可选 · 语音朗读 TTS

> **不配置也能正常玩**（AI 说的话以文字气泡显示，只是没有声音）。

**你要准备的东西只有一个**：一个「语音服务」—— 收 `{text, voiceId}`、返回一段 mp3。
**仓库里已经打包好一份可直接用的**：`deploy/tts/`（FastAPI + edge-tts，微软在线朗读，**免费、免 Key**，不用你写一行代码）。

**做法 A · 一键起全套（最省事）** —— 见 [第 0 节](#0-最快上手--一键部署docker-compose)：compose 会把「站点 + 联机 + 语音」三个一起起好，语音开箱可用。

**做法 B · 已有自己的服务器，手动接上**

1. 起语音服务（用仓库里现成那份，或你自己的）：
   ```bash
   cd deploy/tts
   docker build -t meowcha-tts:latest .
   docker run -d --name tts --restart unless-stopped meowcha-tts:latest    # 内部监听 8000
   ```
2. 在 nginx 加一段反代 —— 前端**固定请求同源** `/api/tts`（模板见 [`../deploy/nginx-meowcha.conf`](../deploy/nginx-meowcha.conf)）：
   ```nginx
   location = /api/tts {
       proxy_pass         http://tts:8000/;   # ← 改成你的语音服务地址；结尾的 / 表示剥掉 /api/tts 前缀
       proxy_http_version 1.1;
       proxy_set_header   Connection "";
       proxy_set_header   Host $host;
       proxy_read_timeout 120s;
       proxy_buffering    off;
   }
   ```
   若语音服务在**别的域名**：构建前设 `NEXT_PUBLIC_TTS_ENDPOINT=https://你的语音服务/xxx` 再 `pnpm build`（跨域、HTTPS 均由你自行保证）。
3. `nginx -t && nginx -s reload`。

**验证**

```bash
curl -s -X POST "https://your-domain.example/api/tts" \
  -H 'Content-Type: application/json' \
  -d '{"text":"测试","voiceId":"zh-CN-XiaoxiaoNeural"}' -o /tmp/t.mp3 && ls -l /tmp/t.mp3
```

**应该看到**：拿到一个非空的 mp3（几 KB～几十 KB）。

| 现象 | 原因与解决 |
| --- | --- |
| 返回 JSON 而不是音频 | 反代没接通，或上游路由对不上（注意 `proxy_pass` 结尾有无 `/` 决定前缀是否被剥掉） |
| 有 mp3，但浏览器里没声音 | 玩家把「音效 / 角色配音」关了，或「语音音量」为 0 —— 首页右上角【设置】与对局内【设置】都能调 |
| 首次合成慢 / 失败 | edge-tts 是**在线**朗读，服务器需要能访问外网 |

---

## 11. 可选 · 邀请码联机

> **单机游玩不需要它。** 只有想「2～3 位真人同桌、其余 AI 补全」时才需要。

**它是什么**：一个很小的「房间服务」。房主浏览器里跑着整局裁判，算出的局面写进它；朋友再从里面读「自己那一份」（狼人是谁这类隐藏信息根本不会被写进去）。房间码即凭据，变更通过 **SSE** 即时推送。

**仓库里已经附了一份可直接用的实现**：`deploy/meowroom/`（FastAPI + SQLite，接口与前端 `src/lib/meowroom/client.ts` 一一对应），**不用你写代码**。

**做法 A · 一键起全套（最省事）** —— 见 [第 0 节](#0-最快上手--一键部署docker-compose)：compose 会连房间服务与 `/meowcha/mp/` 反代一起配好。

**做法 B · 手动接上**

1. 起房间服务：
   ```bash
   cd deploy/meowroom
   docker build -t meowcha-meowroom:latest .
   docker run -d --name meowroom --restart unless-stopped -v meowroom-data:/data meowcha-meowroom:latest
   ```
2. 在 nginx 把 `/meowcha/mp/` 反代过去（**下面三行 SSE 必需项不能省**）：
   ```nginx
   location /meowcha/mp/ {
       proxy_pass              http://meowroom:8000/;   # ← 改成你的房间服务地址
       proxy_http_version      1.1;
       proxy_set_header        Host $host;
       # SSE 必需：清空 Connection 保持长连接；关闭缓冲，否则事件会被 nginx 攒着不发
       proxy_set_header        Connection "";
       proxy_buffering         off;
       proxy_cache             off;
       proxy_read_timeout      3600s;
       proxy_send_timeout      3600s;
   }
   ```
3. `nginx -t && nginx -s reload`，然后进游戏试一次「建房 → 用房间码进房」。

> ⚠️ **最容易踩的坑**：漏掉 `proxy_buffering off;` / `Connection ""` / 长 `proxy_read_timeout` 时，会表现成「**连是连上了，却收不到朋友的动静**」（SSE 被 nginx 缓冲，或被默认 30s 掐断）。
> ⚠️ 房间服务必须**单进程**跑（SSE 用的是进程内发布订阅）—— 仓库里的 Dockerfile 已固定 `--workers 1`。

**接口一览**（想自己实现时照这个写；`BASE_PATH + "/mp"` 就是它的根）：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/rooms` | 建房 → `{code, version}` |
| `GET` | `/rooms/{code}` | 拉取房间（404 = 已删除 / 过期） |
| `PUT` | `/rooms/{code}` | 房主下发局面；body 带 `version` 乐观锁，冲突须返回 **409** |
| `DELETE` | `/rooms/{code}` | 解散房间 / 房主离场 |
| `POST` | `/rooms/{code}/actions` | **客人提交操作**（服务端原子追加、同 id 幂等）—— 少了它，客人的发言/投票传不到房主 |
| `GET` | `/rooms/{code}/stream` | **SSE 变更推送**（只发 `{"version": n}` 一帧，客户端收到后自行 GET）—— 少了它只能靠轮询，延迟明显 |

**排查**：建房/进房失败 → 先 `curl -s -X POST https://你的域名/meowcha/mp/rooms -H 'Content-Type: application/json' -d '{}'`，看是不是 200；404 多半是 `proxy_pass` 的**结尾斜杠**（前缀剥离）与后端路由没对齐。

---

## 12. 可选 · 备案信息

仅**中国大陆自部署**需要，且为**可选**。在 `.env.local` 填好对应变量后**重新构建**：

```ini
NEXT_PUBLIC_ICP_NUMBER=你的ICP备案号
NEXT_PUBLIC_POLICE_NUMBER=你的公安备案号
NEXT_PUBLIC_POLICE_CODE=你的公安备案编号
NEXT_PUBLIC_POLICE_BADGE=/assets/badge_police.png   # 图标地址（可留空）
```

- **不填则完全不显示备案药丸**（由应用渲染，非 nginx 注入）。
- 若用图标，把图标文件放到 `public/assets/` 或 web root 的 `assets/` 下，路径要与变量一致。

---

## 13. 想部署在根路径 `/`

默认部署在 `/meowcha/`。若你想部署在根路径，需**同时**改两处（改完必须**重新构建**）：

1. `next.config.ts`：把 `basePath: "/meowcha"` 改为 `basePath: ""`（或删除该行）。
2. `src/lib/site-path.ts`：把 `BASE_PATH` 的默认值 `"/meowcha"` 改为 `""`（或构建时设 `NEXT_PUBLIC_APP_BASEPATH=""`）。
3. nginx 里的 `location /meowcha/` 与所有 `/meowcha` 前缀同步改为 `/`。

> ⚠️ 这两处的默认值**必须一致**，否则静态资源会 404。

---

## 14. 常见报错与排查

| 现象 | 可能原因 | 解决 |
| --- | --- | --- |
| `pnpm install` 报 Node 版本不符 | Node < 20 | 升级 Node，或用 `node:20-alpine` 容器构建 |
| `pnpm build` 失败 | 依赖未装 / Node 太旧 | 先 `pnpm install --frozen-lockfile`；确认 Node ≥ 20 |
| 首页 404 | nginx 未配 `location /meowcha/` 或未 `try_files` 回落 | 按第 7 步补全并 `reload` |
| 页面能开但图片/音乐 404 | `out/` 没**平铺**到 `/meowcha/` 下 | 确认 `index.html` / `_next/` / `brand/` / `bgm/` 都**直接**在该目录（别多套一层） |
| AI 不说话 | `prefill.js` 文件没放对 / Key 无效 | 先 `curl -sI …/meowcha/prefill.js` 确认 **200**，再看 `localStorage.meowcha_api_config` |
| 改了配置但不生效 | 浏览器缓存 | 强制刷新（`Ctrl/Cmd + Shift + R`）；nginx 已设 `no-store` |
| 语音无声音 | `/api/tts` 未接通，或玩家关了「音效 / 角色配音」 | 见第 10 节：先 `curl -X POST …/api/tts` 确认能回 mp3，再看浏览器 Console 有无 TTS 报错 |
| 联机进不去 | 房间后端未部署 / 未反代 | 见第 11 节；单机不需要 |
| 分享海报地址不对 | 站点地址变量没填 | 填 `NEXT_PUBLIC_SITE_DISPLAY_URL` / `NEXT_PUBLIC_SITE_URL` 后**重新构建** |

> 💡 **通用排查心法**：先看**终端/服务器日志**（`nginx -t`、`nginx` error log），再看**浏览器 `F12` Console**，最后确认**配置改动后是否重新构建 / reload**。

---

## 15. 回滚

```bash
# 方式一：整目录删掉（或恢复上一版备份）
sudo rm -rf /usr/share/nginx/html/meowcha

# 方式二：恢复备份后 reload
sudo mv /usr/share/nginx/html/meowcha.bak /usr/share/nginx/html/meowcha
nginx -s reload
```

> ⚠️ 删除前请确认你没有把「唯一一份 `prefill.js`」也删掉（含你的 Key）。

</details>

---

## 附：一页速查（TL;DR）

```bash
corepack enable
pnpm install
cp deploy/.env.example .env.local      # 填站点地址（可选填备案）
pnpm build                             # → out/

ssh user@<你的服务器IP> 'mkdir -p /usr/share/nginx/html/meowcha'
scp -r out/. user@<你的服务器IP>:/usr/share/nginx/html/meowcha/
cp deploy/prefill.js.example <部署目录>/meowcha/prefill.js   # 填真实 Key

# nginx 配 location /meowcha/（见第 7 步）后：
nginx -t && nginx -s reload
```

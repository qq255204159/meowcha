# 喵杀（MEOWCHA）· 详细部署教程

> 面向**零基础**用户，从零开始把喵杀部署到你自己的服务器。
> 全程命令可直接复制，每一步都说明「**应该看到什么**」与「**报错怎么办**」。
> 约定：站点挂在子路径 **`/meowcha/`** 下（因为 `next.config.ts` 的 `basePath` 是 `/meowcha`）。

---

## 目录

1. [它是怎么跑起来的（先看懂架构）](#1-它是怎么跑起来的先看懂架构)
2. [前置要求](#2-前置要求)
3. [第一步 · 准备源代码](#3-第一步--准备源代码)
4. [第二步 · 配置环境变量](#4-第二步--配置环境变量)
5. [第三步 · 构建静态产物](#5-第三步--构建静态产物)
6. [第四步 · 上传到服务器](#6-第四步--上传到服务器)
7. [第五步 · 配置 nginx](#7-第五步--配置-nginx)
8. [第六步 · 配置 LLM 垫片 prefill.js](#8-第六步--配置-llm-垫片-prefilljs)
9. [第七步 · 验证](#9-第七步--验证)
10. [可选 · TTS 语音服务](#10-可选--tts-语音服务)
11. [可选 · 邀请码联机后端（进阶）](#11-可选--邀请码联机后端进阶)
12. [可选 · 备案信息](#12-可选--备案信息)
13. [想部署在根路径 `/`](#13-想部署在根路径-)
14. [常见报错与排查](#14-常见报错与排查)
15. [回滚](#15-回滚)

---

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
# 装 Node 20+（见 README「快速开始」第 0 步），然后启用 pnpm
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

        # 历史遗留：配置垫片注入 —— 当前版本**不需要**（页面已自带该 <script>，见 src/app/layout.tsx）。
        # 保留仅为兼容旧构建产物；新部署可删，**关键是 prefill.js 文件要放进本目录**（见第 8 步）。
        sub_filter '<head>' '<head><script src="/meowcha/prefill.js"></script>';
        sub_filter '"/brand/' '"/meowcha/brand/';   # 同上，历史遗留（当前产物已无裸 "/brand/"）
        sub_filter_once off;

        add_header Cache-Control "no-store, no-cache, must-revalidate";
    }
}
```

要点说明：

| 配置 | 作用 | 不配会怎样 |
| --- | --- | --- |
| `try_files $uri $uri/ /meowcha/index.html;` | 单页应用回落，刷新子路由不 404 | 直接访问子路径会 404 |
| （可选 · 历史遗留）`sub_filter '<head>' … prefill.js …` | 兼容**旧**构建产物的注入 | 新版本页面自带该标签，删掉也不影响 —— **真正关键的是 `prefill.js` 文件要放在部署目录里** |
| （可选 · 历史遗留）`sub_filter '"/brand/' '"/meowcha/brand/'` | 修正**旧**产物的资源前缀 | 当前产物已自带 `/meowcha` 前缀；仅当你把 brand 放在站点根 `/brand/` 时才需要它兜底 |
| `sub_filter_once off;` | 让 `sub_filter` 对所有出现处生效 | 只替换第一处（仅在上面两条仍在用时才有意义） |

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

# 1b) 配置垫片文件本身能取到
#     ⚠️ 不要用 `grep -c 'prefill.js'` 判断注入：页面**本来就自带**这个 script 标签，永远命中、测不出问题
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

## 10. 可选 · TTS 语音服务

不配置也能正常玩；想要语音朗读再往下看。

**前端行为**：把台词 `POST` 到 `process.env.NEXT_PUBLIC_TTS_ENDPOINT ?? "/api/tts"`，请求体：

```json
{ "text": "要说的话", "voiceId": "zh-CN-XiaoxiaoNeural" }
```

期望返回 **`audio/mpeg`**（即一个可播放的 mp3 二进制）。

**做法一（推荐）**：在 nginx 增加一个反代段，把 `/api/tts` 指向你的 TTS 服务。`deploy/nginx-meowcha.conf` 末尾已给出被注释的示例，取消注释并改地址：

```nginx
location = /api/tts {
    proxy_pass         http://tts:8000;     # ← 改成你的 TTS 服务地址
    proxy_http_version 1.1;
    proxy_set_header   Connection "";
    proxy_set_header   Host $host;
    proxy_read_timeout 120s;
    proxy_buffering    off;
    add_header Cache-Control "no-store";
}
```

**做法二**：若 TTS 服务在别的域名，构建前设 `NEXT_PUBLIC_TTS_ENDPOINT=https://tts.your-domain.example/tts` 并重新构建。

> 💡 自建 TTS 可用 **edge-tts**（免费、免 Key），暴露一个接收 `{text, voiceId}` 返回 mp3 的 HTTP 接口即可。音色分组需与前端 `src/lib/voice-constants.ts` 里的 `voiceGroup` 对应（如 `zh-CN-XiaoxiaoNeural`）。

**验证**：

```bash
curl -s -X POST "https://your-domain.example/api/tts" \
  -H 'Content-Type: application/json' \
  -d '{"text":"测试","voiceId":"zh-CN-XiaoxiaoNeural"}' -o /tmp/t.mp3 && ls -l /tmp/t.mp3
```

**应该看到**：`/tmp/t.mp3` 有大小（几 KB～几十 KB）。
**报错怎么办**：返回 JSON 而非音频 → 反代目标未接通或鉴权/voiceId 有问题；浏览器无声音 → 检查站点是否为 HTTPS、以及是否被静音策略拦截。

---

## 11. 可选 · 邀请码联机后端（进阶）

> **单机游玩不需要它。** 只有当你想「2～3 位真人同桌、其余 AI 补全」时才需要。

**原理**：房主浏览器跑游戏引擎，把「按座位裁剪过的局面」同步到后端房间（变更走 **SSE 即时推送**，另有 0.5 秒兜底同步）；客人只渲染自己那份（隐藏信息不会泄露）。房间码即凭据。

**前端约定**（见 `src/lib/meowroom/client.ts`）：

- 传输走**同源 REST**，基址为 `BASE_PATH + "/mp"`（默认 `/meowcha/mp`）。
- 需要实现的接口（**少一个都会有功能静默失效**）：

  | 方法 | 路径 | 用途 |
  | --- | --- | --- |
  | `POST` | `/rooms` | 建房 |
  | `GET` | `/rooms/{code}` | 拉取房间（404 = 已删除 / 过期） |
  | `PUT` | `/rooms/{code}` | 房主下发局面；body 带 `version` 乐观锁，冲突须返回 **409** |
  | `DELETE` | `/rooms/{code}` | 解散房间 / 房主离场 |
  | `POST` | `/rooms/{code}/actions` | **客人提交操作**（服务端原子追加，避免与房主 PUT 抢版本号）—— 少了它，客人的发言/投票传不到房主 |
  | `GET` | `/rooms/{code}/stream` | **SSE 变更推送**（只发「有新版本号」一帧，客户端收到后自行 GET）—— 少了它，联机只能靠轮询，延迟明显 |

**你需要做的**：

1. 部署一个「房间存储」后端（**FastAPI + SQLite**，实现上述 REST 接口）。
2. 在 nginx 把 `/meowcha/mp/` 反代到该后端：

   ```nginx
   location /meowcha/mp/ {
       proxy_pass         http://meowroom:8000/;   # ← 改成你的房间后端地址
       proxy_http_version 1.1;
       proxy_set_header   Host $host;

       # ⚠️ 下面三行是 SSE 的**必需项**，缺了会表现成「连是连上了，却收不到推送」：
       proxy_buffering    off;      # 不关缓冲 → 变更信号会被 nginx 攒着不发
       proxy_set_header   Connection "";  # SSE 是长连接，必须保持到上游
       proxy_read_timeout 3600s;    # 默认 30s 会把 SSE 掐断，客户端反复重连
   }
   ```

3. 重新加载 nginx：`nginx -t && nginx -s reload`。

**应该看到**：联机大厅能建房、能用邀请码进房、房主开局后客人能看到自己那份牌桌。
**报错怎么办**：建房/进房失败 → 检查 `/meowcha/mp/rooms` 是否可访问（`curl -X POST …`）；404 → 反代 `proxy_pass` 结尾的斜杠或前缀没对齐。

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
| 页面能开但图片/音乐 404 | `out/` 没**平铺**到 `/meowcha/` 下 | 确认 `index.html` / `_next/` / `brand/` / `bgm/` 都**直接**在该目录（别多套一层）；当前产物已自带 `/meowcha` 前缀，一般不需要 `sub_filter` |
| AI 不说话 | `prefill.js` 文件没放对 / Key 无效 | 先 `curl -sI …/meowcha/prefill.js` 确认 **200**，再看 `localStorage.meowcha_api_config`（页面自带该 `<script>` 标签，**不需要** nginx 注入） |
| 改了配置但不生效 | 浏览器缓存 | 强制刷新（`Ctrl/Cmd + Shift + R`）；nginx 已设 `no-store` |
| 语音无声音 | `/api/tts` 未接通，或玩家关了「音效 / AI 语音」 | 见第 10 节：先 `curl -X POST …/api/tts` 确认能回 mp3，再看浏览器 Console 有无 TTS 报错；**不再需要任何 localStorage 占位键**（2026-10-19 起） |
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

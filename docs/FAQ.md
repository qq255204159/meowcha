# 喵杀（MEOWCHA）· 常见问题（FAQ）

> 覆盖安装 / 本地运行 / 配置 / 构建 / 部署 / 玩法 / 许可等高频问题。
> 更细的部署步骤见 [`DEPLOY.md`](DEPLOY.md)，配置项总表见 [`CONFIG.md`](CONFIG.md)。

## 目录

- [A. 安装与本地运行](#a-安装与本地运行)
- [B. 配置与 AI 发言](#b-配置与-ai-发言)
- [C. 构建](#c-构建)
- [D. 部署与 nginx](#d-部署与-nginx)
- [E. 语音（TTS）](#e-语音tts)
- [F. 联机](#f-联机)
- [G. 玩法与规则](#g-玩法与规则)
- [H. 许可、出处与免责](#h-许可出处与免责)

---

## A. 安装与本地运行

**Q1：必须先装 Node 吗？装哪个版本？**
是的。**Node ≥ 20**（推荐 LTS）。⚠️ **Node 18 太旧，构建会失败**。用 `node -v` 查看版本。

**Q2：pnpm 怎么装？**
用 Node 自带的 corepack 即可，无需手动下载：

```bash
corepack enable
pnpm -v      # 期望 9.x.x
```

Windows 若报权限不足，用「以管理员身份运行」的 PowerShell 重开一次。

**Q3：`pnpm install` 一直失败 / 很慢怎么办？**
多为网络问题。可先设镜像再重试：

```bash
pnpm config set registry https://registry.npmmirror.com
pnpm install
```

**Q4：`pnpm dev` 起来了，但打开 `localhost:3000` 是 404？**
地址**必须带子路径**：<http://localhost:3000/meowcha/>（因为 `basePath = /meowcha`）。

**Q5：提示 `Port 3000 is in use`（端口被占用）？**
关掉占用 3000 的程序，或换端口：

```bash
pnpm dev --port 3001     # 地址变 http://localhost:3001/meowcha/
```

**Q6：Windows 上有没有更省事的启动方式？**
有。双击仓库根目录的 `start.bat`，它会自动装 pnpm、装依赖并启动。注意它提示的地址不含 `/meowcha/`，请以浏览器实际跳转的 `/meowcha/` 为准。

**Q7：本地改了代码，页面没变化？**
Next 开发服务器一般会热更新。若没生效，检查终端是否有编译报错，或重启 `pnpm dev`。

---

## B. 配置与 AI 发言

**Q8：AI 一直不说话，为什么？**
最常见原因是**没有可用的 LLM 配置**（`llmApiKey` 为空或无效）。LLM 配置**不经过 `.env`**，而是存在浏览器 localStorage，分两层：

| 优先级 | 来源 | 键 |
| --- | --- | --- |
| 最高 | 游戏首页「**设置 → AI 模型**」里填的 | `meowcha_user_api_config` |
| 次之 | 部署时由 `prefill.js` 注入的服务器默认配置 | `meowcha_api_config` |

排查：先在首页【设置】里看一眼状态提示（会直接告诉你现在用的是哪一层、还是"尚未配置"）。
也可以用 `F12` → Console 检查：

```js
JSON.parse(localStorage.getItem('meowcha_user_api_config'))   // 你填的
JSON.parse(localStorage.getItem('meowcha_api_config'))        // 服务器默认
```

确认 `llmApiKey` 有值、`llmBaseUrl` 正确、`llmModel` 正确。

**Q9：怎么填 LLM 配置最方便？**
**直接在游戏首页点【设置】→「AI 模型（LLM）」**，选服务商、填 API Key 与模型名，点【测试连通性】验证，再点【保存】即可，**不用碰命令行和 Console**。

> 想用命令行/Console 手工写也行（等价于"服务器默认配置"那一层）：
>
> ```js
> localStorage.setItem('meowcha_api_config', JSON.stringify({
>   llmProvider: 'deepseek',
>   llmBaseUrl: 'https://api.deepseek.com/v1/chat/completions',
>   llmApiKey: '你的KEY',
>   llmModel: 'deepseek-flash',
>   ttsEnabled: false, ttsApiKey: '', ttsGroupId: ''
> }));
> localStorage.setItem('meowcha_custom_key_enabled', 'true');
> localStorage.setItem('meowcha_minimax_api_key', 'self-hosted');
> location.reload();
> ```

**Q10：能不能换别的模型 / 服务商？**
可以。在【设置 → AI 模型】里切换「服务商」下拉，或手动把 API 地址换成对应服务商的 **chat completions 完整地址**、模型名换成对应模型即可（DeepSeek、硅基流动、OpenAI、任何兼容接口都行）。

**Q11：为什么配置不是用 `.env`，而要 `prefill.js`？**
因为这是**纯前端静态站点**。`.env` 只承载公开常量（站点地址、备案号等）。服务器默认的 LLM Key 由 `prefill.js` 写进 localStorage 并「锁定」，避免被页面随意改写。
> 注意：玩家在【设置】里填的是**另一个键**（`meowcha_user_api_config`），**不在锁定名单里**，所以设置面板里的覆盖始终能生效。

**Q12：部署后必须用 `prefill.js` 吗？**
看你想要哪种体验：
- **想让访客开箱即用** → 必须。把 `deploy/prefill.js.example` 复制到部署目录的 `prefill.js`，填入真实 Key。
- **只打算自己玩 / 让玩家自己填 Key** → 可以不用；此时每位玩家第一次进游戏会被提示去【设置 → AI 模型】填 Key。

⚠️ 无论哪种，**填好 Key 的 `prefill.js` 绝不能提交进仓库**（`.gitignore` 已忽略）。

**Q13：页面刷新后配置丢了？**
一般是没开启锁定或 `prefill.js` 未注入。线上确认 nginx 的 `sub_filter` 把 `prefill.js` 注入了 `<head>`；本地确认 localStorage 键还在（没清缓存）。

---

## C. 构建

**Q14：`pnpm build` 报 Node 版本错误？**
构建必须在 **Node ≥ 20** 环境进行。若本机太旧，用官方容器构建：

```bash
docker run --rm -v "$PWD:/app" -w /app node:20-alpine \
  sh -c "corepack enable && pnpm install --frozen-lockfile && pnpm build"
```

**Q15：构建产物在哪？**
在 **`out/`**（Next.js 静态导出），是纯静态文件，可放到任意静态托管 / nginx。

**Q16：构建出来能直接双击 `index.html` 打开吗？**
不建议。静态导出带 `trailingSlash` 与 `basePath`，很多路由与资源是面向 `/meowcha/` 的，用文件协议打开往往白屏。请用 nginx 或静态服务器托管。

---

## D. 部署与 nginx

**Q17：为什么必须挂在 `/meowcha/` 子路径？**
因为 `next.config.ts` 里 `basePath = "/meowcha"`。资源与路由都带这个前缀，所以最简单就是部署到该子路径下。

**Q18：能部署在根路径 `/` 吗？**
可以，但要**同时**改两处并重新构建：`next.config.ts` 的 `basePath` 与 `src/lib/site-path.ts` 的 `BASE_PATH` 默认值（两者必须一致），nginx 前缀同步改。

**Q19：首页能开，但图标 / 背景音乐 404？**
静态资源缺 `basePath` 前缀。确认 nginx 里有这两条并生效：

```nginx
sub_filter '<head>' '<head><script src="/meowcha/prefill.js"></script>';
sub_filter '"/brand/' '"/meowcha/brand/';
sub_filter_once off;
```

**Q20：nginx 改了配置没生效？**
改完必须 `nginx -t && nginx -s reload`。另外浏览器可能缓存旧页面，强制刷新（`Ctrl/Cmd + Shift + R`）。

**Q21：怎么快速验证部署成功？**

```bash
curl -s "https://your-domain.example/meowcha/" | grep -c 'prefill.js'   # 期望 >= 1
curl -sI "https://your-domain.example/meowcha/brand/meowcha-favicon.png" | head -1  # 期望 200
```

**Q22：有 Docker 镜像吗？**
仓库内有 `Dockerfile`（基于 `node:20-alpine`）。不过本项目是**静态导出**，常规做法是「构建出 `out/` → 用 nginx 托管」，不一定需要跑 Node 服务。

**Q23：备案药丸怎么显示 / 怎么去掉？**
由环境变量控制：填 `NEXT_PUBLIC_ICP_NUMBER` 等即显示，全部留空即不显示（改完需**重新构建**）。

---

## E. 语音（TTS）

**Q24：没有声音，是坏了吗？**
不是。语音是**可选**的，不配置也能正常玩。前端把台词 `POST` 到 `NEXT_PUBLIC_TTS_ENDPOINT ?? "/api/tts"`，body `{text, voiceId}`，期望返回 `audio/mpeg`。

**Q25：怎么开语音？**
在 nginx 把 `/api/tts` 反代到自建 TTS 服务（[`../deploy/nginx-meowcha.conf`](../deploy/nginx-meowcha.conf) 末尾有被注释的示例），或用 `NEXT_PUBLIC_TTS_ENDPOINT` 指向你的 TTS 服务。自建可用 edge-tts（免 Key）。

**Q26：`/api/tts` 返回 JSON 而不是音频？**
说明反代目标没接通，或鉴权 / voiceId 有问题。确认的 `proxy_pass` 地址、端口正确，且服务确实返回 `audio/mpeg`。

---

## F. 联机

**Q27：联机是必须的吗？单机能玩吗？**
联机是**可选进阶**。**单机游玩完全不需要房间后端**，AI 补全即可。

**Q28：邀请码联机怎么工作？**
2～3 位真人同桌，其余位置 AI 补全。房主浏览器跑游戏引擎，**每 0.8 秒**把「按座位裁剪过的局面」同步到后端房间，客人只渲染自己那份（隐藏信息不会泄露）。

**Q29：联机进不去房间 / 建房失败？**
多半是**没部署房间后端**或 nginx 没把 `/meowcha/mp/` 反代过去。该后端正例为 **FastAPI + SQLite**，实现 `POST /rooms`、`GET/PUT/DELETE /rooms/{code}` 等接口（见 [`DEPLOY.md`](DEPLOY.md) 第 11 节）。

**Q30：房主刷新页面，这局还能继续吗？**
房主页面刷新会丢本地引擎状态，本局无法继续，会退回大厅；其他玩家可留在房内等房主重新开局。

---

## G. 玩法与规则

**Q31：几个人一局？**
**6 / 8 / 10 / 12 人** 四档，默认 **12 人局**。

**Q32：各人数局的角色构成？**

| 人数 | 狼 | 神职 | 平民 |
| --- | --- | --- | --- |
| 6 人 | 2 | 预言家、女巫 | 2 |
| 8 人 | 2 | 预言家、女巫、猎人 | 3 |
| 10 人 | 3 | 预言家、女巫、猎人、白痴 | 3 |
| 12 人（默认） | 4（含白狼王） | 预言家、女巫、猎人、守卫 | 4 |

**Q33：什么叫「自定义房规」？**
开局前可配置 7 项：同守同救、女巫自救、被毒死的猎人是否开枪、胜负条件（屠城 / 屠边）、警长票权、白痴翻牌后投票权、白狼王自爆。**总开关默认关闭＝标准规则**。

**Q34：头像是什么？会联网加载吗？**
是 **16 款本地内置**的不同品种萌猫插画（`public/avatars/cats/cat-01 ~ cat-16`），完全离线、无任何外部请求。同局内猫种互不重复，名字与品种绑定。

**Q35：语速能调吗？复盘能看吗？**
能。游戏内可调语速；对局结束有复盘 / 洞察页，可回看角色、票型与关键决策。

---

## H. 许可、出处与免责

**Q36：这是原创项目吗？**
**不是。** 这是**二创**项目：**喵杀（MEOWCHA）由 [见星阁主](https://github.com/qq255204159) 开发，是狼人杀玩法的深度二创版本**。玩法框架来自上游开源项目 [`oil-oil/wolfcha`](https://github.com/oil-oil/wolfcha)，本版基线为 [`onebai123/wolfcha-web`](https://github.com/onebai123/wolfcha-web)，均为 **MIT License**。

**Q37：我可以再二创 / 商用吗？**
可以，遵循 **MIT License**（见仓库根目录 `LICENSE`，`Copyright (c) 2026 onebai123`）：保留版权声明即可自由使用、修改、分发。请自行评估上游与依赖的许可要求。

**Q38：需要 18+ 吗？内容安全吗？**
建议 **18 岁以上**。游戏内所有 AI 言论均由大语言模型生成，**不代表作者观点**，可能存在不准确或不当之处，请理性看待。

**Q39：能用来赌博吗？**
**绝对不能。** 本项目仅供休闲娱乐，请勿用于赌博或任何违法违规用途。

# 喵杀（MEOWCHA）· 配置项总表

> 本项目配置分**三层**，别混淆：
> 1. **构建期环境变量**（`.env`）——只承载公开常量（站点地址、备案号等），会被打进静态文件。
> 2. **LLM / TTS 运行时配置**——**不走 `.env`**，分两层存放在浏览器 **localStorage**：
>    **服务器默认配置**（部署时由 `prefill.js` 写入并锁定）+ **玩家自定义配置**（游戏首页「设置 → AI 模型」填写，填写后优先）。
> 3. **浏览器 localStorage 键**——游戏运行时的实际读取来源。

模板文件：
- 环境变量： [`../deploy/.env.example`](../deploy/.env.example)
- LLM/TTS 垫片： [`../deploy/prefill.js.example`](../deploy/prefill.js.example)

---

## 一、环境变量（`.env`）

> 复制 `deploy/.env.example` 为 `.env.local`（本地开发）或 `.env`（构建时）。
> ⚠️ Next.js 只会把以 `NEXT_PUBLIC_` 开头的变量暴露给浏览器端。

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_APP_BASEPATH` | 可选 | `/meowcha` | 站点子路径前缀。**必须与 `next.config.ts` 的 `basePath` 一致**；部署在根路径时改为空。 |
| `NEXT_PUBLIC_SITE_DISPLAY_URL` | 可选 | `your-domain.example/meowcha` | 分享海报上显示的站点地址（部署到自己的域名时请覆盖）。 |
| `NEXT_PUBLIC_SITE_URL` | 可选 | 由上一项拼出 `https://...` | 分享海报二维码指向的完整地址。 |
| `NEXT_PUBLIC_TTS_ENDPOINT` | 可选 | `/api/tts` | 语音合成端点；默认走同源自建 TTS。 |
| `NEXT_PUBLIC_ICP_NUMBER` | 可选 | 空 | ICP 备案号；不填则不显示备案药丸。 |
| `NEXT_PUBLIC_POLICE_NUMBER` | 可选 | 空 | 公安备案号；同上。 |
| `NEXT_PUBLIC_POLICE_CODE` | 可选 | 空 | 公安备案编号。 |
| `NEXT_PUBLIC_POLICE_BADGE` | 可选 | 空 | 公安备案图标地址（如 `/assets/badge_police.png`）。 |
| `NEXT_PUBLIC_SUPABASE_URL` | 可选 | 空 | 仅「账号 / 额度」相关界面用到；不填不影响单机对局与联机。 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 可选 | 空 | 同上。 |
| `NEXT_PUBLIC_APP_VERSION` | 自动 | `package.json` 的 `version` | 由 `next.config.ts` 从 `package.json` 注入，无需手填。 |

> ⚠️ **LLM Key 不要写进 `.env`**。LLM 配置走 `prefill.js` → localStorage（见第二节）。

---

## 二、LLM / TTS 配置

### 优先级（重要）

| 优先级 | 来源 | 存储键 | 说明 |
| --- | --- | --- | --- |
| 最高 | 玩家在游戏首页「设置 → AI 模型」填写的配置 | `meowcha_user_api_config` | 填了才生效；**此键不被锁定**，因此能覆盖服务器默认配置 |
| 次之 | 服务器默认配置（`prefill.js` 注入） | `meowcha_api_config` | 开箱即用；玩家留空时生效 |
| 兜底 | 内置默认值（`src/lib/api-config.ts` 的 `DEFAULT_CONFIG`） | — | 没有 Key，AI 无法发言 |

> 两层都没有可用配置时，AI 猫不会说话：点「开始一局」会弹出提示，并自动引导玩家打开设置面板。

### `prefill.js`（服务器默认配置）

> 由 nginx 注入到页面 `<head>`，负责**首次访问即写入默认配置**并**锁定**这些键。
> 模板：`deploy/prefill.js.example`（把 `__DEEPSEEK_KEY__` 换成你自己的 Key）。
> ⚠️ **填好 Key 的 `prefill.js` 绝不能提交进仓库**（`.gitignore` 已忽略 `prefill.js`）。
> 💡 玩家在界面里填写的配置写进的是**另一个键** `meowcha_user_api_config`，**不在锁定名单里**，所以设置面板里的覆盖始终有效。

`prefill.js` 中 `CFG` 对象写入 `meowcha_api_config`，字段如下：

| 字段 | 示例值 | 说明 |
| --- | --- | --- |
| `llmProvider` | `deepseek` | 服务商标识（`deepseek` / `siliconflow` / `openai` / `custom`）。 |
| `llmBaseUrl` | `https://api.deepseek.com/v1/chat/completions` | **完整的 chat completions 地址**。 |
| `llmApiKey` | `__DEEPSEEK_KEY__` | 你的 LLM Key（**部署时替换**）。 |
| `llmModel` | `deepseek-flash` | 模型名。 |
| `ttsEnabled` | `true` / `false` | 是否启用语音。 |
| `ttsApiKey` | `self-hosted-edge-tts` | 自建 TTS 时的占位值（服务端不使用）。 |
| `ttsGroupId` | `self-hosted` | 自建 TTS 时的占位值。 |

服务商 `llmBaseUrl` / `llmModel` 参考：

| 服务商 | `llmBaseUrl` | `llmModel` 示例 |
| --- | --- | --- |
| DeepSeek 官方 | `https://api.deepseek.com/v1/chat/completions` | `deepseek-flash` |
| 硅基流动 | `https://api.siliconflow.cn/v1/chat/completions` | `deepseek-ai/DeepSeek-V3` |
| OpenAI 官方 | `https://api.openai.com/v1/chat/completions` | `gpt-4o` |
| 自定义兼容接口 | 你的地址 | 你的模型名 |

---

## 三、浏览器 localStorage 键

> 游戏运行时实际读取这些键。`prefill.js` 会写入并「锁定」它们（写入即被还原）。

| 键 | 写入方 | 说明 |
| --- | --- | --- |
| `meowcha_api_config` | `prefill.js` | 服务器默认 LLM + TTS 配置（JSON，字段见上表）。**会被锁定**。 |
| `meowcha_user_api_config` | 设置界面 | 玩家自定义 LLM 配置（JSON，字段同上）。**不被锁定**；填写后优先于 `meowcha_api_config`。 |
| `meowcha_custom_key_enabled` | `prefill.js` | 需为 `"true"`，`isCustomKeyEnabled()` 才通过。 |
| `meowcha_zenmux_api_key` | `prefill.js` | 需非空，`hasZenmuxKey()` 才通过。 |
| `meowcha_minimax_api_key` | `prefill.js` | 需非空，`hasMinimaxKey()` 才通过。 |
| `meowcha_minimax_group_id` | `prefill.js` | MiniMax 分组占位值。 |
| `meowcha_locked_config_v1` | `prefill.js` | 锁定标记；被锁定键每次加载会被强制还原。 |
| `meowcha_house_rules` | 开局设置界面 | 自定义房规（JSON，字段见第四节）。 |
| `meowcha_player_id` | 联机 | 玩家身份 ID（同一浏览器多标签各自独立）。 |
| `meowcha_player_name` | 联机 | 玩家昵称。 |
| `meowcha_room_code` | 联机 | 上次的房间码。 |

> 💡 `prefill.js` 还会**清理历史遗留的 `wolfcha_*` 老键**（改名前的键），避免与新键混淆。
>
> ⚠️ **语音能出声的前提**：`meowcha_custom_key_enabled` 必须是 `"true"`、且 `meowcha_minimax_api_key` 非空（`hasMinimaxKey()`，见 `src/lib/audio-manager.ts`）。`deploy/prefill.js.example` 已经写好了占位值（`self-hosted`），照模板部署即可；**只用网页「设置」面板配 LLM，语音不会出声**。

---

## 四、自定义房规（`meowcha_house_rules`）

> 由开局设置界面写入；**总开关 `enabled=false` 时整局行为与标准规则完全一致**。默认值见 `src/lib/house-rules.ts`。

| 字段 | 默认 | 可选值 / 说明 |
| --- | --- | --- |
| `enabled` | `false` | 总开关；`false`＝标准规则。 |
| `guardSaveOverlap` | `"death"` | 同守同救：`"death"`（同守同救仍死）/ 其它值（同守同救存活）。 |
| `witchSelfSave` | `"always"` | 女巫自救：`"always"` / 其它。 |
| `poisonedHunterShoots` | `false` | 被毒死的猎人是否开枪。 |
| `winCondition` | `"city"` | 胜负条件：`"city"`（屠城）/ 其它（屠边）。 |
| `sheriffVoteWeight` | `1.5` | 警长票权（数值）。 |
| `idiotRevealedLosesVote` | `true` | 白痴翻牌后是否失去投票权。 |
| `whiteWolfKingCanBoom` | `true` | 白狼王能否自爆。 |

---

## 五、站点路径相关（易踩坑）

| 位置 | 默认 | 约束 |
| --- | --- | --- |
| `next.config.ts` → `basePath` | `/meowcha` | 必须与下面两者一致。 |
| `src/lib/site-path.ts` → `BASE_PATH` | `process.env.NEXT_PUBLIC_APP_BASEPATH ?? "/meowcha"` | 必须与 `basePath` 一致。 |
| nginx `location` 前缀 | `/meowcha/` | 必须与上面一致；对局资源路径经 `assetPath()` 拼前缀。 |
| 联机 API 基址 | `BASE_PATH + "/mp"`（`/meowcha/mp`） | 需 nginx 反代到房间后端。 |

> ⚠️ 三处前缀**必须同步**；改任意一处就要改全部，并**重新构建**。

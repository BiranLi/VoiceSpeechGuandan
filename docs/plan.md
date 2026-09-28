# 实施计划与阶段验收标准

> 版本：v1.0（草案）· 需求见 [requirements.md](./requirements.md)
> 阶段划分严格对齐 `board-game-voice-asr` skill 的 6 个实施步骤

## 阶段总览

| 阶段 | 名称 | 对应 skill 步骤 | 依赖 | 测试先于实现 | 产出 |
|---|---|---|---|---|---|
| S0 | 基线固化 + 测试骨架 | — | — | — | 质量门基线、vitest、牌工厂、65 个已通过的测试 |
| S1 | ASR 本地代理端点 | 第 1 步 | S0 | ✅ 已建 | `server/asr-proxy.ts` + `vite-asr-plugin.ts`，**16 例** |
| S2 | 浏览器录音模块 | 第 2 步 | S0 | ✅ 已建 | `src/lib/voice/recorder.ts`，**19 例** |
| S3 | VAD 自动收音 | 第 3 步 | S2 | 待建 | 开口即录、静音自动提交 |
| S4 | 领域指令解析器 | 第 4 步 | S1 | ✅ 契约已建 | 文本 → 合法动作（工作量最大） |
| S5 | 回合循环 + UI/无障碍 | 第 5 步 | S3, S4 | 待建 | 完整可用闭环 |
| S6 | e2e 与回归收口 | 第 6 步 | S1–S5 | — | 真实语音 e2e + 全量回归 |

**关键路径**：S0 → S1/S2 → S3 → S4 → S5 → S6。S1 与 S2 可并行。

## 测试左移原则（贯穿全程）

每个阶段的**测试先于实现存在**。具体要求见 `requirements.md` NFR-8：

1. 依赖的**既有/上游**行为，先用特征测试钉死（已在 S0 完成 65 例）；
2. 开工前先提一个**测试 commit（红）**，再提实现 commit（绿）；
3. 不得为“变绿”而降低断言强度；
4. 测试发现的错误假设**必须回写规格文档**（S4 的设计更正即由此而来）。

---

## S0 · 基线固化 + 测试骨架 ✅ 已完成

**目标**：在任何实现改动前把“什么叫通过”钉死，并建立可执行的测试底座。

**已产出**
- `guandan-windows/vitest.config.ts`（独立配置，不动上游 `vite.config.ts`）
- `guandan-windows/test/helpers/cards.ts`（牌工厂，对齐 `deck.ts`：级牌=15、小王=16、大王=17、大小王各 2 张）
- `guandan-windows/test/rules.characterization.test.ts`（**45 例**）
- `guandan-windows/test/parser-contract.test.ts`（**20 例**）
- `package.json` 新增 `test` / `test:watch` / `test:rules` / `test:contract`

**验收标准（实测结果）**

| 编号 | 验收项 | 命令 | 实测 |
|---|---|---|---|
| S0.1 | 类型检查基线已记录 | `npm run check` | 恰好 3 个错误，全在 `src/lib/ai.ts` 1226/1301/1328（TS2322） |
| S0.2 | 错误归属已确证为上游自带 | `diff -q <upstream>/src/lib/ai.ts src/lib/ai.ts` | 逐字节一致 |
| S0.3 | 测试代码零 TS 错误 | `npm run check` | `test/` 与 `vitest.config.ts` 无报错 |
| S0.4 | 测试全绿 | `npm test` | **65 passed**（45 特征 + 20 契约） |
| S0.5 | 性能预算已测 | `npm run test:contract` | 27 张手牌「枚举+过滤+分类」< 500ms |

**本阶段的关键产出：两个设计错误已被测试证伪**

1. **`getPlayInfos` 不是枚举器**——它是“这组牌构成什么牌型”的分类器，
   传入整副 27 张手牌返回 `[]`。原 S4 设计因此作废，
   改用 `generateAllPlays(hand).filter(p => canPlay(p, lastPlay))`。
2. **`getPossiblePlays` 不可用作合法性依据**——它按 `(type,maxValue,length)`
   分组压缩、且与 AI 难度耦合（master 硬上限 355/391）。它是“推荐棋”选择器，不是“全部合法走法”。

**另一个意外收获**：`generateAllPlays` 按**点数多重集去重**（3 张 K 只产出 1 个对子），
因此语音“对K”天然唯一，**不需要在花色层面消歧**——比原估计简单。

---

## S1 · ASR 本地代理端点

**目标**：`POST /api/asr` 在游戏同源端口可用，Key 只在服务端。

**前置**：S0

**测试先行**：先提 `test/asr-proxy.contract.test.ts`（红），验收项 S1.1–S1.8 以该文件为准。

**新增文件**
- `server/asr-proxy.ts`：`AsrProxy` 纯逻辑（不碰 Node req/res，全部可单测）
- `server/vite-asr-plugin.ts`：Vite 插件，只做「读 body → 调 handle → 写 res」
- `vite.config.ts`：仅追加 `asrProxyPlugin()` 一项，未改上游既有配置

**🔑 架构决策**：把代理拆成「纯逻辑 + 薄中间件」两层，而非把逻辑糊在中间件里。
这样 16 个用例能在 node 环境直接覆盖 503/400/错误透传/超时/scheme 校验等分支，
无需起服务器，也无需真实 Key。

**安全决策**：刻意**不设** `Access-Control-Allow-Origin`。前端用相对路径 `/api/asr`
是同源请求，浏览器不发预检也不需要该头；写成通配符 `*` 会让任意网站 POST 到用户
本机 6677、白白消耗他的 ASR 额度（首版曾误加，已移除）。

**⚠️ 模型选型：`-message` 变体不可用（已实测回退）**

曾尝试切到 `qwen-audio-3.1-asr-flash-message`，实测**三种内联形态全部被拒**：

| 请求形态 | 结果 |
|---|---|
| `content:[{audio: "data:audio/wav;base64,…"}]` | `url error, please check url` |
| `content:[{audio: {data: …}}]` | `url error` |
| `content:[{audio: {url: …}}]` | `url error` |
| OpenAI 兼容模式 `/compatible-mode/v1/chat/completions` | `Unsupported model` |

结论：`-message` 需要**真实公网 http(s) 地址**，与本地代理「Base64 内联、无公网依赖」
的架构直接冲突（同 `references/server-proxy.md` 对 `*-filetrans` 一类的结论）。
**已回退为 `qwen-audio-3.1-asr-flash`**，并新增 `DASHSCOPE_ASR_MODEL` 环境变量，
将来若能提供公网地址可随时切换而无需改代码。

**⚠️ e2e 素材陷阱：语音名必须用全名**

传短名 `say -v Flo` **不匹配**，会输出固定杂音——不同文本产生**逐位相同**的音频
（"对K" 与 "我要出对K" 都是 0.73s / RMS 2886.2 / 峰值 16674），或纯静音
（单字类 0.02s / RMS 0）。本机 18 个中文语音**全部已安装可用**，但必须用
`Flo (中文（中国大陆）)` 这类全名。此坑已写进 `test/asr_e2e.py` 文件头注释。

**✅ 真实语音 e2e 已跑通**（`test/asr_e2e.py`，硬失败 0）：

| 原文 | 耗时 | 识别 |
|---|---|---|
| 过 | 0.41s | ✅ `过。` |
| 顺子 | 0.34s | ✅ `顺子。` |
| 三带五 | 0.66s | ✅ `3+5` |
| 大王 | 0.57s | ⚠️ `蟹黄。`（同音误识） |
| 炸弹 | 0.32s | ⚠️ `照见。`（同音误识） |
| 对K | 0.43s | ⚠️ `运费。`（字母 K 被听成中文词） |

延迟 0.32–0.66s，与 skill 标称 ~450ms 吻合。
**S1.6 已实测**：无效 Key → HTTP 500 + `InvalidApiKey` 码，与网络故障可区分。

🔑 **这些识别结果直接约束 S4 解析器设计**：
- 「三带五」被识别为 `3+5` → 归一化阶段必须处理**阿拉伯数字与符号**（`+` 等）
- 字母 `K` 稳定被听成中文词 → 需**云端热词**或改用口语说法（如「老K」）；这是 skill
  标注的「数字/字母是重灾区」的真实体现

**改动文件**
- `guandan-windows/vite.config.ts`：新增 `configureServer` 中间件（**不改**已有 `server.port`/`strictPort`/`proxy` 配置）
- 或 `guandan-windows/server/index.js` + 在 `vite.config.ts` 的 `proxy` 增加 `/api/asr` 条目

**实现要点**（移植自 `references/server-proxy.md`，Python → Node 18+ 全局 `fetch`）
- 响应形状 `{ok:true, text}` / `{ok:false, error}`
- 缺 Key → **503 + 配置指引**，游戏仍可玩
- 转发前校验目标 URL scheme 为 https
- 云端错误体原样透传
- 请求体含 `parameters: {"format":"wav"}`（缺失报 `UNSUPPORTED_FORMAT`）
- 兼容两种返回结构：`output.output.sentence.text` 与 `output.choices[0].message.content[].text`
- 启动日志打印 ASR 是否启用及模型名

**验收标准**

| 编号 | 验收项 | 验证方式 | 期望 |
|---|---|---|---|
| S1.1 | 端点可达且同源 | `curl -s -XPOST localhost:6677/api/asr -d @t.json` | HTTP 200 + `{"ok":true,"text":...}` |
| S1.2 | 无 CORS 预检 | 浏览器 Network 面板 | 无 OPTIONS 请求、无 CORS 报错 |
| S1.3 | 缺 Key 行为正确 | 不设 `DASHSCOPE_API_KEY` 启动后 curl | HTTP 503 + 含 `DASHSCOPE_API_KEY` 的指引文案 |
| S1.4 | 缺 Key 时游戏仍可玩 | 浏览器手动出牌 | 出牌正常，语音按钮给出配置提示 |
| S1.5 | 缺 `audio_base64` | curl 空 body | HTTP 400 |
| S1.6 | 错误可区分 | 用无效 Key 实测 | 报错文案能区分"Key 无效"与"网络不通" |
| S1.7 | **红线**：Key 不入库 | `git grep -nE "sk-\|Bearer [A-Za-z0-9]{20}"` | 无结果 |
| S1.8 | **红线**：构建产物无 Key | `npm run build && grep -ri "dashscope.*key\|sk-" dist/` | 无真实 Key |
| S1.9 | 质量门不退化 | `npm run check` | 错误数 ≤ 3（NFR-6.1）✅ 实测 3 |
| S1.10 | 端到端识别正确 | `python3 test/asr_e2e.py` | ✅ **已实测通过**（硬失败 0） |

**已实测结果（无 Key 条件下）**

```text
$ curl -XPOST localhost:6677/api/asr -d '{"audio_base64":"UklGRg=="}'
HTTP 503
{"ok":false,"error":"服务器未配置 ASR API Key。请通过环境变量 DASHSCOPE_API_KEY 或启动参数 --asr-api-key 提供。"}

$ curl localhost:6677/api/asr          # 非 POST
HTTP 405  {"ok":false,"error":"仅支持 POST"}

# 响应头确认：无 Access-Control-Allow-Origin（同源无需）
```

- ✅ S1.1 同源可达（游戏页 200，代理挂载成功）
- ✅ S1.3 缺 Key 返 503 + 指引文案
- ✅ S1.2 无通配 CORS 头
- ✅ 非 POST 返 405
- ⏳ S1.5（缺 `audio_base64` → 400）**已由单测覆盖**，但无 Key 时线上会先命中 503，故未能 curl 实测
- ⏳ S1.6/S1.10 需真实 Key，待人工验证

**出口条件**：S1.1–S1.10 全过；`DASHSCOPE_API_KEY` 由用户自行 export（**我不代配、不入库**）。

**风险**：Vite 中间件在 `build` 后不生效——本项目语音仅开发/网页环境可用，与 NFR-7.2 一致，需在 UI 上明确。

---

## S2 · 浏览器录音模块

**目标**：`getUserMedia` + `AudioContext` 采集 16kHz 单声道，Float32 → 16-bit PCM WAV → base64。

**前置**：S0

**改动文件**
- 新增 `guandan-windows/src/lib/voice/recorder.ts`

**实现要点**（`references/vad-recording.md`）
- 命名用 `GuandanVoice`（skill 原文是 `ChessVoice`，改名复用）
- 回调契约 4 个**全部必给**：`onStatus` / `onResult` / `onError` / `onStateChange`
- 会话只获取一次并全程复用（反复 `getUserMedia` 有延迟和权限弹窗）
- 16kHz 16-bit 单声道 WAV，**不用** MediaRecorder 的 webm/opus
- 链路 `source → ScriptProcessor → gain(0) → destination` 防回放
- `resume`/attach 空值防御

**验收标准**

| 编号 | 验收项 | 验证方式 | 期望 |
|---|---|---|---|
| S2.1 | 采样格式正确 | 代码审查 + 手动 | `sampleRate:16000`、单声道、PCM16 WAV |
| S2.2 | 首次授权由用户手势触发 | 手动点按钮 | 弹出授权框 |
| S2.3 | 拒绝授权不崩溃 | 手动拒绝 | 走 `onError`，界面正常 |
| S2.4 | 会话只建一次 | 打桩计数 `getUserMedia` | 一次会话内调用 1 次 |
| S2.5 | 不外放 | 录音时听扬声器 | 无回声 |
| S2.6 | WAV 编码正确 | 单测：已知 Float32 数组 → 解码比对 | 头部 `RIFF`/`WAVE`、采样率 16000、位深 16 |
| S2.7 | base64 体积符合预期 | 3s 音频实测 | ≈128KB |
| S2.8 | 释放干净 | 结束对局后看系统麦克风指示灯 | 熄灭；track `stop()` 已调用 |
| S2.9 | 质量门不退化 | `npm run check` | 错误数 ≤ 3 |

**新增文件**：`src/lib/voice/recorder.ts`（`GuandanVoice` 类）

**测试先行**：`test/recorder.test.ts`（19 例，已建并全绿）。按 skill 做法在 node 环境
打桩浏览器 API（AudioContext / getUserMedia / fetch），不依赖真实麦克风。

**已测结果**：S2.3 拒绝授权走 onError、S2.4 会话只获取一次、S2.6 WAV 编码（44 字节头 /
16kHz / 单声道 / 16bit / 钳制不溢出）、S2.8 `stopTrack()` 与 `audioContext.close()`
均被调用、S2.9 质量门 —— 以上均由单测覆盖并通过。

⏳ **待人工验证**（需真实浏览器与麦克风，无法自动完成）：
S2.1 采样格式实测、S2.2 首次授权弹窗、S2.5 录音不外放、S2.7 体积、S2.8 麦克风指示灯熄灭。

**出口条件**：S2.1–S2.9 全过（单测部分已过，人工部分待做）。

**出口条件**：S2.1–S2.9 全过。

**风险**：`ScriptProcessorNode` 已被标准弃用，但全浏览器兼容且实现简单（skill 已知取舍）。追求极致可迁 AudioWorklet，v1 不做。

---

## S3 · VAD 自动收音

**目标**：免按键——开口自动录，静音自动提交。

**前置**：S2

**改动文件**
- `guandan-windows/src/lib/voice/recorder.ts`（在 S2 基础上加状态机）

**参数基线**
```js
energyThreshold: 0.02, silenceMs: 900, minSpeechMs: 150, maxSpeechMs: 6000, CHUNK_SAMPLES: 2048
```

**四个必踩的坑**（skill 明确列出，逐条对应验收）
1. 静音尾巴**不计入** `speechMs`（否则 128ms 噪声 + 静音尾巴就骗过最短过滤）
2. `_onUtteranceEnd` **先存局部变量再 `pause()`**（`pause()` 内部会 reset 计数器与采样缓冲）
3. `processor → gain(0) → destination` 保回调不外放
4. `resume`/attach 做空值防御

**验收标准**

| 编号 | 验收项 | 验证方式 | 期望 |
|---|---|---|---|
| S3.1 | 纯静音不触发 | 单测：50 个全零块 | `transcribe` 调用 **0** 次 |
| S3.2 | 说话+静音正常提交 | 单测：20 块正弦 + 8 块静音 | `onResult` 收到 mock 文本 |
| S3.3 | 过短被拒并自动重听 | 单测：1 块正弦 + 8 块静音 | `onStatus` 含"太短"，状态回 `listening` |
| S3.4 | `transcribe` 抛错走 `onError` | 单测：mock 抛错 | `onError` 收到错误信息 |
| S3.5 | 静音尾巴不计入 `speechMs` | 单测断言 | `speechMs` 仅累加语音块 |
| S3.6 | 数据不因 pause 丢失 | 单测：pause/reset 时序 | `encodeWav` 收到完整样本 |
| S3.7 | 超长自动截断 | 单测：60 块正弦 | 自动提交，状态机不死锁 |
| S3.8 | 未建会话时 resume 不抛 | 单测 | 无异常 |
| S3.9 | 手动 e2e | 浏览器：说"对K" | 自动录音→提交→出牌，**全程无按键** |
| S3.10 | 调参通道存在 | 代码审查 | 参数集中于 `VAD` 常量 |
| S3.11 | 质量门不退化 | `npm run check` | 错误数 ≤ 3 |

**出口条件**：S3.1–S3.11 全过，且手动 e2e 成功。

**风险**：安静房间不触发 → `energyThreshold` 降到 0.015/0.01；环境噪音误触发 → 升到 0.03/0.05；说完半句被提交 → `silenceMs` 升到 1200。按 skill 调参表迭代。

---

## S4 · 领域指令解析器（工作量最大）

**目标**：`parseCommand(state, text)` 把带噪文本翻译成合法动作，并汇入既有入口。

**前置**：S1

**测试先行**：`test/parser-contract.test.ts`（20 例）**已在 S0 建好并全绿**，
它固定了本阶段所依赖的全部规则引擎契约（见 `requirements.md` §0.4）。
实现阶段只需新增 `test/parser.test.ts`（针对解析器本身的用例），先红后绿。

**核心设计：候选集求交集**（借鉴 `OpenGuanDan` 的 `actionList`）

```text
识别文本 → ①清理归一 → ②语法拆解(牌型,点数)
   → ③generateAllPlays(players.p1.hand)   全量枚举
   → ④.filter(canPlay(p, lastValidPlay))  合法性过滤
   → ⑤对候选集按 (牌型, 点数) 过滤：0→error / 1→执行 / >1→消歧
```

> ⚠️ **设计更正**：原写作“用 `getPlayInfos(hand)` 枚举所有合法动作”，已被 S0 的特征测试证伪。
> `getPlayInfos` 是分类器（传整副手牌返回 `[]`），且 `getPossiblePlays` 会剪枝并耦合 AI 难度。
> 正确来源是 `generateAllPlays` + `canPlay`（见 FR-4.3a）。

**改动文件**
- 新增 `guandan-windows/src/lib/voice/parseCommand.ts`
- 新增 `guandan-windows/test/parser.test.ts`

**核心设计：候选集求交集**（借鉴 `OpenGuanDan` 的 `actionList`）

`OpenGuanDan` 服务端在轮到你时下发**当前局面所有合法动作的枚举**，客户端只需按 index 回选。本项目等价物是 `generateAllPlays` + `canPlay`：

```text
识别文本 → ①清理归一 → ②语法拆解(牌型,点数) → ③结合 hand 定位
   → ④getPlayInfos(hand) 枚举所有合法动作
   → ⑤交集：空→error；多→消歧；唯一→执行
```

这样绕开掼蛋最难的部分——**级牌逢人配**与 ASR 误识的组合爆炸。

**验收标准**

| 编号 | 验收项 | 验证方式 | 期望 |
|---|---|---|---|
| S4.1 | 感知实时手牌 | 单测：两种手牌喂 `"对K"` | 产出不同动作 |
| S4.2 | 规则校验兜底 | 单测：`"三带K"` 但无三张 K | 返回 error，`playCards` **未被调用** |
| S4.3 | 歧义按牌桌消解 | 单测：候选集多命中时 | 返回多候选或明确 error，**不静默任选** |
| S4.3a | 候选集来源正确 | 代码审查 + 契约测试 | 用 `generateAllPlays`+`canPlay`，**不用** `getPossiblePlays` |
| S4.3b | 候选集性能 | `npm run test:contract` | 27 张手牌 < 500ms |
| S4.4 | 失败不静默 | 代码审查 + 单测 | 每条失败路径返回结构化 `{error}` |
| S4.5 | 错误文案有教学性 | 断言文案 | 含原文 + 应说格式，如 `无法解析「飞象过河」（应说：牌型+点数，如 对K / 三带5 / 过）` |
| S4.6 | 四种"过"说法 | 单测 4 例 | 均触发 `passTurn('p1')` |
| S4.7 | 容忍标点 | 单测：`"对K。"` | 与 `"对K"` 结果一致 |
| S4.8 | 成功返回结构化动作 | 单测断言形状 | 含目标 `Card[]` 与 `PlayType`，可供 `playCards` 消费 |
| S4.9 | 级牌 v1 不做口语级消歧 | 单测：构造含级牌牌型 | 返回引导性 error，**不产生错误出牌** |
| S4.10 | 覆盖 v1 词表 11 牌型 | 单测：每个 `PlayType` 至少 1 例 | 全覆盖 |
| S4.11 | **不改核心逻辑** | `git diff --stat -- src/store/` | 无输出（NFR-2.2） |
| S4.12 | 汇入既有入口 | 代码审查 | 终点是 `playCards` / `passTurn` |
| S4.13 | 质量门不退化 | `npm run check && npm test` | 错误数 ≤ 3，测试全绿 |

**出口条件**：S4.1–S4.13 全过。解析器单测规模参考 skill 实测（象棋 26 用例），v1 掼蛋预计 30+ 用例。

**风险**：
- 数字是重灾区（ASR 对"七↔西"、"一↔衣"易错）→ 归一化阶段做同音字白名单
- 长顺子/钢板需明确张数 → 交由交集天然过滤（长度不匹配的候选不会被选中）
- 若识别率不足，v2 可上云端热词表（百炼支持）

---

## S5 · 回合循环 + UI/无障碍

**目标**：把 S3+S4 接成完整主循环，并让状态对玩家可见。

**前置**：S3, S4

**改动文件**
- `guandan-windows/src/components/game/HandArea.tsx`：在既有 `isMyTurn` 判据旁挂 start/stop
- 新增 `guandan-windows/src/lib/voice/useVoiceControl.ts`（或 hook）：集中守卫函数
- 新增/修改 UI 组件：语音开关按钮 + 状态提示区

**核心设计：单一守卫函数**（skill 明确警告"最容易漏的一条"是错误分支漏恢复收音）

```ts
function armVoiceTurn() {
  if (!voiceEnabled || !voice) return;
  if (gamePaused) return;
  if (currentTurn !== 'p1' || status !== 'playing') return;  // 轮对手，不收音
  voice.resume();
  updateStatus('🎙️ 请说出牌…');
}
```

所有"要不要恢复收音"都走它：onError、解析失败、对手落子完成、开局。**反面教材**（skill 原话）：早期版本在"每个错误分支里无条件调用恢复"，重构为集中守卫才杜绝漏恢复的 bug。

**接线清单**（skill 全量，逐条验收）

| 编号 | 事件 | 期望收音动作 | 验证方式 |
|---|---|---|---|
| S5.1 | 语音模式开启 | `startAuto()`；当前轮是对手则 `pause()` + 提示"落子后自动收音" | 手动 |
| S5.2 | 解析失败/非法 | `resume()` | 单测：喂乱文本后状态回 `listening` |
| S5.3 | 识别失败（网络/空结果） | `resume()` | 单测：mock 抛错后状态回 `listening` |
| S5.4 | 落子成功→对手回合 | `pause()` | 手动：AI 思考期间说话，断言**无 ASR 请求** |
| S5.5 | 对手落子完成 | `resume()` | 手动：AI 落子后自动恢复收音 |
| S5.6 | 暂停对局 | 一并暂停 / 恢复 | 手动 |
| S5.7 | 结束对局/返回主菜单 | `stopAuto()` + 复位标志 + 清按钮视觉 | 手动：麦克风指示灯熄灭 |
| S5.8 | 对局重开 | 按新状态决定是否立即收音 | 手动 |
| S5.9 | 守卫唯一性 | 代码审查：grep `resume(` | 无旁路调用点 |
| S5.10 | 视觉即麦克风状态 | 手动 | 监听中脉冲发光 / 暂停静止 / 关闭置灰，三态可区分 |
| S5.11 | 回显识别原文 | 手动 | 提示区永远显示"听到了什么" |
| S5.12 | 首次失败教格式 | 手动 | 首次输错顺带给格式示例 |
| S5.13 | 联机/观战时按钮禁用 | 手动：联机大厅 | 置灰 + tooltip 说明，不点才报错 |
| S5.14 | 非文本状态编码 | 代码审查 | 按钮状态不只靠颜色区分（NFR-3.2） |
| S5.15 | 复用 AudioManager 反馈 | 代码审查 | 不新增音频依赖 |
| S5.16 | 质量门不退化 | `npm run check` | 错误数 ≤ 3 |

**出口条件**：S5.1–S5.16 全过；语音在单机模式完整可用一局。

**风险**：`HandArea.tsx` 是上游核心交互组件，改动需最小化——只挂载语音、不重构其既有选牌逻辑，降低与上游同步的冲突面。

---

## S6 · e2e 与回归收口

**目标**：真实语音端到端打通 + 全量回归门（S0–S5 的测试已随各自阶段存在，本阶段不再从零写）。

**前置**：S1–S5

**改动文件**
- 新增 `test/asr_e2e.py`（真实语音 e2e，需 Key）
- 可选 `test/e2e_smoke.spec.ts`（Playwright 浏览器冒烟）

**分层策略**：第 1–2 层（状态机单测、解析器单测）已在 S2–S5 随实现建立，本阶段只补第 3–4 层。

**分层策略**（skill 三层都要有：只测状态机会漏端到端格式问题，只测端到端慢且不稳）

**第 1 层 · 状态机单测**（S3 建立）——合成音频，正弦波=说话、全零=静音，毫秒级
- 关键 mock：`v.transcribe = async () => '对K'`（成功）/ `async () => { throw new Error('网络中断') }`（失败）/ `v.audioContext = {}`（mock 掉浏览器 API）
- 覆盖 S3.1–S3.8

**第 2 层 · 解析器单测**（S4 建立）——构造手牌驱动，断言动作或错误关键词
- 覆盖矩阵：11 牌型 × 点数（含大小王）× 歧义 × 非法拦截（无此牌/长度不符/乱文本/空文本/级牌）
- 规则引擎侧的契约已由 S0 的 65 例固定
- **每修一个 bug 加一个用例**

**第 3 层 · 真实语音 e2e**（走完整 HTTP 链路）
```bash
say -o t.aiff "对K"
afconvert -f WAVE -d LEI16@16000 t.aiff t.wav
# POST http://127.0.0.1:6677/api/asr
```
- 断言用 `expected in got`（ASR 常带句号，**不能用 `==`**）
- 需 Key；CI 无 Key 时跳过并注明
- ⚠️ TTS 语音比真人清晰，**e2e 通过 ≠ 真人识别率达标**，上线前务必真人实测

**第 4 层（可选）· 浏览器冒烟**（headless 无麦克风，正好测错误路径）
- 页面无 JS 错误；语音按钮随对局模式正确启用/禁用
- 点击语音按钮（麦克风拒绝）→ `onError` 路径执行、不崩溃
- 结束对局 → 按钮回禁用、录音状态清理

**验收标准**

| 编号 | 验收项 | 命令 | 期望 |
|---|---|---|---|
| S6.1 | 回归命令可用 | `npm test` | 全绿（S0–S5 累积用例 + S0 的 65 例） |
| S6.2 | 特征与契约测试保持绿 | `npm run test:rules && npm run test:contract` | 65 例全绿 |
| S6.3 | 解析器用例数 | `npm test` | S4 用例 ≥ 30，覆盖 11 牌型 |
| S6.4 | 错误路径已测 | 单测断言 | 网络错/空结果/非法指令均触发 `onError` 且恢复收音 |
| S6.5 | e2e 打通 | 有 Key 时跑 `test/asr_e2e.py` | 识别文本含预期词（用 `in` 断言） |
| S6.6 | 无 Key 时优雅跳过 | 不设 Key 跑 e2e | skip 并打印说明，非失败 |
| S6.7 | 质量门全绿 | `npm run check && npm run lint && npm run build && npm test` | 错误数 ≤ 基线 3，lint 无新增，build 成功，测试全绿 |
| S6.8 | 真人实测完成 | 人工 | 至少 10 句真实语音，统计识别率并记录 |

**出口条件**：S6.1–S6.8 全过。v1 交付。

---

## 阶段依赖与并行

```
S0 ──┬── S1 ──────────┐
     │                ├── S4 ──┐
     └── S2 ── S3 ────┘        ├── S5 ── S6
```

S1（代理）与 S2（录音）互不依赖，可并行推进以缩短周期。S4 依赖 S1 拿到真实响应形状，但解析器单测可先 mock 跑起来。

## 全局验收（v1 交付定义）

| 编号 | 验收项 | 验证方式 |
|---|---|---|
| G1 | 玩家说"对K"能完成出牌，全程无鼠标 | 手动完整一局 |
| G2 | 玩家说"过"能过牌 | 手动 |
| G3 | AI 回合不误采音 | 手动：AI 思考时说话，无 ASR 请求 |
| G4 | 识别失败/非法后必定恢复收音，不卡住 | 手动 + 单测 |
| G5 | 不配置 Key 时游戏完全正常（鼠标可玩） | 手动 |
| G6 | Key 未出现在 git 与构建产物中 | `git grep` + grep `dist/` |
| G7 | `npm run check` 错误数 ≤ 基线 3 且不涉及本次文件 | 实跑 |
| G8 | `npm run build` 成功 | 实跑 |
| G9 | `npm test` 全绿 | 实跑 |
| G10 | 按钮三态视觉可区分，识别原文始终回显 | 手动 |
| G11 | README 与 `docs/` 已更新实际实现状态 | 代码审查 |

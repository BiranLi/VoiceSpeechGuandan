# 需求列表与需求验收标准

> 版本：v1.0（草案）· 基线 commit：`ee90cc1`（vendor 快照 `dengweiqh/guandan-windows@600c175`）
> 依据：`board-game-voice-asr` skill（SKILL.md + 5 份 references）
> 配套计划见 [plan.md](./plan.md)

## 0. 范围界定

### 0.1 v1 目标

在 `guandan-windows/` 单人单机模式（1 人类 vs 3 AI）下，玩家**开口说出出牌/过牌指令**即可完成操作，无需鼠标点击。

### 0.2 明确排除（v1 不做）

| 排除项 | 原因 |
|---|---|
| 局域网/联机模式 | 4 人共用房间抢麦，且无 AI 回合可 gating |
| 进贡/还贡语音 | 独立阶段与协议，v2 再做（`OpenGuanDan` 把它当一等 `tribute`/`back` pattern，可作参考） |
| 级牌逢人配相关组合 | 掼蛋最大复杂度点，v1 交由规则引擎兜底并明确报错 |
| Electron 打包产物内语音 | `base: './'` 为 `file://` 打包而设，麦克风不可用（见 NFR-7） |
| 两段确认、限时收音窗口 | skill 标注为可选增强，v2 |

### 0.3 术语与代码锚点

下表所有函数/字段均已在 vendor 快照中核实存在（`600c175`）：

| 概念 | 代码锚点 |
|---|---|
| 人类出牌入口 | `src/store/gameStore.ts` → `playCards(action: PlayAction)`、`passTurn(playerId)` |
| 出牌合法性校验 | `src/lib/rules.ts` → `canPlay(cards, lastPlay)` |
| **牌型分类器** | `src/lib/rules.ts` → `getPlayInfos(cards)` / `getPlayInfo(cards)` |
| **全量走法枚举**（解析器候选集来源） | `src/lib/ai.ts` → `generateAllPlays(hand)`（已导出） |
| AI 推荐候选（**解析器不适用**，见 S4） | `src/lib/ai.ts` → `getPossiblePlays(hand, lastPlay, difficulty)` |
| 回合判定 | `src/components/game/HandArea.tsx` → `isMyTurn = currentTurn === 'p1' && status === 'playing'` |
| 手牌 | `src/types/game.ts` → `GameState.players[p1].hand: Card[]` |
| 牌型枚举 | `src/types/game.ts` → `PlayType`（11 值） |
| AI 回合调度 | `src/pages/GameBoard.tsx` → `useEffect` 内 `status==='playing'` + `setTimeout` + `requestDecision` |
| 本地开发服务器 | `vite.config.ts` → `server.port: 6677`、`strictPort: true`、已有 `/socket.io` proxy |
| 现成牌型语音表 | `src/lib/audio.ts` → `AudioManager.voiceFiles` |
| 牌堆约定 | `src/lib/deck.ts` → 双副牌 108 张；级牌=15、小王=16、大王=17；逢人配=红桃级牌 |
| 质量门 | `package.json` → `npm run check`（`tsc -b --noEmit`）、`npm run lint`、`npm test`（vitest） |

### 0.4 已由测试钉死的规则引擎契约

以下结论来自 `guandan-windows/test/rules.characterization.test.ts`（45 例）与
`test/parser-contract.test.ts`（20 例），**已全部通过**，是 S4 实现的依据：

| 事实 | 证据 |
|---|---|
| `getPlayInfos` 是**分类器**（“这组牌构成什么牌型”），传整副 27 张手牌返回 `[]` | 用例「传入整副手牌不会枚举出所有走法，而是返回空」 |
| 枚举器是 `generateAllPlays(hand)`，合法性由 `canPlay` 过滤 | 契约测试 `legalCandidates()` |
| `generateAllPlays` 按**点数多重集去重**：3 张 K 只产出 1 个对子（非 C(3,2)=3 种花色组合） | 用例「三张同点数时，对子只有 1 个候选」 |
| 火箭需**恰好 4 张王**（双副牌共 4 张）；2 张王不构成火箭 | 用例「2 张王不构成火箭」 |
| 非逢人配的级牌**不能参与顺子/连对/钢板** | 用例「非逢人配的级牌不能参与顺子」 |
| 逢人配会产生**多个候选**（同一组牌可得 Straight + StraightFlush） | 用例「逢人配会让 getPlayInfos 返回多个候选牌型」 |
| `getPlayInfo` 优先返回炸弹/同花顺/火箭，否则取 `maxValue` 最大解释 | 用例「逢人配场景下优先返回高级牌型」 |
| 炸弹 `maxValue = 张数*1000 + 点数`；同花顺 `maxValue = 5500 + 最大牌` | 实测值 4003 / 5507 |
| 同张数炸弹按点数比大小（四A 压 四3） | 用例「同张数炸弹按点数比大小」 |
| `getPossiblePlays` 会**分组压缩**且**与 AI 难度耦合**（master 硬上限 355/391） | 用例组「getPossiblePlays：为何解析器不直接用它」 |

---

## 1. 功能需求

### FR-1 语音模式开关与麦克风会话

**描述**：玩家通过按钮开启/关闭语音模式。首次开启必须由用户手势触发（浏览器对 `getUserMedia` 的硬性要求），此后麦克风会话全程复用，不反复申请。

**验收标准**

| 编号 | 验收项 | 验证方式 |
|---|---|---|
| FR-1.1 | 按钮在 `status === 'playing'` 且非联机模式下可用；其余场景置灰禁用 + tooltip 说明原因 | 手动：主菜单/大厅/进贡阶段/联机大厅逐一确认按钮禁用 |
| FR-1.2 | 首次点击触发浏览器麦克风授权弹窗；拒绝后走 `onError` 提示且**不崩溃**、不卡住 | 手动：拒绝授权，观察提示文案 |
| FR-1.3 | 会话只获取一次：`navigator.mediaDevices.getUserMedia` 在一次语音会话内**只调用 1 次** | 代码审查 + `navigator.mediaDevices` 打桩计数 |
| FR-1.4 | 关闭语音或结束对局时释放麦克风：`mediaStream` 所有 track `stop()`、`audioContext.close()` 被调用 | 手动：结束对局后 macOS 菜单栏/系统设置中麦克风指示灯熄灭 |
| FR-1.5 | 首次开启时若当前轮是对手，`pause()` 并提示"落子后自动收音" | 手动：在对手回合点击开启 |
| FR-1.6 | 页面刷新后语音模式**不持久化**（保持行为可预期） | 手动：刷新后按钮回到关闭态 |

### FR-2 VAD 自动收音

**描述**：本地能量检测判断玩家是否开口。超过阈值=开始说话，静音超时=一句话结束并自动提交，按钮不承担"按住说话"职责。

**参数基线**（来自 `references/vad-recording.md`，作为可调起点而非硬性值）

```js
energyThreshold: 0.02,  // 块 RMS 阈值
silenceMs: 900,         // 静音多久判定一句结束
minSpeechMs: 150,       // 纯语音短于此视为噪声
maxSpeechMs: 6000,      // 单句上限，防状态机卡死
CHUNK_SAMPLES: 2048,    // 16kHz 下 ≈128ms/块
```

**验收标准**

| 编号 | 验收项 | 验证方式 |
|---|---|---|
| FR-2.1 | 玩家开口即开始录音，停顿 900ms 自动提交，**全程无需按键** | 手动 e2e |
| FR-2.2 | 纯静音环境下不产生任何 ASR 请求 | 单测：连续 50 个全零音频块，断言 `transcribe` 调用次数为 0 |
| FR-2.3 | 短于 `minSpeechMs` 的声音视为噪声，提示后**自动重听**，不提交 ASR | 单测：1 块正弦波 + 8 块静音，断言 `onStatus` 提示"太短" 且状态回 `listening` |
| FR-2.4 | 静音尾巴**不计入** `speechMs`（否则噪声块会骗过最短过滤） | 单测：断言 `speechMs` 仅累加语音块 |
| FR-2.5 | `_onUtteranceEnd` 先保存局部变量再 `pause()`，数据不丢 | 单测：pause/reset 时序用例，断言 `encodeWav` 收到完整样本 |
| FR-2.6 | 麦克风不外放：`source → processor → gain(0) → destination` 链路保持回调但不回放 | 手动：录音过程中扬声器无声 |
| FR-2.7 | `resume()`/`attach` 在会话未建立时做空值防御，不抛异常 | 单测：未 `_ensureSession` 时调 `resume()` |
| FR-2.8 | 超过 `maxSpeechMs` 自动截断提交，状态机不死锁 | 单测：连续 60 块正弦波 |
| FR-2.9 | 提供调参通道（阈值/静音时长），便于按 skill 调参表微调 | 代码审查：参数集中于 `VAD` 常量而非散落字面量 |

### FR-3 ASR 本地代理端点

**描述**：本地服务器提供 `POST /api/asr`，转发云端 ASR，Key 只存在于服务端。

**验收标准**

| 编号 | 验收项 | 验证方式 |
|---|---|---|
| FR-3.1 | `POST /api/asr` 接收 `{audio_base64, mime}`，返回 `{ok:true, text}` | curl 实测 |
| FR-3.2 | 与游戏页面**同源同端口**（6677），无 CORS 预检 | 浏览器 Network 面板无 OPTIONS 请求、无 CORS 报错 |
| FR-3.3 | 未配置 Key 时返回 **503 + 明确配置指引**，且游戏仍可正常点击操作 | 不设环境变量启动，curl 应得 503；界面出牌不受影响 |
| FR-3.4 | 转发前校验目标 URL scheme 为 https（杜绝 `file:` 等自定义 scheme） | 代码审查 + 单元测试 |
| FR-3.5 | 云端错误体原样透传，前端能区分"Key 无效"与"网络不通" | 用无效 Key 实测，断言错误文案可区分 |
| FR-3.6 | 请求体含 `parameters: {"format": "wav"}` | 代码审查（缺失会报 `UNSUPPORTED_FORMAT`） |
| FR-3.7 | 超时 30s；`audio_base64` 缺失返回 400 | curl 实测 |
| FR-3.8 | 启动日志明确打印 ASR 是否启用及所用模型 | 观察启动输出 |

**参考实现**：`references/server-proxy.md` 的 `AsrProxyHandler`。本项目为 Node/Vite，需用 Node 18+ 全局 `fetch` 等价移植，逻辑与红线不变。

### FR-4 领域指令解析器（核心）

**描述**：把带噪识别文本翻译成合法出牌动作。采用 **候选集求交集** 策略（借鉴 `OpenGuanDan` 的 `actionList` 机制），而非"先识别牌型再校验"。

**五步模式**（来自 `references/notation-parser.md`，必须保留骨架）

```text
parseCommand(state, text)
  ① 清理归一  去标点/空白（ASR 常带句号），同音字白名单映射
  ② 语法拆解  拆出 (牌型, 点数, 张数)
  ③ 候选生成  generateAllPlays(players.p1.hand) 全量枚举走法
  ④ 合法性过滤 canPlay(play, lastValidPlay) 滤掉压不动的
  ⑤ 文本匹配  对候选集按 (牌型, 点数) 过滤；命中 0→error，1→执行，>1→消歧
  任何一步失败 → return {error: "玩家能看懂的中文原因"}
```

> ⚠️ **设计更正（由测试发现）**：本需求原写作“用 `getPlayInfos(hand)` 枚举所有合法动作”，
> 该假设**错误**。`getPlayInfos` 是分类器，传整副手牌返回 `[]`。已改为
> `generateAllPlays(hand).filter(p => canPlay(p, lastPlay))`。
> 详见 §0.4。

**v1 指令词表**（牌型名取自 `PlayType` 枚举，与 `AudioManager.voiceFiles` 已有的语音键一致）

| 牌型 | `PlayType` | 口语示例 | 备注 |
|---|---|---|---|
| 单张 | `Single` | 单K / 一张K / 单个K | |
| 对子 | `Pair` | 对K / 一对K | |
| 三张 | `Triple` | 三张K / 三K | |
| 三带一对 | `TripleWithPair` | 三带K / 三个K带对K | |
| 顺子 | `Straight` | 顺子 / 连五张 | 长度需明确（5张起） |
| 三连对 | `Tube` | 三连对 / 钢板对 | |
| 钢板 | `Plate` | 钢板 / 二连三 | |
| 同花顺 | `StraightFlush` | 同花顺 | |
| 炸弹 | `Bomb` | 炸弹 / 四个K | |
| 火箭 | `Rocket` | 火箭 / 王炸 / 大王带小王 | |
| 不出 | `Pass` | 过 / 不要 / 不出 | 映射 `passTurn('p1')` |

点数词表：`2..10`、J、Q、K、A、大小王；需支持汉字数字与阿拉伯数字混写；须覆盖同音误识（"五↔无"、"七↔西"、"一↔衣"、"K↔开"、"A↔诶"）。

**验收标准**

| 编号 | 验收项 | 验证方式 |
|---|---|---|
| FR-4.1 | 解析器**必须感知实时手牌**——同一文本在不同手牌下产出不同动作 | 单测：两种手牌分别喂 `"对K"`，断言动作不同 |
| FR-4.2 | 识别结果必须过规则校验才返回，非法组合绝不执行 | 单测：`"三带K"` 但手牌无三张 K → 返回 error，`playCards` **未被调用** |
| FR-4.3 | 歧义消解依据牌桌实际状态 | 单测：候选集多命中时返回多候选或明确 error，不静默任选 |
| FR-4.3a | 候选集来源为 `generateAllPlays` + `canPlay`，**不得**用 `getPossiblePlays` | 代码审查 + `test/parser-contract.test.ts` |
| FR-4.3b | 候选集在 27 张手牌上 **< 500ms** 完成（含逐项 `getPlayInfo` 分类） | `npm run test:contract` 性能用例 |
| FR-4.4 | 每条失败路径返回结构化 `{error}`，**绝不静默丢弃** | 代码审查 + 单测断言 error 非空 |
| FR-4.5 | 错误文案说明"为什么"和"怎么办"，并回显识别原文 | 断言文案含原文，如 `无法解析「飞象过河」（应说：牌型+点数，如 对K / 三带5 / 过）` |
| FR-4.6 | 支持"过/不要/不出/pass"四种说法，均触发 `passTurn('p1')` | 单测 4 例 |
| FR-4.7 | 支持带句号/标点的输入（ASR 常带） | 单测：`"对K。"` 与 `"对K"` 结果一致 |
| FR-4.8 | 成功返回结构化动作（含目标 `Card[]` 与 `PlayType`），供 `playCards` 消费 | 单测断言返回形状 |
| FR-4.9 | 级牌逢人配：候选集天然覆盖；v1 不做**口语级**级牌消歧，报错引导 | 单测：构造含级牌牌型 → 返回引导性 error |
| FR-4.10 | 成功与失败两条路径最终都汇入既有入口（`playCards`/`passTurn`），游戏核心逻辑零改动 | 代码审查 `git diff`：无对 `gameStore.ts` 的改动 |
| FR-4.11 | 点数不可压时给出**可行动**引导（例："对K 压不过对A，可说：过 / 炸弹"） | 单测：跟对A 时说"对K"，断言 error 含可行动建议 |

### FR-5 回合制收音状态机

**描述**：语音控制的主循环是回合状态机。收敛为**单一守卫函数**决定是否收音，避免任一错误分支漏恢复（skill 明确此为"最容易漏的一条"）。

**接线清单**（来自 `references/ux-turn-flow.md`）

| 事件 | 收音动作 |
|---|---|
| 语音模式开启 | `startAuto()`；当前轮是对手则 `pause()` |
| 解析失败 / 非法指令 | `resume()` |
| 识别失败（网络/空结果） | `resume()` |
| 落子成功 → 进入对手回合 | `pause()` |
| 对手/AI 落子完成 | `resume()` |
| 暂停对局 | 一并暂停 / 恢复 |
| 结束对局 / 返回主菜单 | `stopAuto()` + 复位标志 + 清按钮视觉 |
| 对局重开 | 按新状态决定是否立即收音 |

**验收标准**

| 编号 | 验收项 | 验证方式 |
|---|---|---|
| FR-5.1 | 全部"要不要恢复收音"判定走**同一个守卫函数**，条件只有一处 | 代码审查：grep `resume(` 调用点，确认无旁路 |
| FR-5.2 | 玩家回合收音，对手/AI 回合不收音 | 手动：AI 思考期间说话，断言无 ASR 请求发出 |
| FR-5.3 | 识别失败后**必定**恢复收音 | 单测：mock `transcribe` 抛错 → 断言 `onError` 且状态回 `listening` |
| FR-5.4 | 解析失败后**必定**恢复收音 | 单测：喂乱文本 → 断言状态回 `listening` |
| FR-5.5 | 结束对局强制 `stopAuto()`，麦克风指示灯熄灭 | 手动 + 系统指示灯观察 |
| FR-5.6 | 收音状态变化全部同步到按钮/图标视觉 | 手动：三种状态样式可区分 |

### FR-6 UI 回显与错误文案

**验收标准**

| 编号 | 验收项 | 验证方式 |
|---|---|---|
| FR-6.1 | 永远回显"听到了什么"的识别原文 | 手动：观察提示区 |
| FR-6.2 | 首次解析失败时顺带教格式（教学式文案） | 手动：首次输错观察 |
| FR-6.3 | 按钮三态视觉可区分：监听中（脉冲）/ 暂停（静止）/ 关闭（置灰） | 手动 + 代码审查 |
| FR-6.4 | 状态变化含"聆听中/识别中/太短重听"等过程提示 | 单测：断言 `onStatus` 文本 |
| FR-6.5 | 复用现有 `AudioManager` 通道做反馈（不新增音频依赖） | 代码审查：复用而非重造 |

---

## 2. 非功能需求

### NFR-1 密钥安全（红线）

| 编号 | 验收项 | 验证方式 |
|---|---|---|
| NFR-1.1 | API Key **不出现在任何提交进 git 的文件中**；`grep` 不到真实 Key | `git grep -nE "sk-\|Bearer [A-Za-z0-9]{20}"` 无结果 |
| NFR-1.2 | Key 仅来自环境变量或启动参数，缺失时 503 而非静默失败 | 不设环境变量实测 |
| NFR-1.3 | 前端构建产物中不含 Key | `npm run build` 后 grep `dist/` |
| NFR-1.4 | `.env` / `.env.local` 已被 `.gitignore` 覆盖 | 代码审查 |

### NFR-2 语音是可插拔输入

| 编号 | 验收项 | 验证方式 |
|---|---|---|
| NFR-2.1 | 语音模块任何故障下，**鼠标操作永远可用** | 手动：不配置 Key 完整打一局 |
| NFR-2.2 | 语音链路不改动游戏核心逻辑（`gameStore.ts` 不被修改） | `git diff` 审查 |
| NFR-2.3 | 出错时不产生半执行状态（要么完整出牌，要么什么都没发生） | 单测：非法指令后断言 `playArea` 未变 |

### NFR-3 无障碍

| 编号 | 验收项 | 验证方式 |
|---|---|---|
| NFR-3.1 | 状态可 purely 视觉判断——无障碍用户无法从声音判断系统状态 | 手动 |
| NFR-3.2 | 按钮状态变化同时有文本提示，不只靠颜色 | 代码审查：非纯颜色编码 |

### NFR-4 性能与成本

| 编号 | 验收项 | 验证方式 |
|---|---|---|
| NFR-4.1 | 不说话时零 API 调用 | 单测：静音 50 块断言 0 次请求 |
| NFR-4.2 | 单句识别端到端延迟参考值 ~450ms（`qwen-audio-3.1-asr-flash`），本地代理不成为瓶颈 | 实测计时 |
| NFR-4.3 | WAV 体积可控：3s ≈ 96KB → Base64 ≈ 128KB | 计算 + 实测请求体大小 |

### NFR-5 兼容与降级

| 编号 | 验收项 | 验证方式 |
|---|---|---|
| NFR-5.1 | `isSupported()` 检测 `getUserMedia` + `AudioContext`（含 `webkitAudioContext`）；不支持时按钮禁用并说明 | 代码审查 + 手动 |
| NFR-5.2 | 采样率固定 16kHz 单声道、16-bit PCM WAV（不用 MediaRecorder 的 webm/opus） | 代码审查 |
| NFR-5.3 | ASR 失败不影响对局进行 | 手动 |

### NFR-6 不破坏现有质量门

⚠️ **基线说明**：`npm run check` 在 vendor 快照上**原本就不通过**——`src/lib/ai.ts` 1226/1301/1328 三处 TS2322（`memoGetPlayInfo` 实现返回 `{...} | null` 而依赖类型声明为 `{...} | undefined`）。该文件与上游 `600c175` 逐字节一致，属**上游自带缺陷**，非本项目引入。

| 编号 | 验收项 | 验证方式 |
|---|---|---|
| NFR-6.1 | 新增/修改代码**零** TS 错误 | `npm run check` 的错误数不超过基线 3，且不含本次涉及文件 |
| NFR-6.2 | `npm run lint` 无新增 error | `npm run lint` |
| NFR-6.3 | `npm run build` 成功 | 实跑 |
| NFR-6.4 | `npm test` 全绿 | 实跑 |
| NFR-6.5 | 基线 3 个错误记入文档，不静默遗留 | 本文档 §NFR-6 |

### NFR-8 测试左移（Test-First）

测试不集中在最后阶段，而是**每个阶段的测试与其实现一同先于实现存在**。

| 编号 | 验收项 | 验证方式 |
|---|---|---|
| NFR-8.1 | 依赖的**上游/既有**行为先被特征测试钉死，再写实现 | 本文档 §0.4 已由 65 个通过的测试固定 |
| NFR-8.2 | 每个实现阶段开工前，其测试用例**已存在且失败**（红） | 阶段评审：先提测试 commit |
| NFR-8.3 | 测试不得为了“变绿”而降低断言强度 | code review：断言不得从具体值放宽为 truthy |
| NFR-8.4 | 发现的错误假设必须回写规格文档，不得只修代码 | 本文档 §FR-4 的设计更正即为范例 |

### NFR-7 运行环境约束

| 编号 | 验收项 | 验证方式 |
|---|---|---|
| NFR-7.1 | 语音仅在 HTTP(S) 环境启用；`file://` 下不可用（麦克风权限依赖） | 代码审查 + 文档 |
| NFR-7.2 | Electron 打包产物中语音入口**显式关闭**（`base: './'` 为 `file://` 打包而设） | 代码审查 |
| NFR-7.3 | 开发端口固定 6677（`strictPort: true`），代理同源无 CORS | 实跑 `npm run dev` |

---

## 3. 需求追溯矩阵

| 需求 | 来源（skill） | 对应阶段 | 关键验收 |
|---|---|---|---|
| FR-1 | `vad-recording.md` 按钮只作模式开关 | S2 | FR-1.3 / FR-1.4 |
| FR-2 | `vad-recording.md` VAD 参数与状态机 | S2, S3 | FR-2.2 / FR-2.3 / FR-2.5 |
| FR-3 | `server-proxy.md` + SKILL 第 1 步 | S1 | FR-3.2 / FR-3.3 |
| FR-4 | `notation-parser.md` 五步模式 | S4 | FR-4.1 / FR-4.2 / FR-4.3a |
| FR-5 | `ux-turn-flow.md` 接线清单 | S5 | FR-5.1 / FR-5.3 / FR-5.4 |
| FR-6 | `ux-turn-flow.md` 无障碍 UX | S5 | FR-6.1 / FR-6.3 |
| NFR-1 | SKILL 红线 | S1 | NFR-1.1 / NFR-1.3 |
| NFR-2 | SKILL 核心理念 1 | S4, S5 | NFR-2.1 / NFR-2.2 |
| NFR-6 | SKILL 第 6 步 | 全程 | NFR-6.1 |
| NFR-7 | SKILL 红线 | S2 | NFR-7.2 |
| NFR-8 | 测试左移 | S0, 全程 | NFR-8.2 / NFR-8.4 |

---

## 4. 需求验收总则

一个阶段判定为"完成"须**同时**满足：

1. 该阶段全部验收项通过；
2. 该阶段的测试先于实现存在（NFR-8.2），且现已全绿；
3. `npm run check` 错误数不超基线（NFR-6.1）；
4. `npm run test` 全绿（NFR-6.4）；
5. `npm run build` 成功；
6. 键盘/鼠标路径未受影响（NFR-2.1）；
7. 提交信息说明改了什么、为什么、怎么验收。

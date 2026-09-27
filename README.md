# VoiceSpeechGuandan

掼蛋（Guandan）语音控制项目：用说话代替点击完成出牌、过牌、进贡。

技术方案来自 `board-game-voice-asr` skill，沉淀自一个已上线验证的中国象棋语音对弈项目（浏览器录音 → 本地代理 → 阿里云百炼 Qwen ASR → 领域解析器 → 落子）。

## 架构

```text
[玩家说话] "对K"
   ↓ ① 浏览器录音 + 本地 VAD（RMS 能量检测，静音 900ms 自动提交，免按键）
   ↓ ② POST /api/asr {audio_base64, mime}   ← Key 只存在于本地代理，不进前端
本地代理 → 阿里云百炼 qwen-audio-3.1-asr-flash
   ↓ ③ 领域解析器 parseCommand(state, text)
"对K。" → 结合 handCards 与 actionList 候选集 → {actionIndex: 7}
   ↓ ④ 汇入游戏既有的人类输入入口（不改动游戏核心逻辑）
游戏 AI 应手 → 暂停收音 → 轮回玩家 → 自动恢复收音
```

## 依赖的上游项目（submodule）

| 路径 | 上游 | License | 角色 |
|---|---|---|---|
| `third_party/guandan-windows` | [dengweiqh/guandan-windows](https://github.com/dengweiqh/guandan-windows) | Apache-2.0 | **接入目标**：掼蛋游戏本体，浏览器端可玩 |
| `third_party/OpenGuanDan` | [GameAI-NJUPT/OpenGuanDan](https://github.com/GameAI-NJUPT/OpenGuanDan) | 无 license | **设计参考 + 规则对照床**：纯 Java 服务端，WebSocket JSON 协议 |

```bash
git clone --recurse-submodules git@github.com:BiranLi/VoiceSpeechGuandan.git
# 已 clone 但漏了 submodule：
git submodule update --init --recursive
```

## 为什么选 guandan-windows 作为接入目标

它是唯一同时满足 ASR 接入 4 个结构性前提的项目：

1. **人类出牌入口唯一且干净** —— `src/store/gameStore.ts` 的 `playCards(action: PlayAction)` / `passTurn(playerId)`，语音结果直接调这两个函数，游戏核心逻辑零改动
2. **自带合法性校验** —— `src/lib/rules.ts` 导出 `canPlay(cards, lastPlay)`、`getPlayInfo(cards)`、`getPlayInfos(cards)`，作为 ASR 输出的兜底校验
3. **回合可 gating** —— `GameBoard.tsx` 中 `isMyTurn = currentTurn === 'p1' && status === 'playing'`，AI 回合暂停收音的判据现成
4. **手牌可被解析器读取** —— `GameState.players[p1].hand: Card[]`

额外加分项：

- 已有完整牌型语音资源表 `src/lib/audio.ts` 的 `AudioManager.voiceFiles`（`single_*` / `pair_*` / `triple_*` / `straight` / `tube` / `plate` / `bomb` / `rocket` / `pass_*`），等于项目**已定义牌型词表**，且出牌音效反馈通道现成
- 依赖里已有 `astral-regex`，中文数字/口语量词解析不用从零写
- 单机 vs 3 个 AI（easy/medium/hard/master）—— 一人一张麦克风，没有多人抢麦冲突

## 解析器设计：候选集求交集

直接借鉴 `OpenGuanDan` 服务端的 `actionList` 机制，替代"先识别牌型再校验"的思路。

OpenGuanDan 在轮到你时下发：

```json
{ "type": "act", "stage": "play",
  "handCards": ["S2","H2"],
  "greaterAction": ["Bomb","A",["HA","HA","CA","DA"]],
  "actionList": [ ["PASS","PASS","PASS"], ["Bomb","9",["H9","H9","C9","D9"]] ],
  "indexRange": 21 }
```

客户端只需按 index 回选一项，**服务端把当前局面下所有合法动作枚举成了一份有限候选集**。

移植到 guandan-windows 后的解析流程：

1. ASR 文本 → 清理标点 → 输出**若干候选动作猜测**（"对K" / "三带5" / "过"）
2. 用 `getPlayInfos(hand)` 预先算出当前手牌的所有合法动作
3. 猜测 ∩ 合法集合：空 → 返回结构化 `{error}` 回显；多个（如同花顺 vs 顺子都含 K34567）→ 让玩家点选消歧；唯一 → 直接执行

这样绕开了掼蛋最难的部分——**级牌逢人配**与 ASR 误识导致的组合爆炸。

## 牌型命名对照

| guandan-windows (TS 枚举) | OpenGuanDan (JSON) |
|---|---|
| Single / Pair / Triple / TripleWithPair | Single / Pair / Trips / ThreeWithTwo |
| Straight / Tube(三连对) / Plate(钢板) | Straight / TwoTrips / ThreePair |
| StraightFlush / Bomb / Rocket | StraightFlush / Bomb / FourKings |
| Pass | PASS |
| 进贡/还贡走独立流程 | `tribute` / `back` 是一等 pattern |

⚠️ **卡牌编码不同**（写解析器必踩）：OpenGuanDan 用 `{Suit}{Rank}` 两字符，`T`=10、`B`=小王、`R`=大王；guandan-windows 用 `'10'` 与 `'Small'/'Big'`。

## 实施计划

按 `board-game-voice-asr` skill 的 6 步：

1. 本地代理端点 —— `vite.config.ts` 固定 port 6677 且已有 proxy 配置，加 `configureServer` 中间件即可（Node 18+ 全局 fetch 重写技能的 Python 实现，Key 只进 `process.env.DASHSCOPE_API_KEY`）
2. 浏览器录音模块 —— 新建 `src/lib/voice/recorder.ts`
3. VAD 自动收音 —— 同文件内 RMS 状态机，阈值 0.02 / 静音 900ms / 最短 150ms / 最长 6000ms
4. 领域解析器 —— 新建 `src/lib/voice/parseCommand.ts`，**工作量最大**，采用上述候选集求交集
5. 回合制收音循环 —— 挂在 `isMyTurn` 同一判据上；AI 回合与识别失败都必须恢复收音
6. 测试 —— `tsc --noEmit` / eslint；e2e 用 macOS `say` 生成掼蛋语音

第一版范围：先跑通「代理端点 + 录音/VAD + 单张 / 对子 / 过」三个最小指令，再扩顺子 / 三带 / 炸弹。**级牌逢人配暂不支持**，交由 `canPlay` 兜底并回显。

## 红线

- API Key 出现在前端 JS / 提交进 git = 事故。只走环境变量或服务器启动参数
- 游戏页面必须经 HTTP 服务器访问（麦克风权限依赖），不支持 `file://` 直开 —— 因此 `guandan-windows` 的 Electron 产物需显式关闭语音入口（其 `base: './'` 正是为 `file://` 打包所设）
- 识别文本直接信任前必须过游戏规则校验

## License 注意

`third_party/guandan-windows` 为 Apache-2.0，可修改。`third_party/OpenGuanDan` **无 license 文件且 Java 部分仅有编译好的 jar、无源码**，仅作参考与对照使用，不做二次开发或分发。

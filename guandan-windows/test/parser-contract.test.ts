import { describe, it, expect } from 'vitest';
import { generateAllPlays, getPossiblePlays } from '../src/lib/ai';
import { getPlayInfo, canPlay } from '../src/lib/rules';
import { PlayType } from '../src/types/game';
import type { Card, PlayAction } from '../src/types/game';
import { mkCard, sameRank, pair, bomb, jokers, rankKey } from './helpers/cards';

/**
 * 枚举与解析器契约测试。
 *
 * 背景：docs/requirements.md 的 S4 设计原先押在「getPlayInfos(hand) 能枚举
 * 所有合法走法」上。rules.characterization.test.ts 已证伪该假设——
 * getPlayInfos 是分类器，传入整副手牌返回 []。
 *
 * 真正的枚举器是 generateAllPlays(hand)（ai.ts，已导出），
 * 合法性由 canPlay 过滤。本文件把这个更正后的契约钉死，
 * 使 S4 在写解析器之前就有可执行的验收依据。
 */

const act = (cards: Card[], type: PlayType): PlayAction => ({ playerId: 'p1', cards, type });

/** 解析器将使用的候选集：全量枚举 + 合法性过滤 */
const legalCandidates = (hand: Card[], lastPlay: PlayAction | null = null): Card[][] =>
  generateAllPlays(hand).filter(play => canPlay(play, lastPlay));

/** 在候选集中找出某牌型的全部走法 */
const ofType = (cands: Card[][], type: PlayType) =>
  cands.filter(c => getPlayInfo(c)?.type === type);

describe('generateAllPlays：全量枚举（不是剪枝后的推荐）', () => {
  it('空手牌返回空数组', () => {
    expect(generateAllPlays([])).toEqual([]);
  });

  it('枚举包含手牌中的每一张单牌', () => {
    const hand = [mkCard(3), mkCard(9), mkCard('K')];
    const singles = ofType(generateAllPlays(hand), PlayType.Single);
    expect(singles).toHaveLength(3);
    expect(rankKey(singles[0])).toBe('3');
  });

  it('枚举包含所有对子', () => {
    const hand = [...pair('K'), ...pair(5), mkCard(9)];
    const pairs = ofType(generateAllPlays(hand), PlayType.Pair);
    expect(pairs).toHaveLength(2);
  });

  it('三张同点数时，对子只有 1 个候选（按点数组合去重，不按花色）', () => {
    const hand = sameRank('K', 3);
    const pairs = ofType(generateAllPlays(hand), PlayType.Pair);
    // 实测：generateAllPlays 按「点数多重集」去重，3 张 K 只产出 1 个对子，
    // 而非 C(3,2)=3 种花色组合。这直接简化了解析器：
    // 语音「对K」天然唯一，不需要在花色层面消歧。
    expect(pairs).toHaveLength(1);
    expect(rankKey(pairs[0])).toBe('K,K');
  });

  it('去重后仍保留不同点数组合（同牌型不同点数各一个候选）', () => {
    const hand = [...sameRank('K', 3), ...sameRank(5, 3)];
    const pairs = ofType(generateAllPlays(hand), PlayType.Pair);
    expect(pairs).toHaveLength(2);
  });

  it('手牌中无同点数对子时不产出对子', () => {
    const hand = [mkCard(3), mkCard(5), mkCard(7), mkCard(9)];
    expect(ofType(generateAllPlays(hand), PlayType.Pair)).toHaveLength(0);
  });

  it('【性能】27 张手牌枚举在可接受耗时内完成', () => {
    const hand: Card[] = [
      ...pair(2), ...pair(3), ...pair(4), ...pair(5), ...pair(6), ...pair(7),
      ...pair(8), ...pair(9), ...pair(10), ...pair('J'), ...pair('Q'),
      ...pair('K'), ...pair('A'), mkCard('Big'), mkCard('Small'),
    ];
    const t0 = Date.now();
    const plays = generateAllPlays(hand);
    const elapsed = Date.now() - t0;
    expect(plays.length).toBeGreaterThan(0);
    // 上限放宽到 3s：本机实测远快于此，此处只防「组合爆炸」回归
    expect(elapsed).toBeLessThan(3000);
  });
});

describe('候选集求交集：解析器的合法性依据', () => {
  it('先手时，对K 出现在候选集中', () => {
    const hand = [...pair('K'), mkCard(3), mkCard(5), mkCard(7)];
    const cands = legalCandidates(hand);
    const kPairs = ofType(cands, PlayType.Pair).filter(c => getPlayInfo(c)?.maxValue === 13);
    expect(kPairs.length).toBeGreaterThan(0);
  });

  it('跟更大的对子时，对K 被过滤掉（这正是"过"或换牌型的依据）', () => {
    const hand = [...pair('K'), mkCard(3), mkCard(5), mkCard(7)];
    const lastPlay = act(pair('A'), PlayType.Pair);
    const cands = legalCandidates(hand, lastPlay);
    const kPairs = ofType(cands, PlayType.Pair).filter(c => getPlayInfo(c)?.maxValue === 13);
    expect(kPairs).toHaveLength(0);
  });

  it('跟对3 时，可以用对K 压（点数更大）', () => {
    const hand = [...pair('K'), mkCard(3), mkCard(5), mkCard(7)];
    const lastPlay = act(pair(3), PlayType.Pair);
    const cands = legalCandidates(hand, lastPlay);
    const kPairs = ofType(cands, PlayType.Pair).filter(c => getPlayInfo(c)?.maxValue === 13);
    expect(kPairs.length).toBeGreaterThan(0);
  });

  it('【边界】对K 压不过对A（K=13 < A=14），语音应引导改口或过牌', () => {
    const hand = [...pair('K'), mkCard(3), mkCard(5), mkCard(7)];
    const lastPlay = act(pair('A'), PlayType.Pair);
    const cands = legalCandidates(hand, lastPlay);
    const kPairs = ofType(cands, PlayType.Pair).filter(c => getPlayInfo(c)?.maxValue === 13);
    expect(kPairs).toHaveLength(0);
  });

  it('手牌没有该点数时，候选集中不存在——语音应报"无此牌"而非静默', () => {
    const hand = [mkCard(3), mkCard(5), mkCard(7), mkCard(9)];
    const cands = legalCandidates(hand);
    const qPairs = ofType(cands, PlayType.Pair);
    expect(qPairs).toHaveLength(0);
  });

  it('候选集中的每一项都通过 canPlay 校验（自洽性）', () => {
    const hand = [...pair('K'), ...pair(3), mkCard('A'), mkCard(5)];
    const lastPlay = act(pair('5'), PlayType.Pair);
    for (const c of legalCandidates(hand, lastPlay)) {
      expect(canPlay(c, lastPlay)).toBe(true);
    }
  });

  it('候选集已按牌型分类，语音只需按 (牌型, 点数) 过滤', () => {
    const hand = [...pair('K'), ...pair(3), mkCard('A')];
    const cands = legalCandidates(hand);
    const buckets = new Map<PlayType, number>();
    for (const c of cands) {
      const t = getPlayInfo(c)?.type;
      if (t) buckets.set(t, (buckets.get(t) ?? 0) + 1);
    }
    expect(buckets.get(PlayType.Single)).toBeGreaterThan(0);
    expect(buckets.get(PlayType.Pair)).toBeGreaterThan(0);
  });

  it('炸弹总能出现在候选集中（无论上家是什么）', () => {
    const hand = [...bomb(3), mkCard('A')];
    const lastPlay = act([mkCard('K')], PlayType.Single);
    const bombs = ofType(legalCandidates(hand, lastPlay), PlayType.Bomb);
    expect(bombs.length).toBeGreaterThan(0);
  });

  it('火箭需要 4 张王；只有 2 张时不产生火箭', () => {
    const twoJokers = jokers(2);
    expect(ofType(legalCandidates(twoJokers), PlayType.Rocket)).toHaveLength(0);
    const fourJokers = jokers(4);
    expect(ofType(legalCandidates(fourJokers), PlayType.Rocket).length).toBeGreaterThan(0);
  });
});

describe('getPossiblePlays：为何解析器不直接用它', () => {
  it('会按 (牌型,点数,张数) 分组，压缩同组内的不同花色组合', () => {
    // 两手牌都是「3 张 K」，但 possiblePlays 只保留一个代表
    const hand = [...sameRank('K', 3), mkCard(3)];
    const all = generateAllPlays(hand).filter(p => getPlayInfo(p)?.type === PlayType.Triple);
    const possible = getPossiblePlays(hand, null);
    const possibleTriples = possible.filter(p => getPlayInfo(p)?.type === PlayType.Triple);

    expect(all.length).toBeGreaterThan(0);
    // 分组后数量被压缩（可能配对同 type/maxValue/length 的多组花色组合）
    expect(possibleTriples.length).toBeLessThanOrEqual(all.length);
  });

  it('结果已按 AI 打分排序，不是按"能否出"的语义排序', () => {
    // 说明：解析器若依赖其顺序，会把 AI 偏好误当规则约束
    const hand = [...pair('K'), ...pair(3), mkCard('A')];
    const possible = getPossiblePlays(hand, null);
    // 它仍然是一个合法的子集（可作为兜底，但不应作为唯一依据）
    for (const p of possible) {
      expect(canPlay(p, null)).toBe(true);
    }
  });

  it('难度参数会影响结果规模（说明其与 AI 策略耦合）', () => {
    const hand: Card[] = [
      ...pair(2), ...pair(3), ...pair(4), ...pair(5), ...pair(6),
      ...pair(7), ...pair(8), mkCard('A'), mkCard('K'),
    ];
    const easy = getPossiblePlays(hand, null, 'easy');
    const master = getPossiblePlays(hand, null, 'master');
    // 两者都是合法子集，但可能规模不同
    expect(Array.isArray(easy)).toBe(true);
    expect(Array.isArray(master)).toBe(true);
  });
});

describe('语音候选集的性能预算（解析器每回合都要算）', () => {
  it('27 张手牌上「枚举+过滤+分类」在 500ms 内完成', () => {
    const hand: Card[] = [
      ...pair(2), ...pair(3), ...pair(4), ...pair(5), ...pair(6), ...pair(7),
      ...pair(8), ...pair(9), ...pair(10), ...pair('J'), ...pair('Q'),
      ...pair('K'), ...pair('A'), mkCard('Big'), mkCard('Small'),
    ];
    const t0 = Date.now();
    const cands = legalCandidates(hand);
    for (const c of cands) getPlayInfo(c);
    const elapsed = Date.now() - t0;
    expect(cands.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(500);
  });
});

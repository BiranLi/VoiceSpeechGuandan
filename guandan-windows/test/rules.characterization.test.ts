import { describe, it, expect } from 'vitest';
import {
  getPlayInfos, getPlayInfo, canPlay,
  setRuleProfileByPreset, getRuleProfile,
} from '../src/lib/rules';
import { PlayType } from '../src/types/game';
import type { Card, PlayAction } from '../src/types/game';
import {
  mkCard, sameRank, pair, triple, bomb, jokers, straight, flush, tube, plate,
  tripleWithPair, rankKey,
} from './helpers/cards';

/**
 * 规则引擎特征测试（characterization test）。
 *
 * 目的：在写解析器之前，先把"合法性判定依据"的真实语义钉死。
 * 这些用例测的是**已存在的上游代码**，全部应当立即通过；
 * 它们的产出是 docs/requirements.md 中 S4 设计所依赖的契约。
 *
 * 重点：第 1 组用例记录了一个会致命的误解——
 * getPlayInfos 是「这组指定牌构成什么牌型」的分类器，
 * 而**不是**「这手牌有哪些合法走法」的枚举器。
 */

const act = (cards: Card[], type: PlayType): PlayAction => ({
  playerId: 'p1', cards, type,
});

describe('getPlayInfos 的真实语义：分类器，不是枚举器', () => {
  it('给定一组牌，返回它能构成的牌型（0/1/多个）', () => {
    expect(getPlayInfos(pair('K'))).toEqual([{ type: PlayType.Pair, maxValue: 13 }]);
  });

  it('【关键】传入整副手牌不会枚举出所有走法，而是返回空', () => {
    // 27 张手牌（接近掼蛋真实手牌量）
    const hand = [
      ...sameRank('K', 2), ...sameRank('Q', 2), ...sameRank('J', 2),
      ...sameRank('10', 2), ...sameRank('9', 2), ...sameRank('8', 2),
      ...sameRank('7', 2), ...sameRank('6', 2), ...sameRank('5', 2),
      ...sameRank('4', 2), ...sameRank('3', 1), ...sameRank('2', 1),
      mkCard('A'), mkCard('A'),
    ];
    expect(getPlayInfos(hand)).toEqual([]);
  });

  it('空牌组返回空数组', () => {
    expect(getPlayInfos([])).toEqual([]);
  });

  it('不构成任何牌型时返回空数组', () => {
    const junk = [mkCard('5', 'spade'), mkCard('9', 'spade'), mkCard('J', 'spade')];
    expect(getPlayInfos(junk)).toEqual([]);
  });
});

describe('基础牌型识别', () => {
  it('单牌', () => {
    expect(getPlayInfos([mkCard('7')])).toEqual([{ type: PlayType.Single, maxValue: 7 }]);
  });

  it('对子', () => {
    expect(getPlayInfos(pair('10'))).toEqual([{ type: PlayType.Pair, maxValue: 10 }]);
  });

  it('三不带', () => {
    expect(getPlayInfos(triple('9'))).toEqual([{ type: PlayType.Triple, maxValue: 9 }]);
  });

  it('炸弹：4 张同点数', () => {
    const infos = getPlayInfos(bomb('5'));
    expect(infos).toHaveLength(1);
    expect(infos[0].type).toBe(PlayType.Bomb);
    expect(infos[0].length).toBe(4);
  });

  it('火箭：需要恰好 4 张王（双副牌共 4 张）', () => {
    const infos = getPlayInfos(jokers(4));
    expect(infos).toHaveLength(1);
    expect(infos[0].type).toBe(PlayType.Rocket);
  });

  it('【边界】2 张王不构成火箭', () => {
    expect(getPlayInfos(jokers(2))).toEqual([]);
  });

  it('三带一对（5 张 = 3+2）', () => {
    const infos = getPlayInfos(tripleWithPair('K', '5'));
    expect(infos).toHaveLength(1);
    expect(infos[0].type).toBe(PlayType.TripleWithPair);
    expect(infos[0].maxValue).toBe(13); // 以三张的点数为准
  });

  it('顺子：5 张连续点数', () => {
    const infos = getPlayInfos(straight([3, 4, 5, 6, 7]));
    expect(infos).toEqual([{ type: PlayType.Straight, maxValue: 7 }]);
  });

  it('非连续不是顺子', () => {
    expect(getPlayInfos(straight([3, 4, 5, 6, 8]))).toEqual([]);
  });

  it('顺子长度必须为 5', () => {
    expect(getPlayInfos(straight([3, 4, 5, 6]))).toEqual([]);
  });

  it('同花顺：5 张连续且同花色', () => {
    const infos = getPlayInfos(flush([3, 4, 5, 6, 7], 'heart'));
    expect(infos).toHaveLength(1);
    expect(infos[0].type).toBe(PlayType.StraightFlush);
  });

  it('三连对 Tube：6 张 = 3 组连续对子', () => {
    const infos = getPlayInfos(tube([9, 10, 'J']));
    expect(infos).toHaveLength(1);
    expect(infos[0].type).toBe(PlayType.Tube);
  });

  it('钢板 Plate：6 张 = 2 组连续三张', () => {
    const infos = getPlayInfos(plate([9, 10]));
    expect(infos).toHaveLength(1);
    expect(infos[0].type).toBe(PlayType.Plate);
  });
});

describe('级牌与逢人配（掼蛋的核心复杂度）', () => {
  it('级牌 value 被提升为 15', () => {
    const c = mkCard('5', 'spade', '5');
    expect(c.isLevelCard).toBe(true);
    expect(c.value).toBe(15);
  });

  it('红桃级牌才是逢人配，其他花色的级牌不是', () => {
    expect(mkCard('5', 'heart', '5').isRedJoker).toBe(true);
    expect(mkCard('5', 'spade', '5').isRedJoker).toBe(false);
  });

  it('【关键约束】非逢人配的级牌不能参与顺子', () => {
    // 级牌 5，尝试组成 3-4-5-6-7 顺子
    const hand = [
      mkCard(3), mkCard(4), mkCard(5, 'spade', '5'), mkCard(6), mkCard(7),
    ];
    expect(getPlayInfos(hand)).toEqual([]);
  });

  it('逢人配（红桃级牌）可以参与顺子', () => {
    const hand = [
      mkCard(3), mkCard(4), mkCard(5, 'heart', '5'), mkCard(6), mkCard(7),
    ];
    const infos = getPlayInfos(hand);
    expect(infos.length).toBeGreaterThan(0);
    expect(infos.some(i => i.type === PlayType.Straight)).toBe(true);
  });

  it('【关键】逢人配会让 getPlayInfos 返回多个候选牌型', () => {
    // 逢人配 + 3,4,6,7：既可当黑桃 5 组成顺子(maxValue 7)，
    // 也可当红桃 5 组成同花顺(5500+7)。实测返回 2 个候选。
    const hand = [
      mkCard(5, 'heart', '5'), mkCard(3), mkCard(4), mkCard(6), mkCard(7),
    ];
    const infos = getPlayInfos(hand);
    expect(infos).toHaveLength(2);
    const types = infos.map(i => i.type).sort();
    expect(types).toEqual([PlayType.Straight, PlayType.StraightFlush].sort());
  });

  it('【边界】2 张牌的逢人配只有 1 个候选（去重后）', () => {
    // 逢人配 + 单张 9：只能模拟成 9 才能成对，其余点数不构成牌型
    const hand = [mkCard(5, 'heart', '5'), mkCard(9, 'spade')];
    const infos = getPlayInfos(hand);
    expect(infos).toHaveLength(1);
    expect(infos[0]).toEqual({ type: PlayType.Pair, maxValue: 9 });
  });

  it('逢人配可充当同点数牌组成炸弹', () => {
    // 三张 3 + 逢人配 → 逢人配当 3 → 四张炸弹
    const hand = [mkCard(5, 'heart', '5'), ...sameRank(3, 3)];
    const infos = getPlayInfos(hand);
    expect(infos).toHaveLength(1);
    expect(infos[0].type).toBe(PlayType.Bomb);
  });

  it('无逢人配时结果唯一（去重前）', () => {
    expect(getPlayInfos(pair('Q'))).toHaveLength(1);
  });
});

describe('A2345 规则预设', () => {
  it('classic 预设允许 A2345 顺子', () => {
    setRuleProfileByPreset('classic');
    const infos = getPlayInfos(straight(['A', 2, 3, 4, 5]));
    expect(infos.length).toBeGreaterThan(0);
  });

  it('tournament 预设禁止 A2345 顺子', () => {
    setRuleProfileByPreset('tournament');
    const infos = getPlayInfos(straight(['A', 2, 3, 4, 5]));
    expect(infos).toEqual([]);
  });

  it('切换预设后必须能切回（测试隔离性）', () => {
    setRuleProfileByPreset('classic');
    expect(getRuleProfile().allowA2345Straight).toBe(true);
  });
});

describe('getPlayInfo：多候选取最优', () => {
  it('炸弹优先于普通牌型', () => {
    const info = getPlayInfo(bomb('3'));
    expect(info?.type).toBe(PlayType.Bomb);
  });

  it('逢人配场景下优先返回高级牌型（炸弹/同花顺）', () => {
    // 候选：StraightFlush(5507) 与 Straight(7) → 应选 StraightFlush
    const hand = [mkCard(5, 'heart', '5'), mkCard(3), mkCard(4), mkCard(6), mkCard(7)];
    const info = getPlayInfo(hand);
    expect(info?.type).toBe(PlayType.StraightFlush);
    expect(info!.maxValue).toBe(5507);
  });

  it('不合法牌型返回 null', () => {
    const junk = [mkCard('5'), mkCard('9'), mkCard('J')];
    expect(getPlayInfo(junk)).toBeNull();
  });
});

describe('canPlay：跟牌合法性', () => {
  it('上家为 null（我先手）时任何合法牌型都可出', () => {
    expect(canPlay(pair('3'), null)).toBe(true);
  });

  it('上家 Pass 时可自由出牌', () => {
    expect(canPlay(pair('3'), act([], PlayType.Pass))).toBe(true);
  });

  it('同牌型、更大、同张数 → 可压', () => {
    expect(canPlay(pair('K'), act(pair('5'), PlayType.Pair))).toBe(true);
  });

  it('同牌型、更小 → 不可压', () => {
    expect(canPlay(pair('3'), act(pair('K'), PlayType.Pair))).toBe(false);
  });

  it('同牌型但张数不同 → 不可压', () => {
    expect(canPlay(triple('K'), act(pair('5'), PlayType.Pair))).toBe(false);
  });

  it('不同牌型 → 不可压', () => {
    expect(canPlay(pair('K'), act([mkCard('A')], PlayType.Single))).toBe(false);
  });

  it('炸弹可压普通牌型', () => {
    expect(canPlay(bomb('3'), act([mkCard('A')], PlayType.Single))).toBe(true);
  });

  it('同花顺按炸弹处理，可压普通牌型', () => {
    const sf = flush([3, 4, 5, 6, 7], 'heart');
    expect(canPlay(sf, act([mkCard('A')], PlayType.Single))).toBe(true);
  });

  it('火箭可压一切', () => {
    expect(canPlay(jokers(4), act(bomb('A'), PlayType.Bomb))).toBe(true);
  });

  it('普通牌型不能压炸弹', () => {
    // 对 K 压 四张 3 炸弹 → 非法
    expect(canPlay(pair('K'), act(bomb('3'), PlayType.Bomb))).toBe(false);
  });

  it('同张数炸弹按点数比大小（四A 可压 四3）', () => {
    // maxValue = 张数*1000 + 点数：4A=4014 > 4x3=4003
    expect(canPlay(bomb('A'), act(bomb(3), PlayType.Bomb))).toBe(true);
  });

  it('同张数炸弹点数小则不可压', () => {
    expect(canPlay(bomb(3), act(bomb('A'), PlayType.Bomb))).toBe(false);
  });

  it('不合法牌型永远不可出', () => {
    const junk = [mkCard('5'), mkCard('9'), mkCard('J')];
    expect(canPlay(junk, null)).toBe(false);
  });
});

describe('牌组描述辅助（供解析器断言复用）', () => {
  it('rankKey 能区分同点数的不同花色组合', () => {
    expect(rankKey(sameRank('K', 3))).toBe('K,K,K');
    expect(rankKey(pair('K'))).toBe('K,K');
  });
});

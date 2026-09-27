import type { Card, Rank, Suit } from '../../src/types/game';

/**
 * 测试用牌工厂。
 * 点数映射严格对齐 src/lib/deck.ts（避免测试里凭空假设）：
 *   2..10=2..10, J=11, Q=12, K=13, A=14, 级牌=15, 小王=16, 大王=17
 * 牌堆为双副牌：2 × (4 花色 × 13 点数 + 大小王各 1) = 108 张，
 * 因此大小王各 2 张、共 4 张（这正是 rules.ts 中 Rocket 的判据）。
 */

export const BASE_VALUE: Record<string, number> = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10,
  'J': 11, 'Q': 12, 'K': 13, 'A': 14,
  'Small': 16, 'Big': 17,
};

export const LEVEL_CARD_VALUE = 15;

let seq = 0;
const nextId = () => `t${++seq}`;

/** 重置 id 序列，让测试快照可预期 */
export const resetIds = () => { seq = 0; };

/**
 * 造一张牌。
 * @param rank 点数
 * @param suit 花色
 * @param level 当前级牌；传 null 表示本手牌里没有级牌
 */
export const mkCard = (rank: Rank, suit: Suit = 'spade', level: Rank | null = null): Card => {
  // Rank 中 2..10 是 number，J/Q/K/A 等是 string，级牌可能以任一形式传入，
  // 因此必须用字符串比较——直接 `rank === level` 会静默失效。
  const isLevelCard = level !== null && String(rank) === String(level);
  return {
    id: nextId(),
    suit,
    rank,
    value: isLevelCard ? LEVEL_CARD_VALUE : BASE_VALUE[String(rank)],
    isLevelCard,
    // 逢人配 = 红桃级牌
    isRedJoker: isLevelCard && suit === 'heart',
  };
};

/** 指定花色与点数的单张 */
export const card = (rank: Rank, suit: Suit = 'spade', level: Rank | null = null) => mkCard(rank, suit, level);

/** n 张同点数的牌（自动分配花色） */
export const sameRank = (rank: Rank, n: number, level: Rank | null = null): Card[] => {
  const suits: Suit[] = ['spade', 'heart', 'club', 'diamond'];
  return Array.from({ length: n }, (_, i) => mkCard(rank, suits[i % 4], level));
};

/** 对子 / 三张 / 炸弹 */
export const pair = (rank: Rank, level: Rank | null = null) => sameRank(rank, 2, level);
export const triple = (rank: Rank, level: Rank | null = null) => sameRank(rank, 3, level);
export const bomb = (rank: Rank, level: Rank | null = null) => sameRank(rank, 4, level);

/** n 张王（大小王交替），n=4 即火箭 */
export const jokers = (n: number): Card[] =>
  Array.from({ length: n }, (_, i) => mkCard(i % 2 === 0 ? 'Big' : 'Small', 'joker', null));

/** n 张连续点数的顺子，花色轮转（避免误造出同花顺） */
export const straight = (ranks: Rank[], level: Rank | null = null): Card[] => {
  const suits: Suit[] = ['spade', 'heart', 'club', 'diamond'];
  return ranks.map((r, i) => mkCard(r, suits[i % 4], level));
};

/** n 张连续点数且同花色（同花顺 / 炸弹型连牌） */
export const flush = (ranks: Rank[], suit: Suit = 'spade', level: Rank | null = null): Card[] =>
  ranks.map(r => mkCard(r, suit, level));

/** 连续 n 个点数的对子（Tube 用） */
export const tube = (ranks: Rank[], level: Rank | null = null): Card[] =>
  ranks.flatMap(r => sameRank(r, 2, level));

/** 连续 n 个点数的三张（Plate 用） */
export const plate = (ranks: Rank[], level: Rank | null = null): Card[] =>
  ranks.flatMap(r => sameRank(r, 3, level));

/** 三带一对 */
export const tripleWithPair = (tripleRank: Rank, pairRank: Rank, level: Rank | null = null): Card[] =>
  [...sameRank(tripleRank, 3, level), ...sameRank(pairRank, 2, level)];

/** 把牌按 rank 升序排一下，便于断言时忽略花色顺序 */
export const byRank = (cards: Card[]): Card[] =>
  [...cards].sort((a, b) => a.value - b.value || a.suit.localeCompare(b.suit));

/** 断言用：牌组的 "点数多重集" 描述，如 'K,K' / '5,5,5,5' */
export const rankKey = (cards: Card[]): string =>
  cards.map(c => String(c.rank)).sort().join(',');

/** 断言用：按 value 排序的数值摘要 */
export const valueKey = (cards: Card[]): number[] =>
  cards.map(c => c.value).sort((a, b) => a - b);

export const PlayType = {
  Single: 'Single',
  Pair: 'Pair',
  Triple: 'Triple',
  Straight: 'Straight',
  TripleWithPair: 'TripleWithPair',
  Tube: 'Tube',
  Plate: 'Plate',
  StraightFlush: 'StraightFlush',
  Bomb: 'Bomb',
  Rocket: 'Rocket',
  Pass: 'Pass',
};

const getFaceValue = (card, isAceAsOne = false) => {
  if (card.rank === 'A' && isAceAsOne) return 1;
  if (card.id?.startsWith?.('sim') || card.id?.startsWith?.('mock')) {
    if (card.value === 14 && isAceAsOne) return 1;
    return card.value;
  }
  const rankValues = {
    '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10,
    J: 11, Q: 12, K: 13, A: 14,
  };
  return rankValues[String(card.rank)] || card.value;
};

const getRankCounts = (cards) => {
  const counts = {};
  cards.forEach((c) => {
    const v = c.value;
    counts[v] = (counts[v] || 0) + 1;
  });
  return Object.entries(counts)
    .map(([val, count]) => ({ value: Number(val), count }))
    .sort((a, b) => b.count - a.count || b.value - a.value);
};

const getFaceRankCounts = (cards) => {
  const counts = {};
  cards.forEach((c) => {
    const v = getFaceValue(c);
    counts[v] = (counts[v] || 0) + 1;
  });
  return Object.entries(counts)
    .map(([val, count]) => ({ value: Number(val), count }))
    .sort((a, b) => a.value - b.value);
};

const isStraight = (cards) => {
  if (cards.length !== 5) return { isValid: false, maxValue: 0 };
  const sorted = [...cards].sort((a, b) => getFaceValue(a) - getFaceValue(b));
  let isValid = true;
  for (let i = 0; i < 4; i++) {
    if (getFaceValue(sorted[i + 1]) - getFaceValue(sorted[i]) !== 1) {
      isValid = false;
      break;
    }
  }
  if (isValid && getFaceValue(sorted[4]) <= 14) {
    return { isValid: true, maxValue: getFaceValue(sorted[4]) };
  }

  const sortedAceAsOne = [...cards].sort((a, b) => getFaceValue(a, true) - getFaceValue(b, true));
  isValid = true;
  for (let i = 0; i < 4; i++) {
    if (getFaceValue(sortedAceAsOne[i + 1], true) - getFaceValue(sortedAceAsOne[i], true) !== 1) {
      isValid = false;
      break;
    }
  }
  if (isValid && getFaceValue(sortedAceAsOne[4], true) <= 14) {
    return { isValid: true, maxValue: getFaceValue(sortedAceAsOne[4], true) };
  }

  return { isValid: false, maxValue: 0 };
};

const isConsecutive = (cards, length, countPerRank) => {
  const faceRankCounts = getFaceRankCounts(cards);
  if (faceRankCounts.length !== length) return { isValid: false, maxValue: 0 };
  if (!faceRankCounts.every((r) => r.count === countPerRank)) return { isValid: false, maxValue: 0 };
  for (let i = 0; i < length - 1; i++) {
    if (faceRankCounts[i + 1].value - faceRankCounts[i].value !== 1) return { isValid: false, maxValue: 0 };
  }
  if (faceRankCounts[length - 1].value > 14) return { isValid: false, maxValue: 0 };
  return { isValid: true, maxValue: faceRankCounts[length - 1].value };
};

const getBasePlayInfo = (cards) => {
  const len = cards.length;
  const rankCounts = getRankCounts(cards);
  if (len === 1) return { type: PlayType.Single, maxValue: rankCounts[0].value };
  if (len === 2 && rankCounts[0].count === 2) return { type: PlayType.Pair, maxValue: rankCounts[0].value };
  if (len === 3 && rankCounts[0].count === 3) return { type: PlayType.Triple, maxValue: rankCounts[0].value };
  if (len === 4 && cards.every((c) => c.suit === 'joker')) return { type: PlayType.Rocket, maxValue: 10000 };
  if (len >= 4 && rankCounts[0].count === len) return { type: PlayType.Bomb, maxValue: len * 1000 + rankCounts[0].value, length: len };

  if (len === 5 && rankCounts.length === 2) {
    if (
      (rankCounts[0].count === 3 && rankCounts[1].count === 2) ||
      (rankCounts[0].count === 2 && rankCounts[1].count === 3)
    ) {
      const tripleValue = rankCounts.find((r) => r.count === 3).value;
      return { type: PlayType.TripleWithPair, maxValue: tripleValue };
    }
  }

  if (len === 5) {
    const straightInfo = isStraight(cards);
    if (straightInfo.isValid) {
      const isFlush = cards.every((c) => c.suit === cards[0].suit);
      if (isFlush) return { type: PlayType.StraightFlush, maxValue: 5500 + straightInfo.maxValue };
      return { type: PlayType.Straight, maxValue: straightInfo.maxValue };
    }
  }
  if (len === 6) {
    const tube = isConsecutive(cards, 3, 2);
    if (tube.isValid) return { type: PlayType.Tube, maxValue: tube.maxValue };
    const plate = isConsecutive(cards, 2, 3);
    if (plate.isValid) return { type: PlayType.Plate, maxValue: plate.maxValue };
  }
  return null;
};

const getPlayInfos = (cards) => {
  if (!cards || cards.length === 0) return [];
  const wildcards = cards.filter((c) => c.isRedJoker);
  const normalCards = cards.filter((c) => !c.isRedJoker);
  if (wildcards.length === 0 || normalCards.length === 0) {
    const info = getBasePlayInfo(cards);
    return info ? [info] : [];
  }

  const validInfos = new Map();
  const suits = ['spade', 'heart', 'club', 'diamond'];
  const allValues = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
  const tryAddInfo = (simulatedCards) => {
    const info = getBasePlayInfo(simulatedCards);
    if (!info) return;
    const key = `${info.type}-${info.maxValue}`;
    if (!validInfos.has(key)) validInfos.set(key, info);
  };

  if (wildcards.length === 1) {
    for (const v of allValues) {
      for (const s of suits) {
        const simCard = { id: 'sim', suit: s, rank: '2', value: v, isLevelCard: false, isRedJoker: false };
        tryAddInfo([...normalCards, simCard]);
      }
    }
  } else if (wildcards.length === 2) {
    for (const v1 of allValues) {
      for (const s1 of suits) {
        for (const v2 of allValues) {
          for (const s2 of suits) {
            const simCard1 = { id: 'sim1', suit: s1, rank: '2', value: v1, isLevelCard: false, isRedJoker: false };
            const simCard2 = { id: 'sim2', suit: s2, rank: '2', value: v2, isLevelCard: false, isRedJoker: false };
            tryAddInfo([...normalCards, simCard1, simCard2]);
          }
        }
      }
    }
  }
  return Array.from(validInfos.values());
};

export const getPlayInfo = (cards) => {
  const infos = getPlayInfos(cards);
  if (infos.length === 0) return null;
  const bomb = infos.find((i) => i.type === PlayType.Bomb || i.type === PlayType.StraightFlush || i.type === PlayType.Rocket);
  if (bomb) {
    return infos
      .filter((i) => i.type === PlayType.Bomb || i.type === PlayType.StraightFlush || i.type === PlayType.Rocket)
      .reduce((prev, cur) => (prev.maxValue > cur.maxValue ? prev : cur));
  }
  return infos.reduce((prev, cur) => (prev.maxValue > cur.maxValue ? prev : cur));
};

export const canPlay = (cards, lastPlay) => {
  const myInfos = getPlayInfos(cards);
  if (myInfos.length === 0) return false;
  if (!lastPlay || lastPlay.type === PlayType.Pass) return true;

  const lastInfos = getPlayInfos(lastPlay.cards);
  if (lastInfos.length === 0) return false;
  const validLastInfos = lastInfos.filter((i) => i.type === lastPlay.type);
  const lastInfo = validLastInfos.length > 0
    ? validLastInfos.reduce((prev, cur) => (prev.maxValue > cur.maxValue ? prev : cur))
    : lastInfos[0];

  for (const info of myInfos) {
    if (info.type === PlayType.Rocket) return true;
    const isBombType = info.type === PlayType.Bomb || info.type === PlayType.StraightFlush;
    const isLastBombType = lastInfo.type === PlayType.Bomb || lastInfo.type === PlayType.StraightFlush;
    if (isBombType && !isLastBombType && lastInfo.type !== PlayType.Rocket) return true;
    if (isBombType && isLastBombType && info.maxValue > lastInfo.maxValue) return true;
    if (info.type === lastInfo.type && cards.length === lastPlay.cards.length && info.maxValue > lastInfo.maxValue) return true;
  }
  return false;
};

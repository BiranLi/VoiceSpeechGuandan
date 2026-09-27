import { createDeck, dealCards, shuffleDeck } from '../src/lib/deck';
import { getLastAIMetrics, getPossiblePlays, makeDecision } from '../src/lib/ai';
import { canPlay, getPlayInfo } from '../src/lib/rules';
import { Card, PlayAction, PlayType, Player, PlayerId, Team } from '../src/types/game';
import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

type Difficulty = 'easy' | 'medium' | 'hard';

const ORDER: PlayerId[] = ['p1', 'p2', 'p3', 'p4'];
const TEAM_OF: Record<PlayerId, Team> = { p1: 'teamA', p2: 'teamB', p3: 'teamA', p4: 'teamB' };

type SimState = {
  players: Record<PlayerId, Player>;
  currentTurn: PlayerId;
  playArea: PlayAction[];
  lastValidPlay: PlayAction | null;
  finishedPlayers: PlayerId[];
  turnOrder: PlayerId[];
};

type GameStat = {
  gameIndex: number;
  setup: string;
  winnerTeam: Team;
  firstPlayer: PlayerId;
  turns: number;
  elapsedMs: number;
  bombCount: number;
  bugFlags: string[];
};

type MetricAgg = {
  count: number;
  elapsedMs: number;
  generated: number;
  valid: number;
  pruned: number;
  depth: number;
  nodes: number;
};

const metricAggByDifficulty: Record<Difficulty, MetricAgg> = {
  easy: { count: 0, elapsedMs: 0, generated: 0, valid: 0, pruned: 0, depth: 0, nodes: 0 },
  medium: { count: 0, elapsedMs: 0, generated: 0, valid: 0, pruned: 0, depth: 0, nodes: 0 },
  hard: { count: 0, elapsedMs: 0, generated: 0, valid: 0, pruned: 0, depth: 0, nodes: 0 },
};

type BugCounters = {
  invalidDecisionType: number;
  illegalFollowDecision: number;
  decisionCardsNotInHand: number;
  guardOverflow: number;
  noWinnerResolved: number;
  passWhenPlayable: number;
};

const bugCounters: BugCounters = {
  invalidDecisionType: 0,
  illegalFollowDecision: 0,
  decisionCardsNotInHand: 0,
  guardOverflow: 0,
  noWinnerResolved: 0,
  passWhenPlayable: 0,
};

const setPlayer = (id: PlayerId, hand: Card[]): Player => ({
  id,
  name: id.toUpperCase(),
  isAI: true,
  team: TEAM_OF[id],
  hand,
  role: 'normal',
});

const clonePlayers = (hands: Record<PlayerId, Card[]>) => ({
  p1: setPlayer('p1', [...hands.p1]),
  p2: setPlayer('p2', [...hands.p2]),
  p3: setPlayer('p3', [...hands.p3]),
  p4: setPlayer('p4', [...hands.p4]),
});

const isGameOver = (state: SimState) => {
  if (state.finishedPlayers.length >= 3) return true;
  if (state.finishedPlayers.length >= 2) {
    const a = state.players[state.finishedPlayers[0]];
    const b = state.players[state.finishedPlayers[1]];
    if (a.team === b.team) return true;
  }
  return false;
};

const appendFinished = (state: SimState, playerId: PlayerId) => {
  if (state.players[playerId].hand.length === 0 && !state.finishedPlayers.includes(playerId)) {
    state.finishedPlayers.push(playerId);
  }
};

const nextAliveFrom = (state: SimState, from: PlayerId): PlayerId | null => {
  let idx = state.turnOrder.indexOf(from);
  for (let i = 0; i < 4; i++) {
    idx = (idx + 1) % 4;
    const pid = state.turnOrder[idx];
    if (state.players[pid].hand.length > 0) return pid;
  }
  return null;
};

const advanceTurn = (state: SimState) => {
  if (isGameOver(state)) return;
  const nextTurnId = nextAliveFrom(state, state.currentTurn);
  if (!nextTurnId) return;
  let nextValidPlay = state.lastValidPlay;

  if (nextValidPlay) {
    const lastPlayerId = nextValidPlay.playerId;
    const alivePlayers = state.turnOrder.filter((pId) => state.players[pId].hand.length > 0);
    let lastPlayIndex = -1;
    for (let i = state.playArea.length - 1; i >= 0; i--) {
      const p = state.playArea[i];
      if (p.playerId === lastPlayerId && p.type !== PlayType.Pass && p.cards.length > 0) {
        lastPlayIndex = i;
        break;
      }
    }
    if (lastPlayIndex !== -1) {
      const actionsAfter = state.playArea.slice(lastPlayIndex + 1);
      const passCount = actionsAfter.filter((a) => a.type === PlayType.Pass).length;
      const expectedPasses = alivePlayers.length - (state.players[lastPlayerId].hand.length > 0 ? 1 : 0);
      if (passCount >= expectedPasses) {
        nextValidPlay = null;
        if (state.players[lastPlayerId].hand.length === 0) {
          const lastIdx = state.turnOrder.indexOf(lastPlayerId);
          const teammateId = state.turnOrder[(lastIdx + 2) % 4];
          if (state.players[teammateId].hand.length > 0) {
            state.currentTurn = teammateId;
            state.lastValidPlay = null;
            return;
          }
          state.currentTurn = nextTurnId;
          state.lastValidPlay = null;
          return;
        }
        state.currentTurn = lastPlayerId;
        state.lastValidPlay = null;
        return;
      }
    }
  }

  state.currentTurn = nextTurnId;
  state.lastValidPlay = nextValidPlay;
};

const removeCards = (hand: Card[], played: Card[]) => {
  const ids = new Set(played.map((c) => c.id));
  return hand.filter((c) => !ids.has(c.id));
};

const runOneGame = (gameIndex: number, setupName: string, diffMap: Record<PlayerId, Difficulty>): GameStat => {
  const start = performance.now();
  const deck = shuffleDeck(createDeck(2));
  const hands = dealCards(deck);
  const state: SimState = {
    players: clonePlayers(hands),
    currentTurn: 'p1',
    playArea: [],
    lastValidPlay: null,
    finishedPlayers: [],
    turnOrder: [...ORDER],
  };
  let turns = 0;
  let bombs = 0;
  let guard = 0;
  const bugFlags: string[] = [];

  while (!isGameOver(state) && guard < 3000) {
    guard++;
    const pid = state.currentTurn;
    const player = state.players[pid];
    if (player.hand.length === 0) {
      const next = nextAliveFrom(state, pid);
      if (!next) break;
      state.currentTurn = next;
      continue;
    }

    const difficulty = diffMap[pid];
    let decision = makeDecision(player.hand, state.lastValidPlay, difficulty, player.team, state.players, pid);
    const metrics = getLastAIMetrics();
    const agg = metricAggByDifficulty[difficulty];
    agg.count += 1;
    agg.elapsedMs += metrics.elapsedMs;
    agg.generated += metrics.generatedPlays;
    agg.valid += metrics.validPlays;
    agg.pruned += metrics.prunedPlays;
    agg.depth += metrics.endgameDepth;
    agg.nodes += metrics.endgameNodes;

    const mustPass = state.lastValidPlay && state.lastValidPlay.type !== PlayType.Pass;
    const possiblePlays = getPossiblePlays(player.hand, state.lastValidPlay, difficulty);
    const hasPlayable = possiblePlays.length > 0;
    if (!decision && hasPlayable) {
      bugCounters.passWhenPlayable += 1;
      bugFlags.push('pass_when_playable');
    }
    let action: PlayAction;
    if (!decision || decision.length === 0) {
      action = { playerId: pid, cards: [], type: PlayType.Pass };
    } else {
      const handIdSet = new Set(player.hand.map((c) => c.id));
      const allInHand = decision.every((c) => handIdSet.has(c.id));
      if (!allInHand) {
        bugCounters.decisionCardsNotInHand += 1;
        bugFlags.push('decision_cards_not_in_hand');
        decision = null;
      }
      if (decision && mustPass && !canPlay(decision, state.lastValidPlay!)) {
        bugCounters.illegalFollowDecision += 1;
        bugFlags.push('illegal_follow_decision');
        decision = null;
      }
      if (!decision) {
        action = { playerId: pid, cards: [], type: PlayType.Pass };
      } else {
        const info = getPlayInfo(decision);
        if (!info) {
          bugCounters.invalidDecisionType += 1;
          bugFlags.push('invalid_decision_type');
          action = { playerId: pid, cards: [], type: PlayType.Pass };
        } else {
          action = { playerId: pid, cards: decision, type: info.type };
        }
      }
    }

    if (action.type === PlayType.Pass) {
      state.playArea.push(action);
    } else {
      if (action.type === PlayType.Bomb || action.type === PlayType.StraightFlush || action.type === PlayType.Rocket) bombs += 1;
      state.players[pid] = { ...state.players[pid], hand: removeCards(state.players[pid].hand, action.cards) };
      state.playArea.push(action);
      state.lastValidPlay = action;
      appendFinished(state, pid);
    }

    turns++;
    advanceTurn(state);
  }

  if (guard >= 3000) {
    bugCounters.guardOverflow += 1;
    bugFlags.push('guard_overflow');
  }
  const firstPlayer = state.finishedPlayers[0] ?? 'p1';
  if (state.finishedPlayers.length === 0) {
    bugCounters.noWinnerResolved += 1;
    bugFlags.push('no_winner_resolved');
  }
  const elapsedMs = performance.now() - start;
  return {
    gameIndex,
    setup: setupName,
    winnerTeam: TEAM_OF[firstPlayer],
    firstPlayer,
    turns,
    elapsedMs,
    bombCount: bombs,
    bugFlags,
  };
};

const summarize = (games: GameStat[]) => {
  const bySetup = new Map<string, GameStat[]>();
  for (const g of games) {
    const arr = bySetup.get(g.setup) ?? [];
    arr.push(g);
    bySetup.set(g.setup, arr);
  }

  const setupSummary = Array.from(bySetup.entries()).map(([setup, arr]) => {
    const teamAWins = arr.filter((g) => g.winnerTeam === 'teamA').length;
    const totalTurns = arr.reduce((s, g) => s + g.turns, 0);
    const totalMs = arr.reduce((s, g) => s + g.elapsedMs, 0);
    const totalBombs = arr.reduce((s, g) => s + g.bombCount, 0);
    return {
      setup,
      games: arr.length,
      teamAWinRate: Number((teamAWins / arr.length).toFixed(4)),
      avgTurns: Number((totalTurns / arr.length).toFixed(2)),
      avgElapsedMs: Number((totalMs / arr.length).toFixed(3)),
      avgBombs: Number((totalBombs / arr.length).toFixed(2)),
    };
  });

  const metricSummary = (Object.keys(metricAggByDifficulty) as Difficulty[]).map((k) => {
    const m = metricAggByDifficulty[k];
    const d = Math.max(1, m.count);
    return {
      difficulty: k,
      decisions: m.count,
      avgElapsedMs: Number((m.elapsedMs / d).toFixed(3)),
      avgGenerated: Number((m.generated / d).toFixed(2)),
      avgValid: Number((m.valid / d).toFixed(2)),
      avgPruned: Number((m.pruned / d).toFixed(2)),
      avgDepth: Number((m.depth / d).toFixed(3)),
      avgNodes: Number((m.nodes / d).toFixed(3)),
    };
  });

  return { setupSummary, metricSummary };
};

const main = () => {
  const TOTAL = 3000;
  const setups: Array<{ name: string; diff: Record<PlayerId, Difficulty> }> = [
    { name: 'hard+hard vs medium+medium', diff: { p1: 'hard', p3: 'hard', p2: 'medium', p4: 'medium' } },
    { name: 'hard+hard vs easy+easy', diff: { p1: 'hard', p3: 'hard', p2: 'easy', p4: 'easy' } },
    { name: 'medium+medium vs easy+easy', diff: { p1: 'medium', p3: 'medium', p2: 'easy', p4: 'easy' } },
  ];
  const each = Math.floor(TOTAL / setups.length);
  const games: GameStat[] = [];

  let idx = 1;
  for (const s of setups) {
    for (let i = 0; i < each; i++) {
      games.push(runOneGame(idx++, s.name, s.diff));
    }
  }

  while (games.length < TOTAL) {
    const s = setups[games.length % setups.length];
    games.push(runOneGame(idx++, s.name, s.diff));
  }

  const summary = summarize(games);
  const output = {
    generatedAt: new Date().toISOString(),
    totalGames: games.length,
    setupSummary: summary.setupSummary,
    metricSummary: summary.metricSummary,
    bugCounters,
    gamesWithBugFlags: games.filter((g) => g.bugFlags.length > 0).length,
  };
  mkdirSync('reports', { recursive: true });
  writeFileSync('reports/ai-sim-3000-summary.json', JSON.stringify(output, null, 2), 'utf8');

  console.log(JSON.stringify(output, null, 2));
};

main();

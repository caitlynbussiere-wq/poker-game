const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// ─── State ───────────────────────────────────────────────
let players = [];
let spectators = [];
let hostId = null;
let gameStarted = false;
let deck = [];
let communityCards = [];
let pots = [];
let currentPlayerIndex = 0;
let currentBet = 0;
let round = 'preflop';
let dealerIndex = 0;
let needToAct = [];
let turnTimer = null;
let sbIndex = 0;
let bbIndex = 0;
const TURN_TIME = 20;

// ─── Blind Structure ─────────────────────────────────────
const blindLevels = [
  { small: 25,  big: 50  },
  { small: 50,  big: 100 },
  { small: 100, big: 200 },
  { small: 200, big: 400 },
  { small: 400, big: 800 },
];
let blindLevelIndex = 0;
let blindTimer = null;
let blindTimeRemaining = 10 * 60;

function getSmallBlind() { return blindLevels[blindLevelIndex].small; }
function getBigBlind()   { return blindLevels[blindLevelIndex].big; }

function startBlindTimer() {
  blindTimeRemaining = 10 * 60;
  if (blindTimer) clearInterval(blindTimer);
  blindTimer = setInterval(() => {
    blindTimeRemaining--;
    io.emit('blindTimer', {
      timeRemaining: blindTimeRemaining,
      currentSmall: getSmallBlind(),
      currentBig: getBigBlind(),
      nextSmall: blindLevels[Math.min(blindLevelIndex + 1, blindLevels.length - 1)].small,
      nextBig:   blindLevels[Math.min(blindLevelIndex + 1, blindLevels.length - 1)].big,
      isMax: blindLevelIndex >= blindLevels.length - 1
    });
    if (blindTimeRemaining <= 0) {
      if (blindLevelIndex < blindLevels.length - 1) {
        blindLevelIndex++;
        io.emit('blindsIncreased', { small: getSmallBlind(), big: getBigBlind() });
      }
      blindTimeRemaining = 10 * 60;
    }
  }, 1000);
}

// ─── Deck ────────────────────────────────────────────────
function createDeck() {
  const suits  = ['♠','♥','♦','♣'];
  const values = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  return suits.flatMap(suit => values.map(value => ({ suit, value })));
}

function shuffleDeck(d) {
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

// ─── Hand Evaluation ─────────────────────────────────────
const VALUE_MAP = {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,
                   '9':9,'10':10,'J':11,'Q':12,'K':13,'A':14};

function cardValue(card) { return VALUE_MAP[card.value]; }

function getCombinations(arr, k) {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const [first, ...rest] = arr;
  return [
    ...getCombinations(rest, k - 1).map(c => [first, ...c]),
    ...getCombinations(rest, k)
  ];
}

function evaluateHand(cards) {
  const vals  = cards.map(cardValue).sort((a, b) => b - a);
  const suits = cards.map(c => c.suit);
  const isFlush = suits.every(s => s === suits[0]);
  let isStraight = false;
  let straightHigh = vals[0];
  if (new Set(vals).size === 5 && vals[0] - vals[4] === 4) isStraight = true;
  if (!isStraight && JSON.stringify(vals) === JSON.stringify([14,5,4,3,2])) {
    isStraight = true; straightHigh = 5;
  }
  const counts = {};
  vals.forEach(v => counts[v] = (counts[v] || 0) + 1);
  const groups = Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || b[0] - a[0])
    .map(([val, cnt]) => ({ val: +val, cnt }));
  if (isFlush && isStraight)                     return [8, straightHigh];
  if (groups[0].cnt === 4)                       return [7, groups[0].val, groups[1].val];
  if (groups[0].cnt === 3 && groups[1].cnt === 2)return [6, groups[0].val, groups[1].val];
  if (isFlush)                                   return [5, ...vals];
  if (isStraight)                                return [4, straightHigh];
  if (groups[0].cnt === 3)                       return [3, groups[0].val, groups[1].val, groups[2].val];
  if (groups[0].cnt === 2 && groups[1].cnt === 2)return [2, groups[0].val, groups[1].val, groups[2].val];
  if (groups[0].cnt === 2)                       return [1, groups[0].val, ...groups.slice(1).map(g => g.val)];
  return [0, ...vals];
}

function compareScores(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i]||0) !== (b[i]||0)) return (a[i]||0) - (b[i]||0);
  }
  return 0;
}

function getBestHand(holeCards, community) {
  const all = [...holeCards, ...community];
  const combos = getCombinations(all, 5);
  let best = null;
  for (const combo of combos) {
    const score = evaluateHand(combo);
    if (!best || compareScores(score, best.score) > 0) best = { score, cards: combo };
  }
  return best;
}

const HAND_NAMES = ['High Card','One Pair','Two Pair','Three of a Kind',
  'Straight','Flush','Full House','Four of a Kind','Straight Flush'];

// ─── Side Pot Calculation ────────────────────────────────
function calculateSidePots(contributions) {
  const sorted = [...contributions].sort((a, b) => a.contributed - b.contributed);
  const pots = [];
  let processed = 0;
  for (let i = 0; i < sorted.length; i++) {
    const level = sorted[i].contributed;
    if (level <= processed) continue;
    const amount = (level - processed) * contributions.filter(p => p.contributed >= level).length;
    const eligible = contributions.filter(p => p.contributed >= level && !p.folded).map(p => p.id);
    if (amount > 0 && eligible.length > 0) pots.push({ amount, eligibleIds: eligible });
    processed = level;
  }
  return pots;
}

// ─── Helpers ─────────────────────────────────────────────
function getActivePlayers() { return players.filter(p => !p.folded); }
function getActablePlayers() { return players.filter(p => !p.folded && p.chips > 0); }

function nextActiveIndex(fromIndex) {
  let i = (fromIndex + 1) % players.length;
  let tries = 0;
  while (players[i].folded && tries < players.length) {
    i = (i + 1) % players.length; tries++;
  }
  return i;
}

function getTotalPot() { return pots.reduce((sum, p) => sum + p.amount, 0); }

// ─── Turn Timer ───────────────────────────────────────────
function startTurnTimer() {
  if (turnTimer) clearInterval(turnTimer);
  let timeLeft = TURN_TIME;
  io.emit('turnTimer', { timeLeft, playerId: players[currentPlayerIndex]?.id });
  turnTimer = setInterval(() => {
    timeLeft--;
    io.emit('turnTimer', { timeLeft, playerId: players[currentPlayerIndex]?.id });
    if (timeLeft <= 0) {
      clearInterval(turnTimer);
      turnTimer = null;
      const player = players[currentPlayerIndex];
      if (player && !player.folded) {
        io.emit('logMessage', { msg: `${player.name} timed out and folded`, type: 'log-fold' });
        handleAction({ id: player.id, emit: () => {} }, 'fold', 0);
      }
    }
  }, 1000);
}

function stopTurnTimer() {
  if (turnTimer) clearInterval(turnTimer);
  turnTimer = null;
  io.emit('turnTimer', { timeLeft: 0, playerId: null });
}

// ─── Broadcast ───────────────────────────────────────────
function broadcastGameState() {
  const totalPot = getTotalPot();
  players.forEach(player => {
    const safePlayers = players.map((p, i) => ({
      id: p.id, name: p.name, chips: p.chips,
      folded: p.folded, allIn: p.allIn, bet: p.bet,
      contributed: p.contributed,
      cards: p.id === player.id ? p.cards : null,
      isDealer: i === dealerIndex,
      isSB: i === sbIndex,
      isBB: i === bbIndex
    }));
    io.to(player.id).emit('gameState', {
      players: safePlayers, communityCards,
      pot: totalPot, pots,
      currentPlayerId: players[currentPlayerIndex]?.id,
      currentBet, round, myId: player.id,
      smallBlind: getSmallBlind(), bigBlind: getBigBlind(), needToAct
    });
  });

  spectators.forEach(spec => {
    const safePlayers = players.map((p, i) => ({
      id: p.id, name: p.name, chips: p.chips,
      folded: p.folded, allIn: p.allIn, bet: p.bet,
      cards: null,
      isDealer: i === dealerIndex,
      isSB: i === sbIndex,
      isBB: i === bbIndex
    }));
    io.to(spec.id).emit('spectatorState', {
      players: safePlayers, communityCards,
      pot: totalPot,
      currentPlayerId: players[currentPlayerIndex]?.id,
      round
    });
  });

  startTurnTimer();
}

// ─── Round Flow ───────────────────────────────────────────
function startRound() {
  const broke = players.filter(p => p.chips <= 0);
  broke.forEach(p => {
    spectators.push(p);
    io.to(p.id).emit('becameSpectator');
  });
  players = players.filter(p => p.chips > 0);

  if (players.length < 2) {
    stopTurnTimer();
    io.emit('gameOver', { winnerName: players[0]?.name || 'Nobody' });
    return;
  }

  deck = shuffleDeck(createDeck());
  communityCards = [];
  pots = [{ amount: 0, eligibleIds: players.map(p => p.id) }];
  currentBet = 0;
  round = 'preflop';

  players.forEach(p => {
    p.cards = [deck.pop(), deck.pop()];
    p.folded = false; p.allIn = false;
    p.bet = 0; p.contributed = 0;
  });

  sbIndex = (dealerIndex + 1) % players.length;
  bbIndex = (dealerIndex + 2) % players.length;

  postBlind(players[sbIndex], getSmallBlind());
  postBlind(players[bbIndex], getBigBlind());
  currentBet = getBigBlind();

  currentPlayerIndex = (bbIndex + 1) % players.length;
  needToAct = players.map(p => p.id);

  io.emit('logMessage', { msg: `--- New round ---`, type: 'log-round' });
  broadcastGameState();
}

function postBlind(player, amount) {
  const actual = Math.min(amount, player.chips);
  player.chips -= actual; player.bet += actual;
  player.contributed += actual; pots[0].amount += actual;
  if (player.chips === 0) player.allIn = true;
}

function handleAction(socket, action, amount) {
  const player = players.find(p => p.id === socket.id);
  if (!player) return;
  if (players[currentPlayerIndex]?.id !== socket.id) return;
  if (!needToAct.includes(socket.id)) return;

  if (action === 'fold') {
    player.folded = true;
    pots.forEach(pot => { pot.eligibleIds = pot.eligibleIds.filter(id => id !== socket.id); });
    needToAct = needToAct.filter(id => id !== socket.id);
    io.emit('logMessage', { msg: `${player.name} folded`, type: 'log-fold' });

  } else if (action === 'check') {
    if (player.bet < currentBet) { socket.emit('errorMsg', `You must call ${currentBet - player.bet} or raise!`); return; }
    needToAct = needToAct.filter(id => id !== socket.id);
    io.emit('logMessage', { msg: `${player.name} checked`, type: 'log-action' });

  } else if (action === 'call') {
    const callAmount = Math.min(currentBet - player.bet, player.chips);
    player.chips -= callAmount; player.bet += callAmount;
    player.contributed += callAmount; pots[0].amount += callAmount;
    if (player.chips === 0) player.allIn = true;
    needToAct = needToAct.filter(id => id !== socket.id);
    io.emit('logMessage', { msg: `${player.name} called ${callAmount}`, type: 'log-action' });

  } else if (action === 'raise') {
    const raiseTotal = parseInt(amount);
    if (raiseTotal <= currentBet) { socket.emit('errorMsg', `Raise must be more than ${currentBet}`); return; }
    const diff = Math.min(raiseTotal - player.bet, player.chips);
    player.chips -= diff; player.bet += diff;
    player.contributed += diff; pots[0].amount += diff;
    currentBet = player.bet;
    if (player.chips === 0) player.allIn = true;
    needToAct = getActablePlayers().filter(p => p.id !== socket.id).map(p => p.id);
    io.emit('logMessage', { msg: `${player.name} raised to ${player.bet}`, type: 'log-action' });

  } else if (action === 'allin') {
    const allInAmount = player.chips;
    player.contributed += allInAmount; player.bet += allInAmount;
    pots[0].amount += allInAmount; player.chips = 0; player.allIn = true;
    if (player.bet > currentBet) {
      currentBet = player.bet;
      needToAct = getActablePlayers().filter(p => p.id !== socket.id).map(p => p.id);
    } else {
      needToAct = needToAct.filter(id => id !== socket.id);
    }
    io.emit('logMessage', { msg: `${player.name} went ALL IN (${allInAmount})`, type: 'log-action' });
  }

  const activePlayers = getActivePlayers();
  if (activePlayers.length === 1) { refundExcessBets(); endRound(); return; }
  if (needToAct.filter(id => !players.find(p => p.id === id)?.folded).length === 0) { advanceRound(); return; }

  let nextIndex = nextActiveIndex(currentPlayerIndex);
  let tries = 0;
  while (!needToAct.includes(players[nextIndex].id) && tries < players.length) {
    nextIndex = nextActiveIndex(nextIndex); tries++;
  }
  if (!needToAct.includes(players[nextIndex].id)) { advanceRound(); return; }

  currentPlayerIndex = nextIndex;
  broadcastGameState();
}

function refundExcessBets() {
  const active = getActivePlayers();
  if (active.length !== 1) return;
  const winner = active[0];
  const maxOthers = players.filter(p => p.id !== winner.id).reduce((max, p) => Math.max(max, p.contributed), 0);
  const excess = winner.contributed - maxOthers;
  if (excess > 0) { winner.chips += excess; winner.contributed -= excess; pots[0].amount -= excess; }
}

function advanceRound() {
  players.forEach(p => p.bet = 0);
  currentBet = 0;
  const actable = getActablePlayers();
  if (actable.length <= 1) { runOutBoard(); return; }

  if (round === 'preflop')      { round = 'flop';  communityCards.push(deck.pop(), deck.pop(), deck.pop()); }
  else if (round === 'flop')    { round = 'turn';  communityCards.push(deck.pop()); }
  else if (round === 'turn')    { round = 'river'; communityCards.push(deck.pop()); }
  else if (round === 'river')   { round = 'showdown'; endRound(); return; }

  let firstIndex = (dealerIndex + 1) % players.length;
  let tries = 0;
  while ((players[firstIndex].folded || players[firstIndex].allIn) && tries < players.length) {
    firstIndex = (firstIndex + 1) % players.length; tries++;
  }
  currentPlayerIndex = firstIndex;
  needToAct = actable.map(p => p.id);
  broadcastGameState();
}

function runOutBoard() {
  if (round === 'preflop') { communityCards.push(deck.pop(), deck.pop(), deck.pop()); round = 'flop'; }
  if (round === 'flop')    { communityCards.push(deck.pop()); round = 'turn'; }
  if (round === 'turn')    { communityCards.push(deck.pop()); round = 'river'; }
  round = 'showdown'; needToAct = [];
  broadcastGameState();
  setTimeout(endRound, 1500);
}

function endRound() {
  stopTurnTimer();
  const contributions = players.map(p => ({ id: p.id, name: p.name, contributed: p.contributed, folded: p.folded }));
  const sidePots = calculateSidePots(contributions);
  const active = getActivePlayers();
  const handResults = active.map(p => {
    const result = communityCards.length >= 3 ? getBestHand(p.cards, communityCards) : { score: [0] };
    return { player: p, score: result.score, handName: HAND_NAMES[result.score[0]] };
  });

  const winnings = {};
  const potResults = [];
  players.forEach(p => winnings[p.id] = 0);

  sidePots.forEach(pot => {
    const eligible = handResults.filter(r => pot.eligibleIds.includes(r.player.id));
    if (eligible.length === 0) return;
    let bestScore = null; let potWinners = [];
    eligible.forEach(r => {
      if (!bestScore || compareScores(r.score, bestScore) > 0) { bestScore = r.score; potWinners = [r]; }
      else if (compareScores(r.score, bestScore) === 0) potWinners.push(r);
    });
    const share = Math.floor(pot.amount / potWinners.length);
    potWinners.forEach(r => winnings[r.player.id] += share);
    potResults.push({ amount: pot.amount, winnerNames: potWinners.map(r => r.player.name), winnerIds: potWinners.map(r => r.player.id), handName: potWinners[0].handName });
  });

  players.forEach(p => p.chips += winnings[p.id]);
  round = 'ended';

  const totalPot = sidePots.reduce((s, p) => s + p.amount, 0);
  io.emit('logMessage', { msg: `${potResults[0]?.winnerNames.join(' & ')} wins ${totalPot}!`, type: 'log-win' });

  const showdown = active.map(p => {
    const result = handResults.find(r => r.player.id === p.id);
    return { id: p.id, name: p.name, cards: p.cards, handName: result?.handName || '' };
  });

  io.emit('roundOver', {
    potResults, showdown,
    winnerIds: potResults[0]?.winnerIds || [],
    winnerNames: potResults[0]?.winnerNames || [],
    pot: totalPot
  });

  setTimeout(() => {
    dealerIndex = (dealerIndex + 1) % players.length;
    startRound();
  }, 5000);
}

// ─── Socket Events ────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('playerJoin', (name) => {
    if (players.length === 0) hostId = socket.id;
    players.push({ id: socket.id, name, chips: 5000, cards: [], folded: false, allIn: false, bet: 0, contributed: 0 });
    socket.emit('assignHost', socket.id === hostId);
    io.emit('updatePlayers', players);
  });

  socket.on('startGame', () => {
    if (socket.id !== hostId) return;
    if (players.length < 2) { socket.emit('errorMsg', 'Need at least 2 players!'); return; }
    gameStarted = true;
    io.emit('gameStarted', {});
    startBlindTimer();
    setTimeout(startRound, 500);
  });

  socket.on('playerAction', ({ action, amount }) => {
    handleAction(socket, action, amount);
  });

  socket.on('disconnect', () => {
    players = players.filter(p => p.id !== socket.id);
    spectators = spectators.filter(p => p.id !== socket.id);
    needToAct = needToAct.filter(id => id !== socket.id);
    if (socket.id === hostId && players.length > 0) {
      hostId = players[0].id;
      io.to(hostId).emit('assignHost', true);
    }
    io.emit('updatePlayers', players);
  });
});

server.listen(3000, () => console.log('Server running at http://localhost:3000'));
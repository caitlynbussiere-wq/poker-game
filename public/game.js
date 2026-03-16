const socket = io();

const nameInput = document.getElementById('nameInput');
const joinBtn   = document.getElementById('joinBtn');
const playersList = document.getElementById('players');

let isHost = false;
let myId   = null;
let gamePlayers = [];
let isSpectator = false;
const TURN_TIME = 20;

// ─── Audio Engine ─────────────────────────────────────────
const AudioContext = window.AudioContext || window.webkitAudioContext;
let audioCtx = null;

function getAudio() {
  if (!audioCtx) audioCtx = new AudioContext();
  return audioCtx;
}

function playDeal() {
  try {
    const ctx = getAudio();
    const buf = ctx.createBuffer(1, ctx.sampleRate * 0.08, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 3);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1800;
    filter.Q.value = 0.8;
    src.connect(filter);
    filter.connect(ctx.destination);
    src.start();
  } catch(e) {}
}

function playChip() {
  try {
    const ctx = getAudio();
    [0, 0.05, 0.1].forEach(delay => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(900, ctx.currentTime + delay);
      osc.frequency.exponentialRampToValueAtTime(600, ctx.currentTime + delay + 0.08);
      gain.gain.setValueAtTime(0.3, ctx.currentTime + delay);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + 0.1);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + delay);
      osc.stop(ctx.currentTime + delay + 0.1);
    });
  } catch(e) {}
}

function playWin() {
  try {
    const ctx = getAudio();
    [523, 659, 784, 1047].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, ctx.currentTime + i * 0.12);
      gain.gain.linearRampToValueAtTime(0.3, ctx.currentTime + i * 0.12 + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.12 + 0.4);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + i * 0.12);
      osc.stop(ctx.currentTime + i * 0.12 + 0.4);
    });
  } catch(e) {}
}

// ─── Lobby ───────────────────────────────────────────────
joinBtn.addEventListener('click', () => {
  const name = nameInput.value.trim();
  if (!name) { alert('Please enter your name!'); return; }
  socket.emit('playerJoin', name);
  nameInput.disabled = true;
  joinBtn.disabled   = true;
  joinBtn.textContent = 'Waiting for players...';
});

socket.on('assignHost', (hosting) => {
  isHost = hosting;
  myId   = socket.id;
  if (isHost) {
    const startBtn = document.createElement('button');
    startBtn.id = 'startBtn';
    startBtn.textContent = 'Start Game';
    startBtn.addEventListener('click', () => socket.emit('startGame'));
    document.getElementById('lobby').appendChild(startBtn);
  }
});

socket.on('updatePlayers', (players) => {
  playersList.innerHTML = '';
  players.forEach(player => {
    const li = document.createElement('li');
    li.textContent = `${player.name} — ${player.chips.toLocaleString()} chips`;
    playersList.appendChild(li);
  });
});

socket.on('errorMsg', (msg) => alert(msg));

socket.on('gameStarted', () => {
  document.getElementById('lobby').classList.add('hidden');
  document.getElementById('gameScreen').classList.remove('hidden');
});

// ─── Blind Timer ─────────────────────────────────────────
socket.on('blindTimer', ({ timeRemaining, currentSmall, currentBig, nextSmall, nextBig, isMax }) => {
  const mins = Math.floor(timeRemaining / 60);
  const secs = String(timeRemaining % 60).padStart(2, '0');
  const el = document.getElementById('blindTimerDisplay');
  if (el) {
    el.innerHTML = `
      <span class="blind-current">Blinds: ${currentSmall}/${currentBig}</span>
      ${!isMax ? `<span class="blind-next">Next: ${nextSmall}/${nextBig} in ${mins}:${secs}</span>` : '<span class="blind-next">Max blinds!</span>'}
    `;
    if (timeRemaining <= 30) el.classList.add('urgent');
    else el.classList.remove('urgent');
  }
});

socket.on('blindsIncreased', ({ small, big }) => {
  showBanner(`Blinds increased to ${small}/${big}!`, '#e67e22');
});

socket.on('logMessage', ({ msg, type }) => addLog(msg, type));

// ─── Game State ───────────────────────────────────────────
socket.on('gameState', ({ players, communityCards, pot, currentPlayerId, currentBet, round, myId: id }) => {
  if (isSpectator) return;
  myId = id;
  gamePlayers = players;

  document.getElementById('roundLabel').textContent = round.toUpperCase();
  document.getElementById('potLabel').textContent   = `Pot: ${pot.toLocaleString()}`;

  renderSeats(players, myId, currentPlayerId);

  const me = players.find(p => p.id === myId);
  if (me && me.cards) {
    // Reset cards before rendering new ones
    document.querySelectorAll('.my-card').forEach(c => {
      c.className = 'my-card empty';
      c.innerHTML = '';
    });
    document.querySelectorAll('.community-card').forEach(c => {
      c.className = 'community-card empty';
      c.innerHTML = '';
    });
    renderMyCards(me.cards);
  }

  renderCommunityCards(communityCards);

  const isMyTurn = currentPlayerId === myId;
  document.getElementById('actionButtons').classList.toggle('hidden', !isMyTurn);

  if (isMyTurn) {
    const myBet = me?.bet || 0;
    const callAmount = currentBet - myBet;
    document.getElementById('checkBtn').classList.toggle('hidden', callAmount > 0);
    document.getElementById('callBtn').classList.toggle('hidden', callAmount === 0);
    document.getElementById('callBtn').textContent = `Call ${callAmount}`;
    const allInBtn = document.getElementById('allInBtn');
    if (me && me.chips > 0) {
      allInBtn.classList.remove('hidden');
      allInBtn.textContent = `All In (${me.chips.toLocaleString()})`;
    } else {
      allInBtn.classList.add('hidden');
    }
  }
});

// ─── Spectator Mode ───────────────────────────────────────
socket.on('becameSpectator', () => {
  isSpectator = true;
  document.getElementById('actionButtons').classList.add('hidden');
  document.querySelectorAll('.my-card').forEach(c => { c.className = 'my-card empty'; c.innerHTML = ''; });
  const existing = document.getElementById('spectatorBanner');
  if (!existing) {
    const banner = document.createElement('div');
    banner.id = 'spectatorBanner';
    banner.innerHTML = `
      <div class="spec-title">You have been eliminated</div>
      <div class="spec-sub">Spectating the game...</div>
    `;
    document.getElementById('gameScreen').appendChild(banner);
  }
});

socket.on('spectatorState', ({ players, communityCards, pot, currentPlayerId, round }) => {
  document.getElementById('roundLabel').textContent = round.toUpperCase();
  document.getElementById('potLabel').textContent   = `Pot: ${pot.toLocaleString()}`;
  renderSeats(players, null, currentPlayerId);
  renderCommunityCards(communityCards);
});

// ─── Turn Timer ───────────────────────────────────────────
socket.on('turnTimer', ({ timeLeft, playerId }) => {
  document.querySelectorAll('.seat-timer-fill').forEach(bar => {
    bar.style.width = '0%';
    bar.style.backgroundColor = '#d4af37';
  });
  if (!playerId || timeLeft <= 0) return;
  const fill = document.getElementById(`timer-fill-${playerId}`);
  if (!fill) return;
  fill.style.width = `${(timeLeft / TURN_TIME) * 100}%`;
  if (timeLeft <= 5)       fill.style.backgroundColor = '#cc0000';
  else if (timeLeft <= 10) fill.style.backgroundColor = '#e67e22';
  else                     fill.style.backgroundColor = '#d4af37';
});

// ─── Round Over ───────────────────────────────────────────
socket.on('roundOver', ({ winnerIds, winnerNames, pot, showdown }) => {
  // Reset all cards for next round
  document.querySelectorAll('.community-card').forEach(c => {
    c.className = 'community-card empty';
    c.innerHTML = '';
  });
  document.querySelectorAll('.my-card').forEach(c => {
    c.className = 'my-card empty';
    c.innerHTML = '';
  });

  playWin();
  const names = winnerNames.join(' & ');
  const isSplit = winnerNames.length > 1;
  const winnerData = showdown?.find(p => winnerIds.includes(p.id));
  const handName = winnerData?.handName || '';
  showBanner(`
    <div class="trophy">🏆</div>
    <div class="winner-name">${names}</div>
    ${handName ? `<div class="hand-name">${handName}</div>` : ''}
    <div class="pot-won">wins ${pot.toLocaleString()} chips${isSplit ? ' (split)' : ''}</div>
  `, '#d4af37');
});

socket.on('gameOver', ({ winnerName }) => {
  playWin();
  showBanner(`<div class="trophy">🏆</div><div class="winner-name">${winnerName} wins the game!</div>`, '#d4af37');
});

// ─── Rendering ────────────────────────────────────────────
function renderSeats(players, myId, currentPlayerId) {
  const container = document.getElementById('seats');
  container.innerHTML = '';
  const count = players.length;
  const rx = 72, ry = 85;

  players.forEach((player, index) => {
    const angle = (index / count) * 2 * Math.PI + Math.PI / 2;
    const left  = 50 + rx * Math.cos(angle);
    const top   = 50 + ry * Math.sin(angle);

    const wrap = document.createElement('div');
    wrap.classList.add('seat-wrap');
    wrap.style.left = `${left}%`;
    wrap.style.top  = `${top}%`;

    if (player.isSB) {
      const sb = document.createElement('div');
      sb.classList.add('blind-badge', 'sb');
      sb.textContent = 'SB';
      wrap.appendChild(sb);
    }

    if (player.isBB) {
      const bb = document.createElement('div');
      bb.classList.add('blind-badge', 'bb');
      bb.textContent = 'BB';
      wrap.appendChild(bb);
    }

    const seat = document.createElement('div');
    seat.classList.add('seat');
    seat.id = `seat-${player.id}`;
    if (player.id === currentPlayerId) seat.classList.add('active-turn');
    if (player.folded) seat.classList.add('folded');

    seat.innerHTML = `
      <div class="seat-timer-bar">
        <div class="seat-timer-fill" id="timer-fill-${player.id}"></div>
      </div>
      <div class="seat-name">
        ${player.isDealer ? '<span class="dealer-btn">D</span>' : ''}
        ${player.name}${player.id === myId ? ' (You)' : ''}
      </div>
      <div class="seat-chips">${player.chips.toLocaleString()} chips</div>
      ${player.bet > 0 ? `<div class="seat-bet">Bet: ${player.bet}</div>` : ''}
      ${player.allIn  ? `<div class="seat-allin">ALL IN</div>`            : ''}
    `;

    const stack = document.createElement('div');
    stack.classList.add('seat-card-stack');
    if (player.folded) stack.style.opacity = '0.4';
    stack.innerHTML = `
      <div class="stack-card back"></div>
      <div class="stack-card front"></div>
    `;

    wrap.appendChild(seat);
    wrap.appendChild(stack);
    container.appendChild(wrap);
  });
}

function renderCommunityCards(cards) {
  const divs = document.querySelectorAll('.community-card');
  divs.forEach((div, i) => {
    if (cards[i]) {
      if (div.classList.contains('face-up')) return;
      const card = cards[i];
      const isRed  = card.suit === '♥' || card.suit === '♦';
      const isFace = ['J','Q','K'].includes(card.value);
      div.classList.add('flipping');
      setTimeout(() => {
        div.classList.remove('empty', 'flipping');
        div.classList.add('face-up');
        if (isRed) div.classList.add('red');
        div.innerHTML = isFace ? `
          <div class="card-corner">${card.value}<br>${card.suit}</div>
          <div class="face-inner"></div>
          <div class="face-letter">${card.value}</div>
          <div class="face-suit-tl">${card.suit}</div>
          <div class="face-suit-br">${card.suit}</div>
          <div class="card-corner bot">${card.value}<br>${card.suit}</div>
        ` : `
          <div class="card-corner">${card.value}<br>${card.suit}</div>
          <div class="card-center-suit">${card.suit}</div>
          <div class="card-corner bot">${card.value}<br>${card.suit}</div>
        `;
      }, 300);
    } else {
      div.className = 'community-card empty';
      div.innerHTML = '';
    }
  });
}

function renderMyCards(cards) {
  const divs = document.querySelectorAll('.my-card');
  cards.forEach((card, i) => {
    if (!divs[i] || divs[i].classList.contains('face-up')) return;
    const isRed  = card.suit === '♥' || card.suit === '♦';
    const isFace = ['J','Q','K'].includes(card.value);
    playDeal();
    divs[i].classList.add('dealing');
    setTimeout(() => {
      divs[i].classList.remove('empty', 'dealing');
      divs[i].classList.add('face-up');
      if (isRed) divs[i].classList.add('red');
      divs[i].innerHTML = isFace ? `
        <div class="card-corner">${card.value}<br>${card.suit}</div>
        <div class="face-inner"></div>
        <div class="face-letter">${card.value}</div>
        <div class="face-suit-tl">${card.suit}</div>
        <div class="face-suit-br">${card.suit}</div>
        <div class="card-corner bot">${card.value}<br>${card.suit}</div>
      ` : `
        <div class="card-corner">${card.value}<br>${card.suit}</div>
        <div class="card-center-suit">${card.suit}</div>
        <div class="card-corner bot">${card.value}<br>${card.suit}</div>
      `;
    }, i * 200 + 300);
  });
}

// ─── Banner ───────────────────────────────────────────────
function showBanner(msg, color) {
  const existing = document.getElementById('winnerBanner');
  if (existing) existing.remove();
  const banner = document.createElement('div');
  banner.id = 'winnerBanner';
  banner.innerHTML = msg;
  document.getElementById('gameScreen').appendChild(banner);
  setTimeout(() => banner.remove(), 5000);
}

// ─── Game Log ─────────────────────────────────────────────
function addLog(msg, type = 'log-action') {
  const list = document.getElementById('gameLogList');
  if (!list) return;
  const li = document.createElement('li');
  li.classList.add(type);
  li.textContent = msg;
  list.prepend(li);
  while (list.children.length > 50) list.removeChild(list.lastChild);
}

// ─── Action Buttons ───────────────────────────────────────
document.getElementById('foldBtn').addEventListener('click', () => {
  socket.emit('playerAction', { action: 'fold' });
});

document.getElementById('checkBtn').addEventListener('click', () => {
  socket.emit('playerAction', { action: 'check' });
});

document.getElementById('callBtn').addEventListener('click', () => {
  playChip();
  socket.emit('playerAction', { action: 'call' });
});

document.getElementById('raiseBtn').addEventListener('click', () => {
  const amount = parseInt(document.getElementById('raiseAmount').value);
  if (!amount || amount <= 0) { alert('Enter a valid raise amount!'); return; }
  playChip();
  socket.emit('playerAction', { action: 'raise', amount });
});

document.getElementById('allInBtn').addEventListener('click', () => {
  playChip();
  socket.emit('playerAction', { action: 'allin' });
});

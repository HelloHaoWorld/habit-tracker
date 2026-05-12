// ─── Storage ────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'habit_tracker_v1';

function loadStore() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || defaultStore();
  } catch (e) {
    return defaultStore();
  }
}

function defaultStore() {
  return {
    goals: [
      {
        id: 'school-dropoff',
        name: 'School drop-off',
        desc: 'Ethan at school by 8:45 AM',
        emoji: '🏫',
        createdAt: new Date().toISOString()
      }
    ],
    logs: {}
    // logs structure: { goalId: { 'YYYY-MM-DD': true|false } }
  };
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

let store = loadStore();

// ─── Date helpers ────────────────────────────────────────────────────────────

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

function getLogs(goalId) {
  return store.logs[goalId] || {};
}

function setLog(goalId, dateStr, value) {
  if (!store.logs[goalId]) store.logs[goalId] = {};
  store.logs[goalId][dateStr] = value;
  save();
}

// ─── Stats ────────────────────────────────────────────────────────────────────

function getStreak(goalId) {
  const logs = getLogs(goalId);
  const today = todayKey();
  let streak = 0;
  const d = new Date();
  while (true) {
    const key = dateKey(d);
    if (logs[key] === true) {
      streak++;
    } else if (logs[key] === false) {
      break;
    } else if (key === today) {
      // not yet logged today — don't break streak
    } else {
      break;
    }
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

function getBestStreak(goalId) {
  const logs = getLogs(goalId);
  const keys = Object.keys(logs).sort();
  let best = 0, cur = 0;
  for (const key of keys) {
    if (logs[key] === true) { cur++; best = Math.max(best, cur); }
    else { cur = 0; }
  }
  return best;
}

function getRate(goalId) {
  const logs = getLogs(goalId);
  const vals = Object.values(logs).filter(v => v === true || v === false);
  if (!vals.length) return null;
  return Math.round((vals.filter(v => v === true).length / vals.length) * 100);
}

function getTotalLogged(goalId) {
  const logs = getLogs(goalId);
  return Object.values(logs).filter(v => v === true || v === false).length;
}

// ─── Page routing ─────────────────────────────────────────────────────────────

let currentPage = 'today';
let chartInstance = null;

function switchPage(page, btn) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('page-' + page).classList.add('active');
  btn.classList.add('active');
  currentPage = page;

  const titles = { today: 'Today', stats: 'Stats', goals: 'Goals' };
  document.getElementById('header-title').textContent = titles[page];

  if (page === 'today') renderToday();
  if (page === 'stats') renderStatsPage();
  if (page === 'goals') renderGoalsPage();
}

// ─── Today page ───────────────────────────────────────────────────────────────

function renderToday() {
  const container = document.getElementById('goals-today-list');
  const today = todayKey();

  if (!store.goals.length) {
    container.innerHTML = `<div class="empty"><div class="empty-icon">🎯</div>No goals yet.<br>Add one in the Goals tab!</div>`;
    return;
  }

  container.innerHTML = store.goals.map(goal => {
    const logs = getLogs(goal.id);
    const todayVal = logs[today];
    const streak = getStreak(goal.id);

    const yesClass = todayVal === true ? 'log-btn success selected-yes' : 'log-btn success';
    const noClass = todayVal === false ? 'log-btn fail selected-no' : 'log-btn fail';

    return `
      <div class="goal-card">
        <div class="goal-card-header">
          <div>
            <div class="goal-name">${goal.emoji} ${goal.name}</div>
            <div class="goal-desc">${goal.desc}</div>
          </div>
          <div class="streak-badge">🔥 ${streak}</div>
        </div>
        <div class="log-buttons">
          <button class="${yesClass}" onclick="log('${goal.id}', true)">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
            Made it!
          </button>
          <button class="${noClass}" onclick="log('${goal.id}', false)">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            Missed it
          </button>
        </div>
        ${todayVal !== undefined ? `<p style="font-size:12px; color:var(--gray-400); text-align:center; margin-top:10px;">Logged today — tap to change</p>` : ''}
      </div>`;
  }).join('');
}

function log(goalId, value) {
  setLog(goalId, todayKey(), value);
  renderToday();
  // if stats page open, refresh it too
  if (currentPage === 'stats') renderStats();
}

// ─── Stats page ───────────────────────────────────────────────────────────────

function renderStatsPage() {
  const select = document.getElementById('stats-goal-select');
  select.innerHTML = store.goals.map(g =>
    `<option value="${g.id}">${g.emoji} ${g.name}</option>`
  ).join('');
  renderStats();
}

function renderStats() {
  const goalId = document.getElementById('stats-goal-select').value;
  if (!goalId) return;

  const streak = getStreak(goalId);
  const rate = getRate(goalId);
  const best = getBestStreak(goalId);
  const total = getTotalLogged(goalId);

  document.getElementById('s-streak').textContent = streak;
  document.getElementById('s-rate').textContent = rate !== null ? rate + '%' : '—';
  document.getElementById('s-best').textContent = best;
  document.getElementById('s-total').textContent = total;

  renderHeatmap(goalId);
  renderBarChart(goalId);
}

function renderHeatmap(goalId) {
  const logs = getLogs(goalId);
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const today = todayKey();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDay = new Date(year, month, 1).getDay(); // 0=Sun

  const labelsEl = document.getElementById('stats-heatmap-labels');
  const gridEl = document.getElementById('stats-heatmap');

  labelsEl.innerHTML = ['Su','Mo','Tu','We','Th','Fr','Sa']
    .map(d => `<div class="heatmap-day-label">${d}</div>`).join('');

  let cells = '';
  // empty cells before first day
  for (let i = 0; i < firstDay; i++) {
    cells += `<div class="heatmap-cell empty"></div>`;
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const val = logs[key];
    const isToday = key === today;
    let cls = 'heatmap-cell';
    if (val === true) cls += ' hit';
    else if (val === false) cls += ' miss';
    if (isToday) cls += ' today';
    cells += `<div class="${cls}">${d}</div>`;
  }
  gridEl.innerHTML = cells;
}

function renderBarChart(goalId) {
  const logs = getLogs(goalId);
  const now = new Date();
  const labels = [];
  const hits = [];
  const misses = [];

  for (let w = 7; w >= 0; w--) {
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay() - w * 7 + 1); // Monday
    let wHit = 0, wMiss = 0;
    for (let d = 0; d < 5; d++) {
      const day = new Date(weekStart);
      day.setDate(weekStart.getDate() + d);
      const key = dateKey(day);
      if (logs[key] === true) wHit++;
      else if (logs[key] === false) wMiss++;
    }
    const label = weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    labels.push(label);
    hits.push(wHit);
    misses.push(wMiss);
  }

  const ctx = document.getElementById('bar-chart').getContext('2d');
  if (chartInstance) chartInstance.destroy();

  chartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'On time',
          data: hits,
          backgroundColor: '#1D9E75',
          borderRadius: 4,
          borderSkipped: false
        },
        {
          label: 'Missed',
          data: misses,
          backgroundColor: '#D85A30',
          borderRadius: 4,
          borderSkipped: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: { font: { size: 11 }, boxWidth: 10, padding: 10 }
        }
      },
      scales: {
        x: {
          stacked: true,
          grid: { display: false },
          ticks: { font: { size: 10 }, maxRotation: 45 }
        },
        y: {
          stacked: true,
          beginAtZero: true,
          max: 5,
          ticks: { stepSize: 1, font: { size: 11 } },
          grid: { color: 'rgba(0,0,0,0.05)' }
        }
      }
    }
  });
}

// ─── Goals management page ────────────────────────────────────────────────────

function renderGoalsPage() {
  const list = document.getElementById('goals-list');
  if (!store.goals.length) {
    list.innerHTML = `<div class="empty"><div class="empty-icon">🎯</div>No goals yet. Add your first!</div>`;
    return;
  }
  list.innerHTML = store.goals.map((g, i) => `
    <div class="goal-item">
      <div class="goal-icon">${g.emoji}</div>
      <div class="goal-info">
        <div class="goal-item-name">${g.name}</div>
        <div class="goal-item-desc">${g.desc}</div>
      </div>
      <button onclick="deleteGoal('${g.id}')" style="background:none;border:none;cursor:pointer;color:var(--gray-400);padding:6px;" aria-label="Delete goal">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
      </button>
    </div>
  `).join('');
}

function deleteGoal(id) {
  if (!confirm('Delete this goal and all its data?')) return;
  store.goals = store.goals.filter(g => g.id !== id);
  delete store.logs[id];
  save();
  renderGoalsPage();
}

// ─── Add Goal Modal ───────────────────────────────────────────────────────────

function openAddGoal() {
  document.getElementById('input-name').value = '';
  document.getElementById('input-desc').value = '';
  document.getElementById('input-emoji').value = '🎯';
  document.getElementById('modal-overlay').classList.add('open');
  setTimeout(() => document.getElementById('input-name').focus(), 100);
}

function closeModal(event) {
  if (event.target === document.getElementById('modal-overlay')) {
    closeModalDirect();
  }
}

function closeModalDirect() {
  document.getElementById('modal-overlay').classList.remove('open');
}

function saveGoal() {
  const name = document.getElementById('input-name').value.trim();
  const desc = document.getElementById('input-desc').value.trim();
  const emoji = document.getElementById('input-emoji').value.trim() || '🎯';

  if (!name) {
    document.getElementById('input-name').focus();
    return;
  }

  const id = 'goal-' + Date.now();
  store.goals.push({ id, name, desc, emoji, createdAt: new Date().toISOString() });
  save();
  closeModalDirect();
  renderGoalsPage();
}

// ─── Init ─────────────────────────────────────────────────────────────────────

function init() {
  // Set date in header
  const dateStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric'
  });
  document.getElementById('header-date').textContent = dateStr;

  renderToday();

  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();

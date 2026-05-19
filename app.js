// ─── Supabase setup ───────────────────────────────────────────────────────────

const SUPABASE_URL = 'https://xrbzivRjpjowvykzlhhd.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhyYnppdnJqcGpvd3Z5a3psaGhkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2MTc1NTIsImV4cCI6MjA5NDE5MzU1Mn0.CKkKdCSkyjsSu4hzejKi3HgZxwsQyVys5tg133cfacI';

const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── State ────────────────────────────────────────────────────────────────────

let currentUser = null;
let goals = [];
let logs = {};       // { goalId: { 'YYYY-MM-DD': { success, logged_by } } }
let chartInstance = null;
let currentPage = 'today';
let selectedGoalId = null;
let insightsCache = null; // { text: string, timestamp: Date }
let subscribed = false;

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function signInWithGoogle() {
  await db.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: 'https://habit-tracker-kappa-one-70.vercel.app' }
  });
}

async function signOut() {
  if (!confirm('Sign out?')) return;
  await db.auth.signOut();
  location.reload();
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

// ─── Data loading ─────────────────────────────────────────────────────────────

async function loadGoals() {
  const { data, error } = await db.from('goals').select('*').order('created_at');
  if (error) { console.error(error); return; }

  // Seed default goal if none exist
  if (!data.length) {
    await db.from('goals').insert({
      id: 'school-dropoff',
      name: 'School drop-off',
      description: 'Ethan at school by 8:45 AM',
      emoji: '🏫'
    });
    return loadGoals();
  }
  goals = data;
}

async function loadLogs() {
  const { data, error } = await db.from('logs').select('*');
  if (error) { console.error(error); return; }

  logs = {};
  for (const row of data) {
    if (!logs[row.goal_id]) logs[row.goal_id] = {};
    logs[row.goal_id][row.date] = { success: row.success, logged_by: row.logged_by };
  }
}

// ─── Logging ──────────────────────────────────────────────────────────────────

async function log(goalId, value) {
  const date = todayKey();
  const name = currentUser?.user_metadata?.name || currentUser?.email || 'Unknown';

  // Disable buttons while saving
  document.querySelectorAll('.log-btn').forEach(b => b.disabled = true);

  const { error } = await db.from('logs').upsert(
    { goal_id: goalId, date, success: value, logged_by: name, updated_at: new Date().toISOString() },
    { onConflict: 'goal_id,date' }
  );

  if (error) {
    console.error(error);
    alert('Failed to save. Please try again.');
  } else {
    if (!logs[goalId]) logs[goalId] = {};
    logs[goalId][date] = { success: value, logged_by: name };
  }

  document.querySelectorAll('.log-btn').forEach(b => b.disabled = false);
  renderToday();
}

// ─── Stats helpers ────────────────────────────────────────────────────────────

function getGoalLogs(goalId) {
  return logs[goalId] || {};
}

function getStreak(goalId) {
  const gl = getGoalLogs(goalId);
  const today = todayKey();
  let streak = 0;
  const d = new Date();
  while (true) {
    const key = dateKey(d);
    const entry = gl[key];
    if (entry?.success === true) { streak++; }
    else if (entry?.success === false) { break; }
    else if (key === today) { /* not logged yet, don't break */ }
    else { break; }
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

function getBestStreak(goalId) {
  const gl = getGoalLogs(goalId);
  const keys = Object.keys(gl).sort();
  let best = 0, cur = 0;
  for (const key of keys) {
    if (gl[key]?.success === true) { cur++; best = Math.max(best, cur); }
    else { cur = 0; }
  }
  return best;
}

function getRate(goalId) {
  const gl = getGoalLogs(goalId);
  const vals = Object.values(gl).filter(v => v.success === true || v.success === false);
  if (!vals.length) return null;
  return Math.round((vals.filter(v => v.success === true).length / vals.length) * 100);
}

function getTotalLogged(goalId) {
  const gl = getGoalLogs(goalId);
  return Object.values(gl).filter(v => v.success === true || v.success === false).length;
}

// ─── Page routing ─────────────────────────────────────────────────────────────

function switchPage(page, btn) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('page-' + page).classList.add('active');
  btn.classList.add('active');
  currentPage = page;
  const titles = { today: 'Today', stats: 'Stats', goals: 'Goals', insights: 'Insights' };
  document.getElementById('header-title').textContent = titles[page];
  if (page === 'today') renderToday();
  if (page === 'stats') renderStatsPage();
  if (page === 'goals') renderGoalsPage();
  if (page === 'insights') renderInsightsPage();
}

// ─── Today page ───────────────────────────────────────────────────────────────

function renderToday() {
  const container = document.getElementById('goals-today-list');
  const today = todayKey();

  if (!goals.length) {
    container.innerHTML = `<div class="empty"><div class="empty-icon">🎯</div>No goals yet.<br>Add one in the Goals tab!</div>`;
    return;
  }

  container.innerHTML = goals.map(goal => {
    const gl = getGoalLogs(goal.id);
    const entry = gl[today];
    const todayVal = entry?.success;
    const loggedBy = entry?.logged_by;
    const streak = getStreak(goal.id);
    const yesClass = todayVal === true ? 'log-btn success selected-yes' : 'log-btn success';
    const noClass  = todayVal === false ? 'log-btn fail selected-no' : 'log-btn fail';

    return `
      <div class="goal-card">
        <div class="goal-card-header">
          <div>
            <div class="goal-name">${goal.emoji} ${goal.name}</div>
            <div class="goal-desc">${goal.description || ''}</div>
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
        ${entry !== undefined ? `<div class="logged-by">Logged by ${loggedBy} · tap to change</div>` : ''}
      </div>`;
  }).join('');
}

// ─── Stats page ───────────────────────────────────────────────────────────────

function renderStatsPage() {
  const select = document.getElementById('stats-goal-select');
  select.innerHTML = goals.map(g => `<option value="${g.id}">${g.emoji} ${g.name}</option>`).join('');
  if (selectedGoalId && goals.find(g => g.id === selectedGoalId)) {
    select.value = selectedGoalId;
  }
  renderStats();
}

function renderStats() {
  const goalId = document.getElementById('stats-goal-select').value;
  if (!goalId) return;
  selectedGoalId = goalId;
  document.getElementById('s-streak').textContent = getStreak(goalId);
  const rate = getRate(goalId);
  document.getElementById('s-rate').textContent = rate !== null ? rate + '%' : '—';
  document.getElementById('s-best').textContent = getBestStreak(goalId);
  document.getElementById('s-total').textContent = getTotalLogged(goalId);
  renderHeatmap(goalId);
  renderBarChart(goalId);
}

function renderHeatmap(goalId) {
  const gl = getGoalLogs(goalId);
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const today = todayKey();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDay = new Date(year, month, 1).getDay();

  document.getElementById('stats-heatmap-labels').innerHTML =
    ['Su','Mo','Tu','We','Th','Fr','Sa'].map(d => `<div class="heatmap-day-label">${d}</div>`).join('');

  let cells = '';
  for (let i = 0; i < firstDay; i++) cells += `<div class="heatmap-cell empty"></div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const entry = gl[key];
    const isToday = key === today;
    let cls = 'heatmap-cell';
    if (entry?.success === true) cls += ' hit';
    else if (entry?.success === false) cls += ' miss';
    if (isToday) cls += ' today';
    cells += `<div class="${cls}" title="${key}">${d}</div>`;
  }
  document.getElementById('stats-heatmap').innerHTML = cells;
}

function renderBarChart(goalId) {
  const gl = getGoalLogs(goalId);
  const now = new Date();
  const labels = [], hits = [], misses = [];

  for (let w = 7; w >= 0; w--) {
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay() - w * 7 + 1);
    let wHit = 0, wMiss = 0;
    for (let d = 0; d < 5; d++) {
      const day = new Date(weekStart);
      day.setDate(weekStart.getDate() + d);
      const key = dateKey(day);
      if (gl[key]?.success === true) wHit++;
      else if (gl[key]?.success === false) wMiss++;
    }
    labels.push(weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
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
        { label: 'On time', data: hits, backgroundColor: '#1D9E75', borderRadius: 4, borderSkipped: false },
        { label: 'Missed', data: misses, backgroundColor: '#D85A30', borderRadius: 4, borderSkipped: false }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { font: { size: 11 }, boxWidth: 10, padding: 10 } } },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 45 } },
        y: { stacked: true, beginAtZero: true, max: 5, ticks: { stepSize: 1, font: { size: 11 } }, grid: { color: 'rgba(0,0,0,0.05)' } }
      }
    }
  });
}

// ─── Goals page ───────────────────────────────────────────────────────────────

function renderGoalsPage() {
  const list = document.getElementById('goals-list');
  if (!goals.length) {
    list.innerHTML = `<div class="empty"><div class="empty-icon">🎯</div>No goals yet. Add your first!</div>`;
    return;
  }
  list.innerHTML = goals.map(g => `
    <div class="goal-item">
      <div class="goal-icon">${g.emoji}</div>
      <div class="goal-info">
        <div class="goal-item-name">${g.name}</div>
        <div class="goal-item-desc">${g.description || ''}</div>
      </div>
      <button onclick="deleteGoal('${g.id}')" style="background:none;border:none;cursor:pointer;color:var(--gray-400);padding:6px;">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
      </button>
    </div>`).join('');
}

async function deleteGoal(id) {
  if (!confirm('Delete this goal and all its data?')) return;
  await db.from('goals').delete().eq('id', id);
  goals = goals.filter(g => g.id !== id);
  delete logs[id];
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
  if (event.target === document.getElementById('modal-overlay')) closeModalDirect();
}

function closeModalDirect() {
  document.getElementById('modal-overlay').classList.remove('open');
}

async function saveGoal() {
  const name = document.getElementById('input-name').value.trim();
  const description = document.getElementById('input-desc').value.trim();
  const emoji = document.getElementById('input-emoji').value.trim() || '🎯';
  if (!name) { document.getElementById('input-name').focus(); return; }

  const id = 'goal-' + Date.now();
  const { error } = await db.from('goals').insert({ id, name, description, emoji });
  if (error) { alert('Failed to save goal.'); return; }

  goals.push({ id, name, description, emoji });
  closeModalDirect();
  renderGoalsPage();
}

// ─── Insights page ────────────────────────────────────────────────────────────

function renderInsightsPage() {
  const empty = document.getElementById('insights-empty');
  const loading = document.getElementById('insights-loading');
  const result = document.getElementById('insights-result');
  if (insightsCache) {
    empty.style.display = 'none';
    loading.style.display = 'none';
    result.style.display = 'block';
    document.getElementById('insights-content').innerHTML = renderMarkdown(insightsCache.text);
    document.getElementById('insights-timestamp').textContent =
      `Generated ${insightsCache.timestamp.toLocaleTimeString()}`;
  } else {
    empty.style.display = 'block';
    loading.style.display = 'none';
    result.style.display = 'none';
  }
}

function prepareInsightsData() {
  return goals.map(g => {
    const gl = getGoalLogs(g.id);
    const recent30Days = [];
    for (let i = 0; i < 30; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = dateKey(d);
      const entry = gl[key];
      recent30Days.push({
        date: key,
        result: entry?.success === true ? 'hit' : entry?.success === false ? 'miss' : 'not logged'
      });
    }
    return {
      name: g.name,
      emoji: g.emoji,
      description: g.description || '',
      streak: getStreak(g.id),
      bestStreak: getBestStreak(g.id),
      successRate: getRate(g.id),
      totalLogged: getTotalLogged(g.id),
      recent30Days
    };
  });
}

function renderMarkdown(text) {
  return text
    .split(/\n{2,}/)
    .map(para => {
      para = para.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      para = para.replace(/\*([^*]+)\*/g, '<em>$1</em>');
      para = para.replace(/\n/g, '<br>');
      return `<p>${para}</p>`;
    })
    .join('');
}

async function generateInsights() {
  if (!goals.length) return;

  document.getElementById('insights-empty').style.display = 'none';
  document.getElementById('insights-loading').style.display = 'block';
  document.getElementById('insights-result').style.display = 'none';

  let fullText = '';

  try {
    const res = await fetch('/api/insights', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goals: prepareInsightsData() })
    });

    if (!res.ok) throw new Error('Request failed');

    document.getElementById('insights-loading').style.display = 'none';
    document.getElementById('insights-result').style.display = 'block';
    const contentEl = document.getElementById('insights-content');
    contentEl.innerHTML = '';

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) throw new Error(parsed.error);
          if (parsed.text) {
            fullText += parsed.text;
            contentEl.innerHTML = fullText.replace(/\n/g, '<br>');
          }
        } catch (e) {
          if (!(e instanceof SyntaxError)) throw e;
        }
      }
    }

    contentEl.innerHTML = renderMarkdown(fullText);
    insightsCache = { text: fullText, timestamp: new Date() };
    document.getElementById('insights-timestamp').textContent =
      `Generated ${insightsCache.timestamp.toLocaleTimeString()}`;

  } catch (err) {
    document.getElementById('insights-loading').style.display = 'none';
    document.getElementById('insights-result').style.display = 'block';
    document.getElementById('insights-content').innerHTML =
      `<div class="insights-error">Could not load insights. Please try again.</div>`;
  }
}

// ─── Real-time sync ───────────────────────────────────────────────────────────

function subscribeToLogs() {
  if (db.getChannels().some(c => c.topic === 'realtime:logs-changes')) return;
  db.channel('logs-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'logs' }, payload => {
      const row = payload.new || payload.old;
      if (!row) return;
      if (payload.eventType === 'DELETE') {
        if (logs[row.goal_id]) delete logs[row.goal_id][row.date];
      } else {
        if (!logs[row.goal_id]) logs[row.goal_id] = {};
        logs[row.goal_id][row.date] = { success: row.success, logged_by: row.logged_by };
      }
      if (currentPage === 'today') renderToday();
      if (currentPage === 'stats') renderStats();
    })
    .subscribe();
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  const { data: { session } } = await db.auth.getSession();

  if (!session) {
    document.getElementById('login-screen').style.display = 'flex';
    return;
  }

  currentUser = session.user;

  // Show app
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'block';

  // Set avatar initials
  const name = currentUser?.user_metadata?.name || currentUser?.email || '?';
  document.getElementById('avatar-btn').textContent = name.charAt(0).toUpperCase();
  document.getElementById('avatar-btn').title = `Signed in as ${name} · Tap to sign out`;

  // Set date
  document.getElementById('header-date').textContent = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric'
  });

  // Load data
  await loadGoals();
  await loadLogs();

  // Subscribe to real-time changes (so Yi Lin's logs appear instantly)
  subscribeToLogs();

  renderToday();

  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

// Handle auth redirect back from Google
db.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_IN' && session && !currentUser) {
    init();
  }
});

init();
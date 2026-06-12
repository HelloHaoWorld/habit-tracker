// ─── Supabase setup ───────────────────────────────────────────────────────────

const SUPABASE_URL = 'https://xrbzivRjpjowvykzlhhd.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhyYnppdnJqcGpvd3Z5a3psaGhkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2MTc1NTIsImV4cCI6MjA5NDE5MzU1Mn0.CKkKdCSkyjsSu4hzejKi3HgZxwsQyVys5tg133cfacI';

const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── State ────────────────────────────────────────────────────────────────────

let currentUser = null;
let userProfile = null;
let goals = [];
let logs = {};       // { goalId: { 'YYYY-MM-DD': { success, logged_by } } }
let chartInstance = null;
let currentPage = 'today';
let selectedGoalId = null;
let habitPickerOpen = false;
let insightsCache = {}; // keyed by goalId or 'all'
let subscribed = false;

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function signInWithGoogle() {
  await db.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: 'https://habit-tracker-kappa-one-70.vercel.app' }
  });
}

function signOut() {
  showConfirm('Sign out?', async () => {
    await db.auth.signOut();
    location.reload();
  }, { confirmLabel: 'Sign out' });
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function todayKey() {
  return dateKey(new Date());
}

function dateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isApplicableDay(goal, dateStr) {
  const schedule = goal?.schedule || 'daily';
  if (schedule === 'daily') return true;
  const day = new Date(dateStr + 'T12:00:00').getDay();
  if (schedule === 'weekdays') return day >= 1 && day <= 5;
  if (schedule === 'weekends') return day === 0 || day === 6;
  if (schedule.startsWith('custom:')) {
    return schedule.slice(7).split(',').map(Number).includes(day);
  }
  return true;
}

function schedulePickerHTML(current = 'daily') {
  const isCustom = current?.startsWith('custom:');
  const active = isCustom ? 'custom' : (current || 'daily');
  const customDays = isCustom ? current.slice(7).split(',').map(Number) : [];
  const days = ['Su','Mo','Tu','We','Th','Fr','Sa'];
  return `
    <div class="schedule-toggle">
      <button type="button" class="schedule-btn${active==='daily'?' active':''}" id="sched-daily" onclick="setSchedule('daily')">Daily</button>
      <button type="button" class="schedule-btn${active==='weekdays'?' active':''}" id="sched-weekdays" onclick="setSchedule('weekdays')">Weekdays</button>
      <button type="button" class="schedule-btn${active==='weekends'?' active':''}" id="sched-weekends" onclick="setSchedule('weekends')">Weekends</button>
      <button type="button" class="schedule-btn${active==='custom'?' active':''}" id="sched-custom" onclick="setSchedule('custom')">Custom</button>
    </div>
    <div class="day-picker" id="day-picker" style="display:${active==='custom'?'flex':'none'}">
      ${days.map((d,i) => `<button type="button" class="day-btn${customDays.includes(i)?' active':''}" data-day="${i}" onclick="toggleDay(this)">${d}</button>`).join('')}
    </div>`;
}

// ─── Data loading ─────────────────────────────────────────────────────────────

async function loadGoals() {
  const { data, error } = await db.from('goals').select('*').order('created_at');
  if (error) { console.error(error); return; }
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

async function loadProfile() {
  const { data, error } = await db.from('profiles').select('*').eq('user_id', currentUser.id).single();
  if (error && error.code !== 'PGRST116') { console.error(error); return; }

  if (data) {
    userProfile = data;
  } else {
    const defaultName = currentUser?.user_metadata?.name || currentUser?.email?.split('@')[0] || '';
    if (defaultName) {
      const { data: created } = await db.from('profiles').insert({ user_id: currentUser.id, display_name: defaultName }).select().single();
      userProfile = created;
    }
  }
}

// ─── Logging ──────────────────────────────────────────────────────────────────

async function log(goalId, value) {
  const date = todayKey();
  const name = currentUser?.user_metadata?.name || currentUser?.email || 'Unknown';

  // Disable buttons while saving
  document.querySelectorAll('.log-btn').forEach(b => b.disabled = true);

  const { error } = await db.from('logs').upsert(
    { goal_id: goalId, date, success: value, logged_by: name, user_id: currentUser.id, updated_at: new Date().toISOString() },
    { onConflict: 'goal_id,date' }
  );

  if (error) {
    console.error(error);
    showAlert('Failed to save. Please try again.');
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
  const goal = goals.find(g => g.id === goalId);
  const gl = getGoalLogs(goalId);
  const today = todayKey();
  let streak = 0;
  const d = new Date();
  while (true) {
    const key = dateKey(d);
    if (!isApplicableDay(goal, key)) { d.setDate(d.getDate() - 1); continue; }
    const entry = gl[key];
    if (entry?.success === true) { streak++; }
    else if (entry?.success === false) { break; }
    else if (key === today) { /* not logged yet today */ }
    else { break; }
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

function getBestStreak(goalId) {
  const goal = goals.find(g => g.id === goalId);
  const gl = getGoalLogs(goalId);
  const keys = Object.keys(gl).filter(k => isApplicableDay(goal, k)).sort();
  let best = 0, cur = 0;
  for (const key of keys) {
    if (gl[key]?.success === true) { cur++; best = Math.max(best, cur); }
    else { cur = 0; }
  }
  return best;
}

function getRate(goalId) {
  const goal = goals.find(g => g.id === goalId);
  const gl = getGoalLogs(goalId);
  const applicable = Object.entries(gl).filter(([k, v]) =>
    isApplicableDay(goal, k) && (v.success === true || v.success === false)
  );
  if (!applicable.length) return null;
  return Math.round((applicable.filter(([, v]) => v.success === true).length / applicable.length) * 100);
}

function getTotalLogged(goalId) {
  const goal = goals.find(g => g.id === goalId);
  const gl = getGoalLogs(goalId);
  return Object.entries(gl).filter(([k, v]) =>
    isApplicableDay(goal, k) && (v.success === true || v.success === false)
  ).length;
}

// ─── Page routing ─────────────────────────────────────────────────────────────

function switchPage(page, btn) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('page-' + page).classList.add('active');
  btn.classList.add('active');
  currentPage = page;
  const titles = { today: 'Today', stats: 'Habits', meals: 'Meals' };
  document.getElementById('header-title').textContent = titles[page];
  if (page === 'today') renderToday();
  if (page === 'stats') renderStatsPage();
  if (page === 'meals') renderMealsPage();
}

// ─── Today page ───────────────────────────────────────────────────────────────

function renderToday() {
  const container = document.getElementById('goals-today-list');
  const today = todayKey();
  const applicableGoals = goals.filter(goal => isApplicableDay(goal, today));

  if (!goals.length) {
    container.innerHTML = `<div class="empty"><div class="empty-icon">🎯</div>No habits yet.<br>Add one in the Habits tab!</div>`;
    return;
  }
  if (!applicableGoals.length) {
    container.innerHTML = `<div class="empty"><div class="empty-icon">🎉</div>No habits today.<br>Enjoy your weekend!</div>`;
    return;
  }

  container.innerHTML = applicableGoals.map(goal => {
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

function renderHabitPicker() {
  if (!selectedGoalId && goals.length) selectedGoalId = goals[0].id;
  const goal = goals.find(g => g.id === selectedGoalId);
  const chevron = `<svg viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2.5" width="20" height="20" style="flex-shrink:0;transition:transform 0.2s;transform:rotate(${habitPickerOpen ? 180 : 0}deg)"><polyline points="6 9 12 15 18 9"/></svg>`;
  const dropdown = habitPickerOpen ? `
    <div class="goal-picker-dropdown">
      ${goals.map(g => `
        <div class="goal-picker-row${g.id === selectedGoalId ? ' active' : ''}" onclick="selectHabit('${g.id}')">
          <span class="goal-picker-label">${g.emoji} ${g.name}</span>
          <button class="goal-picker-edit" onclick="openEditHabit(event,'${g.id}')" title="Edit">✏️</button>
          <button class="goal-picker-delete" onclick="deleteHabitFromStats(event,'${g.id}')" title="Delete">−</button>
        </div>`).join('')}
      <div class="goal-picker-row goal-picker-add" onclick="openAddHabit()">
        <span class="goal-picker-label">+ New habit</span>
      </div>
    </div>` : '';
  document.getElementById('stats-goal-list').innerHTML = `
    <button class="goal-picker-trigger" onclick="toggleHabitPicker()">
      <div class="goal-picker-trigger-inner">
        <div class="goal-picker-trigger-label">Current habit</div>
        <div class="goal-picker-trigger-name">${goal ? `${goal.emoji} ${goal.name}` : 'Select a habit'}</div>
      </div>
      ${chevron}
    </button>
    ${dropdown}`;
}

function renderStatsPage() {
  renderHabitPicker();
  renderStats();
}

function toggleHabitPicker() {
  habitPickerOpen = !habitPickerOpen;
  renderHabitPicker();
}

function openAddHabit() {
  habitPickerOpen = false;
  renderHabitPicker();
  openAddGoal();
}

function selectHabit(goalId) {
  selectedGoalId = goalId;
  habitPickerOpen = false;
  renderStatsPage();
}

function deleteHabitFromStats(event, id) {
  event.stopPropagation();
  const goal = goals.find(g => g.id === id);
  showConfirm(`Delete "${goal?.name || 'this habit'}" and all its logged data? This cannot be undone.`, async () => {
    habitPickerOpen = false;
    await db.from('logs').delete().eq('goal_id', id);
    await db.from('goals').delete().eq('id', id);
    goals = goals.filter(g => g.id !== id);
    delete logs[id];
    delete insightsCache[id];
    if (selectedGoalId === id) selectedGoalId = goals[0]?.id ?? null;
    renderStatsPage();
  }, { danger: true, confirmLabel: 'Delete' });
}

function openEditHabit(event, id) {
  event.stopPropagation();
  habitPickerOpen = false;
  const g = goals.find(goal => goal.id === id);
  if (!g) return;
  const overlay = document.getElementById('modal-overlay');
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-title">Edit habit</div>
      <div class="form-group"><label class="form-label">Goal name</label><input class="form-input" id="input-name" type="text" value="${g.name}" maxlength="40"/></div>
      <div class="form-group"><label class="form-label">Description</label><input class="form-input" id="input-desc" type="text" value="${g.description || ''}" maxlength="60"/></div>
      <div class="form-group"><label class="form-label">Icon (emoji)</label><input class="form-input" id="input-emoji" type="text" value="${g.emoji}" maxlength="4" style="font-size:22px;text-align:center;"/></div>
      <div class="form-group"><label class="form-label">Schedule</label>${schedulePickerHTML(g.schedule)}</div>
      <div class="modal-actions">
        <button class="btn-secondary" onclick="closeModalDirect()">Cancel</button>
        <button class="btn-primary" onclick="saveEditGoal('${id}')">Save changes</button>
      </div>
    </div>`;
  overlay.classList.add('open');
  setTimeout(() => document.getElementById('input-name').focus(), 50);
}

async function saveEditGoal(id) {
  const name = document.getElementById('input-name').value.trim();
  const description = document.getElementById('input-desc').value.trim();
  const emoji = document.getElementById('input-emoji').value.trim() || '🎯';
  const schedule = getScheduleValue();
  if (!name) { document.getElementById('input-name').focus(); return; }

  const { error } = await db.from('goals').update({ name, description, emoji, schedule }).eq('id', id);
  if (error) { showAlert('Failed to save changes.'); return; }

  const goal = goals.find(g => g.id === id);
  if (goal) Object.assign(goal, { name, description, emoji, schedule });
  closeModalDirect();
  renderStatsPage();
  renderToday();
}

function renderStats() {
  if (!selectedGoalId) return;
  const goalId = selectedGoalId;
  const goal = goals.find(g => g.id === goalId);
  document.getElementById('header-title').textContent = goal ? `${goal.emoji} ${goal.name}` : 'Stats';
  document.getElementById('s-streak').textContent = getStreak(goalId);
  const rate = getRate(goalId);
  document.getElementById('s-rate').textContent = rate !== null ? rate + '%' : '—';
  document.getElementById('s-best').textContent = getBestStreak(goalId);
  document.getElementById('s-total').textContent = getTotalLogged(goalId);
  renderHeatmap(goalId);
  renderBarChart(goalId);
  renderStatsInsights();
}

function renderHeatmap(goalId) {
  const goal = goals.find(g => g.id === goalId);
  const gl = getGoalLogs(goalId);
  const today = todayKey();
  const hasSchedule = goal?.schedule && goal.schedule !== 'daily';

  document.getElementById('stats-heatmap-labels').innerHTML =
    ['Su','Mo','Tu','We','Th','Fr','Sa'].map(d => `<div class="heatmap-day-label">${d}</div>`).join('');
  document.getElementById('legend-skip').style.display = hasSchedule ? 'flex' : 'none';

  // Offset so first cell aligns to its correct day-of-week column
  const firstDate = new Date();
  firstDate.setDate(firstDate.getDate() - 29);
  const offset = firstDate.getDay(); // 0=Su … 6=Sa

  let cells = '';
  for (let j = 0; j < offset; j++) cells += `<div class="heatmap-cell empty"></div>`;

  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = dateKey(d);
    const applicable = isApplicableDay(goal, key);
    const entry = gl[key];
    const isToday = key === today;
    let cls = 'heatmap-cell';
    if (!applicable) cls += ' skip';
    else if (entry?.success === true) cls += ' hit';
    else if (entry?.success === false) cls += ' miss';
    if (isToday) cls += ' today';
    cells += `<div class="${cls}" title="${applicable ? key : 'Weekend'}">${d.getDate()}</div>`;
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

function deleteGoal(id) {
  showConfirm('Delete this goal and all its data?', async () => {
    await db.from('goals').delete().eq('id', id);
    goals = goals.filter(g => g.id !== id);
    delete logs[id];
    renderGoalsPage();
  }, { danger: true, confirmLabel: 'Delete' });
}

// ─── Add Goal Modal ───────────────────────────────────────────────────────────

function setSchedule(value) {
  ['daily','weekdays','weekends','custom'].forEach(v =>
    document.getElementById(`sched-${v}`)?.classList.toggle('active', v === value)
  );
  const dp = document.getElementById('day-picker');
  if (dp) dp.style.display = value === 'custom' ? 'flex' : 'none';
}

function toggleDay(btn) { btn.classList.toggle('active'); }

function getScheduleValue() {
  const active = ['daily','weekdays','weekends','custom'].find(v =>
    document.getElementById(`sched-${v}`)?.classList.contains('active')
  ) || 'daily';
  if (active !== 'custom') return active;
  const days = [...document.querySelectorAll('.day-btn.active')].map(b => b.dataset.day);
  return days.length ? `custom:${days.join(',')}` : 'daily';
}

function openAddGoal() {
  document.getElementById('input-name').value = '';
  document.getElementById('input-desc').value = '';
  document.getElementById('input-emoji').value = '🎯';
  setSchedule('daily');
  document.getElementById('modal-overlay').classList.add('open');
  setTimeout(() => document.getElementById('input-name').focus(), 100);
}

function closeModal(event) {
  if (event.target === document.getElementById('modal-overlay')) closeMealModal();
}

function closeModalDirect() {
  closeMealModal();
}

async function saveGoal() {
  const name = document.getElementById('input-name').value.trim();
  const description = document.getElementById('input-desc').value.trim();
  const emoji = document.getElementById('input-emoji').value.trim() || '🎯';
  const schedule = getScheduleValue();
  if (!name) { document.getElementById('input-name').focus(); return; }

  const id = 'goal-' + Date.now();
  const { error } = await db.from('goals').insert({ id, name, description, emoji, schedule, user_id: currentUser.id });
  if (error) { alert('Failed to save goal.'); return; }

  goals.push({ id, name, description, emoji, schedule });
  selectedGoalId = id;
  closeModalDirect();
  renderStatsPage();
}

// ─── Insights (in Stats tab) ──────────────────────────────────────────────────

function prepareInsightsData(goalId = null) {
  const targets = goalId ? goals.filter(g => g.id === goalId) : goals;
  return targets.map(g => {
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

function renderStatsInsights() {
  const cached = insightsCache[selectedGoalId];
  const empty = document.getElementById('stats-insights-empty');
  const loading = document.getElementById('stats-insights-loading');
  const result = document.getElementById('stats-insights-result');
  if (cached) {
    empty.style.display = 'none';
    loading.style.display = 'none';
    result.style.display = 'block';
    document.getElementById('stats-insights-content').innerHTML = renderMarkdown(cached.text);
    document.getElementById('stats-insights-timestamp').textContent = `Generated ${cached.timestamp.toLocaleTimeString()}`;
  } else {
    empty.style.display = 'block';
    loading.style.display = 'none';
    result.style.display = 'none';
  }
}

async function generateInsights(mode) {
  if (!goals.length) return;
  const cacheKey = mode === 'goal' ? selectedGoalId : 'all';
  const goalsData = mode === 'goal' ? prepareInsightsData(selectedGoalId) : prepareInsightsData();

  document.getElementById('stats-insights-empty').style.display = 'none';
  document.getElementById('stats-insights-loading').style.display = 'block';
  document.getElementById('stats-insights-result').style.display = 'none';

  let fullText = '';

  try {
    const res = await fetch('/api/insights', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goals: goalsData })
    });

    if (!res.ok) throw new Error('Request failed');

    document.getElementById('stats-insights-loading').style.display = 'none';
    document.getElementById('stats-insights-result').style.display = 'block';
    const contentEl = document.getElementById('stats-insights-content');
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
    insightsCache[cacheKey] = { text: fullText, timestamp: new Date() };
    document.getElementById('stats-insights-timestamp').textContent =
      `Generated ${insightsCache[cacheKey].timestamp.toLocaleTimeString()}`;

  } catch (err) {
    document.getElementById('stats-insights-loading').style.display = 'none';
    document.getElementById('stats-insights-result').style.display = 'block';
    document.getElementById('stats-insights-content').innerHTML =
      `<div class="insights-error">${err.message || 'Could not load insights. Please try again.'}</div>`;
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

// ─── Auto-fill missed ─────────────────────────────────────────────────────────

async function autoFillMissed() {
  const inserts = [];

  for (const goal of goals) {
    const goalCreated = goal.created_at ? dateKey(new Date(goal.created_at)) : null;
    for (let i = 1; i <= 30; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = dateKey(d);
      if (goalCreated && key < goalCreated) break; // before this goal existed
      if (!isApplicableDay(goal, key)) continue;  // skip weekends for weekday goals
      if (!logs[goal.id]?.[key]) {
        if (!logs[goal.id]) logs[goal.id] = {};
        logs[goal.id][key] = { success: false, logged_by: 'auto' };
        inserts.push({ goal_id: goal.id, date: key, success: false, logged_by: 'auto', user_id: currentUser.id, updated_at: new Date().toISOString() });
      }
    }
  }

  if (inserts.length) {
    await db.from('logs').upsert(inserts, { onConflict: 'goal_id,date', ignoreDuplicates: true });
  }
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

  // Set date
  document.getElementById('header-date').textContent = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric'
  });

  // Load data
  await loadProfile();
  await loadGoals();
  await loadLogs();
  await autoFillMissed();

  // Set avatar display name
  const displayName = userProfile?.display_name || currentUser?.user_metadata?.name || currentUser?.email || '?';
  document.getElementById('avatar-btn').textContent = displayName;
  await loadRecipes();
  await loadPantryItems();
  await loadMealPlan();

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

// ─── Meals state ──────────────────────────────────────────────────────────────

let recipes = [];
let pantryItems = [];
let mealPlan = {};
let suggestedRecipesCache = [];
let currentMealsTab = 'planner';
let weekGroceryList = null;

// ─── Meals data loading ───────────────────────────────────────────────────────

async function loadRecipes() {
  const { data, error } = await db.from('recipes').select('*').order('name');
  if (!error) recipes = data;
}

async function loadPantryItems() {
  const { data, error } = await db.from('pantry_items').select('*').order('name');
  if (!error) pantryItems = data;
}

async function loadMealPlan() {
  const { data, error } = await db.from('meals').select('*');
  if (!error) {
    mealPlan = {};
    for (const row of data) mealPlan[row.date] = row;
  }
}

// ─── Meals page routing ───────────────────────────────────────────────────────

function renderMealsPage() {
  switchMealsTab(currentMealsTab,
    document.querySelectorAll('.subnav-btn')[['planner','prep','recipes','pantry'].indexOf(currentMealsTab)]
  );
}

function switchMealsTab(tab, btn) {
  currentMealsTab = tab;
  document.querySelectorAll('.subnav-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  const content = document.getElementById('meals-tab-content');
  if (tab === 'planner')  renderPlanner(content);
  if (tab === 'prep')     renderPrep(content);
  if (tab === 'recipes')  renderRecipes(content);
  if (tab === 'pantry')   renderPantry(content);
}

// ─── Planner tab ──────────────────────────────────────────────────────────────

function getWeekDates() {
  const dates = [];
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  for (let i = 0; i < 5; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    dates.push(dateKey(d));
  }
  return dates;
}

function getRemainingWeekDates() {
  const today = todayKey();
  return getWeekDates().filter(d => d >= today);
}

function getMealNutrition(meal) {
  if (!meal) return [];
  const covered = new Set();
  const recipe = recipes.find(r => r.id === meal.recipe_id);
  if (recipe) recipe.nutrition_tags.forEach(t => covered.add(t));
  (meal.side_recipe_ids || []).forEach(id => {
    const r = recipes.find(r => r.id === id);
    if (r) r.nutrition_tags.forEach(t => covered.add(t));
  });
  (meal.pantry_item_ids || []).forEach(id => {
    const p = pantryItems.find(p => p.id === id);
    if (p) p.nutrition_tags.forEach(t => covered.add(t));
  });
  return [...covered];
}

function getMissingNutrition(meal) {
  const covered = getMealNutrition(meal);
  return ['protein','carb','fat','fiber'].filter(n => !covered.includes(n));
}

function getPantryStatus(recipe) {
  if (!recipe || !(recipe.ingredients || []).length || !pantryItems.length) return null;
  const pantryNames = pantryItems.map(p => p.name.toLowerCase());
  const missingCount = (recipe.ingredients).filter(ing => {
    const ingClean = ing.toLowerCase().replace(/\([^)]*\)/g, '').trim();
    return !pantryNames.some(p => {
      const pc = p.toLowerCase();
      return pc.includes(ingClean) || ingClean.includes(pc) ||
        pc.split(/\s+/).every(w => ingClean.includes(w));
    });
  }).length;
  return { total: recipe.ingredients.length, missing: missingCount };
}

function isRecipeAvoided(recipeId) {
  const r = recipes.find(r => r.id === recipeId);
  return r?.avoid_until && r.avoid_until > todayKey();
}

function formatPlannerDate(dateStr) {
  const [, m, d] = dateStr.split('-').map(Number);
  return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m - 1] + ' ' + d;
}

function getSuggestForNutrient(nutrient) {
  const match = pantryItems.find(p => (p.nutrition_tags || []).includes(nutrient));
  if (match) return match.name;
  return { protein: 'egg or cheese', carb: 'crackers or rice', fiber: 'cucumber or carrot', fat: 'nuts or avocado' }[nutrient] || nutrient;
}

function renderPlanner(container) {
  const dates = getWeekDates();
  const dayLabels = ['Mon','Tue','Wed','Thu','Fri'];
  const today = todayKey();

  const rows = dates.map((date, i) => {
    const meal = mealPlan[date];
    const recipe = meal ? recipes.find(r => r.id === meal.recipe_id) : null;
    const isPast = date < today;

    // Bento box nutrient row
    let bentoHtml = '';
    if (recipe) {
      const covered = new Set(getMealNutrition(meal));
      const anyNutrient = covered.has('protein') || covered.has('carb') || covered.has('fiber');
      const badges = ['protein', 'carb', 'fiber'].map(n =>
        `<span class="nutrition-badge ${n}" style="${covered.has(n) ? '' : 'opacity:0.3;'}">${n}</span>`
      ).join('');
      bentoHtml = `<div class="bento-row">${badges}<span style="margin-left:4px;font-size:15px;">${anyNutrient ? '👍' : '👎'}</span></div>`;
    }

    // Pantry status
    let statusHtml = '';
    if (recipe) {
      const ps = getPantryStatus(recipe);
      if (ps) {
        statusHtml = ps.missing === 0
          ? `<div style="font-size:11px;font-weight:600;color:var(--green);">✓ All in pantry</div>`
          : `<div style="font-size:11px;font-weight:600;color:#f59e0b;">🛒 ${ps.missing} ingredient${ps.missing > 1 ? 's' : ''} needed</div>`;
      }
    }

    // Recipe display
    let recipeHtml;
    if (isPast && recipe) {
      recipeHtml = `<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
        <button class="bento-question" onclick="event.stopPropagation();openEatFeedback('${date}')">?</button>
        <span style="font-size:13px;color:var(--gray-400);">${recipe.name}</span>
      </div>`;
    } else if (recipe) {
      recipeHtml = `<div class="meal-day-name">${recipe.name}</div>`;
    } else {
      recipeHtml = `<div class="meal-day-name" style="color:var(--gray-300);">Unplanned</div>`;
    }

    if (isPast) {
      return `
        <div class="meal-day-card" style="opacity:0.55;cursor:pointer;" onclick="togglePastDay('${date}')">
          <div class="meal-day-header">
            <div>
              <span class="meal-day-label" style="color:var(--gray-400);">${dayLabels[i]}</span>
              <span class="meal-day-date">${formatPlannerDate(date)}</span>
            </div>
            <div style="display:flex;align-items:center;gap:8px;">
              ${recipe ? `<span class="meal-day-rating">⭐ ${recipe.ethan_rating != null ? recipe.ethan_rating + '/10' : 'unknown'}</span>` : ''}
              <span id="chevron-${date}" style="font-size:11px;color:var(--gray-400);">▶</span>
            </div>
          </div>
          <div id="past-detail-${date}" style="display:none;">
            ${recipeHtml}
            ${bentoHtml}
            ${statusHtml}
          </div>
        </div>`;
    }

    return `
      <div class="meal-day-card" onclick="openMealPicker('${date}')">
        <div class="meal-day-header">
          <div>
            <span class="meal-day-label">${dayLabels[i]}</span>
            <span class="meal-day-date">${formatPlannerDate(date)}</span>
          </div>
          ${recipe ? `<span class="meal-day-rating">⭐ ${recipe.ethan_rating != null ? recipe.ethan_rating + '/10' : 'unknown'}</span>` : ''}
        </div>
        ${recipeHtml}
        ${bentoHtml}
        ${statusHtml}
      </div>`;
  }).join('');

  let groceryHtml = '';
  if (weekGroceryList) {
    const isCategorized = typeof weekGroceryList === 'object' && !Array.isArray(weekGroceryList);
    const categories = isCategorized ? weekGroceryList : null;
    const flatList = Array.isArray(weekGroceryList) ? weekGroceryList : null;

    let bodyHtml = '';
    if (categories && Object.keys(categories).length) {
      bodyHtml = Object.entries(categories).map(([cat, items]) => `
        <div style="margin-top:14px;">
          <div style="font-size:11px;font-weight:700;color:var(--green);text-transform:uppercase;letter-spacing:0.6px;margin-bottom:6px;">${cat}</div>
          ${items.map(item => `<div style="padding:7px 0;font-size:14px;border-bottom:0.5px solid var(--gray-100);color:var(--gray-900);">${item}</div>`).join('')}
        </div>`).join('');
    } else if (flatList && flatList.length) {
      bodyHtml = flatList.map(item => `<div style="padding:7px 0;font-size:14px;border-bottom:0.5px solid var(--gray-100);color:var(--gray-900);">${item}</div>`).join('');
    } else {
      bodyHtml = '<div style="color:var(--gray-400);font-size:14px;padding:8px 0;">Everything needed is already in your pantry!</div>';
    }

    groceryHtml = `<div class="card" style="margin-top:4px;"><div class="card-title">🛒 Grocery list</div>${bodyHtml}</div>`;
  }

  container.innerHTML = `
    <button class="action-btn" id="suggest-btn" onclick="autoSuggestWeek()">✨ Auto-suggest week</button>
    ${rows}
    ${groceryHtml}
  `;
}

function togglePastDay(date) {
  const detail = document.getElementById('past-detail-' + date);
  const chevron = document.getElementById('chevron-' + date);
  if (!detail) return;
  const opening = detail.style.display === 'none';
  detail.style.display = opening ? '' : 'none';
  if (chevron) chevron.textContent = opening ? '▼' : '▶';
}

// ─── Auto-suggest ─────────────────────────────────────────────────────────────

async function autoSuggestWeek() {
  const dates = getRemainingWeekDates();
  if (!dates.length) { showAlert('No remaining weekdays this week!'); return; }

  const btn = document.getElementById('suggest-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Suggesting…'; }

  try {
    const res = await fetch('/api/suggest-meals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipes: recipes.filter(r => !isRecipeAvoided(r.id)), pantryItems, dates })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    for (const meal of (data.meals || [])) {
      // Find existing recipe by name match (case-insensitive) or create a new one
      let recipe = recipes.find(r => r.name.toLowerCase() === meal.name.toLowerCase());
      if (!recipe) {
        const { data: inserted, error } = await db.from('recipes').insert({
          name: meal.name,
          description: meal.description,
          ingredients: meal.ingredients,
          nutrition_tags: meal.nutrition_tags || ['protein', 'carb', 'fat'],
          prep_time_minutes: 10,
          ethan_rating: null
        }).select().single();
        if (!error && inserted) {
          recipes.push(inserted);
          recipe = inserted;
        }
      }
      if (!recipe) continue;

      const id = 'meal-' + meal.date;
      const { error: mealErr } = await db.from('meals').upsert(
        { id, date: meal.date, recipe_id: recipe.id, confirmed: false },
        { onConflict: 'date' }
      );
      if (!mealErr) mealPlan[meal.date] = { id, date: meal.date, recipe_id: recipe.id, confirmed: false };
    }

    weekGroceryList = data.groceryList || null;
  } catch (err) {
    showAlert('Could not suggest meals: ' + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '✨ Auto-suggest week'; }
  }

  renderMealsPage();
}

// ─── Meal picker modal ────────────────────────────────────────────────────────

function openMealPicker(date) {
  const meal = mealPlan[date] || {};
  const options = recipes.map(r =>
    `<option value="${r.id}" ${meal.recipe_id === r.id ? 'selected' : ''}>
      ${r.name} (⭐${r.ethan_rating}, ${r.prep_time_minutes}min)
    </option>`
  ).join('');

  const pantryOptions = pantryItems.map(p =>
    `<label style="display:flex;align-items:center;gap:8px;padding:6px 0;font-size:14px;">
      <input type="checkbox" value="${p.id}"
        ${(meal.pantry_item_ids||[]).includes(p.id) ? 'checked' : ''}
        style="accent-color:var(--green);width:16px;height:16px;">
      ${p.name}
      ${p.nutrition_tags.map(t => `<span class="nutrition-badge ${t}">${t}</span>`).join('')}
    </label>`
  ).join('');

  document.getElementById('modal-overlay').innerHTML = `
    <div class="modal">
      <div class="modal-title">Plan meal for ${date}</div>
      <div class="form-group">
        <label class="form-label">Main recipe</label>
        <select class="form-input" id="meal-picker-recipe">${options}</select>
      </div>
      <div class="form-group">
        <label class="form-label">Add pantry items</label>
        <div id="meal-picker-pantry">${pantryOptions}</div>
      </div>
      <div class="modal-actions">
        <button class="btn-secondary" onclick="closeMealModal()">Cancel</button>
        <button class="btn-primary" onclick="saveMealPick('${date}')">Save</button>
      </div>
    </div>`;
  document.getElementById('modal-overlay').classList.add('open');
}

async function saveMealPick(date) {
  const recipeId = document.getElementById('meal-picker-recipe').value;
  const checkedPantry = [...document.querySelectorAll('#meal-picker-pantry input:checked')].map(el => el.value);
  const id = 'meal-' + date;
  const { error } = await db.from('meals').upsert(
    { id, date, recipe_id: recipeId, pantry_item_ids: checkedPantry, confirmed: true },
    { onConflict: 'date' }
  );
  if (!error) mealPlan[date] = { id, date, recipe_id: recipeId, pantry_item_ids: checkedPantry, confirmed: true };
  closeMealModal();
  renderMealsPage();
}

// ─── Eat feedback flow ────────────────────────────────────────────────────────

function openEatFeedback(date) {
  const meal = mealPlan[date];
  const recipe = meal ? recipes.find(r => r.id === meal.recipe_id) : null;
  if (!recipe) return;
  const dayName = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(date + 'T12:00:00').getDay()];

  document.getElementById('modal-overlay').innerHTML = `
    <div class="modal">
      <div class="modal-title">How did lunch go?</div>
      <div style="font-size:12px;color:var(--gray-400);margin:-10px 0 16px;">${dayName} · ${formatPlannerDate(date)}</div>
      <div style="font-size:15px;font-weight:600;color:var(--gray-900);margin-bottom:16px;">🍱 ${recipe.name}</div>
      <div style="font-size:13px;font-weight:500;color:var(--gray-600);margin-bottom:10px;">Did Ethan have this?</div>
      <div class="modal-actions">
        <button class="btn-secondary" onclick="closeMealModal()">Something else</button>
        <button class="btn-primary" onclick="showEatAmountPicker('${date}')">Yes 👍</button>
      </div>
    </div>`;
  document.getElementById('modal-overlay').classList.add('open');
}

function showEatAmountPicker(date) {
  const meal = mealPlan[date];
  const recipe = meal ? recipes.find(r => r.id === meal.recipe_id) : null;
  if (!recipe) return;

  const levels = [
    { label: 'None',    pct: 0,   emoji: '😞' },
    { label: 'A little', pct: 0.2, emoji: '😐' },
    { label: 'Half',    pct: 0.5, emoji: '🙂' },
    { label: 'Most',    pct: 0.8, emoji: '😊' },
    { label: 'All!',    pct: 1.0, emoji: '🤩' },
  ];

  document.getElementById('modal-overlay').innerHTML = `
    <div class="modal">
      <div class="modal-title">How much did Ethan eat?</div>
      <div style="font-size:13px;color:var(--gray-400);margin:-10px 0 16px;">🍱 ${recipe.name}</div>
      <div style="display:flex;gap:6px;margin-bottom:20px;">
        ${levels.map(l => `
          <button class="eat-level-btn" data-pct="${l.pct}" onclick="selectEatLevel(this)">
            <div style="font-size:20px;margin-bottom:3px;">${l.emoji}</div>
            <div>${l.label}</div>
          </button>`).join('')}
      </div>
      <div class="modal-actions">
        <button class="btn-secondary" onclick="openEatFeedback('${date}')">← Back</button>
        <button class="btn-primary" id="eat-save-btn" onclick="saveEatFeedback('${date}')" disabled>Save</button>
      </div>
    </div>`;
  document.getElementById('modal-overlay').classList.add('open');
}

function selectEatLevel(btn) {
  document.querySelectorAll('.eat-level-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('eat-save-btn').disabled = false;
}

async function saveEatFeedback(date) {
  const meal = mealPlan[date];
  const recipe = meal ? recipes.find(r => r.id === meal.recipe_id) : null;
  if (!recipe) return;

  const activeBtn = document.querySelector('.eat-level-btn.active');
  if (!activeBtn) return;
  const pct = parseFloat(activeBtn.dataset.pct);

  // Calculate new rating
  const curr = recipe.ethan_rating;
  let newRating;
  if (curr == null) {
    newRating = Math.max(1, Math.round(pct * 10));
  } else {
    const delta = pct >= 0.8 ? 2 : pct >= 0.5 ? 0 : pct >= 0.2 ? -2 : -3;
    newRating = Math.max(1, Math.min(10, curr + delta));
  }

  const updates = { ethan_rating: newRating };
  if (newRating < 2) {
    const avoidDate = new Date();
    avoidDate.setDate(avoidDate.getDate() + 14);
    updates.avoid_until = dateKey(avoidDate);
  }
  const { error } = await db.from('recipes').update(updates).eq('id', recipe.id);
  if (!error) {
    recipe.ethan_rating = newRating;
    if (updates.avoid_until) recipe.avoid_until = updates.avoid_until;
  }

  closeMealModal();
  renderMealsPage();
}

function openProfileMenu() {
  const displayName = userProfile?.display_name || currentUser?.user_metadata?.name || 'Account';
  const email = currentUser?.email || '';
  const overlay = document.getElementById('modal-overlay');
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-title" style="text-align:center;">${displayName}</div>
      <div style="text-align:center;color:var(--gray-400);font-size:13px;margin-bottom:20px;">${email}</div>
      <button class="btn-primary" style="width:100%;margin-bottom:10px;" onclick="openEditProfile()">Edit name</button>
      <button class="btn-secondary" style="width:100%;" onclick="signOutFromModal()">Sign out</button>
    </div>`;
  overlay.classList.add('open');
}

function openEditProfile() {
  const currentName = userProfile?.display_name || currentUser?.user_metadata?.name || '';
  const overlay = document.getElementById('modal-overlay');
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-title">Edit name</div>
      <div class="form-group">
        <label class="form-label">Display name</label>
        <input class="form-input" id="profile-name-input" type="text" value="${currentName}" maxlength="40" placeholder="Your name"/>
      </div>
      <div class="modal-actions">
        <button class="btn-secondary" onclick="openProfileMenu()">Back</button>
        <button class="btn-primary" onclick="saveProfile()">Save</button>
      </div>
    </div>`;
  overlay.classList.add('open');
  setTimeout(() => document.getElementById('profile-name-input')?.focus(), 50);
}

async function saveProfile() {
  const name = document.getElementById('profile-name-input').value.trim();
  if (!name) return;

  const { error } = await db.from('profiles').upsert(
    { user_id: currentUser.id, display_name: name },
    { onConflict: 'user_id' }
  );

  if (error) { showAlert('Failed to save name. Please try again.'); return; }

  userProfile = { ...userProfile, display_name: name };
  document.getElementById('avatar-btn').textContent = name;
  closeMealModal();
}

async function signOutFromModal() {
  closeMealModal();
  await db.auth.signOut();
  location.reload();
}

function closeMealModal() {
  const overlay = document.getElementById('modal-overlay');
  overlay.classList.remove('open');
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-title">New habit</div>
      <div class="form-group"><label class="form-label">Goal name</label><input class="form-input" id="input-name" type="text" placeholder="e.g. School drop-off" maxlength="40"/></div>
      <div class="form-group"><label class="form-label">Description</label><input class="form-input" id="input-desc" type="text" placeholder="e.g. Ethan at school by 8:45 AM" maxlength="60"/></div>
      <div class="form-group"><label class="form-label">Icon (emoji)</label><input class="form-input" id="input-emoji" type="text" placeholder="🎯" maxlength="4" style="font-size:22px;text-align:center;"/></div>
      <div class="form-group"><label class="form-label">Schedule</label>${schedulePickerHTML()}</div>
      <div class="modal-actions">
        <button class="btn-secondary" onclick="closeModalDirect()">Cancel</button>
        <button class="btn-primary" onclick="saveGoal()">Add habit</button>
      </div>
    </div>`;
}

// ─── Dialog helpers ───────────────────────────────────────────────────────────

let _pendingConfirm = null;

function showAlert(message) {
  const el = document.getElementById('dialog-overlay');
  el.innerHTML = `
    <div class="modal">
      <div style="font-size:15px;color:var(--gray-700);line-height:1.5;margin-bottom:4px;">${message}</div>
      <div class="modal-actions"><button class="btn-primary" onclick="closeDialog()">OK</button></div>
    </div>`;
  el.classList.add('open');
}

function showConfirm(message, onConfirm, { danger = false, confirmLabel = 'Confirm' } = {}) {
  _pendingConfirm = onConfirm;
  const el = document.getElementById('dialog-overlay');
  el.innerHTML = `
    <div class="modal">
      <div style="font-size:15px;color:var(--gray-700);line-height:1.5;margin-bottom:4px;">${message}</div>
      <div class="modal-actions">
        <button class="btn-secondary" onclick="closeDialog()">Cancel</button>
        <button class="${danger ? 'btn-danger' : 'btn-primary'}" onclick="closeDialog(true)">${confirmLabel}</button>
      </div>
    </div>`;
  el.classList.add('open');
}

function closeDialog(confirmed) {
  document.getElementById('dialog-overlay').classList.remove('open');
  if (confirmed && _pendingConfirm) _pendingConfirm();
  _pendingConfirm = null;
}

// ─── Prep tab ─────────────────────────────────────────────────────────────────

function renderPrep(container) {
  const today = todayKey();
  const tomorrow = dateKey(new Date(new Date().setDate(new Date().getDate() + 1)));

  const todayMeal = mealPlan[today];
  const tomorrowMeal = mealPlan[tomorrow];

  function stepsHtml(meal, label) {
    if (!meal) return `<div class="empty" style="padding:20px 0">${label}: no meal planned</div>`;
    const recipe = recipes.find(r => r.id === meal.recipe_id);
    if (!recipe) return '';
    const steps = recipe.prep_steps || [];
    if (!steps.length) return `<div style="color:var(--gray-400);font-size:13px;padding:8px 0">No prep steps for ${recipe.name}</div>`;
    return steps.map((step, i) => `
      <div class="prep-step">
        <input type="checkbox" id="step-${label}-${i}" onchange="toggleStep(this)">
        <label class="prep-step-text" for="step-${label}-${i}">
          ${step.text}
          <span style="font-size:11px;color:var(--gray-400);margin-left:6px">${step.when === 'night_before' ? '🌙 tonight' : '☀️ morning'}</span>
        </label>
      </div>`).join('');
  }

  container.innerHTML = `
    <div class="card">
      <div class="card-title">🌙 Tonight — prep for tomorrow</div>
      ${stepsHtml(tomorrowMeal, 'tomorrow')}
    </div>
    <div class="card">
      <div class="card-title">☀️ This morning — today's lunch</div>
      ${stepsHtml(todayMeal, 'today')}
    </div>
  `;
}

function toggleStep(checkbox) {
  const label = checkbox.nextElementSibling;
  label.classList.toggle('done', checkbox.checked);
}

// ─── Recipes tab ──────────────────────────────────────────────────────────────

function renderRecipes(container) {
  const cards = recipes.map(r => `
    <div class="recipe-card">
      <div class="recipe-card-header">
        <div style="flex:1;min-width:0;">
          <div class="recipe-card-name">${r.name}</div>
          <div class="recipe-card-meta">⏱ ${r.prep_time_minutes} min · ⭐ ${r.ethan_rating != null ? r.ethan_rating + '/10' : 'unknown'}</div>
        </div>
        <div style="display:flex;gap:2px;align-items:center;">
          <button onclick="openEditRecipe('${r.id}')" style="background:none;border:none;cursor:pointer;color:var(--gray-400);padding:4px;" title="Edit">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button onclick="deleteRecipe('${r.id}')" style="background:none;border:none;cursor:pointer;color:var(--gray-400);padding:4px;">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>
          </button>
        </div>
        ${r.photo_url ? `<img class="recipe-thumb" src="${r.photo_url}" alt="${r.name}">` : ''}
      </div>
      <div>${(r.nutrition_tags||[]).map(t => `<span class="nutrition-badge ${t}">${t}</span>`).join('')}</div>
      <div style="margin-top:8px;font-size:13px;color:var(--gray-400)">${(r.ingredients||[]).join(', ')}</div>
      ${(() => {
        const nightSteps = (r.prep_steps||[]).filter(s => s.when === 'night_before');
        if (!nightSteps.length) return '';
        return `<div style="margin-top:10px;padding-top:10px;border-top:0.5px solid var(--gray-100)">
          <div style="font-size:11px;font-weight:600;color:var(--gray-400);margin-bottom:6px;">🌙 PREP TONIGHT</div>
          ${nightSteps.map(s => `<div style="font-size:13px;color:var(--gray-600);padding:2px 0">• ${s.text}</div>`).join('')}
        </div>`;
      })()}
    </div>`).join('');

  container.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:4px;">
      <button class="action-btn" style="flex:1" onclick="openSuggestRecipe()">✨ Suggest</button>
      <button class="action-btn" style="flex:1" onclick="openAddRecipe()">+ Add manually</button>
    </div>
    ${cards || '<div class="empty"><div class="empty-icon">🍱</div>No recipes yet</div>'}
  `;
}

// ─── Suggest recipe flow ──────────────────────────────────────────────────────

function openSuggestRecipe() {
  const chips = (category, options) => `
    <div class="form-group">
      <label class="form-label">${category} <span style="font-weight:400;color:var(--gray-400);">(optional)</span></label>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;">
        ${options.map(o => `<button type="button" class="suggest-chip" data-cat="${category.toLowerCase()}" onclick="toggleSuggestChip(this)">${o}</button>`).join('')}
      </div>
    </div>`;

  document.getElementById('modal-overlay').innerHTML = `
    <div class="modal">
      <div class="modal-title">✨ Suggest recipe</div>
      ${chips('Protein', ['Chicken','Egg','Tuna','Cheese','Tofu','Beans','Salmon','Ham','Pork','Lamb','Beef'])}
      ${chips('Carb', ['Rice','Pasta','Bread','Tortilla','Quinoa','Noodles'])}
      ${chips('Fiber', ['Cucumber','Carrot','Broccoli','Spinach','Tomato','Corn','Edamame'])}
      <div class="form-group">
        <label class="form-label">Keywords / style <span style="font-weight:400;color:var(--gray-400);">(optional)</span></label>
        <input class="form-input" id="suggest-keyword" type="text" placeholder="e.g. Japanese, no-heat, quick, Mediterranean…"/>
      </div>
      <div class="modal-actions">
        <button class="btn-secondary" onclick="closeMealModal()">Cancel</button>
        <button class="btn-primary" onclick="findSuggestedRecipes()">Find recipes →</button>
      </div>
    </div>`;
  document.getElementById('modal-overlay').classList.add('open');
}

function toggleSuggestChip(btn) {
  const cat = btn.dataset.cat;
  document.querySelectorAll(`.suggest-chip[data-cat="${cat}"]`).forEach(c => {
    if (c !== btn) c.classList.remove('active');
  });
  btn.classList.toggle('active');
}

async function findSuggestedRecipes() {
  const get = cat => document.querySelector(`.suggest-chip[data-cat="${cat}"].active`)?.textContent.trim() || null;
  const protein = get('protein'), carb = get('carb'), fiber = get('fiber');
  const keyword = document.getElementById('suggest-keyword')?.value.trim() || '';

  const btn = document.querySelector('#modal-overlay .btn-primary');
  btn.textContent = '⏳ Finding…'; btn.disabled = true;

  try {
    const res = await fetch('/api/suggest-recipes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ protein, carb, fiber, keyword, existingRecipes: recipes })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    suggestedRecipesCache = data.recipes || [];
    showSuggestionResults();
  } catch (err) {
    showAlert('Could not get suggestions: ' + err.message);
    btn.textContent = 'Find recipes →'; btn.disabled = false;
  }
}

function showSuggestionResults() {
  const cards = suggestedRecipesCache.map((r, i) => `
    <label style="display:flex;align-items:flex-start;gap:12px;padding:14px 0;border-bottom:0.5px solid var(--gray-100);cursor:pointer;">
      <input type="checkbox" class="suggest-pick" data-index="${i}" style="margin-top:2px;accent-color:var(--green);width:18px;height:18px;flex-shrink:0;">
      <div style="flex:1;min-width:0;">
        <div style="font-size:15px;font-weight:600;color:var(--gray-900);">${r.name}</div>
        <div style="font-size:13px;color:var(--gray-500);margin:3px 0 5px;">${r.description || ''}</div>
        <div style="font-size:12px;color:var(--gray-400);margin-bottom:6px;">${(r.ingredients||[]).join(', ')}</div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:4px;">
          ${(r.nutrition_tags||[]).map(t => `<span class="nutrition-badge ${t}">${t}</span>`).join('')}
          <a href="https://www.google.com/search?q=${encodeURIComponent(r.name + ' recipe')}" target="_blank" onclick="event.stopPropagation()" style="font-size:12px;color:var(--green);text-decoration:none;margin-left:auto;">🔗 See recipe</a>
        </div>
      </div>
    </label>`).join('');

  document.getElementById('modal-overlay').innerHTML = `
    <div class="modal">
      <div class="modal-title">Pick recipes to save</div>
      <div style="font-size:13px;color:var(--gray-400);margin-bottom:4px;">Select the ones you want to add to your recipe book</div>
      ${cards || '<div style="color:var(--gray-400);padding:20px 0;text-align:center;">No suggestions returned — try different filters</div>'}
      <div class="modal-actions">
        <button class="btn-secondary" onclick="openSuggestRecipe()">← Back</button>
        <button class="btn-primary" onclick="saveSelectedSuggestions()">Save selected</button>
      </div>
    </div>`;
}

async function saveSelectedSuggestions() {
  const picked = [...document.querySelectorAll('.suggest-pick:checked')]
    .map(el => suggestedRecipesCache[parseInt(el.dataset.index)])
    .filter(Boolean);
  if (!picked.length) { showAlert('Select at least one recipe to save.'); return; }

  const btn = document.querySelector('#modal-overlay .btn-primary');
  btn.textContent = '⏳ Saving…'; btn.disabled = true;

  let failed = 0;
  for (const r of picked) {
    const id = 'recipe-' + Date.now() + Math.random().toString(36).slice(2, 7);
    const ingredients = Array.isArray(r.ingredients) ? r.ingredients : (r.ingredients||'').split(',').map(s => s.trim()).filter(Boolean);
    const { error } = await db.from('recipes').insert({
      id, name: r.name, ingredients,
      prep_steps: [], prep_time_minutes: r.prep_time_minutes || 15,
      ethan_rating: null, nutrition_tags: r.nutrition_tags || [], photo_url: null
    });
    if (!error) recipes.push({ id, name: r.name, description: r.description, ingredients, prep_steps: [], prep_time_minutes: r.prep_time_minutes || 15, ethan_rating: null, nutrition_tags: r.nutrition_tags || [], photo_url: null });
    else failed++;
  }

  closeMealModal();
  renderMealsPage();
  if (failed) showAlert(`${failed} recipe(s) could not be saved. Please try again.`);
}

function openAddRecipe() {
  document.getElementById('modal-overlay').innerHTML = `
    <div class="modal">
      <div class="modal-title">New recipe</div>
      <div class="form-group">
        <label class="form-label">Recipe name</label>
        <input class="form-input" id="r-name" type="text" placeholder="e.g. Pasta salad"/>
      </div>
      <div class="form-group">
        <label class="form-label">Ingredients (comma separated)</label>
        <input class="form-input" id="r-ingredients" type="text" placeholder="e.g. pasta, pesto, cherry tomatoes"/>
      </div>
      <div class="form-group">
        <label class="form-label">Prep time (minutes)</label>
        <input class="form-input" id="r-time" type="number" value="15" min="1" max="120"/>
      </div>
      <div class="form-group">
        <label class="form-label">Ethan's rating</label>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <div class="star-rating" id="r-stars">
            ${[1,2,3,4,5,6,7,8,9,10].map(n =>
              `<span class="star" data-val="${n}" onclick="setStars(${n})">★</span>`
            ).join('')}
          </div>
          <button type="button" class="not-sure-btn" onclick="setStars(null)">Unknown</button>
        </div>
        <input type="hidden" id="r-rating" value=""/>
      </div>
      <div class="form-group">
        <label class="form-label">Nutrition coverage</label>
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:4px">
          ${['protein','carb','fat','fiber'].map(t => `
            <label style="display:flex;align-items:center;gap:6px;font-size:14px;">
              <input type="checkbox" value="${t}" class="r-nutrition" style="accent-color:var(--green);width:16px;height:16px;">
              <span class="nutrition-badge ${t}">${t}</span>
            </label>`).join('')}
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Photo</label>
        <div class="photo-upload-area" id="r-photo-preview" onclick="document.getElementById('r-photo-input').click()">
          <div class="photo-upload-placeholder">📷 Tap to add photo</div>
        </div>
        <input type="file" id="r-photo-input" accept="image/*" style="display:none" onchange="previewPhoto(this)">
      </div>
      <div class="form-group">
        <label class="form-label">Describe the recipe — AI will generate prep steps</label>
        <textarea class="form-input" id="r-desc" rows="3" placeholder="e.g. Cook pasta, mix with pesto and cherry tomatoes, pack with fork"></textarea>
      </div>
      <div class="modal-actions">
        <button class="btn-secondary" onclick="closeMealModal()">Cancel</button>
        <button class="btn-primary" onclick="saveRecipeWithAI()">✨ Generate & save</button>
      </div>
    </div>`;
  document.getElementById('modal-overlay').classList.add('open');
  setStars(null);
}

function previewPhoto(input) {
  const file = input.files[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  document.getElementById('r-photo-preview').innerHTML =
    `<img src="${url}" style="width:100%;height:100%;object-fit:cover;">`;
}

function setStars(val) {
  const isEmpty = val === null || val === undefined || val === '';
  document.getElementById('r-rating').value = isEmpty ? '' : val;
  document.querySelectorAll('.star').forEach(s => {
    s.classList.toggle('active', !isEmpty && parseInt(s.dataset.val) <= val);
  });
  const nsBtn = document.querySelector('.not-sure-btn');
  if (nsBtn) nsBtn.classList.toggle('active', isEmpty);
}

async function saveRecipeWithAI() {
  const name = document.getElementById('r-name').value.trim();
  const ingredientsRaw = document.getElementById('r-ingredients').value.trim();
  const prepTime = parseInt(document.getElementById('r-time').value) || 15;
  const ratingRaw = document.getElementById('r-rating').value;
  const rating = ratingRaw === '' ? null : parseInt(ratingRaw);
  const nutritionTags = [...document.querySelectorAll('.r-nutrition:checked')].map(el => el.value);
  const desc = document.getElementById('r-desc').value.trim();
  if (!name) return;

  const saveBtn = document.querySelector('#modal-overlay .btn-primary');
  saveBtn.textContent = '⏳ Generating...';
  saveBtn.disabled = true;

  let prepSteps = [];
  if (desc) {
    try {
      const response = await fetch('/api/generate-steps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description: desc, ingredients: ingredientsRaw })
      });
      const data = await response.json();
      prepSteps = data.steps || [];
    } catch (e) {
      console.error('AI step generation failed', e);
    }
  }

  const id = 'recipe-' + Date.now();
  const ingredients = ingredientsRaw.split(',').map(s => s.trim()).filter(Boolean);

  let photoUrl = null;
  const photoFile = document.getElementById('r-photo-input').files[0];
  if (photoFile) {
    const ext = photoFile.name.split('.').pop() || 'jpg';
    const { error: uploadError } = await db.storage.from('recipe-photos').upload(`${id}.${ext}`, photoFile);
    if (!uploadError) {
      const { data } = db.storage.from('recipe-photos').getPublicUrl(`${id}.${ext}`);
      photoUrl = data.publicUrl;
    }
  }

  const { error } = await db.from('recipes').insert({
    id, name, ingredients, prep_steps: prepSteps,
    prep_time_minutes: prepTime, ethan_rating: rating, nutrition_tags: nutritionTags,
    photo_url: photoUrl
  });

  if (!error) {
    recipes.push({ id, name, ingredients, prep_steps: prepSteps, prep_time_minutes: prepTime, ethan_rating: rating, nutrition_tags: nutritionTags, photo_url: photoUrl });
    closeMealModal();
    renderMealsPage();
  } else {
    showAlert('Failed to save recipe: ' + JSON.stringify(error));
    saveBtn.textContent = '✨ Generate & save';
    saveBtn.disabled = false;
  }
}

function deleteRecipe(id) {
  showConfirm('Delete this recipe?', async () => {
    await db.from('recipes').delete().eq('id', id);
    recipes = recipes.filter(r => r.id !== id);
    renderMealsPage();
  }, { danger: true, confirmLabel: 'Delete' });
}

function openEditRecipe(id) {
  const r = recipes.find(r => r.id === id);
  if (!r) return;
  const nameEsc = r.name.replace(/"/g, '&quot;');
  const ingEsc = (r.ingredients || []).join(', ').replace(/"/g, '&quot;');
  document.getElementById('modal-overlay').innerHTML = `
    <div class="modal">
      <div class="modal-title">Edit recipe</div>
      <div class="form-group">
        <label class="form-label">Recipe name</label>
        <input class="form-input" id="r-name" type="text" value="${nameEsc}"/>
      </div>
      <div class="form-group">
        <label class="form-label">Ingredients (comma separated)</label>
        <input class="form-input" id="r-ingredients" type="text" value="${ingEsc}"/>
      </div>
      <div class="form-group">
        <label class="form-label">Prep time (minutes)</label>
        <input class="form-input" id="r-time" type="number" value="${r.prep_time_minutes}" min="1" max="120"/>
      </div>
      <div class="form-group">
        <label class="form-label">Ethan's rating</label>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <div class="star-rating" id="r-stars">
            ${[1,2,3,4,5,6,7,8,9,10].map(n =>
              `<span class="star" data-val="${n}" onclick="setStars(${n})">★</span>`
            ).join('')}
          </div>
          <button type="button" class="not-sure-btn" onclick="setStars(null)">Unknown</button>
        </div>
        <input type="hidden" id="r-rating" value="${r.ethan_rating ?? ''}"/>
      </div>
      <div class="form-group">
        <label class="form-label">Nutrition coverage</label>
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:4px">
          ${['protein','carb','fat','fiber'].map(t => `
            <label style="display:flex;align-items:center;gap:6px;font-size:14px;">
              <input type="checkbox" value="${t}" class="r-nutrition" ${(r.nutrition_tags||[]).includes(t)?'checked':''} style="accent-color:var(--green);width:16px;height:16px;">
              <span class="nutrition-badge ${t}">${t}</span>
            </label>`).join('')}
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Photo</label>
        <div class="photo-upload-area" id="r-photo-preview" onclick="document.getElementById('r-photo-input').click()">
          ${r.photo_url ? `<img src="${r.photo_url}" style="width:100%;height:100%;object-fit:cover;">` : '<div class="photo-upload-placeholder">📷 Tap to add photo</div>'}
        </div>
        <input type="file" id="r-photo-input" accept="image/*" style="display:none" onchange="previewPhoto(this)">
      </div>
      <div class="form-group">
        <label class="form-label">Re-describe to regenerate prep steps (leave blank to keep existing)</label>
        <textarea class="form-input" id="r-desc" rows="3" placeholder="e.g. Cook pasta, mix with pesto and cherry tomatoes..."></textarea>
      </div>
      <div class="modal-actions">
        <button class="btn-secondary" onclick="closeMealModal()">Cancel</button>
        <button class="btn-primary" onclick="saveEditRecipe('${id}')">Save changes</button>
      </div>
    </div>`;
  document.getElementById('modal-overlay').classList.add('open');
  setStars(r.ethan_rating);
}

async function saveEditRecipe(id) {
  const r = recipes.find(r => r.id === id);
  if (!r) return;
  const name = document.getElementById('r-name').value.trim();
  const ingredientsRaw = document.getElementById('r-ingredients').value.trim();
  const prepTime = parseInt(document.getElementById('r-time').value) || 15;
  const ratingRaw = document.getElementById('r-rating').value;
  const rating = ratingRaw === '' ? null : parseInt(ratingRaw);
  const nutritionTags = [...document.querySelectorAll('.r-nutrition:checked')].map(el => el.value);
  const desc = document.getElementById('r-desc').value.trim();
  if (!name) return;

  const saveBtn = document.querySelector('#modal-overlay .btn-primary');
  saveBtn.disabled = true;

  let prepSteps = r.prep_steps || [];
  if (desc) {
    saveBtn.textContent = '⏳ Generating steps...';
    try {
      const res = await fetch('/api/generate-steps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description: desc, ingredients: ingredientsRaw })
      });
      const data = await res.json();
      prepSteps = data.steps || [];
    } catch (e) { console.error('AI step generation failed', e); }
  } else {
    saveBtn.textContent = '⏳ Saving...';
  }

  const ingredients = ingredientsRaw.split(',').map(s => s.trim()).filter(Boolean);

  let photoUrl = r.photo_url;
  const photoFile = document.getElementById('r-photo-input').files[0];
  if (photoFile) {
    const ext = photoFile.name.split('.').pop() || 'jpg';
    const { error: uploadErr } = await db.storage.from('recipe-photos').upload(`${id}.${ext}`, photoFile, { upsert: true });
    if (!uploadErr) {
      const { data } = db.storage.from('recipe-photos').getPublicUrl(`${id}.${ext}`);
      photoUrl = data.publicUrl;
    }
  }

  const { error } = await db.from('recipes').update({
    name, ingredients, prep_steps: prepSteps,
    prep_time_minutes: prepTime, ethan_rating: rating,
    nutrition_tags: nutritionTags, photo_url: photoUrl
  }).eq('id', id);

  if (!error) {
    const idx = recipes.findIndex(r => r.id === id);
    if (idx !== -1) recipes[idx] = { ...recipes[idx], name, ingredients, prep_steps: prepSteps, prep_time_minutes: prepTime, ethan_rating: rating, nutrition_tags: nutritionTags, photo_url: photoUrl };
    closeMealModal();
    renderMealsPage();
  } else {
    showAlert('Failed to save: ' + JSON.stringify(error));
    saveBtn.textContent = 'Save changes';
    saveBtn.disabled = false;
  }
}

// ─── Pantry tab ───────────────────────────────────────────────────────────────

function renderPantry(container) {
  const items = pantryItems.map(p => `
    <div class="goal-item">
      <div class="goal-info">
        <div class="goal-item-name">${p.name}</div>
        <div style="margin-top:4px">${(p.nutrition_tags||[]).map(t => `<span class="nutrition-badge ${t}">${t}</span>`).join('')}</div>
      </div>
      <div style="display:flex;gap:2px;align-items:center;">
        <button onclick="openEditPantryItem('${p.id}')" style="background:none;border:none;cursor:pointer;color:var(--gray-400);padding:6px;">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button onclick="deletePantryItem('${p.id}')" style="background:none;border:none;cursor:pointer;color:var(--gray-400);padding:6px;">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>
        </button>
      </div>
    </div>`).join('');

  container.innerHTML = `
    <button class="action-btn" onclick="openAddPantryItem()">+ Add pantry item</button>
    <div class="goals-list">${items || '<div class="empty"><div class="empty-icon">🧺</div>No pantry items yet</div>'}</div>
  `;
}

function openAddPantryItem() {
  document.getElementById('modal-overlay').innerHTML = `
    <div class="modal">
      <div class="modal-title">New pantry item</div>
      <div class="form-group">
        <label class="form-label">Item name</label>
        <input class="form-input" id="p-name" type="text" placeholder="e.g. Apple, Cheese stick"/>
      </div>
      <div class="form-group">
        <label class="form-label">Nutrition category</label>
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:4px">
          ${['protein','carb','fat','fiber'].map(t => `
            <label style="display:flex;align-items:center;gap:6px;font-size:14px;">
              <input type="checkbox" value="${t}" class="p-nutrition" style="accent-color:var(--green);width:16px;height:16px;">
              <span class="nutrition-badge ${t}">${t}</span>
            </label>`).join('')}
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn-secondary" onclick="closeMealModal()">Cancel</button>
        <button class="btn-primary" onclick="savePantryItem()">Add item</button>
      </div>
    </div>`;
  document.getElementById('modal-overlay').classList.add('open');
}

async function savePantryItem() {
  const name = document.getElementById('p-name').value.trim();
  const nutritionTags = [...document.querySelectorAll('.p-nutrition:checked')].map(el => el.value);
  if (!name) return;
  const id = 'pantry-' + Date.now();
  const { error } = await db.from('pantry_items').insert({ id, name, nutrition_tags: nutritionTags });
  if (!error) {
    pantryItems.push({ id, name, nutrition_tags: nutritionTags });
    closeMealModal();
    renderMealsPage();
  }
}

function openEditPantryItem(id) {
  const p = pantryItems.find(p => p.id === id);
  if (!p) return;
  document.getElementById('modal-overlay').innerHTML = `
    <div class="modal">
      <div class="modal-title">Edit pantry item</div>
      <div class="form-group">
        <label class="form-label">Item name</label>
        <input class="form-input" id="p-name" type="text" value="${p.name}" placeholder="e.g. Apple, Cheese stick"/>
      </div>
      <div class="form-group">
        <label class="form-label">Nutrition category</label>
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:4px">
          ${['protein','carb','fat','fiber'].map(t => `
            <label style="display:flex;align-items:center;gap:6px;font-size:14px;">
              <input type="checkbox" value="${t}" class="p-nutrition" ${(p.nutrition_tags||[]).includes(t) ? 'checked' : ''} style="accent-color:var(--green);width:16px;height:16px;">
              <span class="nutrition-badge ${t}">${t}</span>
            </label>`).join('')}
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn-secondary" onclick="closeMealModal()">Cancel</button>
        <button class="btn-primary" onclick="saveEditPantryItem('${id}')">Save</button>
      </div>
    </div>`;
  document.getElementById('modal-overlay').classList.add('open');
}

async function saveEditPantryItem(id) {
  const name = document.getElementById('p-name').value.trim();
  const nutritionTags = [...document.querySelectorAll('.p-nutrition:checked')].map(el => el.value);
  if (!name) return;
  const { error } = await db.from('pantry_items').update({ name, nutrition_tags: nutritionTags }).eq('id', id);
  if (!error) {
    const idx = pantryItems.findIndex(p => p.id === id);
    if (idx !== -1) pantryItems[idx] = { ...pantryItems[idx], name, nutrition_tags: nutritionTags };
    closeMealModal();
    renderMealsPage();
  }
}

function deletePantryItem(id) {
  showConfirm('Delete this item?', async () => {
    await db.from('pantry_items').delete().eq('id', id);
    pantryItems = pantryItems.filter(p => p.id !== id);
    renderMealsPage();
  }, { danger: true, confirmLabel: 'Delete' });
}

init();
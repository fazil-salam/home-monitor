/* ═══════════════════════════════════════════════════════
   PLANT HEALTH DASHBOARD — script.js
   ESP32 + BH1750 + 4x capacitive soil sensors → Node/Express + SQLite
   ═══════════════════════════════════════════════════════ */

const CONFIG = {
  apiBase:   '/homemonitor/api',
  refreshMs: 30_000,
};

const SOIL_KEYS = ['soil1', 'soil2', 'soil3', 'soil4'];
const SOIL_COLOR_VARS = ['--soil1-color', '--soil2-color', '--soil3-color', '--soil4-color'];

const state = {
  allFeeds:       [],
  latest:         null,
  settings:       null,
  viewHours:      24,
  viewBucket:     '1h',
  refreshTimer:   null,
  countdownTimer: null,
  countdown:      CONFIG.refreshMs / 1000,
  charts:         { lux: null, soil: null },
};

const $ = id => document.getElementById(id);
const loadingOverlay = $('loadingOverlay');
const errorBanner    = $('errorBanner');
const errorMessage   = $('errorMessage');
const statusDot      = $('statusDot');
const statusText     = $('statusText');
const currentLux     = $('currentLux');
const lastUpdated    = $('lastUpdated');
const lastUpdatedAbs = $('lastUpdatedAbs');
const countdown      = $('countdown');
const refreshBar     = $('refreshBar');
const dataPoints     = $('dataPoints');
const luxStats       = $('luxStats');
const soilLegend     = $('soilLegend');
const alertBar       = $('alertBar');
const alertMessage   = $('alertMessage');

/* ═══════════════════════════════════════════════════════
   API
═══════════════════════════════════════════════════════ */
async function fetchSettings() {
  const res = await fetch(`${CONFIG.apiBase}/plant-settings`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchData() {
  const params = new URLSearchParams({ hours: state.viewHours, bucket: state.viewBucket });
  if (state.viewBucket === '1d' || state.viewBucket === '1w') {
    params.set('tzOffsetMinutes', new Date().getTimezoneOffset());
  }
  const res = await fetch(`${CONFIG.apiBase}/plant-readings?${params}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error('Unexpected response from server');
  return rows;
}

async function fetchLatest() {
  const res = await fetch(`${CONFIG.apiBase}/plant-latest`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/* ═══════════════════════════════════════════════════════
   REFRESH CYCLE
═══════════════════════════════════════════════════════ */
async function refresh(isFirst = false) {
  setStatus('loading');
  if (isFirst) showLoading(true);

  try {
    const [settings, feeds, live] = await Promise.all([fetchSettings(), fetchData(), fetchLatest()]);
    state.settings = settings;
    state.allFeeds = feeds;
    state.latest = live;

    applyChannelNames();
    hideError();
    updateCards();
    updateCharts();
    updateFooter();
    checkAlerts();
    setStatus('ok');
  } catch (err) {
    setStatus('error');
    showError(buildErrorMessage(err));
    console.error('[Plant] Fetch error:', err);
  } finally {
    if (isFirst) showLoading(false);
    restartCountdown();
    animateRefreshBar();
  }
}

function buildErrorMessage(err) {
  if (!navigator.onLine) return 'No internet connection. Check your network.';
  if (String(err).includes('404')) return 'API not found — check the server is running.';
  return `Could not load data: ${err.message}`;
}

function restartCountdown() {
  if (state.countdownTimer) clearInterval(state.countdownTimer);
  state.countdown = CONFIG.refreshMs / 1000;
  countdown.textContent = state.countdown;
  state.countdownTimer = setInterval(() => {
    state.countdown = Math.max(0, state.countdown - 1);
    countdown.textContent = state.countdown;
  }, 1000);
}

function animateRefreshBar() {
  const bar = refreshBar;
  bar.style.animation = 'none';
  void bar.offsetWidth;
  bar.style.animation = `progressDrain ${CONFIG.refreshMs / 1000}s linear`;
}

/* ═══════════════════════════════════════════════════════
   CHANNEL NAMES
═══════════════════════════════════════════════════════ */
function applyChannelNames() {
  const s = state.settings;
  if (!s) return;
  $('soil1Label').textContent = s.soil1_name;
  $('soil2Label').textContent = s.soil2_name;
  $('soil3Label').textContent = s.soil3_name;
  $('soil4Label').textContent = s.soil4_name;

  soilLegend.innerHTML = SOIL_KEYS.map((key, i) => `
    <span class="legend-item">
      <span class="dot" style="background:${getVar(SOIL_COLOR_VARS[i])}"></span>
      ${s[`${key}_name`]}
    </span>
  `).join('');
}

/* ═══════════════════════════════════════════════════════
   DATA HELPERS
═══════════════════════════════════════════════════════ */
function parseNum(v) {
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

function calcStats(arr) {
  const nums = arr.filter(v => v !== null);
  if (!nums.length) return { min: null, avg: null, max: null };
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
  return { min, avg, max };
}

/* ═══════════════════════════════════════════════════════
   UI — CARDS
═══════════════════════════════════════════════════════ */
function updateCards() {
  const latest = state.latest;
  if (!latest) return;

  const lux = parseNum(latest.lux);
  if (lux !== null) setValueFlash(currentLux, Math.round(lux));

  SOIL_KEYS.forEach((key, i) => {
    const pct = parseNum(latest[`${key}_pct`]);
    const el = $(`current${key.charAt(0).toUpperCase()}${key.slice(1)}`);
    if (pct !== null && el) setValueFlash(el, pct.toFixed(1));
  });

  const ts = new Date(latest.recorded_at);
  lastUpdated.textContent = timeAgo(ts);
  lastUpdatedAbs.textContent = formatTime(ts);
}

function setValueFlash(el, val) {
  el.classList.remove('flash');
  void el.offsetWidth;
  el.textContent = val;
  el.classList.add('flash');
}

/* ═══════════════════════════════════════════════════════
   UI — CHARTS
═══════════════════════════════════════════════════════ */
function updateCharts() {
  const feeds = state.allFeeds;
  const times = feeds.map(f => new Date(f.recorded_at));
  const luxValues = feeds.map(f => parseNum(f.lux));

  renderLuxChart(times, luxValues);
  renderSoilChart(times, feeds);
}

function renderLuxChart(times, values) {
  const ctx = document.getElementById('luxChart').getContext('2d');
  const st = calcStats(values);
  updateStatsChips(luxStats, st);

  const points = times
    .map((t, i) => values[i] !== null ? { x: t, y: values[i] } : null)
    .filter(Boolean);
  if (!points.length) return;

  const { gridColor, tickColor, tooltipBg, tooltipText } = themeColors();
  const color = getVar('--lux-color');
  const glow = getVar('--lux-glow');

  const gradient = ctx.createLinearGradient(0, 0, 0, 260);
  gradient.addColorStop(0, glow.replace('0.25', '0.45'));
  gradient.addColorStop(1, glow.replace('0.25', '0.02'));

  const chartData = {
    datasets: [{
      label: 'Light (lux)',
      data: points,
      borderColor: color,
      backgroundColor: gradient,
      borderWidth: 2.2,
      pointRadius: points.length > 150 ? 0 : 2.5,
      pointHoverRadius: 6,
      pointBackgroundColor: color,
      pointBorderColor: tooltipBg,
      pointBorderWidth: 2,
      fill: true,
      tension: 0.35,
      spanGaps: true,
    }]
  };

  const options = baseChartOptions({ gridColor, tickColor, tooltipBg, tooltipText, unit: ' lux', color, legend: false });

  if (state.charts.lux) {
    state.charts.lux.data = chartData;
    state.charts.lux.options = options;
    state.charts.lux.update('active');
  } else {
    state.charts.lux = new Chart(ctx, { type: 'line', data: chartData, options });
  }
}

function renderSoilChart(times, feeds) {
  const ctx = document.getElementById('soilChart').getContext('2d');
  const { gridColor, tickColor, tooltipBg, tooltipText } = themeColors();

  const datasets = SOIL_KEYS.map((key, i) => {
    const color = getVar(SOIL_COLOR_VARS[i]);
    const values = feeds.map(f => parseNum(f[`${key}_pct`]));
    const points = times
      .map((t, idx) => values[idx] !== null ? { x: t, y: values[idx] } : null)
      .filter(Boolean);
    return {
      label: state.settings ? state.settings[`${key}_name`] : key,
      data: points,
      borderColor: color,
      backgroundColor: color,
      borderWidth: 2.2,
      pointRadius: points.length > 150 ? 0 : 2.5,
      pointHoverRadius: 6,
      pointBackgroundColor: color,
      pointBorderColor: tooltipBg,
      pointBorderWidth: 2,
      fill: false,
      tension: 0.35,
      spanGaps: true,
    };
  });

  const chartData = { datasets };
  const options = baseChartOptions({ gridColor, tickColor, tooltipBg, tooltipText, unit: '%', legend: false, yMax: 100, yMin: 0 });
  options.plugins.tooltip.callbacks.label = item => `  ${item.dataset.label}: ${item.parsed.y.toFixed(1)}%`;

  if (state.charts.soil) {
    state.charts.soil.data = chartData;
    state.charts.soil.options = options;
    state.charts.soil.update('active');
  } else {
    state.charts.soil = new Chart(ctx, { type: 'line', data: chartData, options });
  }
}

function baseChartOptions({ gridColor, tickColor, tooltipBg, tooltipText, unit, color, legend, yMax, yMin }) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: tooltipBg,
        titleColor: tickColor,
        bodyColor: tooltipText,
        borderColor: color || tickColor,
        borderWidth: 1,
        padding: 12,
        cornerRadius: 10,
        callbacks: {
          title: items => formatTooltipTime(new Date(items[0].parsed.x)),
          label: item => `  ${item.dataset.label.split(' ')[0]}: ${item.parsed.y.toFixed(1)}${unit}`,
        },
      },
    },
    scales: {
      x: {
        type: 'time',
        time: {
          unit: resolveTimeUnit(state.viewHours),
          tooltipFormat: 'MMM d, yyyy, h:mm a',
          displayFormats: { minute: 'h:mm a', hour: 'h a', day: 'MMM d', month: 'MMM yyyy' },
        },
        grid: { color: gridColor, drawBorder: false },
        ticks: { color: tickColor, maxTicksLimit: 8, maxRotation: 0 },
        border: { display: false },
      },
      y: {
        min: yMin,
        max: yMax,
        grid: { color: gridColor, drawBorder: false },
        ticks: { color: tickColor, callback: v => `${Math.round(v * 10) / 10}${unit}`, maxTicksLimit: 6 },
        border: { display: false },
      }
    },
    animation: { duration: 400 },
  };
}

function resolveTimeUnit(hours) {
  if (hours <= 1)   return 'minute';
  if (hours <= 24)  return 'hour';
  if (hours <= 720) return 'day';
  return 'month';
}

function themeColors() {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  return {
    gridColor: isLight ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.06)',
    tickColor: '#64748b',
    tooltipBg: isLight ? '#ffffff' : '#1e293b',
    tooltipText: isLight ? '#0f172a' : '#f1f5f9',
  };
}

function getVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/* ═══════════════════════════════════════════════════════
   UI — STATS CHIPS
═══════════════════════════════════════════════════════ */
function updateStatsChips(el, st) {
  const chips = el.querySelectorAll('.stat-chip');
  if (st.min === null) { chips.forEach(c => { c.textContent = '— ' + c.title; }); return; }
  const fmt = v => `${Math.round(v)} lux`;
  chips[0].textContent = `${fmt(st.min)} min`;
  chips[1].textContent = `${fmt(st.avg)} avg`;
  chips[2].textContent = `${fmt(st.max)} max`;
}

/* ═══════════════════════════════════════════════════════
   ALERTS
═══════════════════════════════════════════════════════ */
function checkAlerts() {
  if (!state.latest || !state.settings) return;
  const s = state.settings;
  const msgs = [];

  const lux = parseNum(state.latest.lux);
  if (lux !== null) {
    if (lux < s.lux_min) msgs.push(`💡 Low light: ${Math.round(lux)} lux`);
    if (lux > s.lux_max) msgs.push(`☀️ High light: ${Math.round(lux)} lux`);
  }

  SOIL_KEYS.forEach(key => {
    const pct = parseNum(state.latest[`${key}_pct`]);
    const minPct = s[`${key}_min_pct`];
    const name = s[`${key}_name`];
    if (pct !== null && pct < minPct) msgs.push(`🌵 ${name} is dry: ${pct.toFixed(1)}%`);
  });

  if (msgs.length) {
    alertMessage.textContent = msgs.join('  ·  ');
    alertBar.hidden = false;
  } else {
    alertBar.hidden = true;
  }
}

/* ═══════════════════════════════════════════════════════
   STATUS / LOADING / ERRORS
═══════════════════════════════════════════════════════ */
function setStatus(s) {
  statusDot.className = `status-dot ${s}`;
  const labels = { loading: 'Loading…', ok: 'Live', error: 'Error', warn: 'Stale' };
  statusText.textContent = labels[s] || s;
}

function showLoading(show) { loadingOverlay.classList.toggle('hidden', !show); }
function showError(msg) { errorMessage.textContent = msg; errorBanner.hidden = false; }
function hideError() { errorBanner.hidden = true; }

function updateFooter() {
  dataPoints.textContent = `${state.allFeeds.length.toLocaleString()} readings loaded`;
}

/* ═══════════════════════════════════════════════════════
   DATE / TIME HELPERS
═══════════════════════════════════════════════════════ */
function timeAgo(date) {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 10) return 'Just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return formatTime(date);
}

function formatTime(date) {
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function formatTooltipTime(date) {
  return date.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/* ═══════════════════════════════════════════════════════
   THEME
═══════════════════════════════════════════════════════ */
function toggleTheme() {
  const html = document.documentElement;
  const theme = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', theme);
  localStorage.setItem('rm-theme', theme);
  if (state.allFeeds.length) updateCharts();
}

function applyStoredTheme() {
  const saved = localStorage.getItem('rm-theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
}

/* ═══════════════════════════════════════════════════════
   EVENT LISTENERS
═══════════════════════════════════════════════════════ */
document.getElementById('themeBtn').addEventListener('click', toggleTheme);

document.getElementById('refreshBtn').addEventListener('click', async () => {
  const btn = document.getElementById('refreshBtn');
  btn.classList.add('spinning');
  await refresh();
  btn.classList.remove('spinning');
});

document.getElementById('dismissError').addEventListener('click', hideError);

document.querySelectorAll('.view-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.classList.contains('active')) return;
    document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.viewHours = parseInt(btn.dataset.hours, 10);
    state.viewBucket = btn.dataset.bucket;
    refresh();
  });
});

setInterval(() => {
  if (!state.allFeeds.length) return;
  const ts = new Date(state.allFeeds[state.allFeeds.length - 1].recorded_at);
  lastUpdated.textContent = timeAgo(ts);
}, 10_000);

/* ═══════════════════════════════════════════════════════
   BOOT
═══════════════════════════════════════════════════════ */
(async function init() {
  applyStoredTheme();
  await refresh(/* isFirst */ true);
  state.refreshTimer = setInterval(() => refresh(), CONFIG.refreshMs);
})();

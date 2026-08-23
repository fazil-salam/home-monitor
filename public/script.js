/* ═══════════════════════════════════════════════════════
   ROOM MONITOR DASHBOARD — script.js
   ESP32 + DHT11 → Node/Express + SQLite
   ═══════════════════════════════════════════════════════ */

/* ──────────────────────────────────────────────────────
   ★ CONFIG — edit only this section
   ────────────────────────────────────────────────────── */
const CONFIG = {
  apiBase:     '/homemonitor/api',
  refreshMs:   30_000,                      // 30 seconds
  tempWarning: { low: 15, high: 30 },       // °C alert thresholds
  humWarning:  { low: 20, high: 80 },       // % alert thresholds
};
/* ────────────────────────────────────────────────────── */

/* ── STATE ── */
const state = {
  allFeeds:      [],        // rows for the currently selected view (raw or server-aggregated)
  latest:        null,      // most recent 1-min live reading (from the ESP32, for the cards)
  prevLive:      null,      // previous live reading, for trend arrows
  viewHours:     24,        // currently selected window
  viewBucket:    '1h',      // currently selected aggregation ('none'|'30m'|'1h'|'4h'|'1d'|'1w')
  refreshTimer:  null,
  countdownTimer: null,
  countdown:     CONFIG.refreshMs / 1000,
  charts:        { temp: null, hum: null },
  lastFetchOk:   false,
};

/* ── DOM REFS ── */
const $ = id => document.getElementById(id);
const loadingOverlay  = $('loadingOverlay');
const errorBanner     = $('errorBanner');
const errorMessage    = $('errorMessage');
const statusDot       = $('statusDot');
const statusText      = $('statusText');
const currentTemp     = $('currentTemp');
const currentHum      = $('currentHum');
const tempTrend       = $('tempTrend');
const humTrend        = $('humTrend');
const lastUpdated     = $('lastUpdated');
const lastUpdatedAbs  = $('lastUpdatedAbs');
const countdown       = $('countdown');
const refreshBar      = $('refreshBar');
const dataPoints      = $('dataPoints');
const tempStats       = $('tempStats');
const humStats        = $('humStats');
const alertBar        = $('alertBar');
const alertMessage    = $('alertMessage');
const alertIcon       = $('alertIcon');

/* ═══════════════════════════════════════════════════════
   API
═══════════════════════════════════════════════════════ */
async function fetchData() {
  const params = new URLSearchParams({
    hours: state.viewHours,
    bucket: state.viewBucket,
  });
  if (state.viewBucket === '1d' || state.viewBucket === '1w') {
    // Date.prototype.getTimezoneOffset(): minutes to ADD to local time to reach UTC.
    params.set('tzOffsetMinutes', new Date().getTimezoneOffset());
  }
  const url = `${CONFIG.apiBase}/readings?${params}`;

  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error('Unexpected response from server');

  // Rows only land here once a 10-minute averaging window has been flushed
  // to the database, so this can legitimately be empty for the first few
  // minutes after the ESP32 starts sending — that's not an error.

  // Normalize server rows {temperature_c, humidity, recorded_at} into the
  // {created_at, field1, field2} shape the rest of this dashboard expects.
  return rows.map(r => ({
    created_at: r.recorded_at,
    field1: r.temperature_c,
    field2: r.humidity,
  }));
}

async function fetchLatest() {
  const res = await fetch(`${CONFIG.apiBase}/latest`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json(); // { temperature_c, humidity, recorded_at } | null
}

/* ═══════════════════════════════════════════════════════
   REFRESH CYCLE
═══════════════════════════════════════════════════════ */
async function refresh(isFirst = false) {
  setStatus('loading');
  if (isFirst) showLoading(true);

  try {
    const [feeds, live] = await Promise.all([fetchData(), fetchLatest()]);
    state.allFeeds = feeds;
    state.prevLive = state.latest;
    state.latest = live;
    state.lastFetchOk = true;

    hideError();
    updateCards();
    updateCharts();
    updateFooter();
    checkAlerts();
    setStatus('ok');
  } catch (err) {
    state.lastFetchOk = false;
    setStatus('error');
    showError(buildErrorMessage(err));
    console.error('[Dashboard] Fetch error:', err);
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

/* ── COUNTDOWN ── */
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
  /* restart animation by cloning */
  const bar = refreshBar;
  bar.style.animation = 'none';
  void bar.offsetWidth;   // reflow
  bar.style.animation = `progressDrain ${CONFIG.refreshMs / 1000}s linear`;
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
  const latest = state.latest; // live, minute-by-minute reading from the ESP32
  if (!latest) return;

  const prev = state.prevLive;
  const temp = parseNum(latest.temperature_c);
  const hum  = parseNum(latest.humidity);

  // Temperature card
  if (temp !== null) {
    setValueFlash(currentTemp, temp.toFixed(1));
    if (prev) {
      const diff = temp - parseNum(prev.temperature_c);
      setTrend(tempTrend, diff, '°C');
    }
  }

  // Humidity card
  if (hum !== null) {
    setValueFlash(currentHum, Math.round(hum));
    if (prev) {
      const diff = hum - parseNum(prev.humidity);
      setTrend(humTrend, diff, '%');
    }
  }

  // Timestamps
  const ts = new Date(latest.recorded_at);
  lastUpdated.textContent    = timeAgo(ts);
  lastUpdatedAbs.textContent = formatTime(ts);
}

function setValueFlash(el, val) {
  el.classList.remove('flash');
  void el.offsetWidth;
  el.textContent = val;
  el.classList.add('flash');
}

function setTrend(el, diff, unit) {
  if (diff === null || isNaN(diff)) { el.textContent = ''; return; }
  const abs = Math.abs(diff).toFixed(1);
  if (diff > 0.05) {
    el.className = 'card-trend trend-up';
    el.textContent = `↑ +${abs}${unit} from last`;
  } else if (diff < -0.05) {
    el.className = 'card-trend trend-down';
    el.textContent = `↓ −${abs}${unit} from last`;
  } else {
    el.className = 'card-trend trend-same';
    el.textContent = `→ steady`;
  }
}

/* ═══════════════════════════════════════════════════════
   UI — CHARTS
═══════════════════════════════════════════════════════ */
function updateCharts() {
  const feeds = state.allFeeds; // already the right window + aggregation for the current view

  const times = feeds.map(f => new Date(f.created_at));
  const temps = feeds.map(f => parseNum(f.field1));
  const hums  = feeds.map(f => parseNum(f.field2));

  renderChart('temp', times, temps, tempStats, '°C',
    getVar('--temp-color'), getVar('--temp-glow'));

  renderChart('hum',  times, hums,  humStats,  '%',
    getVar('--hum-color'),  getVar('--hum-glow'));
}

function renderChart(key, times, values, statsEl, unit, color, glow) {
  const ctx = document.getElementById(key === 'temp' ? 'tempChart' : 'humChart').getContext('2d');

  /* stats */
  const st = calcStats(values);
  updateStatsChips(statsEl, st, unit);

  /* build chart points (skip nulls) */
  const points = times
    .map((t, i) => values[i] !== null ? { x: t, y: values[i] } : null)
    .filter(Boolean);

  if (!points.length) return;

  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  const gridColor  = isLight ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.06)';
  const tickColor  = isLight ? '#64748b' : '#64748b';
  const tooltip_bg = isLight ? '#ffffff' : '#1e293b';
  const tooltip_text = isLight ? '#0f172a' : '#f1f5f9';

  /* gradient fill */
  const gradient = ctx.createLinearGradient(0, 0, 0, 260);
  gradient.addColorStop(0, glow.replace('0.25', '0.45'));
  gradient.addColorStop(1, glow.replace('0.25', '0.02'));

  const chartData = {
    datasets: [{
      label: key === 'temp' ? `Temperature (${unit})` : `Humidity (${unit})`,
      data: points,
      borderColor: color,
      backgroundColor: gradient,
      borderWidth: 2.2,
      pointRadius: points.length > 150 ? 0 : 2.5,
      pointHoverRadius: 6,
      pointBackgroundColor: color,
      pointBorderColor: tooltip_bg,
      pointBorderWidth: 2,
      fill: true,
      tension: 0.35,
      spanGaps: true,
    }]
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: tooltip_bg,
        titleColor: tickColor,
        bodyColor: tooltip_text,
        borderColor: color,
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
          displayFormats: {
            minute: 'h:mm a',
            hour:   'h a',
            day:    'MMM d',
            month:  'MMM yyyy',
          }
        },
        grid: { color: gridColor, drawBorder: false },
        ticks: { color: tickColor, maxTicksLimit: 8, maxRotation: 0 },
        border: { display: false },
      },
      y: {
        grid: { color: gridColor, drawBorder: false },
        ticks: {
          color: tickColor,
          callback: v => `${Math.round(v * 10) / 10}${unit}`,
          maxTicksLimit: 6,
        },
        border: { display: false },
      }
    },
    animation: { duration: 400 },
  };

  if (state.charts[key]) {
    state.charts[key].data = chartData;
    state.charts[key].options = options;
    state.charts[key].update('active');
  } else {
    state.charts[key] = new Chart(ctx, { type: 'line', data: chartData, options });
  }
}

function resolveTimeUnit(hours) {
  if (hours <= 1)   return 'minute';
  if (hours <= 24)  return 'hour';
  if (hours <= 720) return 'day';   // Week, Month
  return 'month';                   // Year
}

function getVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/* ═══════════════════════════════════════════════════════
   UI — STATS CHIPS
═══════════════════════════════════════════════════════ */
function updateStatsChips(el, st, unit) {
  const chips = el.querySelectorAll('.stat-chip');
  if (st.min === null) { chips.forEach(c => { c.textContent = '— ' + c.title; }); return; }

  // Figure out which field these chips are for
  const isHum = unit === '%';
  const fmt = v => isHum ? `${Math.round(v)}${unit}` : `${v.toFixed(1)}${unit}`;

  chips[0].textContent = `${fmt(st.min)} min`;
  chips[1].textContent = `${fmt(st.avg)} avg`;
  chips[2].textContent = `${fmt(st.max)} max`;
}

/* ═══════════════════════════════════════════════════════
   ALERTS
═══════════════════════════════════════════════════════ */
function checkAlerts() {
  if (!state.latest) return;
  const temp = parseNum(state.latest.temperature_c);
  const hum  = parseNum(state.latest.humidity);
  const msgs = [];

  if (temp !== null) {
    if (temp > CONFIG.tempWarning.high) msgs.push(`🌡️ High temperature: ${temp.toFixed(1)}°C`);
    if (temp < CONFIG.tempWarning.low)  msgs.push(`❄️ Low temperature: ${temp.toFixed(1)}°C`);
  }
  if (hum !== null) {
    if (hum > CONFIG.humWarning.high) msgs.push(`💧 High humidity: ${Math.round(hum)}%`);
    if (hum < CONFIG.humWarning.low)  msgs.push(`🌵 Low humidity: ${Math.round(hum)}%`);
  }

  if (msgs.length) {
    alertMessage.textContent = msgs.join('  ·  ');
    alertBar.hidden = false;
  } else {
    alertBar.hidden = true;
  }
}

/* ═══════════════════════════════════════════════════════
   STATUS
═══════════════════════════════════════════════════════ */
function setStatus(s) {
  statusDot.className = `status-dot ${s}`;
  const labels = { loading: 'Loading…', ok: 'Live', error: 'Error', warn: 'Stale' };
  statusText.textContent = labels[s] || s;
}

/* ═══════════════════════════════════════════════════════
   LOADING / ERRORS
═══════════════════════════════════════════════════════ */
function showLoading(show) {
  loadingOverlay.classList.toggle('hidden', !show);
}

function showError(msg) {
  errorMessage.textContent = msg;
  errorBanner.hidden = false;
}

function hideError() {
  errorBanner.hidden = true;
}

/* ═══════════════════════════════════════════════════════
   FOOTER
═══════════════════════════════════════════════════════ */
function updateFooter() {
  dataPoints.textContent = `${state.allFeeds.length.toLocaleString()} readings loaded`;
}

/* ═══════════════════════════════════════════════════════
   DATE / TIME HELPERS
═══════════════════════════════════════════════════════ */
function timeAgo(date) {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 10)  return 'Just now';
  if (seconds < 60)  return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)  return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24)    return `${hours}h ago`;
  return formatTime(date);
}

function formatTime(date) {
  return date.toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function formatTooltipTime(date) {
  return date.toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

/* ═══════════════════════════════════════════════════════
   CSV EXPORT
═══════════════════════════════════════════════════════ */
function downloadCSV() {
  if (!state.allFeeds.length) return;
  const rows = ['Timestamp,Temperature (°C),Humidity (%)'];
  state.allFeeds.forEach(f => {
    rows.push(`${f.created_at},${f.field1 ?? ''},${f.field2 ?? ''}`);
  });
  const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `room-monitor-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ═══════════════════════════════════════════════════════
   THEME
═══════════════════════════════════════════════════════ */
function toggleTheme() {
  const html  = document.documentElement;
  const theme = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', theme);
  localStorage.setItem('rm-theme', theme);
  // Rebuild charts so colours update
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

document.getElementById('csvBtn').addEventListener('click', downloadCSV);

document.getElementById('dismissError').addEventListener('click', hideError);

document.querySelectorAll('.view-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.classList.contains('active')) return;
    document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.viewHours = parseInt(btn.dataset.hours, 10);
    state.viewBucket = btn.dataset.bucket;
    // Different views pull different windows/aggregations from the server,
    // so this needs a real refetch, not just a re-render of cached data.
    refresh();
  });
});

/* ── LAST-UPDATED RELATIVE TIMER (refreshes every 10s) ── */
setInterval(() => {
  if (!state.allFeeds.length) return;
  const ts = new Date(state.allFeeds[state.allFeeds.length - 1].created_at);
  lastUpdated.textContent = timeAgo(ts);
}, 10_000);

/* ═══════════════════════════════════════════════════════
   BOOT
═══════════════════════════════════════════════════════ */
(async function init() {
  applyStoredTheme();

  await refresh(/* isFirst */ true);

  // Schedule auto-refresh
  state.refreshTimer = setInterval(() => refresh(), CONFIG.refreshMs);
})();

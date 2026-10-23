/* ═══════════════════════════════════════════════════════
   PLANT SETTINGS — script.js
   Channel names, per-channel dry/wet calibration, thresholds
   ═══════════════════════════════════════════════════════ */

const API_BASE = '/homemonitor/api';
const SOIL_KEYS = ['soil1', 'soil2', 'soil3', 'soil4'];
const SOIL_COLOR_VARS = ['--soil1-color', '--soil2-color', '--soil3-color', '--soil4-color'];

const $ = id => document.getElementById(id);
const soilChannels = $('soilChannels');
const errorBanner  = $('errorBanner');
const errorMessage = $('errorMessage');
const saveStatus   = $('saveStatus');

function getVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function buildChannelRow(key, index) {
  const label = key.charAt(0).toUpperCase() + key.slice(1);
  return `
    <div class="soil-channel" data-key="${key}">
      <div class="soil-channel-name">
        <span class="dot" style="background:${getVar(SOIL_COLOR_VARS[index])}"></span>
        <input type="text" id="${key}_name" maxlength="40" required placeholder="e.g. Monstera" />
      </div>
      <div class="soil-channel-calib">
        <div class="calib-field">
          <div class="settings-field">
            <span>Dry raw value (0-4095)</span>
            <input type="number" id="${key}_dry" min="0" max="4095" step="1" required />
          </div>
          <button type="button" class="capture-btn" data-key="${key}" data-target="dry">Use current as Dry</button>
        </div>
        <div class="calib-field">
          <div class="settings-field">
            <span>Wet raw value (0-4095)</span>
            <input type="number" id="${key}_wet" min="0" max="4095" step="1" required />
          </div>
          <button type="button" class="capture-btn" data-key="${key}" data-target="wet">Use current as Wet</button>
        </div>
      </div>
      <div class="settings-field">
        <span>Dry-soil alert threshold (%)</span>
        <input type="number" id="${key}_min_pct" min="0" max="100" step="1" required />
      </div>
    </div>
  `;
}

function populateForm(settings) {
  SOIL_KEYS.forEach(key => {
    $(`${key}_name`).value = settings[`${key}_name`];
    $(`${key}_dry`).value = settings[`${key}_dry`];
    $(`${key}_wet`).value = settings[`${key}_wet`];
    $(`${key}_min_pct`).value = settings[`${key}_min_pct`];
  });
  $('luxMin').value = settings.lux_min;
  $('luxMax').value = settings.lux_max;
}

async function loadSettings() {
  const res = await fetch(`${API_BASE}/plant-settings`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function captureCurrentRaw(key) {
  const res = await fetch(`${API_BASE}/plant-latest`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const latest = await res.json();
  if (!latest) throw new Error('No live reading yet — wait for the next sensor update.');
  return latest[`${key}_raw`];
}

async function saveSettings(payload, password) {
  const res = await fetch(`${API_BASE}/plant-settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-settings-password': password },
    body: JSON.stringify(payload),
  });
  if (res.status === 401) {
    sessionStorage.removeItem('settingsPassword');
    throw new Error('Wrong settings password.');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function readFormPayload() {
  const payload = { lux_min: parseFloat($('luxMin').value), lux_max: parseFloat($('luxMax').value) };
  SOIL_KEYS.forEach(key => {
    payload[`${key}_name`] = $(`${key}_name`).value;
    payload[`${key}_dry`] = parseInt($(`${key}_dry`).value, 10);
    payload[`${key}_wet`] = parseInt($(`${key}_wet`).value, 10);
    payload[`${key}_min_pct`] = parseFloat($(`${key}_min_pct`).value);
  });
  return payload;
}

function showError(msg) {
  errorMessage.textContent = msg;
  errorBanner.hidden = false;
}
function hideError() { errorBanner.hidden = true; }

function toggleTheme() {
  const html = document.documentElement;
  const theme = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', theme);
  localStorage.setItem('rm-theme', theme);
}
function applyStoredTheme() {
  const saved = localStorage.getItem('rm-theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
}

/* ── EVENTS ── */
document.getElementById('themeBtn').addEventListener('click', toggleTheme);
document.getElementById('dismissError').addEventListener('click', hideError);

soilChannels.addEventListener('click', async (e) => {
  const btn = e.target.closest('.capture-btn');
  if (!btn) return;
  const { key, target } = btn.dataset;
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Reading…';
  try {
    const raw = await captureCurrentRaw(key);
    $(`${key}_${target}`).value = raw;
  } catch (err) {
    showError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
});

document.getElementById('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  saveStatus.textContent = 'Saving…';
  saveStatus.className = 'save-status';
  try {
    const payload = readFormPayload();
    const password = $('settingsPassword').value;
    const saved = await saveSettings(payload, password);
    sessionStorage.setItem('settingsPassword', password);
    populateForm(saved);
    saveStatus.textContent = 'Saved.';
    saveStatus.className = 'save-status ok';
  } catch (err) {
    saveStatus.textContent = `Failed: ${err.message}`;
    saveStatus.className = 'save-status error';
  }
});

/* ── BOOT ── */
(async function init() {
  applyStoredTheme();
  soilChannels.innerHTML = SOIL_KEYS.map(buildChannelRow).join('');
  $('settingsPassword').value = sessionStorage.getItem('settingsPassword') || '';
  try {
    const settings = await loadSettings();
    populateForm(settings);
    hideError();
  } catch (err) {
    showError(`Could not load settings: ${err.message}`);
  }
})();

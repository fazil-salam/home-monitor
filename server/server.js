const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3002;
const API_KEY = process.env.HOME_MONITOR_API_KEY;
const SETTINGS_PASSWORD = process.env.HOME_MONITOR_SETTINGS_PASSWORD;
const DB_PATH = process.env.HOME_MONITOR_DB_PATH || path.join(__dirname, '..', 'data', 'homemonitor.db');
const STORE_INTERVAL_MS = 10 * 60 * 1000; // persist an average every 10 minutes

if (!API_KEY) {
  console.error('HOME_MONITOR_API_KEY is not set');
  process.exit(1);
}

if (!SETTINGS_PASSWORD) {
  console.error('HOME_MONITOR_SETTINGS_PASSWORD is not set');
  process.exit(1);
}

// Hash both sides so timingSafeEqual gets equal-length buffers regardless of input length.
function safeEqual(a, b) {
  const ah = crypto.createHash('sha256').update(String(a)).digest();
  const bh = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ah, bh);
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    temperature_c REAL NOT NULL,
    humidity REAL NOT NULL,
    recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX IF NOT EXISTS idx_readings_recorded_at ON readings(recorded_at);

  CREATE TABLE IF NOT EXISTS plant_readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lux REAL NOT NULL,
    soil1_pct REAL NOT NULL,
    soil2_pct REAL NOT NULL,
    soil3_pct REAL NOT NULL,
    soil4_pct REAL NOT NULL,
    recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX IF NOT EXISTS idx_plant_readings_recorded_at ON plant_readings(recorded_at);

  CREATE TABLE IF NOT EXISTS plant_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    soil1_name TEXT NOT NULL DEFAULT 'Soil 1',
    soil2_name TEXT NOT NULL DEFAULT 'Soil 2',
    soil3_name TEXT NOT NULL DEFAULT 'Soil 3',
    soil4_name TEXT NOT NULL DEFAULT 'Soil 4',
    soil1_dry INTEGER NOT NULL DEFAULT 3000,
    soil1_wet INTEGER NOT NULL DEFAULT 1200,
    soil2_dry INTEGER NOT NULL DEFAULT 3000,
    soil2_wet INTEGER NOT NULL DEFAULT 1200,
    soil3_dry INTEGER NOT NULL DEFAULT 3000,
    soil3_wet INTEGER NOT NULL DEFAULT 1200,
    soil4_dry INTEGER NOT NULL DEFAULT 3000,
    soil4_wet INTEGER NOT NULL DEFAULT 1200,
    soil1_min_pct REAL NOT NULL DEFAULT 20,
    soil2_min_pct REAL NOT NULL DEFAULT 20,
    soil3_min_pct REAL NOT NULL DEFAULT 20,
    soil4_min_pct REAL NOT NULL DEFAULT 20,
    lux_min REAL NOT NULL DEFAULT 200,
    lux_max REAL NOT NULL DEFAULT 20000
  );
  INSERT OR IGNORE INTO plant_settings (id) VALUES (1);
`);

const insertReading = db.prepare(
  'INSERT INTO readings (temperature_c, humidity) VALUES (?, ?)'
);
const insertPlantReading = db.prepare(
  'INSERT INTO plant_readings (lux, soil1_pct, soil2_pct, soil3_pct, soil4_pct) VALUES (?, ?, ?, ?, ?)'
);

// Fixed-size time buckets (seconds) for re-aggregating stored readings so
// wide ranges (Week/Month/Year) don't ship thousands of raw 10-min rows to
// the browser. '1d' is handled separately below since day boundaries need
// to respect the viewer's local timezone, not a fixed-size UTC window.
const FIXED_BUCKET_SECONDS = { '30m': 1800, '1h': 3600, '4h': 14400 };

// tzOffsetSec shifts each UTC timestamp into the viewer's local wall-clock
// before truncating to a period, then shifts the bucket label back to UTC —
// so each row's recorded_at is the real UTC instant of local midnight for
// that period's start, which every browser will then render in its own
// local time. Used for '1d' (Month view) and '1w' (Year view) — both need
// local-timezone-aware boundaries, unlike the fixed UTC buckets above.
const LOCAL_PERIOD_SECONDS = { '1d': 86400, '1w': 7 * 86400 };

// Builds the same family of prepared statements (raw select, fixed-size
// UTC buckets, local-timezone-aware buckets) for a table + set of columns
// to average. Used for both `readings` and `plant_readings` so the bucket
// SQL — including the better-sqlite3 REAL-vs-INTEGER CAST fix — only
// exists in one place.
function makeReadingStore(table, columns) {
  const colList = columns.join(', ');
  const avgList = columns.map(c => `AVG(${c}) AS ${c}`).join(',\n      ');

  const selectSince = db.prepare(
    `SELECT id, ${colList}, recorded_at FROM ${table} WHERE recorded_at >= ? ORDER BY recorded_at ASC`
  );
  const selectLatest = db.prepare(
    `SELECT id, ${colList}, recorded_at FROM ${table} ORDER BY recorded_at DESC LIMIT 1`
  );

  const fixedBucketStmts = {};
  for (const [key, seconds] of Object.entries(FIXED_BUCKET_SECONDS)) {
    fixedBucketStmts[key] = db.prepare(`
      SELECT
        strftime('%Y-%m-%dT%H:%M:%fZ', (CAST(strftime('%s', recorded_at) AS INTEGER) / ${seconds}) * ${seconds}, 'unixepoch') AS recorded_at,
        ${avgList}
      FROM ${table}
      WHERE recorded_at >= ?
      GROUP BY CAST(strftime('%s', recorded_at) AS INTEGER) / ${seconds}
      ORDER BY recorded_at ASC
    `);
  }

  const localPeriodStmts = {};
  for (const [key, seconds] of Object.entries(LOCAL_PERIOD_SECONDS)) {
    // better-sqlite3 binds plain JS numbers as SQLite REAL by default (even
    // whole numbers), which would silently turn this integer division into
    // floating-point division and break the grouping. CAST(? AS INTEGER)
    // forces the bound value back to an integer before the arithmetic.
    localPeriodStmts[key] = db.prepare(`
      SELECT
        strftime('%Y-%m-%dT%H:%M:%fZ', ((CAST(strftime('%s', recorded_at) AS INTEGER) - CAST(? AS INTEGER)) / ${seconds}) * ${seconds} + CAST(? AS INTEGER), 'unixepoch') AS recorded_at,
        ${avgList}
      FROM ${table}
      WHERE recorded_at >= ?
      GROUP BY (CAST(strftime('%s', recorded_at) AS INTEGER) - CAST(? AS INTEGER)) / ${seconds}
      ORDER BY recorded_at ASC
    `);
  }

  return { selectSince, selectLatest, fixedBucketStmts, localPeriodStmts };
}

function queryReadings(store, req) {
  const hours = Math.min(Math.max(parseInt(req.query.hours, 10) || 24, 1), 24 * 366);
  const sinceIso = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const bucket = req.query.bucket;

  if (store.localPeriodStmts[bucket]) {
    // getTimezoneOffset() convention: minutes to ADD to local time to reach UTC.
    const tzOffsetMinutes = Math.max(-840, Math.min(840, parseInt(req.query.tzOffsetMinutes, 10) || 0));
    const tzOffsetSec = tzOffsetMinutes * 60;
    return store.localPeriodStmts[bucket].all(tzOffsetSec, tzOffsetSec, sinceIso, tzOffsetSec);
  }
  if (store.fixedBucketStmts[bucket]) {
    return store.fixedBucketStmts[bucket].all(sinceIso);
  }
  return store.selectSince.all(sinceIso);
}

const readingsStore = makeReadingStore('readings', ['temperature_c', 'humidity']);
const plantStore = makeReadingStore('plant_readings', ['lux', 'soil1_pct', 'soil2_pct', 'soil3_pct', 'soil4_pct']);

// ── Plant settings (channel names, per-channel calibration, thresholds) ──
const selectPlantSettings = db.prepare('SELECT * FROM plant_settings WHERE id = 1');
const updatePlantSettingsStmt = db.prepare(`
  UPDATE plant_settings SET
    soil1_name = ?, soil2_name = ?, soil3_name = ?, soil4_name = ?,
    soil1_dry = ?, soil1_wet = ?, soil2_dry = ?, soil2_wet = ?,
    soil3_dry = ?, soil3_wet = ?, soil4_dry = ?, soil4_wet = ?,
    soil1_min_pct = ?, soil2_min_pct = ?, soil3_min_pct = ?, soil4_min_pct = ?,
    lux_min = ?, lux_max = ?
  WHERE id = 1
`);

// Cached in memory so every plant-reading POST doesn't hit the DB just to
// convert raw ADC -> %; refreshed whenever settings are read or written.
let plantSettings = selectPlantSettings.get();

function rawToPct(raw, dryRaw, wetRaw) {
  if (dryRaw === wetRaw) return 0;
  const pct = ((dryRaw - raw) / (dryRaw - wetRaw)) * 100;
  return Math.min(100, Math.max(0, pct));
}

// The ESP32 POSTs once a minute. Every POST updates `latest`/`latestPlant`
// immediately (so the dashboards' live cards reflect it within one refresh
// cycle), but only the average of the samples collected in each 10-minute
// window gets written to the database, via the flush() timer below.
let latest = null; // { temperature_c, humidity, recorded_at }
let bufferTempSum = 0;
let bufferHumSum = 0;
let bufferCount = 0;

let latestPlant = null; // { lux, soil1_raw..soil4_raw, soil1_pct..soil4_pct, recorded_at }
let bufferLuxSum = 0;
let bufferSoilPctSum = [0, 0, 0, 0];
let bufferPlantCount = 0;

const round1 = n => Math.round(n * 10) / 10;

function flush() {
  if (bufferCount > 0) {
    insertReading.run(round1(bufferTempSum / bufferCount), round1(bufferHumSum / bufferCount));
    bufferTempSum = 0;
    bufferHumSum = 0;
    bufferCount = 0;
  }

  if (bufferPlantCount > 0) {
    insertPlantReading.run(
      round1(bufferLuxSum / bufferPlantCount),
      round1(bufferSoilPctSum[0] / bufferPlantCount),
      round1(bufferSoilPctSum[1] / bufferPlantCount),
      round1(bufferSoilPctSum[2] / bufferPlantCount),
      round1(bufferSoilPctSum[3] / bufferPlantCount)
    );
    bufferLuxSum = 0;
    bufferSoilPctSum = [0, 0, 0, 0];
    bufferPlantCount = 0;
  }
}

// Align flushes to wall-clock 10-minute marks (:00, :10, :20, ...) rather
// than a rolling window measured from server startup, using a recursive
// setTimeout (immune to setInterval drift) instead of setInterval.
let flushTimer = null;

function scheduleFlush() {
  const msUntilNextBoundary = STORE_INTERVAL_MS - (Date.now() % STORE_INTERVAL_MS);
  flushTimer = setTimeout(() => {
    flush();
    scheduleFlush();
  }, msUntilNextBoundary);
}

scheduleFlush();

const app = express();
app.use(express.json());

app.post('/api/readings', (req, res) => {
  if (req.get('x-api-key') !== API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { temperature_c, humidity } = req.body || {};
  if (
    typeof temperature_c !== 'number' || !Number.isFinite(temperature_c) ||
    typeof humidity !== 'number' || !Number.isFinite(humidity) ||
    temperature_c < -40 || temperature_c > 80 ||
    humidity < 0 || humidity > 100
  ) {
    return res.status(400).json({ error: 'invalid temperature_c or humidity' });
  }

  latest = { temperature_c, humidity, recorded_at: new Date().toISOString() };
  bufferTempSum += temperature_c;
  bufferHumSum += humidity;
  bufferCount += 1;

  res.status(202).json({ buffered: true, pendingSamples: bufferCount });
});

app.get('/api/readings', (req, res) => {
  res.json(queryReadings(readingsStore, req));
});

// Live "current" reading — reflects the most recent minute-by-minute POST,
// not yet averaged/persisted. Falls back to the last stored row if the
// server just restarted and no POST has arrived yet.
app.get('/api/latest', (req, res) => {
  res.json(latest || readingsStore.selectLatest.get() || null);
});

app.post('/api/plant-readings', (req, res) => {
  if (req.get('x-api-key') !== API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { lux, soil1, soil2, soil3, soil4 } = req.body || {};
  const rawValues = [soil1, soil2, soil3, soil4];
  const validSoil = rawValues.every(
    v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 4095
  );
  if (
    typeof lux !== 'number' || !Number.isFinite(lux) || lux < 0 || lux > 100000 ||
    !validSoil
  ) {
    return res.status(400).json({ error: 'invalid lux or soil reading' });
  }

  const s = plantSettings;
  const pct = [
    rawToPct(soil1, s.soil1_dry, s.soil1_wet),
    rawToPct(soil2, s.soil2_dry, s.soil2_wet),
    rawToPct(soil3, s.soil3_dry, s.soil3_wet),
    rawToPct(soil4, s.soil4_dry, s.soil4_wet),
  ];

  latestPlant = {
    lux,
    soil1_raw: soil1, soil2_raw: soil2, soil3_raw: soil3, soil4_raw: soil4,
    soil1_pct: round1(pct[0]), soil2_pct: round1(pct[1]),
    soil3_pct: round1(pct[2]), soil4_pct: round1(pct[3]),
    recorded_at: new Date().toISOString(),
  };

  bufferLuxSum += lux;
  bufferSoilPctSum[0] += pct[0];
  bufferSoilPctSum[1] += pct[1];
  bufferSoilPctSum[2] += pct[2];
  bufferSoilPctSum[3] += pct[3];
  bufferPlantCount += 1;

  res.status(202).json({ buffered: true, pendingSamples: bufferPlantCount });
});

app.get('/api/plant-readings', (req, res) => {
  res.json(queryReadings(plantStore, req));
});

app.get('/api/plant-latest', (req, res) => {
  res.json(latestPlant || plantStore.selectLatest.get() || null);
});

app.get('/api/plant-settings', (req, res) => {
  res.json(plantSettings);
});

app.put('/api/plant-settings', (req, res) => {
  if (!safeEqual(req.get('x-settings-password') || '', SETTINGS_PASSWORD)) {
    return res.status(401).json({ error: 'wrong settings password' });
  }

  const b = req.body || {};
  const names = [b.soil1_name, b.soil2_name, b.soil3_name, b.soil4_name];
  const calib = [
    b.soil1_dry, b.soil1_wet, b.soil2_dry, b.soil2_wet,
    b.soil3_dry, b.soil3_wet, b.soil4_dry, b.soil4_wet,
  ];
  const minPct = [b.soil1_min_pct, b.soil2_min_pct, b.soil3_min_pct, b.soil4_min_pct];
  const luxRange = [b.lux_min, b.lux_max];

  const validNames = names.every(n => typeof n === 'string' && n.trim().length > 0 && n.length <= 40);
  const validCalib = calib.every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 4095);
  const validMinPct = minPct.every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100);
  const validLux = luxRange.every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100000)
    && luxRange[0] < luxRange[1];

  if (!validNames || !validCalib || !validMinPct || !validLux) {
    return res.status(400).json({ error: 'invalid settings payload' });
  }

  updatePlantSettingsStmt.run(
    names[0].trim(), names[1].trim(), names[2].trim(), names[3].trim(),
    ...calib,
    ...minPct,
    ...luxRange
  );
  plantSettings = selectPlantSettings.get();
  res.json(plantSettings);
});

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`home-monitor server listening on 127.0.0.1:${PORT}`);
});

function shutdown() {
  clearTimeout(flushTimer);
  flush(); // don't lose a partial averaging window on restart/deploy
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

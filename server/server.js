const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const PORT = process.env.PORT || 3002;
const API_KEY = process.env.HOME_MONITOR_API_KEY;
const DB_PATH = process.env.HOME_MONITOR_DB_PATH || path.join(__dirname, '..', 'data', 'homemonitor.db');
const STORE_INTERVAL_MS = 10 * 60 * 1000; // persist an average every 10 minutes

if (!API_KEY) {
  console.error('HOME_MONITOR_API_KEY is not set');
  process.exit(1);
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
`);

const insertReading = db.prepare(
  'INSERT INTO readings (temperature_c, humidity) VALUES (?, ?)'
);
const selectSince = db.prepare(
  'SELECT id, temperature_c, humidity, recorded_at FROM readings WHERE recorded_at >= ? ORDER BY recorded_at ASC'
);
const selectLatest = db.prepare(
  'SELECT id, temperature_c, humidity, recorded_at FROM readings ORDER BY recorded_at DESC LIMIT 1'
);

// Fixed-size time buckets (seconds) for re-aggregating stored readings so
// wide ranges (Week/Month/Year) don't ship thousands of raw 10-min rows to
// the browser. '1d' is handled separately below since day boundaries need
// to respect the viewer's local timezone, not a fixed-size UTC window.
const FIXED_BUCKET_SECONDS = { '30m': 1800, '1h': 3600, '4h': 14400 };

const fixedBucketStmts = {};
for (const [key, seconds] of Object.entries(FIXED_BUCKET_SECONDS)) {
  fixedBucketStmts[key] = db.prepare(`
    SELECT
      strftime('%Y-%m-%dT%H:%M:%fZ', (CAST(strftime('%s', recorded_at) AS INTEGER) / ${seconds}) * ${seconds}, 'unixepoch') AS recorded_at,
      AVG(temperature_c) AS temperature_c,
      AVG(humidity) AS humidity
    FROM readings
    WHERE recorded_at >= ?
    GROUP BY CAST(strftime('%s', recorded_at) AS INTEGER) / ${seconds}
    ORDER BY recorded_at ASC
  `);
}

// tzOffsetSec shifts each UTC timestamp into the viewer's local wall-clock
// before truncating to a period, then shifts the bucket label back to UTC —
// so each row's recorded_at is the real UTC instant of local midnight for
// that period's start, which every browser will then render in its own
// local time. Used for '1d' (Month view) and '1w' (Year view) — both need
// local-timezone-aware boundaries, unlike the fixed UTC buckets above.
const LOCAL_PERIOD_SECONDS = { '1d': 86400, '1w': 7 * 86400 };

const localPeriodStmts = {};
for (const [key, seconds] of Object.entries(LOCAL_PERIOD_SECONDS)) {
  // better-sqlite3 binds plain JS numbers as SQLite REAL by default (even
  // whole numbers), which would silently turn this integer division into
  // floating-point division and break the grouping. CAST(? AS INTEGER)
  // forces the bound value back to an integer before the arithmetic.
  localPeriodStmts[key] = db.prepare(`
    SELECT
      strftime('%Y-%m-%dT%H:%M:%fZ', ((CAST(strftime('%s', recorded_at) AS INTEGER) - CAST(? AS INTEGER)) / ${seconds}) * ${seconds} + CAST(? AS INTEGER), 'unixepoch') AS recorded_at,
      AVG(temperature_c) AS temperature_c,
      AVG(humidity) AS humidity
    FROM readings
    WHERE recorded_at >= ?
    GROUP BY (CAST(strftime('%s', recorded_at) AS INTEGER) - CAST(? AS INTEGER)) / ${seconds}
    ORDER BY recorded_at ASC
  `);
}

// The ESP32 POSTs once a minute. Every POST updates `latest` immediately
// (so the dashboard's live cards reflect it within one refresh cycle), but
// only the average of the samples collected in each 10-minute window gets
// written to the database, via the flush() timer below.
let latest = null; // { temperature_c, humidity, recorded_at }
let bufferTempSum = 0;
let bufferHumSum = 0;
let bufferCount = 0;

const round1 = n => Math.round(n * 10) / 10;

function flush() {
  if (bufferCount === 0) return;
  insertReading.run(round1(bufferTempSum / bufferCount), round1(bufferHumSum / bufferCount));
  bufferTempSum = 0;
  bufferHumSum = 0;
  bufferCount = 0;
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
  const hours = Math.min(Math.max(parseInt(req.query.hours, 10) || 24, 1), 24 * 366);
  const sinceIso = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const bucket = req.query.bucket;

  let rows;
  if (localPeriodStmts[bucket]) {
    // getTimezoneOffset() convention: minutes to ADD to local time to reach UTC.
    const tzOffsetMinutes = Math.max(-840, Math.min(840, parseInt(req.query.tzOffsetMinutes, 10) || 0));
    const tzOffsetSec = tzOffsetMinutes * 60;
    rows = localPeriodStmts[bucket].all(tzOffsetSec, tzOffsetSec, sinceIso, tzOffsetSec);
  } else if (fixedBucketStmts[bucket]) {
    rows = fixedBucketStmts[bucket].all(sinceIso);
  } else {
    rows = selectSince.all(sinceIso);
  }

  res.json(rows);
});

// Live "current" reading — reflects the most recent minute-by-minute POST,
// not yet averaged/persisted. Falls back to the last stored row if the
// server just restarted and no POST has arrived yet.
app.get('/api/latest', (req, res) => {
  res.json(latest || selectLatest.get() || null);
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

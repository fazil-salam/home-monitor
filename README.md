# Home Monitor

ESP32 + DHT11 temperature/humidity monitoring station. The ESP32 samples
every minute and posts to a Node/Express API, which buffers those samples
in memory (for a live dashboard) and persists a 10-minute average to
SQLite. A static dashboard shows live readings plus historical trends at
several aggregation levels (raw, 30-min, 1-hour, 4-hour, daily, weekly).

Live at: https://iot.crestlanegroup.com/homemonitor/

## Structure

- `firmware/` — Arduino sketch for the ESP32 (DHT11 sensor → HTTPS POST)
- `server/` — Node/Express API + SQLite storage (`server.js`)
- `public/` — static dashboard (vanilla JS + Chart.js)
- `deploy/` — reference copies of the systemd unit and nginx site config
  used on the production server (secrets replaced with placeholders)

## Server API

- `POST /api/readings` — ingest a reading (`x-api-key` header required).
  Buffers in memory; not written to the DB until the next 10-minute flush.
- `GET /api/readings?hours=N&bucket=X&tzOffsetMinutes=M` — historical
  readings. `bucket` is one of `none|30m|1h|4h|1d|1w`; `1d`/`1w` need
  `tzOffsetMinutes` (`Date.prototype.getTimezoneOffset()`) for
  local-timezone-aware day/week boundaries.
- `GET /api/latest` — most recent live (pre-average) reading, for the
  dashboard's current-value cards.

## Deploying

1. `cd server && npm install`
2. Set `HOME_MONITOR_API_KEY`, `PORT`, `HOME_MONITOR_DB_PATH` (see
   `deploy/home-monitor.service` for the systemd setup used in prod)
3. Point nginx at `public/` and proxy `/api/` to the Node process (see
   `deploy/nginx-homemonitor.conf`)
4. Fill in real WiFi credentials and the API key in
   `firmware/esp32_dht11_home_monitor.ino` before flashing the ESP32

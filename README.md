# Home Monitor

ESP32-based sensor station with two panels: **Room** (DHT11 temperature/
humidity) and **Plant Health** (BH1750 light + 4x capacitive soil moisture).
Both share one ESP32 and one read cadence — the device samples every
minute and posts to a Node/Express API, which buffers samples in memory
(for the live dashboards) and persists a 10-minute average to SQLite. Each
dashboard shows live readings plus historical trends at several
aggregation levels (raw, 30-min, 1-hour, 4-hour, daily, weekly).

Live at: https://iot.crestlanegroup.com/homemonitor/

## Structure

- `firmware/` — Arduino sketch for the ESP32 (DHT11 + BH1750 + 4 soil
  sensors → HTTPS POST)
- `server/` — Node/Express API + SQLite storage (`server.js`)
- `public/` — static dashboards (vanilla JS + Chart.js): `/` (room),
  `/plant/` (plant health), `/settings/` (plant channel names,
  calibration, alert thresholds)
- `deploy/` — reference copies of the systemd unit and nginx site config
  used on the production server (secrets replaced with placeholders)

## Server API

Room (temperature/humidity):
- `POST /api/readings` — ingest a reading (`x-api-key` header required).
  Buffers in memory; not written to the DB until the next 10-minute flush.
- `GET /api/readings?hours=N&bucket=X&tzOffsetMinutes=M` — historical
  readings. `bucket` is one of `none|30m|1h|4h|1d|1w`; `1d`/`1w` need
  `tzOffsetMinutes` (`Date.prototype.getTimezoneOffset()`) for
  local-timezone-aware day/week boundaries.
- `GET /api/latest` — most recent live (pre-average) reading, for the
  dashboard's current-value cards.

Plant health (light + soil moisture):
- `POST /api/plant-readings` — ingest `{ lux, soil1..soil4 }` (raw ADC
  0-4095 per soil channel; `x-api-key` header required). Raw values are
  converted to % using the calibration in `plant_settings` before
  buffering.
- `GET /api/plant-readings?hours=N&bucket=X&tzOffsetMinutes=M` — same
  bucketing scheme as `/api/readings`, columns are `lux, soil1_pct..soil4_pct`.
- `GET /api/plant-latest` — most recent live reading, including raw ADC
  values (used by the Settings page's "use current as Dry/Wet" capture).
- `GET /api/plant-settings` / `PUT /api/plant-settings` — per-channel
  name, dry/wet calibration, dry-soil %, and lux min/max thresholds.
  `GET` is open (the dashboard needs it); `PUT` requires the
  `x-settings-password` header to match `HOME_MONITOR_SETTINGS_PASSWORD`.

## Deploying

1. `cd server && npm install`
2. Set `HOME_MONITOR_API_KEY` (device ingestion), `HOME_MONITOR_SETTINGS_PASSWORD`
   (saving on the Settings page), `PORT`, `HOME_MONITOR_DB_PATH` (see
   `deploy/home-monitor.service` for the systemd setup used in prod)
3. Point nginx at `public/` and proxy `/api/` to the Node process (see
   `deploy/nginx-homemonitor.conf`) — `/plant/` and `/settings/` are just
   subdirectories under `public/`, no extra nginx config needed
4. Fill in real WiFi credentials and the API key in
   `firmware/esp32_dht11_home_monitor.ino` before flashing the ESP32
5. On first boot, visit `/homemonitor/settings/` and calibrate each soil
   channel: leave it dry in air and click "Use current as Dry", then dip
   it in water and click "Use current as Wet"

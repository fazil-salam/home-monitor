/*
  Home Monitor — ESP32 + DHT11 + BH1750 + 4x Capacitive Soil Moisture
  Once a minute: reads temperature/humidity (DHT11), light (BH1750),
  and 4 soil moisture channels, then POSTs each group to its own
  endpoint on the home-monitor API running on the Oracle server. The
  server shows every POST on the live dashboards immediately, but only
  persists a 10-minute average to the database (see server.js) — so
  this sketch just sends every minute and doesn't need to know about
  the 10-minute storage cadence at all.

  Libraries required (Arduino IDE > Tools > Manage Libraries):
    - "DHT sensor library" by Adafruit  (also installs "Adafruit Unified Sensor")
    - "BH1750" by Christopher Laws

  Wiring — DHT11 (3-pin, no onboard pull-up):
    DHT11 VCC  -> ESP32 3V3
    DHT11 GND  -> ESP32 GND
    DHT11 DATA -> ESP32 GPIO4  (through a 10k pull-up resistor to 3V3
                                 if your DHT11 board doesn't already have one)

  Wiring — BH1750 (I2C light sensor):
    BH1750 VCC -> ESP32 3V3
    BH1750 GND -> ESP32 GND
    BH1750 SDA -> ESP32 GPIO21
    BH1750 SCL -> ESP32 GPIO22
    BH1750 ADDR -> leave unconnected (default I2C address 0x23)

  Wiring — 4x capacitive soil moisture sensors (analog):
    Each sensor VCC -> ESP32 3V3, GND -> ESP32 GND
    Sensor 1 AOUT -> ESP32 GPIO32
    Sensor 2 AOUT -> ESP32 GPIO33
    Sensor 3 AOUT -> ESP32 GPIO34
    Sensor 4 AOUT -> ESP32 GPIO35
    (32-35 are all on ADC1, which stays usable while WiFi is active —
    unlike ADC2 pins, which WiFi disables.)
*/

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <DHT.h>
#include <Wire.h>
#include <BH1750.h>

// ── WiFi ──
const char *WIFI_SSID     = "YOUR_WIFI_SSID";
const char *WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// ── Home Monitor API ──
const char *API_URL       = "https://iot.crestlanegroup.com/homemonitor/api/readings";
const char *PLANT_API_URL = "https://iot.crestlanegroup.com/homemonitor/api/plant-readings";
const char *API_KEY       = "YOUR_HOME_MONITOR_API_KEY";

// ── DHT11 ──
#define DHTPIN 4
#define DHTTYPE DHT11
DHT dht(DHTPIN, DHTTYPE);

// ── BH1750 ──
BH1750 lightMeter;

// ── Soil moisture (raw ADC, calibrated to % server-side) ──
#define SOIL1_PIN 32
#define SOIL2_PIN 33
#define SOIL3_PIN 34
#define SOIL4_PIN 35

// ── Timing ──
const unsigned long READ_INTERVAL_MS = 60UL * 1000UL; // once a minute
unsigned long lastReadMs = 0;

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;

  Serial.printf("Connecting to WiFi \"%s\"...\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) {
    delay(500);
    Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\nWiFi connected, IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("\nWiFi connect failed, will retry next cycle.");
  }
}

bool postJson(const char *url, const char *payload) {
  WiFiClientSecure client;
  // The origin server's Let's Encrypt cert is validated by Cloudflare at the
  // edge; the ESP32 skips its own chain validation to avoid embedding/
  // rotating root CA certs on the device.
  client.setInsecure();

  HTTPClient https;
  if (!https.begin(client, url)) {
    Serial.println("Unable to begin HTTPS connection");
    return false;
  }

  https.addHeader("Content-Type", "application/json");
  https.addHeader("x-api-key", API_KEY);

  int statusCode = https.POST((uint8_t *)payload, strlen(payload));

  bool ok = statusCode > 0 && statusCode >= 200 && statusCode < 300;
  if (statusCode > 0) {
    Serial.printf("POST %s -> %d\n", payload, statusCode);
    if (!ok) Serial.println(https.getString());
  } else {
    Serial.printf("POST failed: %s\n", https.errorToString(statusCode).c_str());
  }

  https.end();
  return ok;
}

void sendReading(float tempC, float humidity) {
  char payload[96];
  snprintf(payload, sizeof(payload),
           "{\"temperature_c\":%.1f,\"humidity\":%.1f}", tempC, humidity);
  postJson(API_URL, payload);
}

void sendPlantReading(float lux, int s1, int s2, int s3, int s4) {
  char payload[160];
  snprintf(payload, sizeof(payload),
           "{\"lux\":%.1f,\"soil1\":%d,\"soil2\":%d,\"soil3\":%d,\"soil4\":%d}",
           lux, s1, s2, s3, s4);
  postJson(PLANT_API_URL, payload);
}

void setup() {
  Serial.begin(115200);
  delay(500);

  dht.begin();

  Wire.begin(); // SDA=GPIO21, SCL=GPIO22 (ESP32 defaults)
  if (!lightMeter.begin(BH1750::CONTINUOUS_HIGH_RES_MODE)) {
    Serial.println("BH1750 not found — check wiring.");
  }

  connectWiFi();
}

void loop() {
  connectWiFi();

  if (millis() - lastReadMs >= READ_INTERVAL_MS || lastReadMs == 0) {
    lastReadMs = millis();

    float humidity = dht.readHumidity();
    float tempC = dht.readTemperature(); // Celsius by default

    if (isnan(humidity) || isnan(tempC)) {
      Serial.println("Failed to read from DHT11 sensor, skipping this cycle.");
    } else {
      Serial.printf("Temp: %.1f C, Humidity: %.1f %%\n", tempC, humidity);
      if (WiFi.status() == WL_CONNECTED) {
        sendReading(tempC, humidity);
      } else {
        Serial.println("WiFi not connected, skipping upload.");
      }
    }

    float lux = lightMeter.readLightLevel();
    int soil1 = analogRead(SOIL1_PIN);
    int soil2 = analogRead(SOIL2_PIN);
    int soil3 = analogRead(SOIL3_PIN);
    int soil4 = analogRead(SOIL4_PIN);

    if (lux < 0) {
      Serial.println("Failed to read from BH1750 sensor, skipping plant upload this cycle.");
    } else {
      Serial.printf("Lux: %.1f, Soil raw: %d, %d, %d, %d\n", lux, soil1, soil2, soil3, soil4);
      if (WiFi.status() == WL_CONNECTED) {
        sendPlantReading(lux, soil1, soil2, soil3, soil4);
      } else {
        Serial.println("WiFi not connected, skipping plant upload.");
      }
    }
  }

  delay(1000);
}

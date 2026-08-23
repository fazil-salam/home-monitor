/*
  Home Monitor — ESP32 + DHT11
  Reads temperature (C) and humidity once a minute and POSTs each
  reading to the home-monitor API running on the Oracle server. The
  server shows every POST on the live dashboard immediately, but only
  persists a 10-minute average to the database (see server.js) — so
  this sketch just sends every minute and doesn't need to know about
  the 10-minute storage cadence at all.

  Library required (Arduino IDE > Tools > Manage Libraries):
    - "DHT sensor library" by Adafruit  (also installs "Adafruit Unified Sensor")

  Wiring (DHT11 with 3 pins, no onboard pull-up resistor board):
    DHT11 VCC  -> ESP32 3V3
    DHT11 GND  -> ESP32 GND
    DHT11 DATA -> ESP32 GPIO4  (through a 10k pull-up resistor to 3V3
                                 if your DHT11 board doesn't already have one)
*/

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <DHT.h>

// ── WiFi ──
const char *WIFI_SSID     = "YOUR_WIFI_SSID";
const char *WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// ── Home Monitor API ──
const char *API_URL = "https://iot.crestlanegroup.com/homemonitor/api/readings";
const char *API_KEY = "YOUR_HOME_MONITOR_API_KEY";

// ── Sensor ──
#define DHTPIN 4
#define DHTTYPE DHT11
DHT dht(DHTPIN, DHTTYPE);

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

void sendReading(float tempC, float humidity) {
  WiFiClientSecure client;
  // The origin server's Let's Encrypt cert is validated by Cloudflare at the
  // edge; the ESP32 skips its own chain validation to avoid embedding/
  // rotating root CA certs on the device.
  client.setInsecure();

  HTTPClient https;
  if (!https.begin(client, API_URL)) {
    Serial.println("Unable to begin HTTPS connection");
    return;
  }

  https.addHeader("Content-Type", "application/json");
  https.addHeader("x-api-key", API_KEY);

  char payload[96];
  snprintf(payload, sizeof(payload),
           "{\"temperature_c\":%.1f,\"humidity\":%.1f}", tempC, humidity);

  int statusCode = https.POST((uint8_t *)payload, strlen(payload));

  if (statusCode > 0) {
    Serial.printf("POST %s -> %d\n", payload, statusCode);
    if (statusCode < 200 || statusCode >= 300) {
      Serial.println(https.getString());
    }
  } else {
    Serial.printf("POST failed: %s\n", https.errorToString(statusCode).c_str());
  }

  https.end();
}

void setup() {
  Serial.begin(115200);
  delay(500);

  dht.begin();
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
  }

  delay(1000);
}

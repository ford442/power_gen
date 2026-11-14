// ============================================
// SEG Electromagnet Driver — line protocol v2
// ============================================
// Receives phase/speed commands over USB Serial from the WebGPU Visualizer.
// Drives a configurable electromagnet array; streams back sensor fusion data
// (hall, magnetometer, phase, RPM).
//
// EXPERIMENTAL. Not required by the web app, not built in CI. Read README.md
// (pin maps, hardware rules, the lock-on test) before wiring a coil to it, and
// run `npm run test:firmware-safety` after changing anything in this folder.
//
// Hardware:
//   - Arduino Uno/Nano, Mega 2560 or ESP32 (pin maps below and in README.md)
//   - Electromagnet array via logic-level MOSFETs / DRV8871, gate pull-downs,
//     flyback diodes, separate low-voltage DC coil supply. Never mains.
//   - Hall effect sensors (active low, pullup enabled)
//   - QMC5883L or HMC5883L magnetometer (I2C)
//
// Protocol: docs/hardware_connection.md. v2 = v1 bytes + the `V` hello.

#include "protocol.h"
#include "coil_controller.h"
#include "sensor_manager.h"
#include "seg_driver_core.h"

#ifndef NOT_AN_INTERRUPT
#define NOT_AN_INTERRUPT -1
#endif

// ============================================
// Pin maps (README.md → Pin maps explains each choice)
// ============================================

#if defined(ARDUINO_AVR_MEGA2560)
#define SEG_BOARD "mega"
// PWM pins; skips 2/3 (hall interrupts), 13 (bootloader LED blink), 20/21 (I2C).
const uint8_t COIL_PINS[] = { 4, 5, 6, 7, 8, 9, 10, 11, 12, 44, 45, 46 };
const uint8_t HALL_PINS[] = { 2, 3 };
#elif defined(ESP32)
#define SEG_BOARD "esp32"
// Output-safe GPIOs only: no strapping pins (0, 2, 5, 12, 15), no flash pins
// (6-11), no pins that pulse at boot (1, 3, 14), no input-only pins (34-39).
const uint8_t COIL_PINS[] = { 25, 26, 27, 32, 33, 4 };
const uint8_t HALL_PINS[] = { 18, 19 };
#else
#define SEG_BOARD "uno"
// Uno / Nano (ATmega328P). D2 = INT0; D4 is polled (D3 is a coil).
const uint8_t COIL_PINS[] = { 3, 5, 6, 9, 10, 11 };
const uint8_t HALL_PINS[] = { 2, 4 };
#endif

const uint8_t NUM_COILS = sizeof(COIL_PINS) / sizeof(COIL_PINS[0]);
const uint8_t NUM_HALLS = sizeof(HALL_PINS) / sizeof(HALL_PINS[0]);

// ============================================
// Global State
// ============================================

CoilController coilController;
SensorManager sensorManager;
DriverCore driver(coilController, NUM_COILS);
segfw::LineAssembler serialLine;

// Outgoing stream throttle
unsigned long lastStreamMs = 0;
const unsigned long STREAM_INTERVAL_MS = 10; // 100Hz max

// Explicit prototypes (the IDE generates them; the host test compiles this as C++).
void processSerial(uint32_t now);
void sendHello();
void reportSafetyEvents();
void streamState();

// ============================================
// Interrupt Service Routines
// ============================================

void onHall0() { sensorManager.onHallPulse(0); }
void onHall1() { sensorManager.onHallPulse(1); }
void (*const HALL_ISRS[])() = { onHall0, onHall1 };

// ============================================
// Setup
// ============================================

void setup() {
  // Coils first, before anything that can wait or fail: every wired pin LOW.
  coilController.begin(COIL_PINS, NUM_COILS);
  driver.begin();

  Serial.begin(SERIAL_BAUD);
  while (!Serial && millis() < 2000); // Wait for native USB (Leonardo, ESP32, etc.)

  Serial.println(F("I SEG Driver initializing..."));

  sensorManager.begin(HALL_PINS, NUM_HALLS);

  // Attach hall interrupts where the pin has one; the rest are polled in
  // SensorManager::update().
  for (uint8_t i = 0; i < NUM_HALLS && i < 2; i++) {
    int irq = digitalPinToInterrupt(HALL_PINS[i]);
    if (irq != NOT_AN_INTERRUPT) {
      attachInterrupt(irq, HALL_ISRS[i], FALLING);
    }
  }

  sendHello();
  Serial.println(F("I Ready. Waiting for P commands."));
}

// ============================================
// Main Loop
// ============================================

void loop() {
  // One timestamp per loop for both parsing and the watchdog.
  uint32_t now = millis();

  // 1. Read and parse serial commands
  processSerial(now);

  // 2. Watchdog, mode, brake bound, commutation, per-coil cap -> pins.
  driver.step(now);
  reportSafetyEvents();

  // 3. Read sensors
  sensorManager.update();

  // 4. Stream state back to app
  if (now - lastStreamMs >= STREAM_INTERVAL_MS) {
    lastStreamMs = now;
    streamState();
  }
}

// ============================================
// Serial Protocol
// ============================================

void processSerial(uint32_t now) {
  while (Serial.available()) {
    const char* line = serialLine.push((char)Serial.read());
    if (!line) continue;
    segfw::LineResult r = driver.onLine(line, now);
    if (r == segfw::LINE_HELLO) {
      sendHello();
    } else if (r == segfw::LINE_CONFIG) {
      Serial.print(F("I Config updated: coils="));
      Serial.println(coilController.getNumCoils());
    }
  }
}

void sendHello() {
  char hello[112];
  driver.safety().formatHello(hello, sizeof(hello), SEG_BOARD, "serial", NUM_HALLS);
  Serial.println(hello);
}

void reportSafetyEvents() {
  if (driver.safety().takeWatchdogTrip()) {
    Serial.println(F("E Watchdog: no valid P/C for 100 ms, coils off"));
  }
  if (driver.guard().takeTrip()) {
    Serial.println(F("E Coil held on too long, cooling down"));
  }
  if (driver.safety().takeConfigClamped()) {
    Serial.print(F("E CONF asked for more coils than are wired; using "));
    Serial.println(NUM_COILS);
  }
}

// ============================================
// State Streaming
// ============================================

void streamState() {
  // S{phase},{rpm},{magX},{magY},{magZ},{hallMask},{coilMask},{timestampMs}
  Serial.print('S');
  Serial.print(sensorManager.getPhase(), 2);
  Serial.print(',');
  Serial.print(sensorManager.getRpm(), 2);
  Serial.print(',');
  Serial.print(sensorManager.getMagX(), 2);
  Serial.print(',');
  Serial.print(sensorManager.getMagY(), 2);
  Serial.print(',');
  Serial.print(sensorManager.getMagZ(), 2);
  Serial.print(',');
  Serial.print(sensorManager.getHallMask());
  Serial.print(',');
  Serial.print(coilController.getActiveMask());
  Serial.print(',');
  Serial.print(millis());
  Serial.println();
}

// ============================================
// SEG Electromagnet Driver
// ============================================
// Receives phase/speed commands over USB Serial from the WebGPU Visualizer.
// Drives configurable electromagnet array with timer-level precision.
// Streams back sensor fusion data (hall, magnetometer, phase, RPM).
//
// Hardware:
//   - Arduino Uno/Nano/Mega or ESP32
//   - Electromagnet array via MOSFET/DRV8871 drivers
//   - Hall effect sensors (active low, pullup enabled)
//   - QMC5883L or HMC5883L magnetometer (I2C)
//
// Protocol: see hardware_connection.md

#include "protocol.h"
#include "coil_controller.h"
#include "sensor_manager.h"

// ============================================
// Pin Configuration (adjust for your board)
// ============================================

// Coil driver pins (must be PWM-capable for variable drive)
const uint8_t COIL_PINS[] = { 3, 5, 6, 9, 10, 11 };
const uint8_t NUM_COILS = sizeof(COIL_PINS) / sizeof(COIL_PINS[0]);

// Hall sensor pins (active low, internal pullup)
const uint8_t HALL_PINS[] = { 2, 4 };
const uint8_t NUM_HALLS = sizeof(HALL_PINS) / sizeof(HALL_PINS[0]);

// ============================================
// Global State
// ============================================

CoilController coilController;
SensorManager sensorManager;

// Incoming command state
float targetPhase = 0.0f;
float targetSpeed = 0.0f; // RPM
uint8_t controlMode = MODE_COAST;
unsigned long lastCommandMs = 0;
bool manualOverride = false;

// Outgoing stream throttle
unsigned long lastStreamMs = 0;
const unsigned long STREAM_INTERVAL_MS = 10; // 100Hz max

// Config
uint8_t configNumCoils = NUM_COILS;
float configOffsetAngle = DEFAULT_OFFSET_ANGLE;
float configDwellAngle = (360.0f / NUM_COILS) * 1.5f;
float configAdvanceAngle = DEFAULT_ADVANCE_ANGLE;

// ============================================
// Interrupt Service Routines
// ============================================

void onHall0() { sensorManager.onHallPulse(0); }
void onHall1() { sensorManager.onHallPulse(1); }

// ============================================
// Setup
// ============================================

void setup() {
  Serial.begin(SERIAL_BAUD);
  while (!Serial && millis() < 2000); // Wait for native USB (Leonardo, ESP32, etc.)

  Serial.println(F("I SEG Driver initializing..."));

  coilController.begin(COIL_PINS, NUM_COILS);
  coilController.setConfig(configNumCoils, configOffsetAngle, configDwellAngle, configAdvanceAngle);

  sensorManager.begin(HALL_PINS, NUM_HALLS);

  // Attach hall interrupts if pins support it
  for (uint8_t i = 0; i < NUM_HALLS; i++) {
    uint8_t pin = HALL_PINS[i];
    if (pin == 2) {
      attachInterrupt(digitalPinToInterrupt(pin), onHall0, FALLING);
    } else if (pin == 3) {
      attachInterrupt(digitalPinToInterrupt(pin), onHall1, FALLING);
    }
    // For other pins, pin-change interrupts or polling fallback in SensorManager::update()
  }

  Serial.println(F("I Ready. Waiting for P commands."));
}

// ============================================
// Main Loop
// ============================================

void loop() {
  unsigned long now = millis();

  // 1. Read and parse serial commands
  processSerial();

  // 2. Watchdog: safe mode if no command received recently
  if (now - lastCommandMs > WATCHDOG_TIMEOUT_MS && controlMode != MODE_COAST) {
    coilController.allOff();
    controlMode = MODE_COAST;
    // Optional: Serial.println(F("E Watchdog timeout — coils disabled"));
  }

  // 3. Compute extrapolated phase for commutation
  float electricalAngle = targetPhase;
  int8_t direction = (targetSpeed >= 0) ? 1 : -1;

  if (controlMode == MODE_RUN && !manualOverride) {
    // Extrapolate based on time since last command and target speed
    float dt = (now - lastCommandMs) / 1000.0f;
    float deltaPhase = targetSpeed * 6.0f * dt; // RPM -> deg/s
    electricalAngle = targetPhase + deltaPhase;
  } else if (controlMode == MODE_BRAKE) {
    // All coils on to brake (or alternate braking pattern)
    coilController.setManual(0xFFFFFFFF, 255);
  } else if (controlMode == MODE_COAST) {
    coilController.allOff();
  }

  // 4. Update coils (if not in coast/brake manual mode)
  if (controlMode == MODE_RUN) {
    coilController.update(electricalAngle, direction);
  }

  // 5. Read sensors
  sensorManager.update();

  // 6. Stream state back to app
  if (now - lastStreamMs >= STREAM_INTERVAL_MS) {
    lastStreamMs = now;
    streamState();
  }
}

// ============================================
// Serial Protocol Parser
// ============================================

void processSerial() {
  static String buffer = "";

  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') {
      buffer.trim();
      if (buffer.length() > 0) {
        parseCommand(buffer);
      }
      buffer = "";
    } else if (buffer.length() < 64) {
      buffer += c;
    }
  }
}

void parseCommand(const String& cmd) {
  if (cmd.length() < 1) return;

  char type = cmd.charAt(0);
  String payload = cmd.substring(1);

  switch (type) {
    case 'P': {
      // P{phase},{speed},{mode}
      int firstComma = payload.indexOf(',');
      int secondComma = payload.indexOf(',', firstComma + 1);
      if (firstComma > 0 && secondComma > firstComma) {
        targetPhase = payload.substring(0, firstComma).toFloat();
        targetSpeed = payload.substring(firstComma + 1, secondComma).toFloat();
        controlMode = (uint8_t)payload.substring(secondComma + 1).toInt();
        lastCommandMs = millis();
        manualOverride = false;
        coilController.clearManual();
      }
      break;
    }

    case 'C': {
      // C{coilMask},{pwmDuty},{durationMs}
      int firstComma = payload.indexOf(',');
      int secondComma = payload.indexOf(',', firstComma + 1);
      if (firstComma > 0 && secondComma > firstComma) {
        uint32_t mask = (uint32_t)payload.substring(0, firstComma).toInt();
        uint8_t pwm = (uint8_t)payload.substring(firstComma + 1, secondComma).toInt();
        // int durationMs = payload.substring(secondComma + 1).toInt(); // unused for now
        manualOverride = true;
        coilController.setManual(mask, pwm);
        lastCommandMs = millis();
      }
      break;
    }

    case 'F': {
      // CONF{numCoils},{offsetAngle},{dwellAngle},{advanceAngle}
      if (payload.startsWith("CONF")) {
        String conf = payload.substring(4);
        int c1 = conf.indexOf(',');
        int c2 = conf.indexOf(',', c1 + 1);
        int c3 = conf.indexOf(',', c2 + 1);
        if (c1 > 0 && c2 > c1 && c3 > c2) {
          configNumCoils = (uint8_t)conf.substring(0, c1).toInt();
          configOffsetAngle = conf.substring(c1 + 1, c2).toFloat();
          configDwellAngle = conf.substring(c2 + 1, c3).toFloat();
          configAdvanceAngle = conf.substring(c3 + 1).toFloat();
          coilController.setConfig(configNumCoils, configOffsetAngle, configDwellAngle, configAdvanceAngle);
          Serial.print(F("I Config updated: coils="));
          Serial.println(configNumCoils);
        }
      }
      break;
    }

    default:
      break;
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

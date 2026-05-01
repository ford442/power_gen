#include "sensor_manager.h"
#include <Wire.h>

// QMC5883L registers
#define QMC_ADDR      0x0D
#define QMC_REG_CTRL  0x09
#define QMC_REG_STATUS 0x06
#define QMC_REG_XLO   0x00
#define QMC_SCALE     0.732421875f // µT per LSB for ±8000 range

// HMC5883L registers
#define HMC_ADDR      0x1E
#define HMC_REG_A     0x00
#define HMC_REG_MODE  0x02
#define HMC_REG_X     0x03
#define HMC_SCALE     0.92f // µT per LSB for ±1.3Ga

SensorManager::SensorManager()
  : _numHalls(0),
    _hallMask(0),
    _rpm(0),
    _magX(0), _magY(0), _magZ(0),
    _magOffsetX(0), _magOffsetY(0), _magOffsetZ(0),
    _magAvailable(false),
    _magAddr(0),
    _fusedPhase(0),
    _extrapolatedPhase(0),
    _lastFusionTime(0),
    _fusionAlpha(0.8f)
{
  memset((void*)_lastHallTime, 0, sizeof(_lastHallTime));
}

void SensorManager::begin(const uint8_t* hallPins, uint8_t numHalls) {
  _numHalls = constrain(numHalls, 0, MAX_HALLS);
  for (uint8_t i = 0; i < _numHalls; i++) {
    _hallPins[i] = hallPins[i];
    pinMode(hallPins[i], INPUT_PULLUP);
  }

  // Initialize magnetometer
  Wire.begin();
  delay(10);

  // Try QMC5883L first
  Wire.beginTransmission(QMC_ADDR);
  Wire.write(QMC_REG_CTRL);
  Wire.write(0x0D); // continuous mode, 200Hz, 2G range
  if (Wire.endTransmission() == 0) {
    _magAddr = QMC_ADDR;
    _magAvailable = true;
    Serial.println(F("I Magnetometer: QMC5883L detected"));
  } else {
    // Try HMC5883L
    Wire.beginTransmission(HMC_ADDR);
    Wire.write(HMC_REG_A);
    Wire.write(0x70); // 8-average, 15Hz, normal measurement
    Wire.write(0x20); // ±1.3Ga
    Wire.write(0x00); // continuous mode
    if (Wire.endTransmission() == 0) {
      _magAddr = HMC_ADDR;
      _magAvailable = true;
      Serial.println(F("I Magnetometer: HMC5883L detected"));
    } else {
      Serial.println(F("E No magnetometer found on I2C"));
    }
  }
}

void SensorManager::update() {
  // Read digital hall states (non-interrupt fallback)
  uint32_t mask = 0;
  for (uint8_t i = 0; i < _numHalls; i++) {
    if (digitalRead(_hallPins[i]) == LOW) { // active low with pullup
      mask |= (1UL << i);
    }
  }
  _hallMask = mask;

  // Read magnetometer
  readMagnetometer();

  // Fuse
  fuse();
}

void SensorManager::onHallPulse(uint8_t hallIndex) {
  if (hallIndex >= _numHalls) return;

  uint32_t now = micros();
  uint32_t last = _lastHallTime[hallIndex];
  _lastHallTime[hallIndex] = now;

  if (last != 0) {
    uint32_t dt = now - last;
    if (dt > 0) {
      // Convert to RPM: 60 seconds / (dt microseconds * numHalls per rev)
      float revTimeUs = (float)dt * _numHalls;
      float newRpm = 60000000.0f / revTimeUs;
      // Simple low-pass filter
      _rpm = _rpm * 0.7f + newRpm * 0.3f;
    }
  }

  // Snap phase to known hall position
  float hallAngle = (360.0f / _numHalls) * hallIndex;
  _fusedPhase = hallAngle;
  _extrapolatedPhase = hallAngle;
}

void SensorManager::setMagnetometerOffset(float x, float y, float z) {
  _magOffsetX = x;
  _magOffsetY = y;
  _magOffsetZ = z;
}

void SensorManager::resetFusion() {
  _fusedPhase = 0;
  _extrapolatedPhase = 0;
  _rpm = 0;
}

// ============================================
// Private
// ============================================

void SensorManager::readMagnetometer() {
  if (!_magAvailable) return;

  int16_t x, y, z;

  if (_magAddr == QMC_ADDR) {
    Wire.beginTransmission(QMC_ADDR);
    Wire.write(QMC_REG_XLO);
    Wire.endTransmission();
    Wire.requestFrom(QMC_ADDR, (uint8_t)6);
    if (Wire.available() >= 6) {
      x = (int16_t)(Wire.read() | (Wire.read() << 8));
      y = (int16_t)(Wire.read() | (Wire.read() << 8));
      z = (int16_t)(Wire.read() | (Wire.read() << 8));
      _magX = x * QMC_SCALE - _magOffsetX;
      _magY = y * QMC_SCALE - _magOffsetY;
      _magZ = z * QMC_SCALE - _magOffsetZ;
    }
  } else if (_magAddr == HMC_ADDR) {
    Wire.beginTransmission(HMC_ADDR);
    Wire.write(HMC_REG_X);
    Wire.endTransmission();
    Wire.requestFrom(HMC_ADDR, (uint8_t)6);
    if (Wire.available() >= 6) {
      x = (int16_t)((Wire.read() << 8) | Wire.read());
      z = (int16_t)((Wire.read() << 8) | Wire.read());
      y = (int16_t)((Wire.read() << 8) | Wire.read());
      _magX = x * HMC_SCALE - _magOffsetX;
      _magY = y * HMC_SCALE - _magOffsetY;
      _magZ = z * HMC_SCALE - _magOffsetZ;
    }
  }
}

void SensorManager::fuse() {
  // Extrapolation step: integrate RPM
  unsigned long nowMs = millis();
  float dt = (nowMs - _lastFusionTime) / 1000.0f;
  _lastFusionTime = nowMs;

  float rpmDegPerSec = _rpm * 6.0f; // RPM * 360 / 60
  _extrapolatedPhase += rpmDegPerSec * dt;
  _extrapolatedPhase = fmod(_extrapolatedPhase, 360.0f);
  if (_extrapolatedPhase < 0) _extrapolatedPhase += 360.0f;

  // Magnetometer phase
  float magPhase = magnetometerToPhase();

  // Complementary filter: trust extrapolation more when mag is noisy
  // (simple heuristic: if magZ is large, sensor is likely tilted)
  float tiltPenalty = constrain(fabs(_magZ) / 100.0f, 0.0f, 1.0f);
  float alpha = _fusionAlpha + tiltPenalty * 0.15f;
  alpha = constrain(alpha, 0.0f, 1.0f);

  _fusedPhase = alpha * _extrapolatedPhase + (1.0f - alpha) * magPhase;
  _fusedPhase = fmod(_fusedPhase, 360.0f);
  if (_fusedPhase < 0) _fusedPhase += 360.0f;
}

float SensorManager::magnetometerToPhase() {
  // Phase from horizontal field vector
  float phase = atan2(_magY, _magX) * (180.0f / PI);
  if (phase < 0) phase += 360.0f;
  return phase;
}

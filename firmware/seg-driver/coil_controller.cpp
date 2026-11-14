#include "coil_controller.h"

CoilController::CoilController()
  : _wiredCoils(0),
    _numCoils(0),
    _offsetAngle(DEFAULT_OFFSET_ANGLE),
    _dwellAngle(DEFAULT_DWELL_ANGLE),
    _advanceAngle(DEFAULT_ADVANCE_ANGLE),
    _pattern(PATTERN_OVERLAP),
    _activeMask(0)
{
  memset(_coilPins, 0, sizeof(_coilPins));
}

void CoilController::begin(const uint8_t* coilPins, uint8_t numCoils) {
  _wiredCoils = constrain(numCoils, 1, MAX_COILS);
  _numCoils = _wiredCoils;
  for (uint8_t i = 0; i < _wiredCoils; i++) {
    _coilPins[i] = coilPins[i];
    // LOW before OUTPUT: the pin never drives high, even for a cycle. The gate
    // pull-down (README → Hardware rules) covers the reset/boot window before this.
    digitalWrite(coilPins[i], LOW);
    pinMode(coilPins[i], OUTPUT);
    digitalWrite(coilPins[i], LOW);
  }
  _activeMask = 0;
}

void CoilController::setConfig(uint8_t numCoils, float offsetAngle, float dwellAngle, float advanceAngle) {
  // v1 clamped to MAX_COILS, so CONF12 on a 6-coil board drove pin slots 6..11,
  // which are 0. And shrinking the count left the coils above it latched on,
  // because update()/allOff() only walked the configured ones.
  _numCoils = constrain(numCoils, 1, _wiredCoils);
  _offsetAngle = offsetAngle;
  _dwellAngle = constrain(dwellAngle, 1.0f, 180.0f);
  _advanceAngle = advanceAngle;
}

void CoilController::setPattern(uint8_t pattern) {
  _pattern = constrain(pattern, PATTERN_SINGLE, PATTERN_SINUSOIDAL);
}

void CoilController::commutate(float electricalAngle, int8_t direction, uint8_t* pwmOut) const {
  for (uint8_t i = 0; i < _wiredCoils; i++) pwmOut[i] = 0;

  float angle = normalizeAngle(electricalAngle + _advanceAngle * direction);
  float halfDwell = _dwellAngle / 2.0f;

  for (uint8_t i = 0; i < _numCoils; i++) {
    float coilCenter = normalizeAngle(i * (360.0f / _numCoils) + _offsetAngle);
    float dist = angularDistance(angle, coilCenter);
    if (!(dist < halfDwell)) continue;  // also false for NaN

    uint8_t pwm = 0;
    switch (_pattern) {
      case PATTERN_SINGLE:
      case PATTERN_OVERLAP:
        pwm = 255;
        break;

      case PATTERN_TRAPEZOIDAL: {
        float ramp = halfDwell * 0.3f;
        if (dist < ramp) {
          pwm = (uint8_t)(255.0f * (dist / ramp));
        } else if (dist > halfDwell - ramp) {
          pwm = (uint8_t)(255.0f * ((halfDwell - dist) / ramp));
        } else {
          pwm = 255;
        }
        break;
      }

      case PATTERN_SINUSOIDAL: {
        float t = (dist / halfDwell) * (PI / 2.0f);
        pwm = (uint8_t)(255.0f * cos(t));
        break;
      }
    }
    pwmOut[i] = pwm;
  }
}

void CoilController::fillMask(uint32_t coilMask, uint8_t pwm, uint8_t* pwmOut) const {
  for (uint8_t i = 0; i < _wiredCoils; i++) {
    bool on = i < _numCoils && i < 32 && ((coilMask >> i) & 1UL);
    pwmOut[i] = on ? pwm : 0;
  }
}

void CoilController::write(const uint8_t* pwm) {
  uint32_t mask = 0;
  for (uint8_t i = 0; i < _wiredCoils; i++) {
    writeCoil(i, pwm[i]);
    if (pwm[i] > 0 && i < 32) mask |= (1UL << i);
  }
  _activeMask = mask;
}

void CoilController::allOff() {
  for (uint8_t i = 0; i < _wiredCoils; i++) {
    writeCoil(i, 0);
  }
  _activeMask = 0;
}

// ============================================
// Helpers
// ============================================

float CoilController::normalizeAngle(float deg) {
  float a = fmod(deg, 360.0f);
  if (a < 0) a += 360.0f;
  return a;
}

float CoilController::angularDistance(float a, float b) {
  float diff = fabs(a - b);
  if (diff > 180.0f) diff = 360.0f - diff;
  return diff;
}

void CoilController::writeCoil(uint8_t index, uint8_t pwm) {
  if (index >= _wiredCoils) return;
  // One API for every level. On the ESP32 core, a pin that analogWrite() has
  // handed to the LEDC peripheral is not reliably taken back by digitalWrite(),
  // so v1's mix (digitalWrite for 0/255, analogWrite between) could write "LOW"
  // and leave the coil at its last duty. On AVR, analogWrite(0) / (255) already
  // are digitalWrite LOW / HIGH, so nothing changes there.
  analogWrite(_coilPins[index], pwm);
}

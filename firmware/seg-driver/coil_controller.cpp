#include "coil_controller.h"

CoilController::CoilController()
  : _numCoils(DEFAULT_NUM_COILS),
    _offsetAngle(DEFAULT_OFFSET_ANGLE),
    _dwellAngle(DEFAULT_DWELL_ANGLE),
    _advanceAngle(DEFAULT_ADVANCE_ANGLE),
    _pattern(PATTERN_OVERLAP),
    _manualMode(false),
    _manualMask(0),
    _manualPwm(255),
    _activeMask(0)
{
  memset(_coilPins, 0, sizeof(_coilPins));
}

void CoilController::begin(const uint8_t* coilPins, uint8_t numCoils) {
  _numCoils = constrain(numCoils, 1, MAX_COILS);
  for (uint8_t i = 0; i < _numCoils; i++) {
    _coilPins[i] = coilPins[i];
    pinMode(coilPins[i], OUTPUT);
    digitalWrite(coilPins[i], LOW);
  }
}

void CoilController::setConfig(uint8_t numCoils, float offsetAngle, float dwellAngle, float advanceAngle) {
  _numCoils = constrain(numCoils, 1, MAX_COILS);
  _offsetAngle = offsetAngle;
  _dwellAngle = constrain(dwellAngle, 1.0f, 180.0f);
  _advanceAngle = advanceAngle;
}

void CoilController::setPattern(uint8_t pattern) {
  _pattern = constrain(pattern, PATTERN_SINGLE, PATTERN_SINUSOIDAL);
}

void CoilController::update(float electricalAngle, int8_t direction) {
  if (_manualMode) {
    // Manual override: apply mask directly
    for (uint8_t i = 0; i < _numCoils; i++) {
      bool on = (_manualMask >> i) & 1U;
      writeCoil(i, on ? _manualPwm : 0);
    }
    _activeMask = _manualMask;
    return;
  }

  float angle = normalizeAngle(electricalAngle + _advanceAngle * direction);
  uint32_t mask = 0;

  for (uint8_t i = 0; i < _numCoils; i++) {
    float coilCenter = normalizeAngle(i * (360.0f / _numCoils) + _offsetAngle);
    float dist = angularDistance(angle, coilCenter);
    float halfDwell = _dwellAngle / 2.0f;

    bool active = false;
    uint8_t pwm = 0;

    switch (_pattern) {
      case PATTERN_SINGLE:
      case PATTERN_OVERLAP:
        active = dist < halfDwell;
        pwm = active ? 255 : 0;
        break;

      case PATTERN_TRAPEZOIDAL: {
        float ramp = halfDwell * 0.3f;
        if (dist < halfDwell) {
          active = true;
          if (dist < ramp) {
            pwm = (uint8_t)(255.0f * (dist / ramp));
          } else if (dist > halfDwell - ramp) {
            pwm = (uint8_t)(255.0f * ((halfDwell - dist) / ramp));
          } else {
            pwm = 255;
          }
        }
        break;
      }

      case PATTERN_SINUSOIDAL: {
        if (dist < halfDwell) {
          active = true;
          float t = (dist / halfDwell) * (PI / 2.0f);
          pwm = (uint8_t)(255.0f * cos(t));
        }
        break;
      }
    }

    if (active) {
      mask |= (1UL << i);
      writeCoil(i, pwm);
    } else {
      writeCoil(i, 0);
    }
  }

  _activeMask = mask;
}

void CoilController::setManual(uint32_t coilMask, uint8_t pwm) {
  _manualMode = true;
  _manualMask = coilMask;
  _manualPwm = pwm;
}

void CoilController::clearManual() {
  _manualMode = false;
  _manualMask = 0;
}

void CoilController::allOff() {
  for (uint8_t i = 0; i < _numCoils; i++) {
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
  uint8_t pin = _coilPins[index];
  if (pwm >= 255) {
    digitalWrite(pin, HIGH);
  } else if (pwm <= 0) {
    digitalWrite(pin, LOW);
  } else {
    analogWrite(pin, pwm);
  }
}

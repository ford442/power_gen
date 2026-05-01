#ifndef COIL_CONTROLLER_H
#define COIL_CONTROLLER_H

#include <Arduino.h>
#include "protocol.h"

class CoilController {
public:
  CoilController();

  void begin(const uint8_t* coilPins, uint8_t numCoils);

  void setConfig(uint8_t numCoils, float offsetAngle, float dwellAngle, float advanceAngle);
  void setPattern(uint8_t pattern);

  void update(float electricalAngle, int8_t direction);
  void setManual(uint32_t coilMask, uint8_t pwm);
  void clearManual();

  void allOff();

  uint32_t getActiveMask() const { return _activeMask; }
  uint8_t getNumCoils() const { return _numCoils; }

private:
  uint8_t _coilPins[MAX_COILS];
  uint8_t _numCoils;
  float _offsetAngle;
  float _dwellAngle;
  float _advanceAngle;
  uint8_t _pattern;
  bool _manualMode;
  uint32_t _manualMask;
  uint8_t _manualPwm;
  uint32_t _activeMask;

  float normalizeAngle(float deg);
  float angularDistance(float a, float b);
  void writeCoil(uint8_t index, uint8_t pwm);
};

#endif // COIL_CONTROLLER_H

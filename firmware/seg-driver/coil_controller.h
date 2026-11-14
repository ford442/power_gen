#ifndef COIL_CONTROLLER_H
#define COIL_CONTROLLER_H

#include <Arduino.h>
#include "protocol.h"

// Commutation geometry + pin output. It decides *which* coils an angle lights;
// whether any coil may be lit at all is seg_safety.h's call, made before
// write(). Duties are computed into an array first so the per-coil guard can
// see — and cap — exactly what is about to reach the pins.
class CoilController {
public:
  CoilController();

  /** Pins actually wired. Every one is driven LOW here and by every write(). */
  void begin(const uint8_t* coilPins, uint8_t numCoils);

  /** numCoils is clamped to the wired count — never addresses an unset pin slot. */
  void setConfig(uint8_t numCoils, float offsetAngle, float dwellAngle, float advanceAngle);
  void setPattern(uint8_t pattern);

  /** Fill pwmOut[0..wired) for the coils active at electricalAngle (0 beyond numCoils). */
  void commutate(float electricalAngle, int8_t direction, uint8_t* pwmOut) const;
  /** Fill pwmOut[0..wired): pwm on each configured coil in mask, 0 elsewhere. */
  void fillMask(uint32_t coilMask, uint8_t pwm, uint8_t* pwmOut) const;

  /** Write pwm[0..wired) to the pins — every wired coil, configured or not. */
  void write(const uint8_t* pwm);
  void allOff();

  uint32_t getActiveMask() const { return _activeMask; }
  uint8_t getNumCoils() const { return _numCoils; }
  uint8_t getWiredCoils() const { return _wiredCoils; }

private:
  uint8_t _coilPins[MAX_COILS];
  uint8_t _wiredCoils;
  uint8_t _numCoils;
  float _offsetAngle;
  float _dwellAngle;
  float _advanceAngle;
  uint8_t _pattern;
  uint32_t _activeMask;

  static float normalizeAngle(float deg);
  static float angularDistance(float a, float b);
  void writeCoil(uint8_t index, uint8_t pwm);
};

#endif // COIL_CONTROLLER_H

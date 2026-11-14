#ifndef SEG_DRIVER_CORE_H
#define SEG_DRIVER_CORE_H

// The whole command -> pin path, minus Serial and sensors, so the host test
// (test/safety_test.cpp) drives exactly what the sketch drives:
//
//   line -> SafetyCore::feedLine -> SafetyCore::tick -> CoilController
//        commutate/fillMask -> CoilGuard::limit -> CoilController::write
//
// Every loop writes every wired coil, so nothing depends on a pin keeping a
// value some earlier branch left on it.

#include "coil_controller.h"
#include "seg_safety.h"

class DriverCore {
public:
  DriverCore(CoilController& coils, uint8_t wiredCoils)
    : _coils(coils), _safety(wiredCoils) {}

  /** Apply the safety core's default geometry to the controller. Call after coils.begin(). */
  void begin() { syncConfig(); }

  segfw::LineResult onLine(const char* line, uint32_t nowMs) {
    segfw::LineResult r = _safety.feedLine(line, nowMs);
    if (r == segfw::LINE_CONFIG) syncConfig();
    return r;
  }

  /** One control step. nowMs must be the same value passed to onLine() this loop. */
  void step(uint32_t nowMs) {
    segfw::Output out = _safety.tick(nowMs);
    uint8_t pwm[MAX_COILS];
    for (uint8_t i = 0; i < MAX_COILS; i++) pwm[i] = 0;
    switch (out.kind) {
      case segfw::OUT_RUN:
        _coils.commutate(out.electricalAngle, out.direction, pwm);
        break;
      case segfw::OUT_BRAKE:
      case segfw::OUT_MANUAL:
        _coils.fillMask(out.mask, out.pwm, pwm);
        break;
      case segfw::OUT_OFF:
      default:
        break;
    }
    _guard.limit(pwm, _coils.getWiredCoils(), nowMs);
    _coils.write(pwm);
  }

  /** Link dropped: coils off in this call, not after the watchdog. */
  void linkLost() {
    _safety.linkLost();
    _coils.allOff();
  }

  segfw::SafetyCore& safety() { return _safety; }
  segfw::CoilGuard& guard() { return _guard; }

private:
  CoilController& _coils;
  segfw::SafetyCore _safety;
  segfw::CoilGuard _guard;

  void syncConfig() {
    const segfw::CoilConfig& c = _safety.config();
    _coils.setConfig(c.numCoils, c.offsetAngle, c.dwellAngle, c.advanceAngle);
  }
};

#endif // SEG_DRIVER_CORE_H

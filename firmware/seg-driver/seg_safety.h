#ifndef SEG_SAFETY_H
#define SEG_SAFETY_H

// ============================================
// SEG driver safety core (protocol v2)
// ============================================
// Everything that decides whether a coil may be energised lives here, with no
// Arduino dependency, so the sketch and the host test (test/safety_test.cpp,
// `npm run test:firmware-safety`) run the same code. The rule it enforces:
//
//   A coil is on only while valid P/C commands keep arriving (watchdog), only
//   in a mode the protocol defines, in BRAKE only for a bounded time at a
//   bounded duty, and never for more than COIL_MAX_ON_MS at a stretch however
//   it is commanded (CoilGuard). Anything the parser cannot fully read as a
//   motor command stops the motor; it never refreshes the watchdog.
//
// Wire format is unchanged from v1 (see protocol.h); v2 only adds `V`.

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "protocol.h"

namespace segfw {

enum OutputKind : uint8_t {
  OUT_OFF = 0,  // every wired coil low
  OUT_RUN,      // commutate at electricalAngle
  OUT_BRAKE,    // mask at pwm (bounded by BRAKE_PWM_MAX / BRAKE_MAX_MS)
  OUT_MANUAL    // host's C override: mask at pwm
};

struct Output {
  OutputKind kind;
  float electricalAngle;
  int8_t direction;
  uint32_t mask;
  uint8_t pwm;
};

enum LineResult : uint8_t {
  LINE_IGNORED = 0,  // not a command this sketch knows — dropped, as v1 did
  LINE_COMMAND,      // valid P or C: fed the watchdog
  LINE_CONFIG,       // valid CONF: geometry updated; does not feed the watchdog
  LINE_HELLO,        // V: caller prints formatHello(); does not feed the watchdog
  LINE_REJECTED      // malformed P / C (motor coasted) or malformed CONF (ignored)
};

struct CoilConfig {
  uint8_t numCoils;
  float offsetAngle;
  float dwellAngle;
  float advanceAngle;
};

inline bool finiteFloat(double v) {
  return v == v && v <= 3.0e38 && v >= -3.0e38;
}

// --------------------------------------------
// Field parsers: a field must be consumed whole, up to ',' (or the end of the
// line for the last one). "12abc", "", "nan" and "inf" all fail.
// --------------------------------------------

inline bool parseFloatField(const char*& p, float& out, bool last) {
  char* end = 0;
  double v = strtod(p, &end);
  if (end == p) return false;
  if (last ? (*end != '\0') : (*end != ',')) return false;
  if (!finiteFloat(v)) return false;
  out = (float)v;
  p = last ? end : end + 1;
  return true;
}

inline bool parseUintField(const char*& p, uint32_t& out, uint32_t maxValue, bool last) {
  const char* s = p;
  while (*s == ' ') s++;
  if (*s < '0' || *s > '9') return false;  // no sign, no empty field
  char* end = 0;
  unsigned long v = strtoul(s, &end, 10);
  if (last ? (*end != '\0') : (*end != ',')) return false;
  if (v > (unsigned long)maxValue) return false;
  out = (uint32_t)v;
  p = last ? end : end + 1;
  return true;
}

// --------------------------------------------
// Line assembly: '\n' ends a line, '\r' is ignored, surrounding spaces are
// trimmed. A line longer than LINE_MAX is dropped whole — v1 parsed its first
// 64 characters, so a cut-off "P123.4,5" could still drive the coils.
// --------------------------------------------

class LineAssembler {
 public:
  LineAssembler() : _len(0), _overflow(false) { _buf[0] = '\0'; }

  /** Push one received byte. Returns a complete line, or 0. */
  const char* push(char c) {
    if (c == '\r') return 0;
    if (c == '\n') {
      bool dropped = _overflow;
      _buf[_len] = '\0';
      _len = 0;
      _overflow = false;
      if (dropped) return 0;
      return trimmed();
    }
    if (_overflow) return 0;
    if (_len >= LINE_MAX) {
      _overflow = true;
      return 0;
    }
    _buf[_len++] = c;
    return 0;
  }

  void reset() {
    _len = 0;
    _overflow = false;
  }

 private:
  char _buf[LINE_MAX + 1];
  uint8_t _len;
  bool _overflow;

  const char* trimmed() {
    char* s = _buf;
    while (*s == ' ' || *s == '\t') s++;
    size_t n = strlen(s);
    while (n > 0 && (s[n - 1] == ' ' || s[n - 1] == '\t')) s[--n] = '\0';
    return *s ? s : 0;
  }
};

// --------------------------------------------
// Per-coil continuous-on cap. Runs after commutation on the final per-coil
// duties, so it bounds every mode the same way, including ones added later.
// --------------------------------------------

class CoilGuard {
 public:
  CoilGuard() : _tripped(false) {
    for (uint8_t i = 0; i < MAX_COILS; i++) {
      _on[i] = false;
      _cooling[i] = false;
      _sinceMs[i] = 0;
    }
  }

  /** Zero any duty that has been on for COIL_MAX_ON_MS, and hold it off for COIL_COOLDOWN_MS. */
  void limit(uint8_t* pwm, uint8_t n, uint32_t nowMs) {
    if (n > MAX_COILS) n = MAX_COILS;
    for (uint8_t i = 0; i < n; i++) {
      if (_cooling[i]) {
        if ((uint32_t)(nowMs - _sinceMs[i]) < COIL_COOLDOWN_MS) {
          pwm[i] = 0;
          continue;
        }
        _cooling[i] = false;
      }
      if (pwm[i] == 0) {
        _on[i] = false;
        continue;
      }
      if (!_on[i]) {
        _on[i] = true;
        _sinceMs[i] = nowMs;
      } else if ((uint32_t)(nowMs - _sinceMs[i]) >= COIL_MAX_ON_MS) {
        _on[i] = false;
        _cooling[i] = true;
        _sinceMs[i] = nowMs;
        pwm[i] = 0;
        _tripped = true;
      }
    }
  }

  /** True once after a coil hit the cap — report it as an E line. */
  bool takeTrip() {
    bool t = _tripped;
    _tripped = false;
    return t;
  }

 private:
  bool _on[MAX_COILS];
  bool _cooling[MAX_COILS];
  uint32_t _sinceMs[MAX_COILS];  // on-since while on; cooldown start while cooling
  bool _tripped;
};

// --------------------------------------------
// The core
// --------------------------------------------

class SafetyCore {
 public:
  explicit SafetyCore(uint8_t wiredCoils)
      : _wired(wiredCoils < 1 ? 1 : (wiredCoils > MAX_COILS ? MAX_COILS : wiredCoils)),
        _mode(MODE_COAST),
        _fed(false),
        _lastFeedMs(0),
        _targetPhase(0.0f),
        _targetSpeed(0.0f),
        _brakeStartMs(0),
        _brakeLatched(false),
        _manual(false),
        _manualMask(0),
        _manualPwm(0),
        _manualStartMs(0),
        _manualDurationMs(0),
        _tripped(false),
        _configClamped(false) {
    _config.numCoils = _wired;
    _config.offsetAngle = DEFAULT_OFFSET_ANGLE;
    _config.dwellAngle = (360.0f / _wired) * 1.5f;
    if (_config.dwellAngle > 180.0f) _config.dwellAngle = 180.0f;
    _config.advanceAngle = DEFAULT_ADVANCE_ANGLE;
  }

  /** One complete, trimmed line from any link. Use the same nowMs as tick(). */
  LineResult feedLine(const char* line, uint32_t nowMs) {
    if (!line || !*line) return LINE_IGNORED;
    // CONF before C: v1 checked the first letter only, so every CONF line was
    // parsed as a manual override with a zero mask and never reached its case.
    if (strncmp(line, "CONF", 4) == 0) return parseConf(line + 4);
    switch (line[0]) {
      case 'P': return parsePhase(line + 1, nowMs);
      case 'C': return parseCoils(line + 1, nowMs);
      case 'V': return LINE_HELLO;
      default: return LINE_IGNORED;
    }
  }

  /** Decide what the coils do now. Call every loop with the same nowMs as feedLine(). */
  Output tick(uint32_t nowMs) {
    Output out;
    out.kind = OUT_OFF;
    out.electricalAngle = 0.0f;
    out.direction = 1;
    out.mask = 0;
    out.pwm = 0;

    // Unsigned age: correct across the 49-day millis() wrap. A feed stamped in
    // the future reads as a huge age, which trips — fail-safe, not fail-on.
    if (!_fed || (uint32_t)(nowMs - _lastFeedMs) > WATCHDOG_TIMEOUT_MS) {
      if (_mode != MODE_COAST || _manual) _tripped = true;
      coast();
      _fed = false;
      return out;
    }

    if (_mode == MODE_BRAKE) {
      if (!_brakeLatched && (uint32_t)(nowMs - _brakeStartMs) >= BRAKE_MAX_MS) _brakeLatched = true;
      if (_brakeLatched) return out;
      out.kind = OUT_BRAKE;
      out.mask = configuredMask();
      out.pwm = BRAKE_PWM_MAX;
      return out;
    }

    if (_mode != MODE_RUN) return out;

    if (_manual && _manualDurationMs > 0 && (uint32_t)(nowMs - _manualStartMs) >= _manualDurationMs) {
      clearManual();
    }
    if (_manual) {
      out.kind = OUT_MANUAL;
      out.mask = _manualMask & configuredMask();
      out.pwm = _manualPwm;
      if (out.mask == 0 || out.pwm == 0) out.kind = OUT_OFF;
      return out;
    }

    // Extrapolate between commands; the watchdog bounds dt to 0.1 s.
    float dt = (float)(uint32_t)(nowMs - _lastFeedMs) / 1000.0f;
    float angle = _targetPhase + _targetSpeed * 6.0f * dt;  // RPM -> deg/s
    if (!finiteFloat(angle)) return out;
    out.kind = OUT_RUN;
    out.electricalAngle = angle;
    out.direction = _targetSpeed >= 0.0f ? 1 : -1;
    return out;
  }

  /** The link is gone (BLE disconnect, USB DTR drop): off now, not after the watchdog. */
  void linkLost() {
    coast();
    _fed = false;
  }

  /** True once after the watchdog cut a live drive — report it as an E line. */
  bool takeWatchdogTrip() {
    bool t = _tripped;
    _tripped = false;
    return t;
  }

  /** True once after a CONF asked for more coils than are wired — report it. */
  bool takeConfigClamped() {
    bool c = _configClamped;
    _configClamped = false;
    return c;
  }

  /** "I v=2 ..." — the hello reply. v1 hosts just log it as info. */
  int formatHello(char* buf, size_t n, const char* board, const char* link, uint8_t halls) const {
    return snprintf(buf, n, "I v=%u fw=seg-driver board=%s link=%s coils=%u halls=%u wd=%u brake=%u/%u",
                    (unsigned)PROTOCOL_VERSION, board, link, (unsigned)_wired, (unsigned)halls,
                    (unsigned)WATCHDOG_TIMEOUT_MS, (unsigned)BRAKE_PWM_MAX, (unsigned)BRAKE_MAX_MS);
  }

  const CoilConfig& config() const { return _config; }
  uint8_t mode() const { return _mode; }
  uint8_t wiredCoils() const { return _wired; }
  bool fed() const { return _fed; }

 private:
  uint8_t _wired;
  uint8_t _mode;
  bool _fed;
  uint32_t _lastFeedMs;
  float _targetPhase;
  float _targetSpeed;
  uint32_t _brakeStartMs;
  bool _brakeLatched;
  bool _manual;
  uint32_t _manualMask;
  uint8_t _manualPwm;
  uint32_t _manualStartMs;
  uint32_t _manualDurationMs;
  bool _tripped;
  bool _configClamped;
  CoilConfig _config;

  uint32_t configuredMask() const {
    return _config.numCoils >= 32 ? 0xFFFFFFFFUL : ((1UL << _config.numCoils) - 1UL);
  }

  void clearManual() {
    _manual = false;
    _manualMask = 0;
    _manualPwm = 0;
    _manualDurationMs = 0;
  }

  void coast() {
    _mode = MODE_COAST;
    _brakeLatched = false;
    clearManual();
  }

  void feed(uint32_t nowMs) {
    _fed = true;
    _lastFeedMs = nowMs;
  }

  // P{phase},{speed},{mode}
  LineResult parsePhase(const char* p, uint32_t nowMs) {
    float phase = 0.0f;
    float speed = 0.0f;
    uint32_t mode = 0;
    if (!parseFloatField(p, phase, false) || !parseFloatField(p, speed, false) ||
        !parseUintField(p, mode, 0xFFFFUL, true) || mode > MODE_COAST) {
      // Includes a well-formed line with an undefined mode: v1 fell through
      // every branch for those and left the coils as they were.
      coast();
      return LINE_REJECTED;
    }
    if (speed > 999.9f) speed = 999.9f;
    if (speed < -999.9f) speed = -999.9f;

    if (mode == MODE_BRAKE) {
      if (_mode != MODE_BRAKE) {
        _brakeStartMs = nowMs;
        _brakeLatched = false;
      }
    } else {
      _brakeLatched = false;
    }
    _mode = (uint8_t)mode;
    _targetPhase = phase;
    _targetSpeed = speed;
    clearManual();
    feed(nowMs);
    return LINE_COMMAND;
  }

  // C{coilMask},{pwmDuty},{durationMs}
  LineResult parseCoils(const char* p, uint32_t nowMs) {
    uint32_t mask = 0;
    uint32_t pwm = 0;
    uint32_t duration = 0;
    if (!parseUintField(p, mask, 0xFFFFFFFFUL, false) || !parseUintField(p, pwm, 255UL, false) ||
        !parseUintField(p, duration, 65535UL, true)) {
      coast();
      return LINE_REJECTED;
    }
    // The host sends only C lines while it holds an override, so C feeds the
    // watchdog exactly as in v1; the override still applies in RUN only.
    if ((mask & configuredMask()) == 0 || pwm == 0) {
      clearManual();  // C0,0,0 releases the override
    } else {
      _manual = true;
      _manualMask = mask;
      _manualPwm = (uint8_t)pwm;
      _manualStartMs = nowMs;
      _manualDurationMs = duration;  // 0 = until the next command; >0 is now honoured
    }
    feed(nowMs);
    return LINE_COMMAND;
  }

  // CONF{numCoils},{offsetAngle},{dwellAngle},{advanceAngle}
  LineResult parseConf(const char* p) {
    uint32_t n = 0;
    float offset = 0.0f;
    float dwell = 0.0f;
    float advance = 0.0f;
    if (!parseUintField(p, n, 255UL, false) || !parseFloatField(p, offset, false) ||
        !parseFloatField(p, dwell, false) || !parseFloatField(p, advance, true) || n < 1) {
      return LINE_REJECTED;
    }
    // Never more coils than are wired: v1 accepted up to MAX_COILS and drove
    // the unset pin slots, which are pin 0 (UART RX on an Uno).
    if (n > _wired) {
      n = _wired;
      _configClamped = true;
    }
    if (dwell < 1.0f) dwell = 1.0f;
    if (dwell > 180.0f) dwell = 180.0f;
    _config.numCoils = (uint8_t)n;
    _config.offsetAngle = offset;
    _config.dwellAngle = dwell;
    _config.advanceAngle = advance;
    return LINE_CONFIG;
  }
};

}  // namespace segfw

#endif  // SEG_SAFETY_H

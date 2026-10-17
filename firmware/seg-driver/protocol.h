#ifndef PROTOCOL_H
#define PROTOCOL_H

// ============================================
// SEG Driver Protocol Constants
// ============================================

// Line protocol version this sketch speaks. v2 keeps every v1 command byte for
// byte (P / C / CONF in, S / E / I out) and only *adds*: the `V` hello and the
// `I v=2 ...` reply. A v1 sketch drops `V` as an unknown command, so a v2 host
// still drives it — and still coasts it — with the v1 lines alone.
#define PROTOCOL_VERSION 2

// Control modes
#define MODE_RUN   0
#define MODE_BRAKE 1
#define MODE_COAST 2

// Default config
#define DEFAULT_NUM_COILS     8
#define DEFAULT_OFFSET_ANGLE  0.0f
#define DEFAULT_DWELL_ANGLE   67.5f
#define DEFAULT_ADVANCE_ANGLE 0.0f

// Safety
#define WATCHDOG_TIMEOUT_MS   100   // no valid P/C for this long -> all coils off
#define SERIAL_BAUD           115200

// BRAKE is a bounded holding pulse on every wired coil, not a regenerative
// brake: at most BRAKE_PWM_MAX duty for at most BRAKE_MAX_MS after entering
// brake, then all off until the host leaves brake. (v1 froze whichever coils
// RUN had last switched on, for as long as the host kept sending brake.)
#define BRAKE_PWM_MAX         128
#define BRAKE_MAX_MS          1000

// Per-coil continuous-on cap, whatever the mode: a coil held on this long
// (RUN at ~0 RPM, a held C override) is forced off for COIL_COOLDOWN_MS. So a
// host that keeps re-sending one static command gets at most 50% average on
// one coil, never DC. Conservative defaults for unknown coils — your coil's
// own thermal rating still applies (README → Hardware rules).
#define COIL_MAX_ON_MS        2000
#define COIL_COOLDOWN_MS      2000

// A received line longer than this is dropped whole, never parsed truncated.
#define LINE_MAX              64

// Pin defaults: see the pin maps in README.md (Uno/Nano, Mega 2560, ESP32).
#define MAX_COILS 24
#define MAX_HALLS 8

// Firing patterns (must match JS enum)
#define PATTERN_SINGLE       0
#define PATTERN_OVERLAP      1
#define PATTERN_TRAPEZOIDAL  2
#define PATTERN_SINUSOIDAL   3

#endif // PROTOCOL_H

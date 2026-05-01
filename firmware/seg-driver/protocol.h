#ifndef PROTOCOL_H
#define PROTOCOL_H

// ============================================
// SEG Driver Protocol Constants
// ============================================

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
#define WATCHDOG_TIMEOUT_MS   100
#define SERIAL_BAUD           115200

// Pin defaults (Arduino Uno/Nano)
// Coils: D3, D5, D6, D9, D10, D11 (PWM capable)
// Expandable on Mega or ESP32
#define MAX_COILS 24
#define MAX_HALLS 8

// Firing patterns (must match JS enum)
#define PATTERN_SINGLE       0
#define PATTERN_OVERLAP      1
#define PATTERN_TRAPEZOIDAL  2
#define PATTERN_SINUSOIDAL   3

#endif // PROTOCOL_H

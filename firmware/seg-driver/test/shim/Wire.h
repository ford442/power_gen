// Host-side I2C stand-in: no device ever ACKs, so the sketch takes its
// "no magnetometer" path. Test-only.
#ifndef SEG_TEST_WIRE_SHIM_H
#define SEG_TEST_WIRE_SHIM_H

#include <stdint.h>

class ShimWire {
 public:
  void begin() {}
  void beginTransmission(uint8_t) {}
  uint8_t write(uint8_t) { return 1; }
  uint8_t endTransmission() { return 2; }  // NACK on address
  uint8_t requestFrom(uint8_t, uint8_t) { return 0; }
  int available() { return 0; }
  int read() { return 0; }
};
inline ShimWire Wire;

#endif  // SEG_TEST_WIRE_SHIM_H

// Host-side stand-in for the Arduino core: just enough of the API for the SEG
// driver sketch to compile and run under `c++` on a desktop, with every pin
// write recorded. Test-only — never on a board. (C++17 inline variables.)
#ifndef SEG_TEST_ARDUINO_SHIM_H
#define SEG_TEST_ARDUINO_SHIM_H

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <string>

#define HIGH 1
#define LOW 0
#define INPUT 0
#define OUTPUT 1
#define INPUT_PULLUP 2
#define FALLING 2
#define NOT_AN_INTERRUPT -1
#ifndef PI
#define PI 3.14159265358979323846
#endif
#define F(s) (s)
#define constrain(amt, low, high) ((amt) < (low) ? (low) : ((amt) > (high) ? (high) : (amt)))

namespace shim {
constexpr int kPins = 64;
inline int level[kPins];          // -1 = never written; 0..255 duty
inline bool isOutput[kPins];
inline int inputLevel[kPins];     // what digitalRead returns
inline uint32_t highBeforeOutput = 0;  // a non-zero write to a pin not yet OUTPUT
inline uint32_t badPin = 0;       // pin number out of range
inline uint32_t writes[kPins];
inline uint32_t nowMs = 0;
inline std::string serialIn;
inline std::string serialOut;

inline void reset() {
  for (int i = 0; i < kPins; i++) {
    level[i] = -1;
    isOutput[i] = false;
    inputLevel[i] = HIGH;
    writes[i] = 0;
  }
  highBeforeOutput = 0;
  badPin = 0;
  nowMs = 0;
  serialIn.clear();
  serialOut.clear();
}

inline void record(uint8_t pin, int duty) {
  if (pin >= kPins) {
    badPin++;
    return;
  }
  if (duty > 0 && !isOutput[pin]) highBeforeOutput++;
  level[pin] = duty;
  writes[pin]++;
}
}  // namespace shim

inline void pinMode(uint8_t pin, uint8_t mode) {
  if (pin >= shim::kPins) {
    shim::badPin++;
    return;
  }
  shim::isOutput[pin] = (mode == OUTPUT);
}
inline void digitalWrite(uint8_t pin, uint8_t val) { shim::record(pin, val ? 255 : 0); }
inline void analogWrite(uint8_t pin, int val) { shim::record(pin, val < 0 ? 0 : (val > 255 ? 255 : val)); }
inline int digitalRead(uint8_t pin) { return pin < shim::kPins ? shim::inputLevel[pin] : LOW; }
inline unsigned long millis() { return shim::nowMs; }
inline unsigned long micros() { return shim::nowMs * 1000UL; }
inline void delay(unsigned long ms) { shim::nowMs += (uint32_t)ms; }
inline int digitalPinToInterrupt(uint8_t pin) { return (pin == 2 || pin == 3) ? pin - 2 : NOT_AN_INTERRUPT; }
inline void attachInterrupt(int, void (*)(), int) {}

class ShimSerial {
 public:
  void begin(unsigned long) {}
  explicit operator bool() const { return true; }
  int available() const { return (int)shim::serialIn.size(); }
  int read() {
    if (shim::serialIn.empty()) return -1;
    int c = (unsigned char)shim::serialIn[0];
    shim::serialIn.erase(0, 1);
    return c;
  }
  void print(const char* s) { shim::serialOut += s; }
  void print(char c) { shim::serialOut += c; }
  void print(unsigned long v) { shim::serialOut += std::to_string(v); }
  void print(unsigned int v) { shim::serialOut += std::to_string(v); }
  void print(int v) { shim::serialOut += std::to_string(v); }
  void print(long v) { shim::serialOut += std::to_string(v); }
  void print(unsigned char v) { shim::serialOut += std::to_string((unsigned)v); }
  void print(double v, int digits = 2) {
    char buf[48];
    snprintf(buf, sizeof(buf), "%.*f", digits, v);
    shim::serialOut += buf;
  }
  void println() { shim::serialOut += "\r\n"; }
  template <typename T>
  void println(T v) {
    print(v);
    println();
  }
};
inline ShimSerial Serial;

#endif  // SEG_TEST_ARDUINO_SHIM_H

#ifndef SEG_BLE_LINK_H
#define SEG_BLE_LINK_H

// ============================================
// BLE (Nordic UART) link plumbing — no radio code (#257 §4)
// ============================================
// What sits between a BLE stack's callbacks (another FreeRTOS task on the
// ESP32) and loop(), kept free of any BLE / Arduino header so the host test
// (test/safety_test.cpp, `npm run test:firmware-safety`) runs exactly this:
//
//   RX write callback ─► ByteRing (SPSC, drops a whole write when full and
//                         flags it) ─► loop(): LineAssembler ─► driver.onLine
//   disconnect callback ─► LinkState::onDisconnect (a latch) ─► loop():
//                         driver.linkLost() — coils off that loop, then the
//                         100 ms watchdog is the backstop if the callback is late
//   S / E / I lines ─► chunkLine(MTU − 3) ─► TX notify
//
// The radio never reaches a pin: every byte goes through the same
// LineAssembler → SafetyCore path as Serial. No BLE-specific command path.

#include <stddef.h>
#include <stdint.h>
#include <atomic>

#include "seg_safety.h"

namespace segfw {

/**
 * Single-producer (BLE task) / single-consumer (loop) byte ring. A write that
 * does not fit is dropped *whole* and flagged, and the consumer then discards
 * the partial line it was assembling — so two fragments can never splice into
 * a command neither of them was.
 */
template <size_t N>
class ByteRing {
  static_assert(N >= 2 && (N & (N - 1)) == 0, "ByteRing size must be a power of two");

 public:
  /** Producer side: all of data, or none of it. */
  bool push(const uint8_t* data, size_t len) {
    const size_t head = _head.load(std::memory_order_relaxed);
    const size_t tail = _tail.load(std::memory_order_acquire);
    if (len > N - 1 - ((head - tail) & (N - 1))) {
      _dropped.store(true, std::memory_order_release);
      return false;
    }
    for (size_t i = 0; i < len; i++) _buf[(head + i) & (N - 1)] = data[i];
    _head.store((head + len) & (N - 1), std::memory_order_release);
    return true;
  }

  /** Consumer side: next byte, or false when empty. */
  bool pop(uint8_t& out) {
    const size_t tail = _tail.load(std::memory_order_relaxed);
    if (tail == _head.load(std::memory_order_acquire)) return false;
    out = _buf[tail];
    _tail.store((tail + 1) & (N - 1), std::memory_order_release);
    return true;
  }

  /** True once after the producer dropped a write. */
  bool takeDropped() { return _dropped.exchange(false, std::memory_order_acq_rel); }

 private:
  uint8_t _buf[N] = {};
  std::atomic<size_t> _head{0};
  std::atomic<size_t> _tail{0};
  std::atomic<bool> _dropped{false};
};

/** Connection state set from the BLE task, consumed by loop(). */
class LinkState {
 public:
  void onConnect() {
    _connected.store(true, std::memory_order_release);
  }
  /** Latches "lost" until loop() takes it, even if a reconnect follows first. */
  void onDisconnect() {
    _connected.store(false, std::memory_order_release);
    _lost.store(true, std::memory_order_release);
  }
  bool connected() const { return _connected.load(std::memory_order_acquire); }
  bool takeLost() { return _lost.exchange(false, std::memory_order_acq_rel); }

 private:
  std::atomic<bool> _connected{false};
  std::atomic<bool> _lost{false};
};

/**
 * loop()'s half of the RX path: drain the ring into the assembler and hand
 * each complete line to `onLine(line)`. After a dropped write the partial
 * line is discarded (and so is the rest of it, up to its '\n').
 */
template <size_t N, class OnLine>
void drainLines(ByteRing<N>& ring, LineAssembler& lines, bool& skipToNewline, OnLine onLine) {
  if (ring.takeDropped()) {
    lines.reset();
    skipToNewline = true;
  }
  uint8_t c;
  while (ring.pop(c)) {
    if (skipToNewline) {
      if (c == '\n') skipToNewline = false;
      continue;
    }
    const char* line = lines.push((char)c);
    if (line) onLine(line);
  }
}

/**
 * Split one outgoing line (its '\n' included) into notifications of at most
 * `payload` bytes (ATT MTU − 3). Returns the number of chunks sent.
 */
template <class Send>
size_t chunkLine(const char* text, size_t len, size_t payload, Send send) {
  if (payload == 0) return 0;
  size_t chunks = 0;
  for (size_t at = 0; at < len; at += payload) {
    const size_t n = len - at < payload ? len - at : payload;
    send(reinterpret_cast<const uint8_t*>(text + at), n);
    chunks++;
  }
  return chunks;
}

}  // namespace segfw

#endif  // SEG_BLE_LINK_H

// "We will not ship firmware that can lock a coil on."
//
// Host-compiled test of the SEG driver sketch: the safety core, the coil
// controller and the sketch itself (setup()/loop()), run against a shim that
// records every pin write, with a 1 ms simulated loop. Every step checks:
//
//   I1  watchdog   a coil is on only if a valid P/C arrived <= WATCHDOG_TIMEOUT_MS ago
//   I2  DC cap     no coil stays on continuously for COIL_MAX_ON_MS or more
//   I3  brake      in BRAKE, duty <= BRAKE_PWM_MAX and only within BRAKE_MAX_MS of entering it
//   I4  pins       nothing but the wired coil pins is ever driven; nothing high before OUTPUT
//
// then scenarios for each way v1 could hold a coil on, a randomized fuzz, and
// an end-to-end run of seg-driver.ino. Build + run: `npm run test:firmware-safety`.
// Not a CI job (issue #217): run it before flashing anything changed here.

#include <Arduino.h>

#include <string>
#include <vector>

#include "../coil_controller.h"
#include "../sensor_manager.h"
#include "../seg_driver_core.h"

static int g_pass = 0;
static int g_fail = 0;

#define CHECK(cond, ...)                                  \
  do {                                                    \
    if (cond) {                                           \
      g_pass++;                                           \
    } else {                                              \
      g_fail++;                                           \
      printf("  FAIL %s:%d: ", __FILE__, __LINE__);       \
      printf(__VA_ARGS__);                                \
      printf("\n");                                       \
    }                                                     \
  } while (0)

static const uint8_t PINS6[] = {3, 5, 6, 9, 10, 11};
static const int N6 = 6;

static bool isWired(int pin) {
  for (int i = 0; i < N6; i++)
    if (PINS6[i] == pin) return true;
  return false;
}

// --------------------------------------------
// Bench: DriverCore on six coils, invariants checked every simulated ms
// --------------------------------------------

struct Bench {
  CoilController coils;
  DriverCore core;
  uint32_t now;
  bool everCommanded = false;
  uint32_t lastCommandMs = 0;
  uint32_t brakeEntryMs = 0;
  bool on[N6] = {};
  uint32_t onSince[N6] = {};
  uint32_t maxOnRun[N6] = {};
  uint32_t onTicks[N6] = {};
  std::vector<std::string> violations;

  explicit Bench(uint32_t start = 0) : core(coils, N6), now(start) {
    shim::reset();
    shim::nowMs = start;
    coils.begin(PINS6, N6);
    core.begin();
  }

  int level(int coil) const {
    int v = shim::level[PINS6[coil]];
    return v < 0 ? 0 : v;
  }
  bool anyOn() const {
    for (int i = 0; i < N6; i++)
      if (level(i) > 0) return true;
    return false;
  }
  uint8_t mode() { return core.safety().mode(); }

  segfw::LineResult line(const char* s) {
    uint8_t before = mode();
    segfw::LineResult r = core.onLine(s, now);
    if (r == segfw::LINE_COMMAND) {
      everCommanded = true;
      lastCommandMs = now;
      if (mode() == MODE_BRAKE && before != MODE_BRAKE) brakeEntryMs = now;
    }
    return r;
  }

  void violate(const char* what) {
    if (violations.size() < 8) {
      char buf[160];
      snprintf(buf, sizeof(buf), "t=%u: %s", (unsigned)now, what);
      violations.push_back(buf);
    }
  }

  void check() {
    bool any = anyOn();
    // I1
    if (any && (!everCommanded || (uint32_t)(now - lastCommandMs) > WATCHDOG_TIMEOUT_MS))
      violate("coil on without a valid command inside the watchdog window");
    // I2
    for (int i = 0; i < N6; i++) {
      if (level(i) > 0) {
        onTicks[i]++;
        if (!on[i]) {
          on[i] = true;
          onSince[i] = now;
        }
        uint32_t run = (uint32_t)(now - onSince[i]) + 1;
        if (run > maxOnRun[i]) maxOnRun[i] = run;
        if (run > COIL_MAX_ON_MS) violate("coil on continuously past COIL_MAX_ON_MS");
      } else {
        on[i] = false;
      }
    }
    // I3
    if (any && mode() == MODE_BRAKE) {
      for (int i = 0; i < N6; i++)
        if (level(i) > BRAKE_PWM_MAX) violate("brake duty above BRAKE_PWM_MAX");
      if ((uint32_t)(now - brakeEntryMs) >= BRAKE_MAX_MS) violate("brake held past BRAKE_MAX_MS");
    }
    // I4
    for (int p = 0; p < shim::kPins; p++)
      if (!isWired(p) && shim::writes[p] > 0) violate("an unwired pin was written");
    if (shim::highBeforeOutput) violate("a pin was driven before it was an OUTPUT");
    if (shim::badPin) violate("write to an out-of-range pin");
  }

  void step() {
    shim::nowMs = now;
    core.step(now);
    check();
    now++;
  }
  void run(uint32_t ms) {
    for (uint32_t t = 0; t < ms; t++) step();
  }
  void stream(const char* s, uint32_t periodMs, uint32_t totalMs) {
    for (uint32_t t = 0; t < totalMs; t++) {
      if (t % periodMs == 0) line(s);
      step();
    }
  }
  /** What the web host really sends: P every periodMs with the phase advanced at rpm. */
  void streamRotating(float rpm, uint32_t periodMs, uint32_t totalMs, bool* sawCoil = nullptr) {
    for (uint32_t t = 0; t < totalMs; t++) {
      if (t % periodMs == 0) {
        char l[48];
        float phase = fmodf(phaseDeg, 360.0f);
        snprintf(l, sizeof(l), "P%.2f,%.1f,0", phase, rpm);
        line(l);
      }
      phaseDeg += rpm * 6.0f / 1000.0f;
      step();
      if (sawCoil)
        for (int i = 0; i < N6; i++) sawCoil[i] = sawCoil[i] || level(i) > 0;
    }
  }
  float phaseDeg = 0.0f;
  bool clean(const char* name) {
    for (auto& v : violations) printf("  [%s] %s\n", name, v.c_str());
    return violations.empty();
  }
  /** Step until every coil is off; return (time of the first all-off step) - since. */
  uint32_t stepUntilOff(uint32_t since, uint32_t limitMs = 1000) {
    while ((uint32_t)(now - since) < limitMs) {
      uint32_t t = now;
      step();
      if (!anyOn()) return (uint32_t)(t - since);
    }
    return limitMs;
  }
};

// Re-sending one P line resets the phase each time, so the board only
// extrapolates up to one period (16 ms ≈ 6° at 60 RPM): effectively a hold on
// coil 0. Bench::streamRotating() is the realistic, advancing stream.
static const char* RUN60 = "P0.00,60.0,0";
static const char* HOLD300 = "P300.00,0.0,0"; // 0 RPM at coil 5's centre: a static DC hold

// --------------------------------------------
// Scenarios
// --------------------------------------------

static void bootQuiet() {
  Bench b;
  for (int i = 0; i < N6; i++) {
    CHECK(shim::level[PINS6[i]] == 0, "boot: coil %d not driven LOW by begin() (level %d)", i, shim::level[PINS6[i]]);
    CHECK(shim::isOutput[PINS6[i]], "boot: coil %d not an OUTPUT", i);
  }
  b.run(10000);
  CHECK(!b.anyOn(), "boot: a coil came on with no host at all");
  CHECK(b.clean("boot"), "boot: invariant violated");
}

static void v1StreamThenSilence() {
  Bench b;
  bool saw[N6] = {};
  b.streamRotating(60.0f, 16, 3000, saw);
  for (int i = 0; i < N6; i++) CHECK(saw[i], "v1 stream: coil %d never lit in 3 revolutions", i);
  uint32_t offAfter = b.stepUntilOff(b.lastCommandMs);
  CHECK(offAfter == WATCHDOG_TIMEOUT_MS + 1, "v1 stream: coils went off %u ms after the last P (want %u)", (unsigned)offAfter, (unsigned)WATCHDOG_TIMEOUT_MS + 1);
  CHECK(b.core.safety().takeWatchdogTrip(), "v1 stream: watchdog trip not reported");
  b.run(2000);
  CHECK(!b.anyOn(), "v1 stream: coil came back on during silence");
  CHECK(b.clean("v1-silence"), "v1 stream: invariant violated");
}

static void unknownModeCoasts() {
  Bench b;
  b.stream(HOLD300, 16, 200);
  CHECK(b.level(5) > 0, "unknown mode: setup hold did not light coil 5");
  CHECK(b.line("P300.00,0.0,3") == segfw::LINE_REJECTED, "unknown mode: mode 3 accepted");
  b.step();
  CHECK(!b.anyOn(), "unknown mode: coils still on the step after mode 3 (v1 froze them)");
  b.stream("P300.00,0.0,3", 16, 2000);
  CHECK(!b.anyOn(), "unknown mode: a streamed mode 3 re-energised a coil");
  CHECK(b.mode() == MODE_COAST, "unknown mode: not coasting");
  CHECK(b.clean("unknown-mode"), "unknown mode: invariant violated");
}

static void garbageNeverFeeds() {
  const char* bad[] = {
    "P0.00,60.0,x", "Pnan,1,0", "P1,inf,0", "P,,", "P1,2", "P1,2,0,", "P1,2,-0", "P1,2,0x1",
    "P1e999,0,0", "C1,999,0", "C-1,10,0", "C1,10", "Cx,1,0", "C1,10,0,", "C1,10,70000", "C1 ,10,0"};
  for (const char* g : bad) {
    Bench b;
    b.stream(HOLD300, 16, 100);
    CHECK(b.anyOn(), "garbage: setup hold off");
    segfw::LineResult r = b.line(g);
    CHECK(r == segfw::LINE_REJECTED, "garbage: '%s' was not rejected (result %d)", g, (int)r);
    b.step();
    CHECK(!b.anyOn(), "garbage: '%s' did not stop the motor", g);
    // A stream of nothing but garbage never brings a coil back.
    for (uint32_t t = 0; t < 500; t++) {
      if (t % 16 == 0) b.line(g);
      b.step();
    }
    CHECK(!b.anyOn(), "garbage: streamed '%s' energised a coil", g);
    CHECK(b.clean(g), "garbage: invariant violated for '%s'", g);
  }
  // Unknown command letters are ignored (forward compatibility), and do not feed.
  Bench b;
  b.stream(HOLD300, 16, 100);
  CHECK(b.line("X1,2,3") == segfw::LINE_IGNORED, "unknown letter not ignored");
  CHECK(b.line("V2") == segfw::LINE_HELLO, "V2 not a hello");
  uint32_t last = b.lastCommandMs;
  for (uint32_t t = 0; t < 400; t++) {
    if (t % 16 == 0) {
      b.line("V2");
      b.line("X1,2,3");
      b.line("CONF6,0,90,0");
    }
    b.step();
  }
  CHECK(!b.anyOn(), "V/X/CONF kept a coil alive past the watchdog (last P at %u)", (unsigned)last);
  CHECK(b.clean("ignored"), "ignored lines: invariant violated");
}

static void brakeIsBounded() {
  Bench b;
  b.stream(HOLD300, 16, 200);
  CHECK(b.level(5) > 0, "brake: setup hold off");
  uint32_t braking = 0;
  for (uint32_t t = 0; t < 5000; t++) {
    if (t % 16 == 0) b.line("P0.00,0.0,1");
    b.step();
    if (b.anyOn()) braking++;
    for (int i = 0; i < N6; i++)
      if (b.level(i) > BRAKE_PWM_MAX) {
        CHECK(false, "brake: coil %d at duty %d", i, b.level(i));
        i = N6;
        t = 5000;
      }
  }
  CHECK(braking > 0 && braking <= BRAKE_MAX_MS, "brake: on for %u ms of a 5 s brake (cap %u)", (unsigned)braking, (unsigned)BRAKE_MAX_MS);
  CHECK(!b.anyOn(), "brake: still on at the end of a 5 s brake");
  // Leaving brake and coming back re-arms one bounded pulse.
  b.line("P0.00,0.0,2");
  b.step();
  b.stream("P0.00,0.0,1", 16, 300);
  CHECK(b.anyOn(), "brake: re-entering brake did not re-arm");
  CHECK(b.clean("brake"), "brake: invariant violated");
}

static void manualOverride() {
  {
    Bench b;
    b.stream(RUN60, 16, 100);
    for (uint32_t t = 0; t < 1000; t++) {
      if (t % 16 == 0) b.line("C3,200,0");
      b.step();
    }
    CHECK(b.level(0) == 200 && b.level(1) == 200, "manual: coils 0/1 not at 200 (%d, %d)", b.level(0), b.level(1));
    for (int i = 2; i < N6; i++) CHECK(b.level(i) == 0, "manual: coil %d on outside the mask", i);
    uint32_t offAfter = b.stepUntilOff(b.lastCommandMs);
    CHECK(offAfter == WATCHDOG_TIMEOUT_MS + 1, "manual: override went off %u ms after the last C", (unsigned)offAfter);
    CHECK(b.clean("manual"), "manual: invariant violated");
  }
  {
    // durationMs is honoured now (v1 parsed and dropped it). Coil 3 sits at
    // 180°, which RUN at ~0-20° never lights, so once the pulse ends it is off.
    Bench b;
    b.stream(RUN60, 16, 100);
    b.line("C8,255,50");
    b.run(49);
    CHECK(b.level(3) == 255, "manual: C with 50 ms duration not on at 49 ms");
    b.run(2);
    CHECK(b.level(3) == 0, "manual: C with 50 ms duration still on at 51 ms (%d)", b.level(3));
    CHECK(b.clean("manual-duration"), "manual duration: invariant violated");
  }
  {
    // An override never energises from COAST.
    Bench b;
    b.line("P0.00,0.0,2");
    for (uint32_t t = 0; t < 500; t++) {
      if (t % 16 == 0) b.line("C63,255,0");
      b.step();
    }
    CHECK(!b.anyOn(), "manual: C energised coils while coasting");
    CHECK(b.clean("manual-coast"), "manual coast: invariant violated");
  }
}

static void confClampAndShrink() {
  {
    Bench b;
    CHECK(b.line("CONF12,0,45,0") == segfw::LINE_CONFIG, "conf: CONF12 rejected");
    CHECK(b.core.safety().takeConfigClamped(), "conf: clamp not reported");
    CHECK(b.coils.getNumCoils() == N6, "conf: CONF12 gave %u coils on a 6-coil board", (unsigned)b.coils.getNumCoils());
    bool saw[N6] = {};
    b.streamRotating(60.0f, 16, 3000, saw);  // three revolutions: every coil slot is reached
    for (int i = 0; i < N6; i++) CHECK(saw[i], "conf: coil %d never lit while rotating", i);
    CHECK(shim::writes[0] == 0, "conf: pin 0 written (v1 drove unset pin slots)");
    CHECK(b.clean("conf-clamp"), "conf clamp: invariant violated");
  }
  {
    Bench b;
    b.stream(HOLD300, 16, 200);
    CHECK(b.level(5) > 0, "conf shrink: coil 5 not lit by the hold");
    b.line("CONF4,0,90,0");
    b.line(HOLD300);
    b.step();
    CHECK(b.level(5) == 0 && b.level(4) == 0, "conf shrink: coils above the new count stayed on (4=%d 5=%d)", b.level(4), b.level(5));
    CHECK(b.clean("conf-shrink"), "conf shrink: invariant violated");
  }
}

static void dcHoldIsCapped() {
  Bench b;
  b.stream(HOLD300, 16, 10000);
  CHECK(b.maxOnRun[5] <= COIL_MAX_ON_MS, "dc hold: coil 5 on for %u ms at a stretch", (unsigned)b.maxOnRun[5]);
  CHECK(b.onTicks[5] > 0 && b.onTicks[5] <= 10000 / 2 + COIL_MAX_ON_MS,
        "dc hold: coil 5 on %u of 10000 ms (cap is ~50%%)", (unsigned)b.onTicks[5]);
  CHECK(b.core.guard().takeTrip(), "dc hold: guard trip not reported");
  CHECK(b.clean("dc-hold"), "dc hold: invariant violated");

  // While a coil cools down, a fresh command does not bring it back early.
  Bench c;
  c.stream(HOLD300, 16, COIL_MAX_ON_MS + 5);
  CHECK(c.level(5) == 0, "dc hold: coil 5 not cooling after the cap");
  c.stream(HOLD300, 16, COIL_COOLDOWN_MS - 20);
  CHECK(c.level(5) == 0, "dc hold: coil 5 back on before COIL_COOLDOWN_MS");
}

static void linkLostIsImmediate() {
  Bench b;
  b.stream(HOLD300, 16, 200);
  CHECK(b.anyOn(), "link lost: setup hold off");
  b.core.linkLost();
  CHECK(!b.anyOn(), "link lost: coils still on in the same call");
  b.run(1000);
  CHECK(!b.anyOn(), "link lost: coil came back with no new command");
  b.stream(HOLD300, 16, 100);
  CHECK(b.anyOn(), "link lost: a reconnected host could not drive again");
  CHECK(b.clean("link-lost"), "link lost: invariant violated");
}

static void millisWrap() {
  Bench b(0xFFFFFF00u);
  b.stream(RUN60, 16, 600);  // crosses 2^32
  CHECK(b.now < 0x1000u, "wrap: test did not cross the wrap");
  uint32_t offAfter = b.stepUntilOff(b.lastCommandMs);
  CHECK(offAfter == WATCHDOG_TIMEOUT_MS + 1, "wrap: watchdog cut at %u ms across the millis() wrap", (unsigned)offAfter);
  CHECK(b.clean("wrap"), "wrap: invariant violated");
}

static void lineAssembler() {
  segfw::LineAssembler la;
  auto feed = [&](const std::string& s) {
    std::vector<std::string> out;
    for (char c : s) {
      const char* l = la.push(c);
      if (l) out.push_back(l);
    }
    return out;
  };
  auto a = feed("P1,2,0\r\n");
  CHECK(a.size() == 1 && a[0] == "P1,2,0", "assembler: CRLF line");
  a = feed("  P1,2,0  \n");
  CHECK(a.size() == 1 && a[0] == "P1,2,0", "assembler: trim");
  a = feed("\n\r\n   \n");
  CHECK(a.empty(), "assembler: blank lines produced output");
  std::string longLine = "P1.000000000000000000000000000000,2.000000000000000000000000000000,0";
  CHECK(longLine.size() > LINE_MAX, "assembler: test line not long");
  a = feed(longLine + "\nP3,4,0\n");
  CHECK(a.size() == 1 && a[0] == "P3,4,0", "assembler: overlong line not dropped whole (got %zu lines)", a.size());
  a = feed("P5,");
  CHECK(a.empty(), "assembler: partial line emitted");
  a = feed("6,0\n");
  CHECK(a.size() == 1 && a[0] == "P5,6,0", "assembler: split line");
}

static void helloLine() {
  segfw::SafetyCore core(6);
  char buf[112];
  core.formatHello(buf, sizeof(buf), "uno", "serial", 2);
  CHECK(std::string(buf) == "I v=2 fw=seg-driver board=uno link=serial coils=6 halls=2 wd=100 brake=128/1000",
        "hello: '%s'", buf);
}

// Random host: valid and invalid lines, silences, link drops — invariants every ms.
static void fuzz() {
  uint32_t s = 0x9E3779B9u;
  auto rnd = [&]() {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    return s;
  };
  Bench b;
  char line[96];
  const uint32_t total = 3000000;
  uint32_t energised = 0;
  for (uint32_t t = 0; t < total; t++) {
    uint32_t r = rnd() % 1000;
    if (r < 60) {
      uint32_t k = rnd() % 12;
      switch (k) {
        case 0: case 1: case 2: case 3:
          snprintf(line, sizeof(line), "P%.2f,%.1f,%u", (rnd() % 36000) / 100.0, ((int)(rnd() % 4000) - 2000) / 10.0, (unsigned)(rnd() % 3));
          break;
        case 4:
          snprintf(line, sizeof(line), "P%.2f,%.1f,%u", (rnd() % 36000) / 100.0, 0.0, (unsigned)(rnd() % 7));
          break;
        case 5:
          snprintf(line, sizeof(line), "C%u,%u,%u", (unsigned)(rnd() % 256), (unsigned)(rnd() % 300), (unsigned)(rnd() % 200));
          break;
        case 6:
          snprintf(line, sizeof(line), "CONF%u,%.1f,%.1f,%.1f", (unsigned)(rnd() % 30), (rnd() % 360) * 1.0, (rnd() % 200) * 1.0, (rnd() % 40) * 1.0);
          break;
        case 7:
          snprintf(line, sizeof(line), "%s", (rnd() & 1) ? "V2" : "V");
          break;
        case 8: {
          int n = (int)(rnd() % 20);
          line[0] = (rnd() & 1) ? 'P' : 'C';
          for (int i = 1; i <= n; i++) line[i] = (char)(32 + rnd() % 95);
          line[n + 1] = '\0';
          break;
        }
        case 9:
          b.core.linkLost();
          line[0] = '\0';
          break;
        case 10: {
          uint32_t gap = rnd() % 400;  // the host stalls
          for (uint32_t g = 0; g < gap && t < total; g++, t++) {
            b.step();
            if (b.anyOn()) energised++;
          }
          line[0] = '\0';
          break;
        }
        default:
          snprintf(line, sizeof(line), "P%.2f,%.1f,0", (rnd() % 36000) / 100.0, 0.0);  // static holds
          break;
      }
      if (line[0]) b.line(line);
    }
    b.step();
    if (b.anyOn()) energised++;
    if (!b.violations.empty()) break;
  }
  CHECK(energised > total / 20, "fuzz: coils were on for only %u of %u ms (fuzz too timid to mean much)", (unsigned)energised, (unsigned)total);
  CHECK(b.clean("fuzz"), "fuzz: invariant violated");
}

// --------------------------------------------
// The sketch itself, end to end
// --------------------------------------------

namespace sketch {
#include "../seg-driver.ino"
}

static const uint8_t UNO_COILS[] = {3, 5, 6, 9, 10, 11};

static bool sketchAnyOn() {
  for (uint8_t p : UNO_COILS)
    if (shim::level[p] > 0) return true;
  return false;
}

static void sketchLoop(uint32_t ms, const char* lineEvery16 = nullptr) {
  for (uint32_t t = 0; t < ms; t++) {
    if (lineEvery16 && t % 16 == 0) {
      shim::serialIn += lineEvery16;
      shim::serialIn += "\n";
    }
    sketch::loop();
    shim::nowMs++;
  }
}

/** The web host's real stream, as bytes on the sketch's Serial: P at 60 RPM, phase advancing. */
static uint32_t sketchRotate(uint32_t ms) {
  uint32_t litMask = 0;
  for (uint32_t t = 0; t < ms; t++) {
    if (t % 16 == 0) {
      char l[48];
      snprintf(l, sizeof(l), "P%.2f,60.0,0\n", fmod(shim::nowMs * 0.36, 360.0));
      shim::serialIn += l;
    }
    sketch::loop();
    for (int i = 0; i < 6; i++)
      if (shim::level[UNO_COILS[i]] > 0) litMask |= 1u << i;
    shim::nowMs++;
  }
  return litMask;
}

static void sketchEndToEnd() {
  shim::reset();
  sketch::setup();
  for (uint8_t p : UNO_COILS) {
    CHECK(shim::isOutput[p] && shim::level[p] == 0, "sketch: coil pin %u not LOW OUTPUT after setup()", (unsigned)p);
  }
  const std::string hello = "I v=2 fw=seg-driver board=uno link=serial coils=6 halls=2 wd=100 brake=128/1000";
  CHECK(shim::serialOut.find(hello) != std::string::npos, "sketch: boot hello missing; output was:\n%s", shim::serialOut.c_str());

  shim::serialOut.clear();
  shim::serialIn += "V2\n";
  sketchLoop(1);
  CHECK(shim::serialOut.find(hello) != std::string::npos, "sketch: no hello reply to V2");

  // A v1 host never sends V: plain P lines drive it, and every coil commutes.
  uint32_t lit = sketchRotate(2000);
  CHECK(lit == 0x3Fu, "sketch: rotating P stream lit coil mask 0x%X, want 0x3F", (unsigned)lit);
  CHECK(shim::serialOut.find("\r\nS") != std::string::npos, "sketch: no S stream");

  shim::serialOut.clear();
  sketchLoop(WATCHDOG_TIMEOUT_MS + 2);
  CHECK(!sketchAnyOn(), "sketch: coils on after %u ms of silence", (unsigned)WATCHDOG_TIMEOUT_MS + 2);
  CHECK(shim::serialOut.find("E Watchdog") != std::string::npos, "sketch: watchdog trip not reported");

  sketchLoop(500, "P0.00,60.0,3");
  CHECK(!sketchAnyOn(), "sketch: undefined mode energised a coil");

  shim::serialOut.clear();
  shim::serialIn += "CONF12,0,45,0\n";
  sketchLoop(2);
  CHECK(shim::serialOut.find("E CONF asked for more coils") != std::string::npos, "sketch: CONF clamp not reported");
  CHECK(shim::serialOut.find("I Config updated: coils=6") != std::string::npos, "sketch: CONF not acknowledged with the clamped count");
  lit = sketchRotate(3000);
  CHECK(lit == 0x3Fu, "sketch: after CONF12, rotating lit 0x%X, want all six wired coils", (unsigned)lit);
  for (int p = 0; p < shim::kPins; p++) {
    bool coil = false;
    for (uint8_t c : UNO_COILS) coil = coil || c == p;
    if (!coil && shim::level[p] > 0) CHECK(false, "sketch: non-coil pin %d driven to %d", p, shim::level[p]);
  }
  CHECK(shim::highBeforeOutput == 0 && shim::badPin == 0, "sketch: pin driven before OUTPUT, or out of range");
}

int main() {
  struct {
    const char* name;
    void (*fn)();
  } tests[] = {
    {"boot is quiet", bootQuiet},
    {"v1 stream, then silence -> watchdog", v1StreamThenSilence},
    {"undefined mode coasts", unknownModeCoasts},
    {"malformed lines stop the motor and never feed", garbageNeverFeeds},
    {"brake is bounded in duty and time", brakeIsBounded},
    {"manual override: mask, duration, watchdog, not from coast", manualOverride},
    {"CONF never addresses unwired pins; shrinking turns coils off", confClampAndShrink},
    {"a static hold cannot become DC", dcHoldIsCapped},
    {"link lost -> off in the same call", linkLostIsImmediate},
    {"watchdog across the millis() wrap", millisWrap},
    {"line assembly", lineAssembler},
    {"hello line", helloLine},
    {"fuzz: 3,000,000 ms of a random host", fuzz},
    {"the sketch end to end (setup/loop over the shim)", sketchEndToEnd},
  };
  for (auto& t : tests) {
    int before = g_fail;
    t.fn();
    printf("%s %s\n", g_fail == before ? "ok  " : "FAIL", t.name);
  }
  printf("[firmware-safety] %d checks passed, %d failed\n", g_pass, g_fail);
  return g_fail ? 1 : 0;
}

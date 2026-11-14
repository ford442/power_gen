# SEG driver firmware — line protocol v2 (experimental)

Arduino sketch that drives an electromagnet array from the visualizer's
hardware twin (`src/hardware-bridge.ts`) and streams hall / magnetometer state
back. **Experimental.** The web app never needs it, CI never builds it, it is
not certified for anything, and it is only for **low-voltage DC coils** — never
mains.

Protocol reference: [`docs/hardware_connection.md`](../../docs/hardware_connection.md).

| File | Role |
|------|------|
| `seg-driver.ino` | Board glue: pin maps, Serial, sensors, the S stream |
| `seg_safety.h` | **Every decision about whether a coil may be on** — parser, watchdog, modes, brake bound, per-coil DC cap. No Arduino dependency |
| `seg_driver_core.h` | The command → pin path the sketch and the test share |
| `coil_controller.{h,cpp}` | Commutation geometry and pin writes |
| `sensor_manager.{h,cpp}` | Hall + QMC5883L/HMC5883L fusion (unchanged from v1) |
| `protocol.h` | Version, modes, safety constants |
| `test/` | Host test + Arduino shim — never compiled into the sketch |

## Protocol v2

v2 keeps every v1 line byte for byte — `P` / `C` / `CONF` in, `S` / `E` / `I`
out — and adds one exchange:

```
host  → board   V2
board → host    I v=2 fw=seg-driver board=uno link=serial coils=6 halls=2 wd=100 brake=128/1000
```

The board also prints that line once at boot. Everything else v2 changes is
*inside* the board: stricter parsing and tighter bounds (next section).

| | v1 sketch | v2 sketch |
|---|---|---|
| **v1 host** (never sends `V`) | as before | works unchanged; the boot hello is an `I` line, which a v1 host logs as info |
| **v2 host** (sends `V2` on connect) | `V2` is an unknown command, which v1 drops; the host reports *no hello (v1 firmware)* and drives it with v1 lines | hello answered; the host shows `fw v2` and the board's limits |

**Disconnect still coasts on every transport, against either sketch.** The host's
coast is `P0,0,2` then `C0,0,0` — v1 lines, flushed before the link closes
(`npm run test:transports` pins that). A link that drops on its own leaves the
board's watchdog to cut the coils — **100 ms, unchanged from v1**.

## "We will not ship firmware that can lock a coil on"

What that means here, all enforced in `seg_safety.h` and checked by
`npm run test:firmware-safety` on every simulated millisecond:

1. **Watchdog.** A coil is on only while a valid `P` or `C` arrived in the last
   100 ms. `V`, `CONF`, unknown letters and malformed lines never refresh it.
2. **Defined modes only.** A `P` with a mode other than 0/1/2, or any `P`/`C`
   the parser cannot read whole (`nan`, `inf`, signs, missing or extra fields,
   out-of-range values), coasts the motor.
3. **Bounded brake.** BRAKE is ≤ 50 % duty (`BRAKE_PWM_MAX` 128) on every coil
   for ≤ `BRAKE_MAX_MS` (1 s), then off until the host leaves brake. It is a
   holding pulse, not a regenerative brake.
4. **No DC, however it is commanded.** A coil on for `COIL_MAX_ON_MS` (2 s) at a
   stretch is forced off for `COIL_COOLDOWN_MS` (2 s). That covers RUN at
   ~0 RPM and a held `C` override — a host that keeps re-sending one static
   command gets at most ~50 % average on one coil, never a locked coil.
5. **Only wired pins.** `CONF` can lower the coil count but never raise it past
   the pins in the map, and every wired coil is rewritten every loop, so a coil
   outside the configured count cannot stay latched.
6. **Link lost → off now.** `DriverCore::linkLost()` writes every coil low in
   the same call (for transports that can see a disconnect).
7. **Boot.** Every coil pin is written LOW before it becomes an OUTPUT, before
   Serial or I2C start.

The test (`test/safety_test.cpp`) runs those as invariants under targeted
scenarios, a 3,000,000 ms fuzz of a random host (valid and invalid lines,
stalls, link drops) and an end-to-end run of `seg-driver.ino`'s own
`setup()`/`loop()` over a recording shim. Each guarantee has been checked by
breaking it on purpose (watchdog ×50, guard removed, `CONF` unclamped, undefined
modes accepted, brake cap ×100); every one of those fails the test.

```bash
npm run test:firmware-safety   # host c++ / g++ / clang++; ~1 s
```

**Not a CI job** (issue #217): run it by hand before flashing anything changed
in this folder. No compiler → it says *SKIPPED*, never *passed*.

### What the test cannot see

- **Hardware that fails on.** A MOSFET that fails short holds its coil on with
  the MCU powered down. Only a fuse and a supply switch catch that (below).
- **The reset / flash window** before `setup()` runs — that is the gate
  pull-down's job.
- **Board-core PWM behaviour.** The shim treats a pin as whatever was last
  written. The sketch writes every level with `analogWrite()` because on the
  ESP32 core `digitalWrite()` does not reliably take back a pin that
  `analogWrite()` has handed to LEDC — but that is reasoning, not a test.
- Thermal limits of your coils. The DC cap bounds average duty; it is not a
  thermal model.

### What v2 fixed in v1

Found while writing the test above. Each row is a way v1 could leave a coil
energised (or do something else unintended) while the host was still talking
to it:

| v1 behaviour | Effect | v2 |
|---|---|---|
| A `P` with mode 3+ fell through every branch | coils frozen in their last state for as long as the host kept sending | coasts |
| BRAKE called `setManual()` but never wrote the pins | froze whatever RUN last lit, indefinitely | bounded pulse, then off |
| `toInt()` / `toFloat()` return 0 on garbage | a garbled mode read as RUN | fields parsed whole or the line is rejected |
| `CONF` clamped to `MAX_COILS` (24) | `CONF12` on six pins drove unset pin slots — pin 0, UART RX on an Uno | clamped to the wired count |
| Shrinking the count only rewrote the configured coils | coils above it stayed latched on | every wired coil written each loop |
| `CONF` was matched as `C` (first letter only) | `CONF` never applied | `CONF` checked first |
| Lines over 64 chars were cut and *parsed* | a truncated `P` could drive coils | dropped whole |
| `digitalWrite` for 0/255, `analogWrite` between | ESP32: a "LOW" might not reach a PWM-attached pin | `analogWrite` only |
| No limit on a static hold | RUN at 0 RPM / held `C` = DC indefinitely | 2 s on, 2 s cooldown |
| `C` duration parsed and ignored | — | honoured |

## Pin maps

Selected at compile time by board (`seg-driver.ino`). The rule for coil pins:
PWM-capable, and **never** a pin that toggles or floats high during reset, boot
or flashing.

**Arduino Uno / Nano (ATmega328P)** — `board=uno`, 6 coils

| Signal | Pins | Notes |
|--------|------|-------|
| Coils 0–5 | D3, D5, D6, D9, D10, D11 | PWM pins; D13 avoided (bootloader blinks it) |
| Hall H0 | D2 | INT0 |
| Hall H1 | D4 | polled — D3 is coil 0 (the old doc put H1 on D3; that collided) |
| Magnetometer | A4 SDA, A5 SCL | |

**Arduino Mega 2560** — `board=mega`, 12 coils

| Signal | Pins | Notes |
|--------|------|-------|
| Coils 0–11 | D4–D12, D44, D45, D46 | PWM pins; skips D2/D3 (hall interrupts), D13 (bootloader LED), D20/D21 (I2C) |
| Hall H0, H1 | D2, D3 | interrupts |
| Magnetometer | D20 SDA, D21 SCL | |

**ESP32 DevKitC (WROOM-32)** — `board=esp32`, 6 coils, 3.3 V logic

| Signal | Pins | Notes |
|--------|------|-------|
| Coils 0–5 | GPIO 25, 26, 27, 32, 33, 4 | output-safe GPIOs |
| Hall H0, H1 | GPIO 18, 19 | internal pull-ups work here (not on 34–39) |
| Magnetometer | GPIO 21 SDA, GPIO 22 SCL | default `Wire` pins |
| **Never for a coil** | 0, 2, 5, 12, 15 (strapping); 6–11 (flash); 1, 3 (UART0); 14 (pulses at boot); 34–39 (input-only); 16/17 on WROVER (PSRAM) | |

Needs an ESP32 Arduino core that provides `analogWrite()` (3.x does). Flashing
over USB serial uses the same protocol as the Uno; the host's **Serial** button
is the path.

## Hardware rules (the half software cannot enforce)

- **Low-voltage DC coil supply only** (12–24 V), separate from logic, common
  ground. Never mains, never a transformer-less supply.
- **10 kΩ gate pull-down on every MOSFET** (gate to source), so a coil stays off
  while the MCU is in reset, booting or being flashed — before any of the
  firmware above exists.
- **Flyback diode across every coil.** Without them the MOSFETs fail, and they
  can fail *shorted* — on.
- **Fuse the coil supply** for your coils' current, and give it a **switch you
  can reach**. A shorted MOSFET is a lock-on no firmware can see.
- **3.3 V boards (ESP32):** a MOSFET specified for full enhancement at
  V_GS ≈ 2.5–3.3 V, or a gate driver. A 5 V-gate part half-on is a heater.
- Duty within your coils' thermal rating. The DC cap is a backstop, not a rating.

## ESP32 + Bluetooth (Nordic UART) on the board — deferred

The web side has spoken Nordic UART since WS3 (`src/bluetooth-uart-transport.ts`:
the service and characteristic UUIDs in `docs/hardware_connection.md`, 20-byte
write chunks, a 50 ms command period), and `npm run test:transports` pins its
framing and its coast-on-disconnect against a fake GATT link. **The on-board BLE
peripheral is not in this sketch, on purpose:**

1. **Nothing here can build or bench it.** There is no ESP32 toolchain or board
   in this repo, and firmware is kept out of CI by design. The host test covers
   the safety core, but not a radio stack's callbacks.
2. **The ESP32 BLE APIs differ between versions** in ways that break code written
   for the other one — for example `BLECharacteristic::getValue()` returns
   `std::string` on Arduino core 2.x and Arduino `String` on 3.x, and NimBLE's
   callback signatures changed between its 1.x and 2.x. Code written blind would
   most likely not compile on the reader's setup.
3. **A radio path into a coil driver is exactly where "untested but probably
   fine" is not acceptable** under the lock-on rule above.

What a BLE build has to do, so whoever has a board can add it without touching
the safety logic:

- Advertise the Nordic UART service; RX (`…0002…`) writes go byte by byte into
  the **same** `segfw::LineAssembler` → `driver.onLine(line, now)`. No
  BLE-specific command path.
- On disconnect, call **`driver.linkLost()`** — coils off in that callback — then
  restart advertising.
- Notify `S` / `E` / `I` lines on TX (`…0003…`), chunked to the negotiated MTU.
- Report `link=ble` in the hello.
- Leave `WATCHDOG_TIMEOUT_MS` at 100: the host's 20 Hz period (50 ms) already
  fits inside it.
- Before merging: `npm run test:firmware-safety`, then on the bench — connect,
  drive, walk out of range with coils on, and confirm they drop within 100 ms.

## Build and flash

Arduino IDE 2 or `arduino-cli`: open `seg-driver.ino`, pick the board, flash.
Serial at **115200**. After changing anything here, run
`npm run test:firmware-safety` first.

# SEG Hardware Connection Spec

## Overview
This document defines the protocol, wiring, and configuration for connecting the SEG WebGPU Visualizer to an Arduino-driven electromagnet array.

## Communication Protocol

### Physical Layer

The protocol is the same on every link: newline-terminated ASCII, app → board
`P` / `C` / `CONF`, board → app `S` / `E` / `I`. Only the bytes' route differs.

| Transport | API | Baud / rate | When to use |
|-----------|-----|-------------|-------------|
| `serial` | Web Serial (Chrome/Edge 113+) | 115200 8N1, ~60 Hz commands | **Reference link.** Anything that enumerates as a USB CDC serial port |
| `bluetooth` | Web Bluetooth GATT, Nordic UART Service | ~20 Hz commands (`BLE_COMMAND_THROTTLE_MS`) | Classroom tables that cannot run a cable to the bench |
| `usb` | WebUSB, CDC-ACM interface | 115200 8N1, ~60 Hz commands | Only when the platform hides the board's CDC interface from Web Serial |
| `mock` | none | ~125 Hz `S` stream | CI, demos, no-Arduino development (`?mockHardware=1`) |

- **Line Ending**: `\n` (LF). `\r\n` is accepted and trimmed.
- All three real links need a **secure context** and a **user gesture** for their
  chooser (`requestPort` / `requestDevice`).
- Firefox and Safari have none of them — those browsers get Mock.

**Bluetooth UART (`bluetooth`)**

| Piece | UUID |
|-------|------|
| Service (Nordic UART) | `6e400001-b5a3-f393-e0a9-e50e24dcca9e` |
| RX — app writes commands | `6e400002-b5a3-f393-e0a9-e50e24dcca9e` |
| TX — app subscribes for `S` | `6e400003-b5a3-f393-e0a9-e50e24dcca9e` |

Writes are chunked to 20 B (default-MTU write-without-response) and serialised
through a queue, because GATT operations cannot overlap. The bridge widens its
command period to 50 ms on connect — still inside the firmware watchdog (100 ms)
and the host timeout (200 ms) — and restores the configured period when the link
closes. `gattserverdisconnected` is treated exactly like a yanked USB cable.

**WebUSB (`usb`)**

Claims the CDC **Data** interface (class `0x0A`) and uses its bulk IN/OUT
endpoints, after a `SET_CONTROL_LINE_STATE` (DTR|RTS) on the control interface so
boards that gate output on an open host start streaming. On most platforms the OS
CDC driver already owns the interface and `claimInterface()` fails with a
security error — that is why Web Serial is the documented path and this one is a
fallback, not a replacement.

### App → Arduino Commands

#### `P` - Phase Setpoint
```
P{phase},{speed},{mode}\n
```
| Field | Type | Range | Description |
|-------|------|-------|-------------|
| phase | float | 0.0 – 360.0 | Target electrical angle in degrees |
| speed | float | -999.9 – 999.9 | Target speed in RPM (negative = reverse) |
| mode  | int   | 0, 1, 2 | 0=run, 1=brake, 2=coast |

Sent by the app at ~60Hz. Arduino extrapolates phase between commands using `speed`.

#### `C` - Manual Coil Override
```
C{coilMask},{pwmDuty},{durationMs}\n
```
| Field | Type | Range | Description |
|-------|------|-------|-------------|
| coilMask | uint | 0 – 0xFFFF | Bitmask of coils to activate |
| pwmDuty  | int  | 0 – 255 | PWM duty cycle (255 = full on) |
| durationMs | int | 0 – 65535 | How long to hold (0 = infinite until next command) |

Immediately overrides automatic commutation. Send `C0,0,0` to release override.

#### `CONF` - Coil Geometry Configuration
```
CONF{numCoils},{offsetAngle},{dwellAngle},{advanceAngle}\n
```
| Field | Type | Description |
|-------|------|-------------|
| numCoils | int | Number of electromagnets (4, 6, 8, 12, etc.) |
| offsetAngle | float | Mechanical offset for coil 0 in degrees |
| dwellAngle | float | Angular width each coil stays active |
| advanceAngle | float | Lead angle for torque optimization |

### Arduino → App State Stream

#### `S` - Sensor State
```
S{phase},{rpm},{magX},{magY},{magZ},{hallMask},{coilMask},{timestampMs}\n
```
| Field | Type | Description |
|-------|------|-------------|
| phase | float | Fused electrical angle 0-360° |
| rpm | float | Calculated revolutions per minute |
| magX | float | Magnetometer X in µT |
| magY | float | Magnetometer Y in µT |
| magZ | float | Magnetometer Z in µT |
| hallMask | uint | Bitmask of currently triggered hall sensors |
| coilMask | uint | Bitmask of currently active coils |
| timestampMs | uint | Arduino millis() at time of sample |

Streamed at 100–200Hz or on every hall state change.

#### `E` - Error
```
E{message}\n
```
Forwarded to browser console as an error.

#### `I` - Info/Debug
```
I{message}\n
```
Forwarded to browser console as a log.

## Coil Configuration Reference

### Default Dwell Angles
| Coils | Sector | Dwell (1.5x overlap) | Dwell (single) |
|-------|--------|----------------------|----------------|
| 4     | 90°    | 135°                 | 90°            |
| 6     | 60°    | 90°                  | 60°            |
| 8     | 45°    | 67.5°                | 45°            |
| 12    | 30°    | 45°                  | 30°            |

### Firing Patterns
- **single**: One coil on at a time, hard edges.
- **overlap**: Adjacent coils overlap by ~50% for smoother torque.
- **trapezoidal**: Ramped leading/trailing edges to reduce switching noise.
- **sinusoidal**: PWM-modulated sinusoidal envelope, lowest torque ripple.

## Wiring

### Arduino Pinout (Example: Uno/Nano)

#### Electromagnet Drivers (via MOSFET or DRV8871)
| Coil | Pin | Notes |
|------|-----|-------|
| 0    | D3  | PWM capable |
| 1    | D5  | PWM capable |
| 2    | D6  | PWM capable |
| 3    | D9  | PWM capable |
| 4    | D10 | PWM capable |
| 5    | D11 | PWM capable |

For >6 coils, use a Mega (D2–D13, D44–D46) or ESP32 (GPIO 0–33).

#### Hall Effect Sensors
| Sensor | Pin | Notes |
|--------|-----|-------|
| H0     | D2  | External interrupt |
| H1     | D3  | External interrupt |

More sensors can use pin-change interrupts on other digital pins.

#### Magnetometer (QMC5883L / HMC5883L)
| Signal | Pin |
|--------|-----|
| VCC    | 3.3V or 5V (module dependent) |
| GND    | GND |
| SDA    | A4 (Uno) / D20 (Mega) |
| SCL    | A5 (Uno) / D21 (Mega) |

### Power
- **Logic**: Arduino USB or 7–12V barrel jack.
- **Coils**: Separate 12V–24V supply, common ground with Arduino.
- **Flyback diode**: Required across every coil.

## Safety Rules
1. **Watchdog (firmware)**: If no `P` command for >100ms, Arduino disables all coils.
2. **Browser disconnect**: `HardwareBridge.disconnect()` sends `P0,0,2` (coast)
   then `C0,0,0` before closing the link — on **every** transport, and on a
   transport *switch* too. Queued links (BLE, WebUSB) are flushed first so those
   two lines actually reach the board rather than dying with the connection.
   A link that drops on its own (unplug, out-of-range BLE) has nothing left to
   write to: there the **firmware** watchdog is what coasts the coils, and the
   host clears its manual override and reports `error`.
3. **Host timeout**: If `update()` is not called for >200ms while connected, the bridge forces coast + coils off.
4. **Current limiting**: Use PWM or series resistors to stay within driver/coil ratings.
5. **Thermal**: Monitor coil temperature; duty cycle should not exceed ratings.
6. **Back-EMF**: Flyback diodes mandatory. Without them, MOSFETs will fail.

## Browser digital twin UI

| Piece | Path |
|-------|------|
| Bridge (protocol + safety) | `src/hardware-bridge.ts` + `hardware-bridge-protocol.ts` |
| Transport interface | `src/hardware-transport.ts` (framing, write queue, feature detection) |
| Serial link | `src/serial-line-transport.ts` |
| Bluetooth link | `src/bluetooth-uart-transport.ts` |
| WebUSB link | `src/webusb-cdc-transport.ts` |
| Mock link | `src/mock-serial-transport.ts` |
| Panel | `src/hardware-panel.ts` (left sidebar) |
| Commutation preview | `src/electromagnet-controller.js` |
| Hub field | `TelemetryHub` → `hardwareTwin.shadowResidual` |
| Contract test | `npm run test:transports` |

**Layering rule:** the bridge owns the protocol *and every safety rule* (coast on
disconnect, host watchdog, NaN-safe closed loop, PWM clamp). A transport only
moves framed lines and reports drops, so adding one cannot invent a new way to
leave coils energised. That is what `npm run test:transports` pins down.

### Happy path (mock — CI / demos)

1. Open `/?renderer=webgl2&mockHardware=1` (or WebGPU with the same flag).
2. Bridge auto-connects `MockSerialTransport` and sets twin mode to **shadow**.
3. Click **START** (or `window.segOperator.start()`).
4. Each frame the hub publishes:

```js
telemetryHub.getSnapshot().hardwareTwin
// {
//   connected: true,
//   mock: true,
//   twinMode: 'shadow',
//   sensorRpm, sensorPhase,
//   shadowResidual: { phaseErrorDeg, rpmError, voltageError, currentError }
//   connectionState: 'mock' | 'serial' | 'bluetooth' | 'usb'
// }
```

5. Open **Scientific UI** (`Ctrl+Shift+S`) — **Shadow Twin Residual** chart shows ΔRPM / ΔV / ΔI time series.
6. Header badge: `Twin mock` / `Twin serial` / `Twin BLE` / `Twin USB` / `Twin off` (`#hw-twin-badge`).
7. Agent hook: `window.getRendererInfo().hardwareTwin.shadowResidual` (WebGL2).
8. Playwright: `e2e/app.spec.js` asserts residuals + disconnect coast + scientific chart.

Firmware is **not** required for this path.

### Connect (real hardware)

1. Chrome/Edge with **Web Serial** (secure context). Safari / Firefox: no Serial — use Mock.
2. Open the multi-device dashboard → **Hardware Twin** section.
3. Pick a link: **Serial** (port chooser), **BLE** (device chooser, NUS boards),
   **USB** (device chooser, CDC-ACM) or **Mock** (no hardware). Buttons for links
   this browser lacks are disabled, not hidden. Switching transport disconnects
   the prior link and coasts coils first.
4. Choose twin mode:
   - **Open-loop**: sim phase/RPM → coils; visualize sim
   - **Closed-loop**: measured HW phase/RPM drive on-screen rollers
   - **Shadow**: open-loop drive + show Δφ / ΔRPM / ΔV / ΔI vs hardware (`shadowResidual` on hub)
5. Baud **115200**, line-oriented `\n` protocol above. Disconnect always coasts coils.

### Connection state machine

| `connectionState` | `bridge.status` | UI badge | Meaning |
|-------------------|-----------------|----------|---------|
| `disconnected` | `disconnected` | Twin off | No link; coils not commanded |
| `mock` | `mock` | Twin mock | `MockSerialTransport` (CI / demos) |
| `serial` | `connected` | Twin serial | Live Web Serial stream |
| `bluetooth` | `bluetooth` | Twin BLE | Nordic UART over GATT |
| `usb` | `usb` | Twin USB | Raw WebUSB CDC-ACM |

`status` keeps the legacy `connected` value for Serial so existing panels and
tests do not churn; the wireless links get their own states rather than hiding
behind it. `connecting` and `error` are transient and both report
`connectionState: 'disconnected'`.

Disconnect always sends coast (`P0,0,2`) + coils off (`C0,0,0`) and clears manual PWM duty.

### Safety clamps (host)

- RPM commands clamped to protocol ±999.9; NaN sensor RPM never drives closed-loop rollers.
- Manual coil PWM duty saturated 0–1 before wire encoding (0–255).

- Requires a user gesture for `requestPort()` / `requestDevice()`; filters cover
  common Arduino/CH340/CP210x/FTDI/ESP32 VIDs. To reopen a link the page already
  has permission for (`navigator.serial.getPorts()`, a remembered
  `BluetoothDevice`), hand the instance straight to
  `bridge.connectTransport(transport)` — that path skips the chooser and needs no
  fresh gesture.
- An unframed babbler (wrong baud, binary firmware) cannot grow the receive
  buffer: past `MAX_LINE_BYTES` the partial line is dropped.
- Browser host timeout (~200 ms without `update()`) and firmware watchdog (~100 ms without `P`) both coast coils.
- Magnetometer / hall fusion is firmware-side; the web app trusts the `S` stream.
- Do not treat mock lag as calibrated metrology — residuals are for twin debugging only.
- Optional `firmware/seg-driver/` is **experimental** and never blocks web-only users.

### Mock / demos / CI
```
?mockHardware=1
```
or click **Mock**. Streams synthetic `S` lines; accepts `P`/`C`/`CONF`.

### Live metric
`S` stream fields populate the panel; magnetometer magnitude feeds scientific B-field context when connected.
`shadowResidual` is always populated while connected (even in open/closed modes) so dashboards can chart Δ without mode gating.

## Sensor Fusion Notes

### Hall Sensors
- Provide instantaneous position pulses.
- Best for RPM calculation (pulse interval → frequency).
- Position resolution = 360° / numHallSensors.

### Magnetometer
- Provides continuous field vector.
- Angle derived from `atan2(magY, magX)` relative to sensor mounting.
- Update rate ~200Hz (I2C limited).
- Susceptible to stray fields and tilting.

### Fusion Strategy
```
extrapolatedPhase = lastTargetPhase + elapsed * targetSpeed * 6  // deg/s
magnetometerPhase = atan2(magY, magX) * (180/PI) + magOffset
fusedPhase = alpha * extrapolatedPhase + (1-alpha) * magnetometerPhase
```
Alpha is higher when magnetometer data is noisy or stale. Hall edges are used to snap `fusedPhase` to known angles and correct drift.

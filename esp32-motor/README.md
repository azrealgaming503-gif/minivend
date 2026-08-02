# MiniVend motor controller (ESP32)

Slim firmware that drives two TMC2209 steppers. Talks to the Raspberry Pi
over USB-serial. Drops are measured by rotations (run time); jams use
TMC2209 StallGuard4 via each driver's DIAG pin.

## Build & flash

```bash
# Requires PlatformIO (VS Code extension or pip install platformio)
cd esp32-motor
pio run -t upload
pio device monitor
```

After flashing, the board prints `TMC M1=ok ms=16 M2=ok ms=16` then
`READY minivend-motor-1.11` on the USB serial port. The Pi opens that
port at 115200 baud (8N1) and exchanges line-delimited ASCII.

If chamber 2 spins much slower than chamber 1, check that boot line:
`M2 ms=` should be `16` (same as M1). A higher value (32/64/256) means
UART did not set microsteps on driver 2 — usually MS1 not tied to 3.3 V
(address 1) or a flaky UART bus. Fix the wiring rather than compensating
in software.

Drivers are only enabled while a move is in progress; EN goes high
(disabled) as soon as motion stops so coils do not sit holding current.

If you see `TMC M1=fail` / `M2=fail`, UART wiring or address straps are
wrong — see Wiring below. **Do not put the TMC UART on RX0/TX0** (GPIO
3/1): that is the same UART the Pi uses over USB.

## Wiring

| Signal | ESP32 pin | Notes |
|--------|-----------|--------|
| M1 STEP | GPIO 25 | To STEP on driver 1 |
| M1 DIR | GPIO 26 | To DIR on driver 1 |
| M1 DIAG | GPIO 21 | StallGuard output from driver 1 |
| M2 STEP | GPIO 32 | To STEP on driver 2 |
| M2 DIR | GPIO 33 | To DIR on driver 2 |
| M2 DIAG | GPIO 19 | StallGuard output from driver 2 |
| EN (shared) | GPIO 27 | To EN on **both** drivers. LOW = on, HIGH = off. Must **not** be tied to GND — idle = EN high so coils release. |
| UART RX | GPIO 16 | Serial2 RX — bus node (direct) |
| UART TX | GPIO 17 | Serial2 TX — **1 kΩ** → bus node |

UART bus (single wire to both `PDN_UART` pins):

```
ESP32 TX (GPIO17) ──[1kΩ]──┐
ESP32 RX (GPIO16) ─────────┤── PDN_UART driver 1
                           └── PDN_UART driver 2
```

UART addresses (MS1/MS2; floating = GND via internal pull-down):

| Driver | MS1 | MS2 | Address |
|--------|-----|-----|---------|
| 1 | float/GND | float/GND | 0 |
| 2 | **3.3 V (VIO)** | float/GND | 1 |

Also: VIO = 3.3 V, common GND, bulk cap (100 µF) on each driver's VMOT.

Firmware sets SpreadCycle, 16 microsteps, and ~1200 mA RMS over UART.
Match **"Steps per revolution"** on the Motor page to `200 × microsteps`
(e.g. 3200 for 1/16). Tune `TMC_SGTHRS` in `src/main.cpp` if jams are
too sensitive / not sensitive enough.

## Protocol

All commands are one ASCII line, `\n` terminated. The board responds
with `OK` (or `ERR <code> <detail>`) for each command. Some commands
trigger asynchronous event lines later.

| Command | Response / events |
|---------|-------------------|
| `PING` | `PONG <fw>` |
| `STATUS` | `STATUS M1_EN=.. M1_SPD=.. M2_EN=.. M2_SPD=.. DRV=.. TMC1=.. TMC2=..` |
| `ENABLE <id> <0\|1>` | `OK` |
| `JOG <id> <dir> <speed>` | `OK` |
| `RUNFOR <id> <dir> <speed> <ms>` | `OK` |
| `DISPENSE <id> <dir> <speed> <run_ms>` | `OK` then `DONE <id> <ms>` or `JAM <id> <ms>` |
| `STOP [<id>]` | `OK` (and `DONE <id>` if a DISPENSE was open) |

Async events:

```
READY <fw>       on boot
DONE <id> <ms>   DISPENSE finished its rotations (or STOP)
JAM  <id> <ms>   StallGuard DIAG trip during DISPENSE
```

## Why this is on a separate MCU

Stepper drivers need evenly-spaced step pulses (~830 µs apart at
1200 steps/s). Linux on the Pi cannot reliably hit that timing while
also rendering Chromium + decoding video. This ESP32 is the timing-
critical loop; the Pi only sends high-level commands like
"dispense from compartment 1 at 1200 steps/s for N rotations".

# MiniVend motor controller (ESP32)

Slim firmware whose only job is to drive two stepper motors and read
two drop sensors. Talks to the Raspberry Pi over USB-serial.

## Build & flash

```bash
# Requires PlatformIO (VS Code extension or pip install platformio)
cd esp32-motor
pio run -t upload
pio device monitor
```

After flashing, the board prints `READY minivend-motor-1.0\n` on the
USB serial port. The Pi opens that port at 115200 baud (8N1) and
exchanges line-delimited ASCII.

## Wiring (defaults — edit at the top of `src/main.cpp` to change)

| Signal     | ESP32 pin | Notes                                   |
|------------|-----------|------------------------------------------|
| M1 STEP    | GPIO 25   | To STEP on driver 1                     |
| M1 DIR     | GPIO 26   | To DIR on driver 1                      |
| M2 STEP    | GPIO 32   | To STEP on driver 2                     |
| M2 DIR     | GPIO 33   | To DIR on driver 2                      |
| EN (shared)| GPIO 27   | To EN on **both** drivers; LOW = enable |
| DROP S1    | GPIO 19   | INPUT_PULLUP, active LOW                |
| DROP S2    | GPIO 21   | INPUT_PULLUP, active LOW                |

A 10–47 µF capacitor across each driver's VMOT and GND is mandatory.

## Protocol

All commands are one ASCII line, `\n` terminated. The board responds
with `OK` (or `ERR <code> <detail>`) for each command. Some commands
trigger asynchronous event lines later.

| Command                              | Response / events                        |
|--------------------------------------|------------------------------------------|
| `PING`                               | `PONG <fw>`                              |
| `STATUS`                             | `STATUS M1_EN=.. M1_SPD=.. ...`          |
| `SENSOR`                             | `SENSOR S1=<0|1> S2=<0|1>`               |
| `ENABLE <id> <0|1>`                  | `OK`                                     |
| `JOG <id> <dir> <speed>`             | `OK`                                     |
| `RUNFOR <id> <dir> <speed> <ms>`     | `OK`                                     |
| `DISPENSE <id> <dir> <speed> <max>`  | `OK` then one of `DROPPED <id> <ms>`,    |
|                                      | `JAM <id>`, or `DONE <id>`               |
| `STOP [<id>]`                        | `OK` (and `DONE` if a DISPENSE was open) |

Async events the Pi should always be ready to receive:

```
READY <fw>           on boot
DROPPED <id> <ms>    drop sensor edge during a DISPENSE
JAM <id>             DISPENSE timeout (no drop within max_ms)
DONE <id>            DISPENSE ended via STOP (manual)
EVT SENSOR <id> 1    sensor edge while no DISPENSE was active
```

## Why this is on a separate MCU

Stepper drivers need evenly-spaced step pulses (~830 µs apart at
1200 steps/s). Linux on the Pi cannot reliably hit that timing while
also rendering Chromium + decoding video. This ESP32 is the timing-
critical loop; the Pi only sends high-level commands like
"dispense from compartment 1 at 1200 steps/s, fail after 3 s".

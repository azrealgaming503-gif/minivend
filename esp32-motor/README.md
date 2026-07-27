# MiniVend motor controller (ESP32)

Slim firmware whose only job is to drive two stepper motors. Talks to
the Raspberry Pi over USB-serial. Drops are measured by rotations
(run time), not a sensor.

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

A 10–47 µF capacitor across each driver's VMOT and GND is mandatory.

## Protocol

All commands are one ASCII line, `\n` terminated. The board responds
with `OK` (or `ERR <code> <detail>`) for each command. Some commands
trigger asynchronous event lines later.

| Command                              | Response / events                        |
|--------------------------------------|------------------------------------------|
| `PING`                               | `PONG <fw>`                              |
| `STATUS`                             | `STATUS M1_EN=.. M1_SPD=.. ...`          |
| `ENABLE <id> <0|1>`                  | `OK`                                     |
| `JOG <id> <dir> <speed>`             | `OK`                                     |
| `RUNFOR <id> <dir> <speed> <ms>`     | `OK`                                     |
| `DISPENSE <id> <dir> <speed> <run_ms>` | `OK` then `DONE <id> <ms>` on completion |
| `STOP [<id>]`                        | `OK` (and `DONE <id>` if a DISPENSE was open) |

Async events the Pi should always be ready to receive:

```
READY <fw>       on boot
DONE <id> <ms>   a DISPENSE finished its run (or was stopped)
```

## Why this is on a separate MCU

Stepper drivers need evenly-spaced step pulses (~830 µs apart at
1200 steps/s). Linux on the Pi cannot reliably hit that timing while
also rendering Chromium + decoding video. This ESP32 is the timing-
critical loop; the Pi only sends high-level commands like
"dispense from compartment 1 at 1200 steps/s for N rotations".

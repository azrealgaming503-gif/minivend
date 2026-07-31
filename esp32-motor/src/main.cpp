// MiniVend motor controller (ESP32)
//
// Owns the two TMC2209 stepper drivers. Talks to the Raspberry Pi over
// USB-serial at 115200 baud, one ASCII line per command, '\n' terminated.
//
// Protocol (Pi -> ESP32):
//   PING                              -> "PONG <fw>"
//   STATUS                            -> "STATUS M1_EN=.. M1_SPD=.. M2_EN=.. M2_SPD=.. DRV=<0|1> TMC=<ok|fail>"
//   ENABLE   <id> <0|1>               -> "OK" / "ERR ..."
//   JOG      <id> <dir> <speed>       -> "OK"
//   RUNFOR   <id> <dir> <speed> <ms>  -> "OK"
//   DISPENSE <id> <dir> <speed> <run_ms>
//                                     -> "OK" immediately; later one of
//                                        "DONE <id> <ms>"  (run completed)
//                                        "JAM  <id> <ms>"  (StallGuard DIAG trip)
//   STOP [<id>]                       -> "OK" (+ "DONE <id>" if a dispense was active)
//
// Async events (ESP32 -> Pi):
//   READY <fw>                  on boot
//   DONE <id> <ms>              a DISPENSE finished its run (or was stopped)
//   JAM  <id> <ms>              StallGuard detected a stall during DISPENSE
//
// Drops are measured by rotations (run time). Jam sensing uses TMC2209
// StallGuard4 via the DIAG pin (UART configures the threshold).
//
// Wiring (defaults — change in the constants block below):
//   M1   STEP=GPIO25  DIR=GPIO26  DIAG=GPIO21  UART addr 0 (MS1/MS2 float)
//   M2   STEP=GPIO32  DIR=GPIO33  DIAG=GPIO19  UART addr 1 (MS1=3.3V, MS2 float)
//   EN   (shared)     GPIO27   (LOW = drivers enabled)
//   UART Serial2      RX=GPIO16  TX=GPIO17
//                     TX --[1kΩ]-- bus node -- RX; both PDN_UART on that node
//   IMPORTANT: do NOT use UART0 (RX0/TX0 = GPIO3/1) — that is the Pi USB link.
//
// Notes:
//   - The shared driver EN line is managed automatically: it is enabled
//     while either motor is actively stepping and released IDLE_RELEASE_MS
//     after the last motion, to reduce heat build-up (no holding torque
//     between drops). ENABLE <id> 1 also powers the drivers immediately
//     so there is settle time before the following DISPENSE/JOG/RUNFOR.
//   - Every motion command (JOG/RUNFOR/DISPENSE) self-enables, and every
//     stop (run complete, STOP, jam, stopAll) clears the motor's enable flag,
//     so once both motors are idle the EN line is always released.
//   - StallGuard only fires during an active DISPENSE, and DIAG is
//     debounced so motor EMI does not register a phantom jam.

#include <Arduino.h>
#include <TMCStepper.h>

// ---------------- Configuration ----------------
static const char* FW_VERSION = "minivend-motor-1.10";

// Stepper pins
static const int M1_STEP_PIN = 25;
static const int M1_DIR_PIN  = 26;
static const int M2_STEP_PIN = 32;
static const int M2_DIR_PIN  = 33;

// Shared driver EN (ENN). Active LOW on SilentStepStick-style boards:
//   LOW  = drivers on (coils powered)
//   HIGH = drivers off (no holding torque)
// Both drivers' EN pins must go to this GPIO — and must NOT be tied to GND.
static const int EN_PIN = 27;
static const bool EN_ACTIVE_LOW = true;

// Step pulse width (HIGH duration).
static const uint32_t STEP_PULSE_US = 2;

// Safety: ignore step rates above this. At 16 microsteps, ~19200 steps/s
// matches the old full-step feel of 1200 steps/s (200 steps/rev).
// Headroom above 19200 lets RPM compensation work when a driver is stuck
// at 32 µsteps (needs ~2× pulse rate for the same shaft RPM).
static const uint32_t MAX_STEPS_PER_SEC = 50000;

// ---- TMC2209 UART + StallGuard ----
// Serial2 on GPIO16/17 — NOT UART0 (GPIO3/1), which the Pi uses over USB.
static const int TMC_UART_RX = 16;
static const int TMC_UART_TX = 17;
static const uint32_t TMC_UART_BAUD = 115200;
// Sense resistor on SilentStepStick-style boards (ohms).
static const float TMC_R_SENSE = 0.11f;
// UART addresses from MS1/MS2 straps:
//   M1: MS1 float, MS2 float -> addr 0
//   M2: MS1 = 3.3V, MS2 float -> addr 1
static const uint8_t TMC_ADDR_M1 = 0;
static const uint8_t TMC_ADDR_M2 = 1;
// DIAG pins (HIGH = stall / driver error when StallGuard is armed).
static const int M1_DIAG_PIN = 21;
static const int M2_DIAG_PIN = 19;
// Run current (mA RMS). Tune to your motors; keep heatsinks if >~1 A.
static const uint16_t TMC_RMS_CURRENT_MA = 1000;
// Microsteps set over UART (MS1/MS2 are address pins in UART mode).
// Match "Steps per revolution" on the Motor page (200 * microsteps).
static const uint16_t TMC_MICROSTEPS = 16;
// StallGuard threshold 0–255. Higher = more sensitive (trips sooner).
// Low values avoid false JAM at dispense start (no accel ramp yet).
// Raise slowly if real hard jams are missed.
static const uint8_t TMC_SGTHRS = 5;
// Velocity below which StallGuard is armed (TSTEP units). 0xFFFFF ≈ always on
// while moving at typical dispense speeds.
static const uint32_t TMC_TCOOLTHRS = 0xFFFFF;
// Ignore DIAG for this long after a dispense starts (startup / accel noise).
// False "JAM in ~105ms" was arm(80)+debounce(25) with DIAG already high.
static const uint32_t DIAG_ARM_MS = 400;
// DIAG must stay asserted this long before we call it a jam (EMI debounce).
static const uint32_t DIAG_DEBOUNCE_MS = 80;

// ---------------- Internal state ----------------
struct Motor {
  uint8_t id;            // 1 or 2
  int stepPin;
  int dirPin;
  int diagPin;
  bool enabledRequested; // tracks the most recent ENABLE request
  int  direction;        // -1 or +1
  uint32_t speedStepsPerS;
  // Active timed run (RUNFOR or DISPENSE backing store)
  bool timedActive;
  uint32_t runUntilMs;
  // DISPENSE bookkeeping
  bool dispenseActive;
  uint32_t dispenseStartMs;
  // DIAG debounce while dispensing
  uint32_t diagAssertedSinceMs; // 0 = not currently asserted
  bool diagSeenLow;             // must see DIAG low after arm before a jam counts
  // Step generation
  uint32_t intervalUs;     // computed from speedStepsPerS
  uint32_t lastStepUs;
};

static Motor m1 { 1, M1_STEP_PIN, M1_DIR_PIN, M1_DIAG_PIN, false, +1, 0, false, 0, false, 0, 0, false, 0, 0 };
static Motor m2 { 2, M2_STEP_PIN, M2_DIR_PIN, M2_DIAG_PIN, false, +1, 0, false, 0, false, 0, 0, false, 0, 0 };

static String lineBuf;

// TMC drivers (UART). Constructed after Serial2 is ready in setup().
static TMC2209Stepper* tmc1 = nullptr;
static TMC2209Stepper* tmc2 = nullptr;
static bool g_tmc1Ok = false;
static bool g_tmc2Ok = false;
// Last verified microstep setting per motor (for RPM compensation if UART
// leaves a driver at OTP / pin defaults — e.g. M2 at 32 while M1 is at 16).
static uint16_t g_m1Microsteps = TMC_MICROSTEPS;
static uint16_t g_m2Microsteps = TMC_MICROSTEPS;

// ---------------- Helpers ----------------
static bool g_driverPowered = false;
static uint32_t g_lastActiveMs = 0;

static void driverEnabled(bool en) {
  if (EN_ACTIVE_LOW) digitalWrite(EN_PIN, en ? LOW : HIGH);
  else               digitalWrite(EN_PIN, en ? HIGH : LOW);
}

// Simple EN gate only — no UART spam while idle (that caused monitor errors).
static void setDriverPower(bool on) {
  if (on == g_driverPowered) return;
  driverEnabled(on);
  g_driverPowered = on;
}

static Motor* motorById(int id) {
  if (id == 1) return &m1;
  if (id == 2) return &m2;
  return nullptr;
}

// Same shaft RPM when drivers disagree on microsteps: pulse rate scales with
// actual_µsteps / target_µsteps (32 vs 16 → 2× step rate for equal RPM).
static uint32_t speedForActualMicrosteps(uint32_t speedStepsPerS, uint16_t actualMs) {
  if (actualMs == 0 || actualMs == TMC_MICROSTEPS) return speedStepsPerS;
  uint64_t adj = (uint64_t)speedStepsPerS * (uint64_t)actualMs / (uint64_t)TMC_MICROSTEPS;
  if (adj < 1) adj = 1;
  if (adj > MAX_STEPS_PER_SEC) adj = MAX_STEPS_PER_SEC;
  return (uint32_t)adj;
}

static uint16_t actualMicrostepsFor(const Motor& m) {
  return (m.id == 2) ? g_m2Microsteps : g_m1Microsteps;
}

static void setJog(Motor& m, int dir, uint32_t speedStepsPerS) {
  m.direction = (dir >= 0) ? +1 : -1;
  digitalWrite(m.dirPin, (m.direction > 0) ? HIGH : LOW);
  // Store the *commanded* (Pi-facing) speed; interval uses compensated rate.
  m.speedStepsPerS = speedStepsPerS;
  uint32_t pulseRate = speedForActualMicrosteps(speedStepsPerS, actualMicrostepsFor(m));
  if (pulseRate == 0) {
    m.intervalUs = 0;
  } else {
    if (pulseRate > MAX_STEPS_PER_SEC) pulseRate = MAX_STEPS_PER_SEC;
    m.intervalUs = 1000000UL / pulseRate;
  }
  m.lastStepUs = micros();
}

static bool motorActive(const Motor& m) {
  return m.enabledRequested && m.intervalUs != 0;
}

// EN HIGH as soon as nothing is stepping.
static void releaseDriversIfIdle() {
  if (motorActive(m1) || motorActive(m2)) return;
  setDriverPower(false);
}

static void stopMotor(Motor& m) {
  m.speedStepsPerS = 0;
  m.intervalUs = 0;
  m.timedActive = false;
  m.dispenseActive = false;
  m.enabledRequested = false;
  m.diagAssertedSinceMs = 0;
  m.diagSeenLow = false;
  releaseDriversIfIdle();
}

static void stopAll() {
  stopMotor(m1);
  stopMotor(m2);
  releaseDriversIfIdle();
}

static void serviceDriverPower() {
  if (motorActive(m1) || motorActive(m2)) {
    g_lastActiveMs = millis();
    setDriverPower(true);
    return;
  }
  setDriverPower(false);
}

static void serviceStepper(Motor& m) {
  if (m.intervalUs == 0) return;
  if (!m.enabledRequested) return;
  uint32_t now = micros();
  if ((uint32_t)(now - m.lastStepUs) < m.intervalUs) return;
  m.lastStepUs = now;
  digitalWrite(m.stepPin, HIGH);
  delayMicroseconds(STEP_PULSE_US);
  digitalWrite(m.stepPin, LOW);
}

// Timed auto-stop for RUNFOR / DISPENSE run_ms.
static void serviceTimedStop(Motor& m) {
  if (!m.timedActive) return;
  if ((int32_t)(millis() - m.runUntilMs) < 0) return;
  bool wasDispense = m.dispenseActive;
  uint8_t id = m.id;
  uint32_t elapsed = millis() - m.dispenseStartMs;
  stopMotor(m);
  if (wasDispense) {
    Serial.print("DONE ");
    Serial.print(id);
    Serial.print(' ');
    Serial.println(elapsed);
  }
}

// StallGuard DIAG: only during DISPENSE, after arm delay, with debounce.
// Require DIAG to go low once after arm so a stuck-high / startup-asserted
// DIAG cannot immediately fire "JAM in ~105ms".
static void serviceJam(Motor& m) {
  if (!m.dispenseActive) {
    m.diagAssertedSinceMs = 0;
    m.diagSeenLow = false;
    return;
  }
  uint32_t now = millis();
  if ((uint32_t)(now - m.dispenseStartMs) < DIAG_ARM_MS) {
    m.diagAssertedSinceMs = 0;
    m.diagSeenLow = false;
    return;
  }
  const bool diagHigh = digitalRead(m.diagPin) == HIGH;
  if (!diagHigh) {
    m.diagSeenLow = true;
    m.diagAssertedSinceMs = 0;
    return;
  }
  // DIAG high but never saw a clean low after arm -> ignore (stuck / noise).
  if (!m.diagSeenLow) {
    m.diagAssertedSinceMs = 0;
    return;
  }
  if (m.diagAssertedSinceMs == 0) {
    m.diagAssertedSinceMs = now;
    return;
  }
  if ((uint32_t)(now - m.diagAssertedSinceMs) < DIAG_DEBOUNCE_MS) return;

  uint8_t id = m.id;
  uint32_t elapsed = now - m.dispenseStartMs;
  stopMotor(m);
  Serial.print("JAM ");
  Serial.print(id);
  Serial.print(' ');
  Serial.println(elapsed);
}

static TMC2209Stepper* tmcById(int id) {
  if (id == 2) return tmc2;
  return tmc1;
}

static uint16_t* microstepsSlotFor(int id) {
  return (id == 2) ? &g_m2Microsteps : &g_m1Microsteps;
}

static bool* tmcOkSlotFor(int id) {
  return (id == 2) ? &g_tmc2Ok : &g_tmc1Ok;
}

// Push full UART config for one driver (no verify).
static void tmcWriteSettings(TMC2209Stepper& d) {
  d.pdn_disable(true);
  d.mstep_reg_select(true);   // microsteps from UART, not MS1/MS2 pins
  d.I_scale_analog(false);
  d.rms_current(TMC_RMS_CURRENT_MA);
  d.microsteps(TMC_MICROSTEPS);
  d.en_spreadCycle(true);
  d.TCOOLTHRS(TMC_TCOOLTHRS);
  d.SGTHRS(TMC_SGTHRS);
  d.toff(4);
}

// Write + read back version and microsteps. Retries — M2 on a shared UART
// bus often needs a second pass before MRES sticks.
static bool configureTmcVerified(TMC2209Stepper& d, uint16_t* outMs) {
  d.begin();
  for (int attempt = 0; attempt < 6; attempt++) {
    tmcWriteSettings(d);
    delay(3);
    uint8_t ver = d.version();
    uint16_t ms = d.microsteps();
    if (outMs) *outMs = ms;
    if (ver == 0x21 && ms == TMC_MICROSTEPS) return true;
    delay(5);
  }
  if (outMs) *outMs = d.microsteps();
  return d.version() == 0x21;
}

// EN on, push UART settings, verify microsteps; keep actual for RPM scale.
static void applyTmcBeforeMotion(int id) {
  setDriverPower(true);
  delay(10);  // some TMC boards need settle after EN before UART works

  TMC2209Stepper* d = tmcById(id);
  uint16_t* slot = microstepsSlotFor(id);
  bool* okSlot = tmcOkSlotFor(id);
  if (!d) return;

  uint16_t ms = 0;
  bool ok = false;
  for (int attempt = 0; attempt < 6; attempt++) {
    tmcWriteSettings(*d);
    delay(3);
    uint8_t ver = d->version();
    ms = d->microsteps();
    if (ver == 0x21 && ms == TMC_MICROSTEPS) {
      ok = true;
      break;
    }
    delay(5);
  }
  if (!ok) ms = d->microsteps();
  if (ms == 0) ms = TMC_MICROSTEPS;  // read failed — avoid wild scale
  *slot = ms;
  *okSlot = ok || (d->version() == 0x21);

  if (ms != TMC_MICROSTEPS) {
    Serial.print("WARN TMC M");
    Serial.print(id);
    Serial.print(" microsteps=");
    Serial.print(ms);
    Serial.print(" (want ");
    Serial.print(TMC_MICROSTEPS);
    Serial.println(") — scaling step rate");
  }
}

static void initTmcDrivers() {
  Serial2.begin(TMC_UART_BAUD, SERIAL_8N1, TMC_UART_RX, TMC_UART_TX);
  delay(50);

  tmc1 = new TMC2209Stepper(&Serial2, TMC_R_SENSE, TMC_ADDR_M1);
  tmc2 = new TMC2209Stepper(&Serial2, TMC_R_SENSE, TMC_ADDR_M2);

  setDriverPower(true);
  delay(50);

  g_tmc1Ok = configureTmcVerified(*tmc1, &g_m1Microsteps);
  delay(10);
  g_tmc2Ok = configureTmcVerified(*tmc2, &g_m2Microsteps);

  // If addr 1 never answers, MS1 may not be at 3.3V — probe 2 and 3.
  if (!g_tmc2Ok || g_m2Microsteps != TMC_MICROSTEPS) {
    for (uint8_t tryAddr = 2; tryAddr <= 3; tryAddr++) {
      TMC2209Stepper probe(&Serial2, TMC_R_SENSE, tryAddr);
      uint16_t ms = 0;
      bool ok = configureTmcVerified(probe, &ms);
      if (ok && ms == TMC_MICROSTEPS) {
        delete tmc2;
        tmc2 = new TMC2209Stepper(&Serial2, TMC_R_SENSE, tryAddr);
        g_tmc2Ok = configureTmcVerified(*tmc2, &g_m2Microsteps);
        Serial.print("TMC M2 remapped to UART addr ");
        Serial.println(tryAddr);
        break;
      }
    }
  }

  setDriverPower(false);   // EN high — idle, no hold

  Serial.print("TMC M1=");
  Serial.print(g_tmc1Ok ? "ok" : "fail");
  Serial.print(" ms=");
  Serial.print(g_m1Microsteps);
  Serial.print(" M2=");
  Serial.print(g_tmc2Ok ? "ok" : "fail");
  Serial.print(" ms=");
  Serial.println(g_m2Microsteps);
}

// ---------------- Command parser ----------------
static int parseTokens(const String& line, String* out, int maxTokens) {
  int n = 0;
  int start = 0;
  while (start < (int)line.length() && n < maxTokens) {
    while (start < (int)line.length() && isspace(line[start])) start++;
    if (start >= (int)line.length()) break;
    int end = start;
    while (end < (int)line.length() && !isspace(line[end])) end++;
    out[n++] = line.substring(start, end);
    start = end;
  }
  return n;
}

static bool parseInt(const String& s, int32_t& out) {
  if (s.length() == 0) return false;
  char* endp = nullptr;
  long v = strtol(s.c_str(), &endp, 10);
  if (endp == s.c_str()) return false;
  out = (int32_t)v;
  return true;
}

static void replyErr(const char* code, const char* detail) {
  Serial.print("ERR ");
  Serial.print(code);
  if (detail && *detail) {
    Serial.print(' ');
    Serial.print(detail);
  }
  Serial.println();
}

static void handleCommand(const String& line) {
  String trimmed = line;
  trimmed.trim();
  if (trimmed.length() == 0) return;

  String tokens[6];
  int n = parseTokens(trimmed, tokens, 6);
  if (n == 0) return;
  String cmd = tokens[0];
  cmd.toUpperCase();

  if (cmd == "PING") {
    Serial.print("PONG ");
    Serial.println(FW_VERSION);
    return;
  }
  if (cmd == "STATUS") {
    Serial.print("STATUS M1_EN=");
    Serial.print(m1.enabledRequested ? 1 : 0);
    Serial.print(" M1_SPD=");
    Serial.print(m1.speedStepsPerS);
    Serial.print(" M1_MS=");
    Serial.print(g_m1Microsteps);
    Serial.print(" M2_EN=");
    Serial.print(m2.enabledRequested ? 1 : 0);
    Serial.print(" M2_SPD=");
    Serial.print(m2.speedStepsPerS);
    Serial.print(" M2_MS=");
    Serial.print(g_m2Microsteps);
    Serial.print(" DRV=");
    Serial.print(g_driverPowered ? 1 : 0);
    Serial.print(" TMC1=");
    Serial.print(g_tmc1Ok ? "ok" : "fail");
    Serial.print(" TMC2=");
    Serial.println(g_tmc2Ok ? "ok" : "fail");
    return;
  }
  if (cmd == "ENABLE") {
    if (n < 3) { replyErr("BAD_CMD", "usage: ENABLE <id> <0|1>"); return; }
    int32_t id = 0, en = 0;
    if (!parseInt(tokens[1], id) || !parseInt(tokens[2], en)) { replyErr("BAD_INT", "ENABLE"); return; }
    Motor* m = motorById((int)id);
    if (!m) { replyErr("BAD_MOTOR", "id must be 1 or 2"); return; }
    m->enabledRequested = (en != 0);
    // Never energize coils for ENABLE alone — that caused idle holding
    // torque. Motion commands (JOG/RUNFOR/DISPENSE) power the drivers.
    // ENABLE 0 / both off: force coils off immediately.
    if (!m1.enabledRequested && !m2.enabledRequested) {
      setDriverPower(false);
    }
    Serial.println("OK");
    return;
  }
  if (cmd == "JOG") {
    if (n < 4) { replyErr("BAD_CMD", "usage: JOG <id> <dir> <speed>"); return; }
    int32_t id = 0, dir = 0, spd = 0;
    if (!parseInt(tokens[1], id) || !parseInt(tokens[2], dir) || !parseInt(tokens[3], spd)) {
      replyErr("BAD_INT", "JOG"); return;
    }
    Motor* m = motorById((int)id);
    if (!m) { replyErr("BAD_MOTOR", "id must be 1 or 2"); return; }
    m->enabledRequested = true;
    m->timedActive = false;
    m->dispenseActive = false;
    m->diagAssertedSinceMs = 0;
    m->diagSeenLow = false;
    applyTmcBeforeMotion((int)id);
    setJog(*m, (dir >= 0) ? +1 : -1, (uint32_t)spd);
    Serial.println("OK");
    return;
  }
  if (cmd == "RUNFOR") {
    if (n < 5) { replyErr("BAD_CMD", "usage: RUNFOR <id> <dir> <speed> <ms>"); return; }
    int32_t id = 0, dir = 0, spd = 0, ms = 0;
    if (!parseInt(tokens[1], id) || !parseInt(tokens[2], dir) || !parseInt(tokens[3], spd) || !parseInt(tokens[4], ms)) {
      replyErr("BAD_INT", "RUNFOR"); return;
    }
    Motor* m = motorById((int)id);
    if (!m) { replyErr("BAD_MOTOR", "id must be 1 or 2"); return; }
    if (ms <= 0) { replyErr("BAD_ARG", "ms must be > 0"); return; }
    m->enabledRequested = true;
    applyTmcBeforeMotion((int)id);
    setJog(*m, (dir >= 0) ? +1 : -1, (uint32_t)spd);
    m->timedActive = true;
    m->dispenseActive = false;
    m->diagAssertedSinceMs = 0;
    m->diagSeenLow = false;
    m->runUntilMs = millis() + (uint32_t)ms;
    Serial.println("OK");
    return;
  }
  if (cmd == "DISPENSE") {
    if (n < 5) { replyErr("BAD_CMD", "usage: DISPENSE <id> <dir> <speed> <run_ms>"); return; }
    int32_t id = 0, dir = 0, spd = 0, ms = 0;
    if (!parseInt(tokens[1], id) || !parseInt(tokens[2], dir) || !parseInt(tokens[3], spd) || !parseInt(tokens[4], ms)) {
      replyErr("BAD_INT", "DISPENSE"); return;
    }
    Motor* m = motorById((int)id);
    if (!m) { replyErr("BAD_MOTOR", "id must be 1 or 2"); return; }
    if (ms <= 0) { replyErr("BAD_ARG", "run_ms must be > 0"); return; }
    m->enabledRequested = true;
    applyTmcBeforeMotion((int)id);
    setJog(*m, (dir >= 0) ? +1 : -1, (uint32_t)spd);
    m->timedActive = true;
    m->dispenseActive = true;
    m->diagAssertedSinceMs = 0;
    m->diagSeenLow = false;
    m->runUntilMs = millis() + (uint32_t)ms;
    m->dispenseStartMs = millis();
    Serial.println("OK");
    return;
  }
  if (cmd == "STOP") {
    if (n == 1) {
      bool m1Disp = m1.dispenseActive;
      bool m2Disp = m2.dispenseActive;
      stopAll();
      if (m1Disp) { Serial.print("DONE "); Serial.println(1); }
      if (m2Disp) { Serial.print("DONE "); Serial.println(2); }
      Serial.println("OK");
      return;
    }
    int32_t id = 0;
    if (!parseInt(tokens[1], id)) { replyErr("BAD_INT", "STOP"); return; }
    Motor* m = motorById((int)id);
    if (!m) { replyErr("BAD_MOTOR", "id must be 1 or 2"); return; }
    bool wasDisp = m->dispenseActive;
    stopMotor(*m);
    if (wasDisp) {
      Serial.print("DONE ");
      Serial.println(m->id);
    }
    Serial.println("OK");
    return;
  }

  replyErr("BAD_CMD", "unknown");
}

// ---------------- Arduino entrypoints ----------------
void setup() {
  Serial.begin(115200);
  lineBuf.reserve(64);

  pinMode(M1_STEP_PIN, OUTPUT);
  pinMode(M1_DIR_PIN,  OUTPUT);
  pinMode(M2_STEP_PIN, OUTPUT);
  pinMode(M2_DIR_PIN,  OUTPUT);
  pinMode(EN_PIN,      OUTPUT);
  pinMode(M1_DIAG_PIN, INPUT_PULLDOWN);
  pinMode(M2_DIAG_PIN, INPUT_PULLDOWN);
  driverEnabled(false);

  initTmcDrivers();

  Serial.print("READY ");
  Serial.println(FW_VERSION);
}

void loop() {
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      handleCommand(lineBuf);
      lineBuf = "";
    } else if (lineBuf.length() < 200) {
      lineBuf += c;
    }
  }

  serviceTimedStop(m1);
  serviceTimedStop(m2);
  serviceJam(m1);
  serviceJam(m2);
  serviceDriverPower();
  serviceStepper(m1);
  serviceStepper(m2);
}

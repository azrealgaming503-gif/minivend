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
static const char* FW_VERSION = "minivend-motor-1.6";

// Stepper pins
static const int M1_STEP_PIN = 25;
static const int M1_DIR_PIN  = 26;
static const int M2_STEP_PIN = 32;
static const int M2_DIR_PIN  = 33;

// Shared driver enable (LOW = enabled on most A4988/TMC2208/2209 carriers).
// Tie both drivers' EN pins together to this pin.
static const int EN_PIN = 27;
static const bool EN_ACTIVE_LOW = true;

// Auto-release the drivers this many ms after the last motor motion.
// Keep this short — holding current is what makes TMC2209s + motors hot.
// (UART idle-high on PDN_UART also disables the chip's own standstill
// current cut, so EN must go HIGH whenever nothing is moving.)
static const uint32_t IDLE_RELEASE_MS = 50;

// Step pulse width (HIGH duration).
static const uint32_t STEP_PULSE_US = 2;

// Safety: ignore step rates above this. At 16 microsteps, ~19200 steps/s
// matches the old full-step feel of 1200 steps/s (200 steps/rev).
static const uint32_t MAX_STEPS_PER_SEC = 25000;

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

// ---------------- Helpers ----------------
static bool g_driverPowered = false;
static uint32_t g_lastActiveMs = 0;

static void driverEnabled(bool en) {
  if (EN_ACTIVE_LOW) digitalWrite(EN_PIN, en ? LOW : HIGH);
  else               digitalWrite(EN_PIN, en ? HIGH : LOW);
}

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

static void recomputeInterval(Motor& m) {
  if (m.speedStepsPerS == 0) {
    m.intervalUs = 0; // disabled
  } else {
    uint32_t spd = m.speedStepsPerS;
    if (spd > MAX_STEPS_PER_SEC) spd = MAX_STEPS_PER_SEC;
    m.intervalUs = 1000000UL / spd;
  }
}

static void setJog(Motor& m, int dir, uint32_t speedStepsPerS) {
  m.direction = (dir >= 0) ? +1 : -1;
  digitalWrite(m.dirPin, (m.direction > 0) ? HIGH : LOW);
  m.speedStepsPerS = speedStepsPerS;
  recomputeInterval(m);
  m.lastStepUs = micros();
}

static bool motorActive(const Motor& m) {
  return m.enabledRequested && m.intervalUs != 0;
}

// Cut EN as soon as nothing is stepping. Call after every stop / ENABLE 0.
static void releaseDriversIfIdle() {
  if (motorActive(m1) || motorActive(m2)) return;
  setDriverPower(false);
}

// Fully stop a motor AND mark it disabled, then drop EN if both are idle
// so coils never sit holding current after a dispense/jog/runfor/jam.
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
  // Nothing stepping — release after a short grace (or immediately if 0).
  if (!g_driverPowered) return;
  if (IDLE_RELEASE_MS == 0 ||
      (uint32_t)(millis() - g_lastActiveMs) >= IDLE_RELEASE_MS) {
    setDriverPower(false);
  }
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

static bool configureTmc(TMC2209Stepper& d) {
  d.begin();
  d.pdn_disable(true);          // PDN_UART is UART, not auto power-down
  d.mstep_reg_select(true);     // microsteps from UART, not MS pins
  d.I_scale_analog(false);      // current from UART, not VREF pot
  d.rms_current(TMC_RMS_CURRENT_MA);
  d.microsteps(TMC_MICROSTEPS);
  d.en_spreadCycle(true);       // stronger under load; StallGuard reliable
  d.TCOOLTHRS(TMC_TCOOLTHRS);
  d.SGTHRS(TMC_SGTHRS);
  d.toff(4);
  // Version register should read 0x21 for TMC2209.
  uint8_t ver = d.version();
  return ver == 0x21;
}

// Re-push microsteps/current before motion. If chamber 2 never got UART
// config it stays on pin-strap microsteps (often 1/32 with MS1=VIO) and
// runs much slower than chamber 1 at the same step rate.
static void applyTmcBeforeMotion(int id) {
  TMC2209Stepper* d = tmcById(id);
  if (!d) return;
  setDriverPower(true);
  delay(2);
  d->pdn_disable(true);
  d->mstep_reg_select(true);
  d->I_scale_analog(false);
  d->rms_current(TMC_RMS_CURRENT_MA);
  d->microsteps(TMC_MICROSTEPS);
  d->en_spreadCycle(true);
  d->TCOOLTHRS(TMC_TCOOLTHRS);
  d->SGTHRS(TMC_SGTHRS);
}

static void initTmcDrivers() {
  Serial2.begin(TMC_UART_BAUD, SERIAL_8N1, TMC_UART_RX, TMC_UART_TX);
  delay(50);

  tmc1 = new TMC2209Stepper(&Serial2, TMC_R_SENSE, TMC_ADDR_M1);
  tmc2 = new TMC2209Stepper(&Serial2, TMC_R_SENSE, TMC_ADDR_M2);

  // Drivers must be powered (EN low) to answer UART on some boards.
  setDriverPower(true);
  delay(20);

  g_tmc1Ok = configureTmc(*tmc1);
  delay(5);
  g_tmc2Ok = configureTmc(*tmc2);

  // Read back microsteps so a failed M2 config is obvious in the log.
  uint16_t ms1 = tmc1->microsteps();
  uint16_t ms2 = tmc2->microsteps();

  setDriverPower(false);

  Serial.print("TMC M1=");
  Serial.print(g_tmc1Ok ? "ok" : "fail");
  Serial.print(" ms=");
  Serial.print(ms1);
  Serial.print(" M2=");
  Serial.print(g_tmc2Ok ? "ok" : "fail");
  Serial.print(" ms=");
  Serial.println(ms2);
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
    Serial.print(" M2_EN=");
    Serial.print(m2.enabledRequested ? 1 : 0);
    Serial.print(" M2_SPD=");
    Serial.print(m2.speedStepsPerS);
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
    // ENABLE 1: power drivers for a short settle before motion.
    // ENABLE 0 / both off: cut EN immediately — no holding current / heat.
    if (m1.enabledRequested || m2.enabledRequested) {
      setDriverPower(true);
      g_lastActiveMs = millis();
    } else {
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

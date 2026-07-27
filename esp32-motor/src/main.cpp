// MiniVend motor controller (ESP32)
//
// Owns the two stepper drivers. Talks to the Raspberry Pi over
// USB-serial at 115200 baud, one ASCII line per command, '\n' terminated.
//
// Protocol (Pi -> ESP32):
//   PING                              -> "PONG <fw>"
//   STATUS                            -> "STATUS M1_EN=.. M1_SPD=.. M2_EN=.. M2_SPD=.. DRV=<0|1>"
//   ENABLE   <id> <0|1>               -> "OK" / "ERR ..."
//   JOG      <id> <dir> <speed>       -> "OK"
//   RUNFOR   <id> <dir> <speed> <ms>  -> "OK"
//   DISPENSE <id> <dir> <speed> <run_ms>
//                                     -> "OK" immediately; later
//                                        "DONE <id> <ms>" when the run completes
//   STOP [<id>]                       -> "OK" (+ "DONE <id>" if a dispense was active)
//
// Async events (ESP32 -> Pi):
//   READY <fw>                  on boot
//   DONE <id> <ms>              a DISPENSE finished its run (or was stopped)
//
// Drops are measured by rotations, not a sensor. The Pi converts the
// configured rotations-per-dispense into run_ms (rotations * steps_per_rev
// / speed) and the motor simply spins for that long, then reports DONE.
// There is no drop/jam sensor in this firmware.
//
// Wiring (defaults — change in the constants block below):
//   M1   STEP=GPIO25  DIR=GPIO26
//   M2   STEP=GPIO32  DIR=GPIO33
//   EN   (shared)     GPIO27   (LOW = drivers enabled)
//
// Notes:
//   - The shared driver EN line is managed automatically: it is enabled
//     while either motor is actively stepping and released IDLE_RELEASE_MS
//     after the last motion, to reduce heat build-up (no holding torque
//     between drops). ENABLE <id> 1 also powers the drivers immediately
//     so there is settle time before the following DISPENSE/JOG/RUNFOR.
//   - Every motion command (JOG/RUNFOR/DISPENSE) self-enables, and every
//     stop (run complete, STOP, stopAll) clears the motor's enable flag,
//     so once both motors are idle the EN line is always released. A motor
//     is never left holding current after an operation. NOTE: this only
//     works if each driver's EN pin is actually wired to EN_PIN (GPIO27);
//     if a driver's EN is tied to GND it is always on and firmware cannot
//     disable it.

#include <Arduino.h>

// ---------------- Configuration ----------------
static const char* FW_VERSION = "minivend-motor-1.1";

// Stepper pins
static const int M1_STEP_PIN = 25;
static const int M1_DIR_PIN  = 26;
static const int M2_STEP_PIN = 32;
static const int M2_DIR_PIN  = 33;

// Shared driver enable (LOW = enabled on most A4988/TMC2208 carriers).
// Tie both drivers' EN pins together to this pin.
static const int EN_PIN = 27;
static const bool EN_ACTIVE_LOW = true;

// Auto-release the drivers this many ms after the last motor motion.
// Steppers draw their full rated current (and get hot) whenever the
// driver is enabled, even when standing still holding torque. A vend
// carousel doesn't need holding torque between drops, so we cut driver
// power shortly after each move to keep the drivers and motors cool.
// A short grace window avoids toggling EN between back-to-back moves.
// Set to 0 to disable auto-release (drivers stay powered once enabled).
static const uint32_t IDLE_RELEASE_MS = 750;

// Step pulse width (HIGH duration). A4988/TMC2208 datasheets say >=1us;
// 2us is generously safe and easy to generate.
static const uint32_t STEP_PULSE_US = 2;

// Safety: ignore step rates above this. Tune to your mechanism.
static const uint32_t MAX_STEPS_PER_SEC = 10000;

// ---------------- Internal state ----------------
struct Motor {
  uint8_t id;            // 1 or 2
  int stepPin;
  int dirPin;
  bool enabledRequested; // tracks the most recent ENABLE request
  int  direction;        // -1 or +1
  uint32_t speedStepsPerS;
  // Active timed run (RUNFOR or DISPENSE backing store)
  bool timedActive;
  uint32_t runUntilMs;
  // DISPENSE bookkeeping
  bool dispenseActive;
  uint32_t dispenseStartMs;
  // Step generation
  uint32_t intervalUs;     // computed from speedStepsPerS
  uint32_t lastStepUs;
};

static Motor m1 { 1, M1_STEP_PIN, M1_DIR_PIN, false, +1, 0, false, 0, false, 0, 0, 0 };
static Motor m2 { 2, M2_STEP_PIN, M2_DIR_PIN, false, +1, 0, false, 0, false, 0, 0, 0 };

static String lineBuf;

// ---------------- Helpers ----------------
// Tracks the physical EN-line state and the last time a motor stepped,
// so we can release the drivers when idle (heat reduction).
static bool g_driverPowered = false;
static uint32_t g_lastActiveMs = 0;

static void driverEnabled(bool en) {
  if (EN_ACTIVE_LOW) digitalWrite(EN_PIN, en ? LOW : HIGH);
  else               digitalWrite(EN_PIN, en ? HIGH : LOW);
}

// Set the shared driver power, remembering current state so we only
// touch the pin on an actual transition.
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

// Fully stop a motor AND mark it disabled. Clearing enabledRequested here
// guarantees the motor is no longer "active", so serviceDriverPower() cuts
// the shared EN line once both motors are stopped — no lingering holding
// current (and no heat) after a dispense/jog/runfor.
static void stopMotor(Motor& m) {
  m.speedStepsPerS = 0;
  m.intervalUs = 0;
  m.timedActive = false;
  m.dispenseActive = false;
  m.enabledRequested = false;
}

static void stopAll() {
  stopMotor(m1);
  stopMotor(m2);
}

// A motor counts as "active" (drawing current / generating motion) when
// it has been enabled and has a non-zero step rate.
static bool motorActive(const Motor& m) {
  return m.enabledRequested && m.intervalUs != 0;
}

// Enable the shared driver line while anything is moving and release it
// IDLE_RELEASE_MS after the last motion, to keep the drivers/motors cool.
static void serviceDriverPower() {
  if (motorActive(m1) || motorActive(m2)) {
    g_lastActiveMs = millis();
    setDriverPower(true);
    return;
  }
  if (IDLE_RELEASE_MS == 0) return; // auto-release disabled
  if (g_driverPowered && (uint32_t)(millis() - g_lastActiveMs) >= IDLE_RELEASE_MS) {
    setDriverPower(false);
  }
}

// Drive a single step pulse on the active motor's STEP pin if it's time.
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

// Handle the "timed" auto-stop for RUNFOR / DISPENSE run_ms. A DISPENSE
// that reaches its run time has delivered the configured rotations, so it
// completed successfully -> report DONE (there is no sensor/jam concept).
static void serviceTimedStop(Motor& m) {
  if (!m.timedActive) return;
  if ((int32_t)(millis() - m.runUntilMs) < 0) return;
  // Time elapsed.
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

  String upper = trimmed;
  upper.toUpperCase();
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
    Serial.println(g_driverPowered ? 1 : 0);
    return;
  }
  if (cmd == "ENABLE") {
    if (n < 3) { replyErr("BAD_CMD", "usage: ENABLE <id> <0|1>"); return; }
    int32_t id = 0, en = 0;
    if (!parseInt(tokens[1], id) || !parseInt(tokens[2], en)) { replyErr("BAD_INT", "ENABLE"); return; }
    Motor* m = motorById((int)id);
    if (!m) { replyErr("BAD_MOTOR", "id must be 1 or 2"); return; }
    m->enabledRequested = (en != 0);
    // Drivers share one EN pin. Power them up now if either motor is
    // enabled so there's settle time before the next move; the idle
    // auto-release in serviceDriverPower() drops power once motion ends.
    if (m1.enabledRequested || m2.enabledRequested) {
      setDriverPower(true);
      g_lastActiveMs = millis(); // hold through the grace window
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
    m->enabledRequested = true;   // motion commands self-enable
    m->timedActive = false;
    m->dispenseActive = false;
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
    m->enabledRequested = true;   // motion commands self-enable
    setJog(*m, (dir >= 0) ? +1 : -1, (uint32_t)spd);
    m->timedActive = true;
    m->dispenseActive = false;
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
    m->enabledRequested = true;   // motion commands self-enable
    setJog(*m, (dir >= 0) ? +1 : -1, (uint32_t)spd);
    m->timedActive = true;
    m->dispenseActive = true;
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
  driverEnabled(false);

  Serial.print("READY ");
  Serial.println(FW_VERSION);
}

void loop() {
  // Drain incoming command bytes.
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

  // Stepper service.
  serviceTimedStop(m1);
  serviceTimedStop(m2);
  serviceDriverPower();   // power EN before stepping; release when idle
  serviceStepper(m1);
  serviceStepper(m2);
}

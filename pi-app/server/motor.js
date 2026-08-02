// Talks to the ESP32 motor controller over USB-serial.
//
// Responsibilities:
//   - Open the serial port (with auto-detect fallback).
//   - Reconnect with backoff if the device is unplugged or fails to enumerate.
//   - Buffer incoming bytes into lines and emit them as events.
//   - Expose convenience methods for DISPENSE / STOP / etc.
//
// The wire protocol is documented in esp32-motor/src/main.cpp.

const { EventEmitter } = require('events');
const { SerialPort } = require('serialport');
const { MotorFwLog } = require('./motor-fw-log');

class MotorBridge extends EventEmitter {
  constructor({ port = 'AUTO', baud = 115200, logFile = null } = {}) {
    super();
    this.portName = port;
    this.baud = baud;
    this.serial = null;
    this.connected = false;
    this.lineBuf = '';
    this.reconnectMs = 1000;
    this.lastFw = null;
    this.lastStatus = null;
    this.log = logFile ? new MotorFwLog(logFile) : null;
    this._log('INFO', `logger ready path=${logFile || '(disabled)'}`);
    this._open();
  }

  _log(kind, line) {
    if (this.log) this.log.write(kind, line);
  }

  /** Ask the ESP32 for firmware + driver/UART status (boot lines are often missed). */
  _probeLink() {
    if (!this.connected) return;
    this._log('INFO', 'probe: PING + STATUS (USB-serial link + TMC UART ok/fail)');
    this.ping();
    setTimeout(() => {
      if (this.connected) this.status();
    }, 150);
  }

  async _resolvePort() {
    if (this.portName && this.portName !== 'AUTO') return this.portName;
    try {
      const ports = await SerialPort.list();
      const candidate = ports.find((p) => {
        const pn = (p.path || '').toLowerCase();
        return pn.includes('ttyusb') || pn.includes('ttyacm');
      });
      return candidate ? candidate.path : null;
    } catch (e) {
      return null;
    }
  }

  async _open() {
    const resolved = await this._resolvePort();
    if (!resolved) {
      this._scheduleReopen('no USB-serial adapter detected');
      return;
    }
    try {
      this.serial = new SerialPort({
        path: resolved,
        baudRate: this.baud,
        autoOpen: false,
      });
    } catch (e) {
      this._scheduleReopen(`construct failed: ${e.message}`);
      return;
    }

    this.serial.on('error', (err) => {
      this._log('INFO', `serial error: ${err.message}`);
      this.emit('warn', `serial error: ${err.message}`);
    });
    this.serial.on('close', () => {
      this.connected = false;
      this._log('INFO', 'serial closed — USB link down');
      this.emit('disconnected');
      this._scheduleReopen('port closed');
    });
    this.serial.on('data', (chunk) => this._onData(chunk));

    this.serial.open((err) => {
      if (err) {
        this._scheduleReopen(`open failed: ${err.message}`);
        return;
      }
      this.connected = true;
      this.reconnectMs = 1000;
      this._log('INFO', `USB-serial connected port=${resolved} baud=${this.baud}`);
      this.emit('connected', resolved);
      // ESP32 often printed READY/TMC before we opened the port — ask again.
      setTimeout(() => this._probeLink(), 400);
    });
  }

  _scheduleReopen(reason) {
    this.connected = false;
    this.serial = null;
    this._log('INFO', `reconnect in ${this.reconnectMs}ms (${reason})`);
    this.emit('warn', `reconnect in ${this.reconnectMs}ms (${reason})`);
    const delay = this.reconnectMs;
    this.reconnectMs = Math.min(this.reconnectMs * 2, 30000);
    setTimeout(() => this._open(), delay);
  }

  _onData(chunk) {
    this.lineBuf += chunk.toString('utf8');
    let idx;
    while ((idx = this.lineBuf.indexOf('\n')) >= 0) {
      const line = this.lineBuf.slice(0, idx).replace(/\r$/, '');
      this.lineBuf = this.lineBuf.slice(idx + 1);
      if (line.length === 0) continue;
      this._handleLine(line);
    }
    // Don't let a misbehaving firmware fill memory with no newline.
    if (this.lineBuf.length > 4096) this.lineBuf = '';
  }

  _handleLine(line) {
    this._log('RX', line);
    const parts = line.split(/\s+/);
    const head = parts[0];
    if (head === 'READY') {
      this.lastFw = parts.slice(1).join(' ');
      this._log('INFO', `firmware ready fw=${this.lastFw}`);
      this.emit('ready', this.lastFw);
    } else if (head === 'PONG') {
      this.lastFw = parts.slice(1).join(' ') || this.lastFw;
      this._log('INFO', `usb link ok fw=${this.lastFw || '?'}`);
      this.emit('reply', line);
    } else if (head === 'STATUS') {
      this.lastStatus = line;
      const tmc1 = (line.match(/TMC1=(\S+)/) || [])[1] || '?';
      const tmc2 = (line.match(/TMC2=(\S+)/) || [])[1] || '?';
      const drv = (line.match(/DRV=(\S+)/) || [])[1] || '?';
      const enGpio = (line.match(/EN_GPIO=(\S+)/) || [])[1] || '?';
      const enpol = (line.match(/ENPOL=(\S+)/) || [])[1] || '?';
      this._log(
        'INFO',
        `driver status TMC_UART_M1=${tmc1} TMC_UART_M2=${tmc2} DRV=${drv} EN_GPIO=${enGpio} ENPOL=${enpol}`,
      );
      if (String(enGpio) === '0' && enpol === 'active_low') {
        this._log(
          'INFO',
          'WARN EN looks ON (EN_GPIO=0 + active_low) — motors will hold/heat; Flip EN polarity or check EN short to GND',
        );
      }
      if (tmc1 === 'fail' && tmc2 === 'fail') {
        this._log(
          'INFO',
          'WARN TMC UART bus dead (both fail) — check GPIO16/17 + 1k on TX + PDN_UART to both drivers',
        );
      }
      this.emit('reply', line);
    } else if (head === 'TMC' || line.startsWith('TMC ')) {
      // Boot line: "TMC M1=ok ms=16 M2=fail ms=0"
      this._log('INFO', `tmc uart boot ${line}`);
      this.emit('reply', line);
    } else if (head === 'DONE') {
      // A dispense finished its rotation-based run (or was stopped). The
      // firmware includes elapsed ms on run completion; a manual STOP omits it.
      const motorId = parseInt(parts[1], 10);
      const ms = parts[2] !== undefined ? parseInt(parts[2], 10) : undefined;
      // Explicitly drop ENABLE so drivers never sit holding current / heat.
      this.enable(motorId, false);
      this.emit('dispense_result', { motor: motorId, kind: 'done', ms });
    } else if (head === 'JAM') {
      // StallGuard DIAG trip during a DISPENSE.
      const motorId = parseInt(parts[1], 10);
      const ms = parts[2] !== undefined ? parseInt(parts[2], 10) : undefined;
      this.enable(motorId, false);
      this.emit('dispense_result', { motor: motorId, kind: 'jam', ms });
    } else {
      // Pass-through: OK, ERR, etc.
      this.emit('reply', line);
    }
  }

  _send(line) {
    if (!this.connected || !this.serial) {
      this._log('INFO', `dropped (not connected): ${line}`);
      this.emit('warn', `dropped command (not connected): ${line}`);
      return false;
    }
    this._log('TX', line);
    this.serial.write(`${line}\n`, (err) => {
      if (err) {
        this._log('INFO', `write error: ${err.message}`);
        this.emit('warn', `write error: ${err.message}`);
      }
    });
    return true;
  }

  ping()                       { return this._send('PING'); }
  status()                     { return this._send('STATUS'); }
  /** Re-query link + TMC UART status into the log (same as post-connect probe). */
  probe()                      { this._probeLink(); return this.connected; }
  cool()                       { return this._send('COOL'); }
  enpol(activeLow) {
    if (activeLow === undefined || activeLow === null) return this._send('ENPOL');
    return this._send(`ENPOL ${activeLow ? 1 : 0}`);
  }
  enable(id, on)               { return this._send(`ENABLE ${id} ${on ? 1 : 0}`); }
  stop(id)                     { return this._send(id && id > 0 ? `STOP ${id}` : 'STOP'); }
  jog(id, dir, speed)          { return this._send(`JOG ${id} ${dir} ${speed}`); }
  runFor(id, dir, speed, ms)   { return this._send(`RUNFOR ${id} ${dir} ${speed} ${ms}`); }
  dispense(id, dir, speed, maxMs) {
    // Firmware powers coils only for the motion command — do not ENABLE
    // first (that left holding torque if disable was missed).
    return this._send(`DISPENSE ${id} ${dir} ${speed} ${maxMs}`);
  }
}

module.exports = { MotorBridge };

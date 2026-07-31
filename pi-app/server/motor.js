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

class MotorBridge extends EventEmitter {
  constructor({ port = 'AUTO', baud = 115200 } = {}) {
    super();
    this.portName = port;
    this.baud = baud;
    this.serial = null;
    this.connected = false;
    this.lineBuf = '';
    this.reconnectMs = 1000;
    this.lastFw = null;
    this._open();
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
      this.emit('warn', `serial error: ${err.message}`);
    });
    this.serial.on('close', () => {
      this.connected = false;
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
      this.emit('connected', resolved);
    });
  }

  _scheduleReopen(reason) {
    this.connected = false;
    this.serial = null;
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
    const parts = line.split(/\s+/);
    const head = parts[0];
    if (head === 'READY') {
      this.lastFw = parts.slice(1).join(' ');
      this.emit('ready', this.lastFw);
    } else if (head === 'DONE') {
      // A dispense finished its rotation-based run (or was stopped). The
      // firmware includes elapsed ms on run completion; a manual STOP omits it.
      const motor = parseInt(parts[1], 10);
      const ms = parts[2] !== undefined ? parseInt(parts[2], 10) : undefined;
      // Explicitly drop ENABLE so drivers never sit holding current / heat.
      this.enable(motor, false);
      this.emit('dispense_result', { motor, kind: 'done', ms });
    } else if (head === 'JAM') {
      // StallGuard DIAG trip during a DISPENSE.
      const motor = parseInt(parts[1], 10);
      const ms = parts[2] !== undefined ? parseInt(parts[2], 10) : undefined;
      this.enable(motor, false);
      this.emit('dispense_result', { motor, kind: 'jam', ms });
    } else {
      // Pass-through: OK, ERR, PONG, STATUS, TMC, etc.
      this.emit('reply', line);
    }
  }

  _send(line) {
    if (!this.connected || !this.serial) {
      this.emit('warn', `dropped command (not connected): ${line}`);
      return false;
    }
    this.serial.write(`${line}\n`, (err) => {
      if (err) this.emit('warn', `write error: ${err.message}`);
    });
    return true;
  }

  ping()                       { return this._send('PING'); }
  status()                     { return this._send('STATUS'); }
  enable(id, on)               { return this._send(`ENABLE ${id} ${on ? 1 : 0}`); }
  stop(id)                     { return this._send(id && id > 0 ? `STOP ${id}` : 'STOP'); }
  jog(id, dir, speed)          { return this._send(`JOG ${id} ${dir} ${speed}`); }
  runFor(id, dir, speed, ms)   { return this._send(`RUNFOR ${id} ${dir} ${speed} ${ms}`); }
  dispense(id, dir, speed, maxMs) {
    // Brief ENABLE settle, then DISPENSE (firmware self-enables too).
    // DONE/JAM handlers send ENABLE 0 so coils are never left energized.
    this.enable(id, true);
    return this._send(`DISPENSE ${id} ${dir} ${speed} ${maxMs}`);
  }
}

module.exports = { MotorBridge };

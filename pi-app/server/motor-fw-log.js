// Append-only firmware ↔ Pi serial log for remote debugging (Pi Connect / SSH).
// Rotates to motor-fw.log.1 when the file exceeds maxBytes.

const fs = require('fs');
const path = require('path');

class MotorFwLog {
  constructor(file, { maxBytes = 1024 * 1024 } = {}) {
    this.file = file;
    this.maxBytes = maxBytes;
    this._ensured = false;
  }

  _ensureDir() {
    if (this._ensured) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      this._ensured = true;
    } catch (e) {
      console.warn(`[motor-log] mkdir failed: ${e.message}`);
    }
  }

  _rotateIfNeeded() {
    try {
      const st = fs.statSync(this.file);
      if (st.size < this.maxBytes) return;
      const bak = `${this.file}.1`;
      try { fs.unlinkSync(bak); } catch (_) {}
      fs.renameSync(this.file, bak);
    } catch (_) {
      // missing file is fine
    }
  }

  /** @param {'TX'|'RX'|'INFO'} kind */
  write(kind, line) {
    if (!this.file) return;
    this._ensureDir();
    this._rotateIfNeeded();
    const ts = new Date().toISOString();
    const text = String(line).replace(/\s+$/g, '');
    try {
      fs.appendFileSync(this.file, `${ts} ${kind} ${text}\n`, 'utf8');
    } catch (e) {
      console.warn(`[motor-log] write failed: ${e.message}`);
    }
  }
}

module.exports = { MotorFwLog };

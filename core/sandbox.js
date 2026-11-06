'use strict';

// OS sandbox policy (advisory + path checks) and encrypted conversation storage.
// Real OS-level sandboxing is platform-specific; this module provides the
// policy layer and a portable encrypted-at-rest store using node crypto.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

class SandboxPolicy {
  constructor({ workspace, allowNetwork = false, allowSystem = false } = {}) {
    this.workspace = path.resolve(workspace || process.cwd());
    this.allowNetwork = !!allowNetwork;
    this.allowSystem = !!allowSystem;
  }

  checkPath(p) {
    // A Windows drive/UNC path is absolute even when Nexus runs on POSIX.
    // Do not reinterpret it as a harmless filename under the workspace.
    if (path.win32.isAbsolute(p) && !path.isAbsolute(p)) {
      return { ok: false, reason: `path uses another OS's absolute syntax: ${p}` };
    }
    const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(this.workspace, p);
    if (this.allowSystem) return { ok: true, abs };
    const rel = path.relative(this.workspace, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return { ok: false, reason: `path escapes workspace: ${p}` };
    }
    return { ok: true, abs };
  }

  checkCommand(cmd) {
    const lower = String(cmd || '').toLowerCase();
    const dangerous = ['format ', 'diskpart', 'mkfs', 'rm -rf /', 'del /f /s /q c:\\'];
    for (const d of dangerous) if (lower.includes(d)) return { ok: false, reason: `blocked: ${d}` };
    if (!this.allowNetwork && /\bcurl\b|\bwget\b|\binvoke-webrequest\b/i.test(cmd)) {
      return { ok: false, reason: 'network access disabled by sandbox policy' };
    }
    return { ok: true };
  }
}

// Encrypted conversation storage (AES-256-GCM, key derived from a passphrase).
class EncryptedStore {
  constructor(root, passphrase) {
    this.root = root;
    this.key = crypto.scryptSync(passphrase || 'nexus-default', 'nexus-salt', 32);
  }

  _file(name) {
    return path.join(this.root, 'secure', `${name}.enc`);
  }

  async write(name, data) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const plaintext = Buffer.from(JSON.stringify(data), 'utf8');
    const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const payload = Buffer.concat([iv, tag, enc]);
    const file = this._file(name);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, payload, { mode: 0o600 });
  }

  async read(name) {
    const payload = await fs.readFile(this._file(name));
    const iv = payload.subarray(0, 12);
    const tag = payload.subarray(12, 28);
    const enc = payload.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return JSON.parse(dec.toString('utf8'));
  }
}

module.exports = { SandboxPolicy, EncryptedStore };
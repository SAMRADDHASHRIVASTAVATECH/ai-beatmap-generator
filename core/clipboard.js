'use strict';

/** Copy text to the OS clipboard without a clipboard dependency (Windows, PowerShell). */
const { execFileSync } = require('node:child_process');

function copy(text) {
  const t = String(text || '');
  if (!t) return false;
  try {
    const b64 = Buffer.from(t, 'utf8').toString('base64');
    const script =
      `$data = [Convert]::FromBase64String('${b64}'); ` +
      `[Text.Encoding]::UTF8.GetString($data) | Set-Clipboard`;
    execFileSync('powershell', ['-NoProfile', '-Command', script], { windowsHide: true, timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function readClipboard() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      '[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-Clipboard -Raw'],
      { windowsHide: true, timeout: 5000, maxBuffer: 2_000_000 });
    return String(out || '');
  } catch {
    return '';
  }
}

module.exports = { copy, readClipboard };

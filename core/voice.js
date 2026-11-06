'use strict';

/**
 * Local voice + vision I/O. No cloud speech APIs, ever.
 *
 * TTS: Windows System.Speech (works out of the box on Windows).
 * Mic: DirectShow capture through ffmpeg.
 * STT: uses faster-whisper / openai-whisper in Python if they are installed.
 *      If neither is present we say so plainly instead of faking it.
 * Screenshots: whole-desktop capture via System.Drawing (explicit call only).
 */
const { execFile, spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

function which(cmd) {
  return new Promise((resolve) => {
    execFile(process.platform === 'win32' ? 'where.exe' : 'which', [cmd], { windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim().split('\n')[0] || null);
    });
  });
}

// ------------------------------------------------------------------- TTS
let lastSpeech = null;
function speak(text, { rate = null } = {}) {
  const t = String(text || '').replace(/["'`]/g, "'").slice(0, 4000);
  if (!t) return { ok: false, error: 'empty text' };
  const rateArg = Number.isFinite(rate) ? ` $s.Rate = ${Math.round(rate)};` : '';
  const script = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer;${rateArg} $s.Speak("${t}")`;
  const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c',
    `powershell -NoProfile -Command "${script.replace(/"/g, '""')}"`], { windowsHide: true, stdio: 'ignore' });
  lastSpeech = child;
  return { ok: true, pid: child.pid };
}

function stopSpeaking() {
  if (lastSpeech && !lastSpeech.killed) {
    try { lastSpeech.kill(); } catch {}
    return { ok: true, stopped: true };
  }
  return { ok: true, stopped: false };
}

// ------------------------------------------------------------------- MIC
async function listAudioDevices() {
  const ffmpeg = await which('ffmpeg');
  if (!ffmpeg) return { ok: false, error: 'ffmpeg not on PATH', devices: [] };
  if (process.platform === 'linux') return { ok: true, devices: ['default'], input: 'pulse' };
  if (process.platform === 'darwin') return { ok: true, devices: [':0'], input: 'avfoundation' };
  return new Promise((resolve) => {
    execFile(ffmpeg, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'],
      { windowsHide: true, timeout: 15000 }, (_err, stdout, stderr) => {
        const text = `${stdout || ''}\n${stderr || ''}`;
        const devices = [...text.matchAll(/"([^"]+)" \(audio\)/g)].map((m) => m[1]);
        resolve(devices.length
          ? { ok: true, devices, input: 'dshow' }
          : { ok: false, devices: [], error: 'No microphone found by ffmpeg' });
      });
  });
}

async function recordMic({ seconds = 5, file = null, device = null } = {}) {
  const ffmpeg = await which('ffmpeg');
  if (!ffmpeg) return { ok: false, error: 'ffmpeg not on PATH' };
  const out = file || path.join(process.env.TEMP || '.', `nexus-mic-${Date.now()}.wav`);
  const list = await listAudioDevices();
  if (!list.ok) return { ok: false, error: list.error };
  const dev = device || list.devices[0];
  const input = process.platform === 'win32' ? `audio=${dev}` : dev;
  return new Promise((resolve) => {
    execFile(ffmpeg, ['-y', '-f', list.input, '-i', input, '-t', String(Math.min(120, seconds)), out],
      { windowsHide: true, timeout: (seconds + 15) * 1000 }, (err, _stdout, stderr) => {
        if (err) return resolve({ ok: false, error: String(stderr || err).slice(-400) });
        resolve({ ok: true, file: out, device: dev });
      });
  });
}

// ------------------------------------------------------------------- STT
async function sttAvailable() {
  for (const python of ['python', 'python3']) {
    for (const mod of ['faster_whisper', 'whisper']) {
      const found = await new Promise((resolve) => {
        execFile(python, ['-c', `import ${mod}; print('yes')`],
          { windowsHide: true, timeout: 10000 }, (err, stdout) => {
            resolve(!err && String(stdout).includes('yes'));
          });
      });
      if (found) return { available: true, module: mod, python };
    }
  }
  return {
    available: false,
    module: null,
    reason: 'faster-whisper / openai-whisper not installed for python on PATH',
    install: 'pip install faster-whisper',
  };
}

// ----------------------------------------------------------- SCREENSHOT
function captureScreen(file = null) {
  const out = file || path.join(process.env.TEMP || '.', `nexus-screen-${Date.now()}.png`);
  return new Promise((resolve) => {
    const script = `Add-Type -AssemblyName System.Drawing; $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size); $bmp.Save('${out.replace(/'/g, "''")}'); $g.Dispose(); $bmp.Dispose()`;
    execFile(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c',
      `powershell -NoProfile -STA -Command "Add-Type -AssemblyName System.Windows.Forms; ${script}"`],
      { windowsHide: true, timeout: 30000 }, (err, stdout, stderr) => {
        if (err) return resolve({ ok: false, error: String(stderr || err).slice(-400) });
        resolve({ ok: true, file: out });
      });
  });
}

module.exports = { speak, stopSpeaking, listAudioDevices, recordMic, sttAvailable, captureScreen };

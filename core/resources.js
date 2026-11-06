'use strict';

/**
 * Real resource measurements: RAM, CPU, GPU VRAM and utilization (nvidia-smi),
 * plus model-pressure heuristics. Everything is measured, nothing is invented.
 */
const os = require('node:os');
const { execFile } = require('node:child_process');

function ramInfo() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  return {
    totalBytes: total,
    usedBytes: used,
    freeBytes: free,
    usedPct: Math.round((used / total) * 1000) / 10,
    totalHuman: `${(total / 1024 ** 3).toFixed(1)} GB`,
    freeHuman: `${(free / 1024 ** 3).toFixed(1)} GB`,
  };
}

function cpuInfo() {
  const cpus = os.cpus() || [];
  const load = os.loadavg ? os.loadavg()[0] : null; // Windows reports 0, but keep it honest
  const model = cpus[0]?.model || 'unknown';
  // Rough busy estimate from OS-wide times over a short window would need sampling;
  // report core count and model, and let the event loop lag be measured separately.
  return {
    cores: cpus.length,
    model,
    avgLoad1m: load,
    note: 'Windows reports no reliable per-core busy counter without sampling; see load1 and the event-loop lag probe for real pressure',
  };
}

function gpuInfo() {
  return new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu', '--format=csv,noheader,nounits'],
      { timeout: 5000, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) return resolve({ available: false, note: 'nvidia-smi unavailable or not an NVIDIA GPU' });
        const line = stdout.trim().split('\n')[0];
        const [name, total, used, free, util] = line.split(',').map((s) => s.trim());
        resolve({
          available: true,
          name,
          totalMiB: Number(total),
          usedMiB: Number(used),
          freeMiB: Number(free),
          utilizationPct: Number(util),
        });
      }
    );
  });
}

async function snapshot() {
  const gpu = await gpuInfo();
  return {
    time: new Date().toISOString(),
    ram: ramInfo(),
    cpu: cpuInfo(),
    gpu,
  };
}

/** True when memory or VRAM pressure is high enough to defer nonessential work. */
function isLowResource({ ramUsedPct = null, gpuFreeMiB = null, ramFreeBytes = null } = {}) {
  const ram = ramInfo();
  const used = ramUsedPct ?? ram.usedPct;
  const free = ramFreeBytes ?? ram.freeBytes;
  if (used > 90) return true;
  if (free < 1.5 * 1024 ** 3) return true;
  if (gpuFreeMiB != null && gpuFreeMiB < 400) return true;
  return false;
}

module.exports = { ramInfo, cpuInfo, gpuInfo, snapshot, isLowResource };

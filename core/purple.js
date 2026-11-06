'use strict';

// "Purple-line" autonomous engineering cycle.
// State machine: PLAN -> IMPLEMENT -> BUILD -> RUN -> OBSERVE -> DIAGNOSE -> FIX -> TEST -> VERIFY
// Each phase produces evidence; transitions require a recorded outcome.
const PHASES = ['PLAN', 'IMPLEMENT', 'BUILD', 'RUN', 'OBSERVE', 'DIAGNOSE', 'FIX', 'TEST', 'VERIFY'];

class PurpleCycle {
  constructor({ maxIterations = 3 } = {}) {
    this.maxIterations = maxIterations;
    this.iteration = 0;
    this.phase = 'PLAN';
    this.history = []; // { phase, outcome, evidence, time }
    this.evidence = {};
    this.status = 'idle'; // idle | running | done | failed
  }

  start(goal) {
    this.goal = goal;
    this.status = 'running';
    this.phase = 'PLAN';
    this.iteration = 1;
    return this.snapshot();
  }

  record(phase, outcome, evidence = '') {
    if (phase !== this.phase) throw new Error(`cannot record ${phase} while in ${this.phase}`);
    this.history.push({ phase, outcome, evidence, time: new Date().toISOString(), iteration: this.iteration });
    this.evidence[phase] = evidence;
    // Advance
    const idx = PHASES.indexOf(phase);
    if (outcome === 'fail' && (phase === 'BUILD' || phase === 'RUN' || phase === 'TEST')) {
      // jump to DIAGNOSE/FIX instead of advancing
      this.phase = phase === 'BUILD' ? 'DIAGNOSE' : 'DIAGNOSE';
    } else if (idx === PHASES.length - 1) {
      if (outcome === 'pass') {
        this.status = 'done';
        this.phase = 'VERIFY';
      } else {
        this._retry();
      }
    } else {
      this.phase = PHASES[idx + 1];
    }
    return this.snapshot();
  }

  _retry() {
    if (this.iteration >= this.maxIterations) {
      this.status = 'failed';
      return;
    }
    this.iteration += 1;
    this.phase = 'DIAGNOSE';
  }

  snapshot() {
    return {
      goal: this.goal,
      status: this.status,
      phase: this.phase,
      iteration: this.iteration,
      maxIterations: this.maxIterations,
      history: this.history.slice(),
      evidence: { ...this.evidence },
    };
  }

  isTerminal() {
    return this.status === 'done' || this.status === 'failed';
  }
}

module.exports = { PurpleCycle, PHASES };
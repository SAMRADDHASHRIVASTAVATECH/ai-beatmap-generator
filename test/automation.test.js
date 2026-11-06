const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AutomationBus } = require('../core/automation');

const dataDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-auto-'));

test('queue persists across loads and respects priority order', async () => {
  const dir = dataDir();
  const bus = new AutomationBus({ dataDir: dir, onEvent: () => {} });
  await bus.load();
  const a = await bus.add({ kind: 'generic', title: 'low priority', priority: 9 });
  const b = await bus.add({ kind: 'generic', title: 'high priority', priority: 1 });
  await bus.save();

  const bus2 = new AutomationBus({ dataDir: dir, onEvent: () => {} });
  await bus2.load();
  assert.strictEqual(bus2.tasks.length, 2);
  const next = bus2.claimNext();
  assert.strictEqual(next.id, b.id, 'lower priority number claimed first');
  await bus2.complete(next.id, 'done');
  assert.strictEqual(bus2.list({ status: 'done' }).length, 1);
  const notes = await bus2.notifications();
  assert.ok(notes.some((n) => /high priority/.test(n.body)));
  await bus.stop();
  await bus2.stop();
});

test('pause blocks claiming; resume restores it', async () => {
  const bus = new AutomationBus({ dataDir: dataDir(), onEvent: () => {} });
  await bus.load();
  await bus.add({ title: 'first item', priority: 1 });
  await bus.add({ title: 'second item', priority: 1 });
  assert.ok(bus.claimNext());
  await bus.pause();
  assert.strictEqual(bus.claimNext(), null);
  await bus.resume();
  assert.ok(bus.claimNext(), 'the remaining queued item is claimed after resume');
  await bus.stop();
});

test('recurring task reschedules itself on completion', async () => {
  const bus = new AutomationBus({ dataDir: dataDir(), onEvent: () => {} });
  await bus.load();
  const t = await bus.add({ title: 'nightly check', recurringMs: 3600000, priority: 3 });
  await bus.complete(t.id, 'ran');
  const queued = bus.list({ status: 'queued' });
  assert.strictEqual(queued.length, 1, 'next occurrence created');
  assert.ok(new Date(queued[0].dueAt) > new Date());
  await bus.stop();
});

test('file watcher fires on real file changes', async () => {
  const watched = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-watch-'));
  const events = [];
  const bus = new AutomationBus({ dataDir: dataDir(), onEvent: (e) => events.push(e) });
  await bus.load();
  bus.watch(watched, { recursive: false });
  await new Promise((r) => setTimeout(r, 300));
  fs.writeFileSync(path.join(watched, 'touch.txt'), 'x');
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(events.some((e) => e.type === 'fs' && /touch\.txt/.test(e.file || '')), JSON.stringify(events));
  await bus.stop();
});

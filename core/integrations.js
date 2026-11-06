'use strict';

// Computer assistance integrations: document, spreadsheet and presentation
// helpers that operate on plain files (no external office suite required).
const fs = require('node:fs/promises');
const path = require('node:path');

async function readCsv(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  const lines = raw.trim().split(/\r?\n/);
  return lines.map((l) => l.split(',').map((c) => c.trim().replace(/^"|"$/g, '')));
}

async function writeCsv(filePath, rows) {
  const body = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, body + '\n', 'utf8');
}

async function readMarkdown(filePath) {
  return fs.readFile(filePath, 'utf8');
}

async function writeMarkdown(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

// Minimal presentation: a JSON slide deck.
async function writeDeck(filePath, slides) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify({ slides: slides || [] }, null, 2), 'utf8');
}

async function readDeck(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

module.exports = { readCsv, writeCsv, readMarkdown, writeMarkdown, writeDeck, readDeck };
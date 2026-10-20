'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '../dist');
const context = vm.createContext({ window: {} });
for (const name of ['study-engine.js', 'data.js', 'transfer-data.js']) vm.runInContext(fs.readFileSync(path.join(root, name), 'utf8'), context);
const { ESSAY_DATA: { articles }, TRANSFER_TASKS: tasks, StudyEngine: E } = context.window;
test('twenty complete essays preserve their paragraph text and exact recall targets', () => {
  assert.equal(articles.length, 20);
  assert.equal(new Set(articles.map(a => a.id)).size, 20);
  assert.equal(articles.filter(a => a.level === 'CET4').length, 10);
  assert.equal(articles.filter(a => a.level === 'CET6').length, 10);
  for (const a of articles) {
    assert.equal(E.normalize(a.sentences.map(s => s.en).join(' ')), E.normalize(a.paragraphs.map(p => p.en).join(' ')), a.id);
    assert.ok(a.structure.length >= 3, a.id);
    assert.ok(a.sentences.every(s => s.zh && !s.zh.startsWith('本句所在')), a.id);
    assert.ok(a.sentences.flatMap(s => s.targets).length >= 4, a.id);
    for (const s of a.sentences) for (const target of s.targets) assert.ok(s.en.includes(target), a.id + ': ' + target);
  }
});
test('all eighty maps and their thumbnails are valid available WebP assets', () => {
  const all = articles.flatMap(a => a.images);
  assert.equal(all.length, 80);
  assert.equal(new Set(all.map(i => i.id)).size, 80);
  for (const a of articles) assert.equal(new Set(a.images.map(i => i.kind)).size, 4, a.id);
  for (const image of all) for (const asset of [image.src, image.thumb]) {
    assert.match(asset, /^assets\/[a-z0-9.-]+\.webp$/);
    const bytes = fs.readFileSync(path.join(root, asset));
    assert.equal(bytes.subarray(0, 4).toString(), 'RIFF', asset);
    assert.equal(bytes.subarray(8, 12).toString(), 'WEBP', asset);
    assert.ok(bytes.length > 1000, asset);
  }
});
test('transfer tasks cover all essays and every independent practice filter has a task', () => {
  const ids = new Set(articles.map(a => a.id));
  assert.equal(tasks.length, 36);
  assert.equal(new Set(tasks.map(t => t.id)).size, tasks.length);
  assert.equal(new Set(tasks.flatMap(t => t.sourceIds)).size, 20);
  for (const t of tasks) {
    assert.ok(t.sourceIds.every(id => ids.has(id)), t.id);
    assert.ok(t.minWords > 0 && t.maxWords >= t.minWords && t.maxParagraphs >= t.minParagraphs, t.id);
    assert.equal(t.origin, '自拟训练', t.id);
    assert.equal(t.rubric.length, 4, t.id);
  }
  for (const level of ['CET4', 'CET6']) for (const mode of ['paragraph', 'essay']) assert.ok(tasks.some(t => t.level === level && t.difficulty === 'independent' && t.mode === mode));
});

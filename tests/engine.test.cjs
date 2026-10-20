'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const enginePath = path.join(__dirname, '../dist/study-engine.js');
const E = require(enginePath);

test('normalization ignores case, punctuation and whitespace while retaining word boundaries', () => {
  assert.equal(E.normalize('  Don’t STOP, taking\n action! '), 'dont stop taking action');
  assert.equal(E.compare("Don't stop.", 'DON’T STOP!').correct, true);
  assert.equal(E.compare('actionturns', 'action turns').correct, false);
  assert.equal(E.countWords("中文提示 Don't stop, well-known ideas in CET4."), 7);
});

test('sequence diff locates omitted and extra words without hiding order errors', () => {
  const result = E.compare('Action turns good plans reality today.', 'Action turns plans into reality.');
  assert.equal(result.correct, false);
  assert.deepEqual(result.missingTokens, ['into']);
  assert.deepEqual(result.extraTokens, ['good', 'today']);
  assert.equal(result.accuracy, 4 / 6);
  assert.deepEqual(result.tokens.filter(x => x.type === 'equal').map(x => x.text), ['Action', 'turns', 'plans', 'reality']);
  assert.equal(E.compare('B A', 'A B').correct, false);
  assert.equal(E.compare('', '').accuracy, 1);
  assert.throws(() => E.compare('word '.repeat(2501), 'word'), RangeError);
});

test('cloze rotates sentences and targets, reconstructs exact source, and ignores absent targets', () => {
  const article = {
    id: 'cet4-1',
    sentences: Array.from({ length: 5 }, (_, i) => ({
      en: `First phrase ${i} and second phrase ${i}.`, zh: `第${i}句`, section: 'body',
      targets: [`First phrase ${i}`, `second phrase ${i}`, 'not in source']
    }))
  };
  const first = E.cloze(article, 0, 3);
  const next = E.cloze(article, 1, 3);
  assert.deepEqual(first.map(x => x.sentenceIndex), [0, 1, 2]);
  assert.deepEqual(next.map(x => x.sentenceIndex), [3, 4, 0]);
  assert.notEqual(first[0].answer, next[2].answer);
  [...first, ...next].forEach(item => assert.equal(item.before + item.answer + item.after, article.sentences[item.sentenceIndex].en));
  assert.equal(new Set(first.map(x => x.sentenceIndex)).size, first.length);
  assert.deepEqual(E.cloze({ id: 'empty', sentences: [{ en: 'No exact target.', targets: ['wrong'] }] }), []);
  assert.throws(() => E.cloze(article, -1), RangeError);
});

test('review spacing grows after independent retrieval and resets after assistance or failure', () => {
  let record = E.schedule(null, 'independent', '2026-10-20');
  assert.deepEqual(record, { intervalDays: 1, dueAt: '2026-10-21', streak: 1, lastOutcome: 'independent' });
  record = E.schedule(record, 'independent', '2026-10-21');
  assert.equal(record.intervalDays, 3);
  record = E.schedule(record, 'independent', '2026-10-24');
  assert.equal(record.intervalDays, 7);
  const assisted = E.schedule(record, 'assisted', '2026-10-31');
  assert.equal(assisted.intervalDays, 1);
  assert.equal(assisted.streak, 0);
  assert.equal(E.schedule(assisted, 'independent', '2026-11-01').intervalDays, 1);
  assert.equal(E.schedule(record, 'again', '2026-10-31').intervalDays, 1);
  assert.equal(E.isDue(record, '2026-10-30'), false);
  assert.equal(E.isDue(record, '2026-10-31'), true);
  assert.equal(E.isDue(null, '2026-10-31'), false);
});

test('review dates follow Shanghai calendar days independent of machine timezone', () => {
  assert.equal(E.schedule(null, 'again', '2026-10-20T16:05:00Z').dueAt, '2026-10-22');
  assert.equal(E.schedule(null, 'again', '2026-10-21T00:05:00+08:00').dueAt, '2026-10-22');
  assert.equal(E.schedule(null, 'again', '2024-02-28').dueAt, '2024-02-29');
  assert.equal(E.schedule(null, 'again', '2026-12-31').dueAt, '2027-01-01');
  ['2026-02-30', '2026-10-20T10:00:00', '2026-10-20T25:00:00Z', '2026-02-30T00:00:00Z', 'not a date', '2026-01-01T10:00:00+15:00'].forEach(value => {
    assert.throws(() => E.schedule(null, 'again', value), RangeError);
  });
  assert.throws(() => E.isDue({ dueAt: '2026-02-30' }, '2026-10-20'), RangeError);
  assert.throws(() => E.schedule(null, 'perfect', '2026-10-20'), RangeError);
});

test('transfer checks report observable constraints and source overlap, never an essay score', () => {
  const paragraph = 'Taking action helps students turn a simple plan into a real habit through small daily steps. For example, a student can practise speaking English for ten minutes each morning before breakfast and keep a short record of progress.';
  const result = E.assessTransfer({ mode: 'paragraph', minWords: 30, maxWords: 80, sourceText: paragraph }, { outline: 'action → small steps → speaking example', text: paragraph });
  assert.equal(result.wordRange.within, true);
  assert.equal(result.paragraphRequirement.met, true);
  assert.equal(result.hasOutline, true);
  assert.equal(result.sourceOverlap.ratio, 1);
  assert.ok(result.sourceOverlap.warning.length);
  assert.equal('score' in result, false);
  const essay = E.assessTransfer({ mode: 'essay', minWords: 5, maxWords: 20 }, { text: 'One useful idea.\n\nAnother clear reason.\nA final conclusion.', outline: '' });
  assert.equal(essay.paragraphCount, 3);
  assert.equal(essay.paragraphRequirement.met, true);
  assert.equal(essay.sourceOverlap.checked, false);
  assert.equal(essay.hasOutline, false);
});

function backup() {
  return { version: 1, records: { 'cet4-1:cloze': E.schedule(null, 'independent', '2026-10-20') }, drafts: { 'cet4-1': { text: 'An essay.', outline: 'A plan.' } }, settings: { level: 'CET4', dailyLimit: 4 }, history: [{ articleId: 'cet4-1', outcome: 'independent' }], bookmarks: ['cet4-1'] };
}

test('backup validates and safely copies real learning state', () => {
  const input = backup();
  const result = E.validateBackup(input);
  assert.equal(result.valid, true);
  assert.notEqual(result.data, input);
  input.drafts['cet4-1'].text = 'Changed later.';
  assert.equal(result.data.drafts['cet4-1'].text, 'An essay.');
  assert.equal(Object.getPrototypeOf(result.data.records), null);
});

test('backup rejects corruption, prototype pollution, executable values, invalid schedules and excess payload', () => {
  const invalid = [null, {}, { ...backup(), version: 2 }, { ...backup(), unknown: true }, { ...backup(), records: [] }, { ...backup(), bookmarks: ['same', 'same'] }];
  const polluted = JSON.parse(JSON.stringify(backup()));
  polluted.drafts = JSON.parse('{"__proto__":{"polluted":true}}');
  invalid.push(polluted);
  const dangerousConstructor = backup();
  dangerousConstructor.settings = JSON.parse('{"constructor":{"prototype":{"polluted":true}}}');
  invalid.push(dangerousConstructor);
  const badDate = backup(); badDate.records['cet4-1:cloze'].dueAt = '2026-02-30'; invalid.push(badDate);
  const badFunction = backup(); badFunction.settings.fn = () => {}; invalid.push(badFunction);
  const enormous = backup(); enormous.drafts.large = 'a'.repeat(50001); invalid.push(enormous);
  const excessiveBytes = backup(); excessiveBytes.drafts = Object.fromEntries(Array.from({ length: 60 }, (_, i) => ['draft' + i, '中'.repeat(15000)])); invalid.push(excessiveBytes);
  const cyclic = backup(); cyclic.settings.self = cyclic; invalid.push(cyclic);
  const accessor = backup(); Object.defineProperty(accessor.settings, 'secret', { get() { throw new Error('must not execute'); } }); invalid.push(accessor);
  invalid.forEach(input => assert.equal(E.validateBackup(input).valid, false));
  assert.equal({}.polluted, undefined);
});

test('classic browser script exposes the same engine without a module loader', () => {
  const context = { window: {}, Intl, Date, TextEncoder };
  vm.runInNewContext(fs.readFileSync(enginePath, 'utf8'), context);
  assert.equal(typeof context.window.StudyEngine.cloze, 'function');
  assert.equal(context.window.StudyEngine.normalize('Hello, World!'), 'hello world');
});

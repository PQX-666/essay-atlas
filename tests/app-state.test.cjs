'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const dist = path.join(__dirname, '../dist');

// Expose private state only in a VM copy; the distributable script stays untouched.
function app(raw) {
  const elements = new Map();
  function element() {
    return {
      innerHTML: '', textContent: '', open: false, dataset: {},
      classList: { add() {}, remove() {} },
      querySelectorAll() { return []; }, querySelector() { return element(); },
      setAttribute() {}, removeAttribute() {}, addEventListener() {},
      showModal() { this.open = true; }, close() { this.open = false; },
      scrollIntoView() {}, focus() {}, click() {}, getBoundingClientRect() { return { left: 0 }; }
    };
  }
  const storage = new Map(raw ? [['essay-atlas:learning:v1', JSON.stringify(raw)]] : []);
  let now = '2026-10-20T02:00:00Z';
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return new Date(now).getTime(); }
  }
  const context = vm.createContext({
    window: { addEventListener() {}, scrollTo() {}, crypto: { randomUUID: () => 'test-attempt' } },
    document: {
      getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
      querySelectorAll() { return []; }, addEventListener() {}, createElement: element
    },
    location: { hash: '' }, history: { replaceState() {} },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    Intl, Date: FixedDate, TextEncoder, URL, Blob,
    setTimeout() { return 1; }, clearTimeout() {}
  });
  ['study-engine.js', 'data.js', 'transfer-data.js'].forEach(file => vm.runInContext(fs.readFileSync(path.join(dist, file), 'utf8'), context));
  const code = fs.readFileSync(path.join(dist, 'app.js'), 'utf8');
  const end = '  navigate(location.hash.slice(1));\n})();';
  assert.ok(code.includes(end), 'App boot signature changed; update VM harness');
  const instrumented = code.replace(end, `
    window.__APP_TEST__ = {
      getDb:()=>db, setDb:v=>db=v,
      getRecall:()=>recall, setRecall:v=>recall=v,
      getTransfer:()=>transfer, setTransfer:v=>transfer=v,
      articles,tasks,loadDatabase,startRecall,chooseTransfer,
      recallItems,freezeRecall,recallEligibility,markReference,persistRecall,persistTransfer,
      transferEligibility,recordAttempt,validDraft,openSettings,
      renderRecall,renderTransfer,importBackup,submitTransfer
    };
  })();`);
  vm.runInContext(instrumented, context);
  context.A = context.window.__APP_TEST__;
  return { run: source => vm.runInContext(source, context), api: context.A, setNow: value => { now = value; } };
}

function backup() { return { version: 1, records: {}, drafts: {}, settings: { dailyLimit: 12 }, history: [], bookmarks: [] }; }

test('first recall response is frozen before hints and survives later edits', () => {
  const a = app();
  a.run(`A.startRecall(A.articles[0].id,'cloze',true,false);
    A.getRecall().answers.one='first answer'; A.freezeRecall();
    A.getRecall().answers.one='corrected answer'; A.freezeRecall();`);
  assert.equal(a.api.getRecall().firstAnswers.one, 'first answer');
});

test('same-day repeat cannot lengthen independent spacing', () => {
  const a = app();
  a.run(`A.recordAttempt('recall:cet4-01:cloze',{type:'recall',articleId:'cet4-01',mode:'cloze',attemptId:'one'},'independent');
    A.recordAttempt('recall:cet4-01:cloze',{type:'recall',articleId:'cet4-01',mode:'cloze',attemptId:'two'},'independent');`);
  assert.equal(a.api.getDb().records['recall:cet4-01:cloze'].intervalDays, 1);
  assert.equal(a.api.getDb().records['recall:cet4-01:cloze'].streak, 1);
});

test('restoring structurally damaged learning state cannot crash settings or recall', () => {
  const b = backup();
  b.history = [{}];
  b.drafts['recall:cet4-01:cloze'] = { articleId: 'cet4-01', mode: 'cloze', answers: null, variant: 0 };
  const a = app(b);
  assert.doesNotThrow(() => a.api.openSettings());
  assert.doesNotThrow(() => {
    a.api.startRecall('cet4-01', 'cloze', false, false);
    a.api.renderRecall();
  });
});

test('import draft validator rejects missing nested objects and invalid rotation', () => {
  const a = app();
  assert.equal(a.run(`A.validDraft('recall:cet4-01:cloze', {articleId:'cet4-01',mode:'cloze',answers:{},variant:0.5})`), false);
  assert.equal(a.run(`A.validDraft('recall:cet4-01:cloze', {articleId:'cet4-01',mode:'cloze',answers:{},variant:1000001})`), false);
  assert.equal(a.run(`A.validDraft('transfer:'+A.tasks[0].id, {taskId:A.tasks[0].id,text:'draft',outline:''})`), false);
});

test('viewing a transfer source in the image library removes independent eligibility', () => {
  const a = app();
  a.run(`A.chooseTransfer(A.tasks[0].id,true,false);
    A.getTransfer().text='This is my own preliminary response.';
    A.markReference(A.tasks[0].sourceIds[0]);`);
  assert.equal(a.api.getTransfer().helpUsed, true);
  assert.equal(a.api.getTransfer().firstDraft.text, 'This is my own preliminary response.');
});

test('a duplicate persisted attempt cannot be recorded again after reload or next day', () => {
  const a = app();
  const code = `A.recordAttempt('recall:cet4-01:cloze',{type:'recall',articleId:'cet4-01',mode:'cloze',attemptId:'same-attempt'},'independent');`;
  a.run(code);
  a.setNow('2026-10-21T02:00:00Z');
  a.run(code);
  assert.equal(a.api.getDb().history.length, 1);
  assert.equal(a.api.getDb().records['recall:cet4-01:cloze'].intervalDays, 1);
});

test('a final transfer draft must still meet observable constraints before independent completion', () => {
  const a = app();
  a.run(`A.chooseTransfer(A.tasks[0].id,true,false);
    A.getTransfer().text=Array.from({length:A.tasks[0].minWords},()=> 'word').join(' ');
    A.getTransfer().firstDraft={text:A.getTransfer().text,outline:''};
    A.getTransfer().text='One word.';
    A.getTransfer().checks=Object.fromEntries(A.tasks[0].rubric.map(r=>[r.id,true]));`);
  assert.equal(a.run('A.transferEligibility(A.tasks[0]).independent'), false);
});

test('editing a structure response after seeing the answer cannot become independent completion', () => {
  const a = app();
  a.run(`A.startRecall(A.articles[0].id,'structure',true,false);
    const r=A.getRecall(); const items=A.recallItems();
    r.answers=Object.fromEntries(items.map(x=>[x.key,'unsure'])); A.freezeRecall(); r.checked=true;
    r.answers=Object.fromEntries(items.map(x=>[x.key,x.expected])); r.selfChecks={logic:true,support:true};`);
  assert.equal(a.run('A.recallEligibility(A.recallItems()).independent'), false);
});

test('failed backup merge is atomic and cannot partially change records', async () => {
  const a = app();
  const incoming = backup();
  const detail = { type: 'recall', articleId: 'cet4-01', mode: 'cloze', key: 'recall:cet4-01:cloze' };
  incoming.records[detail.key] = { ...detail, dueAt: '2026-10-21', intervalDays: 1, streak: 1, lastOutcome: 'independent', reviewedAt: '2026-10-20T02:00:00Z' };
  // Date.parse accepts numeric years, but numeric values have no localeCompare.
  incoming.history = [{ ...detail, at: 2026, attemptId: 'incoming-1' }, { ...detail, at: 2027, attemptId: 'incoming-2' }];
  const before = JSON.stringify(a.api.getDb());
  await a.run(`A.importBackup({target:{files:[{size:1000,text:async()=>${JSON.stringify(JSON.stringify(incoming))}}]}})`);
  const after = a.api.getDb();
  const rejected = a.run("document.getElementById('toast').textContent.includes('格式无效')");
  if (rejected) assert.equal(JSON.stringify(after), before, 'Failed import partially changed records before rejecting malformed history');
  else assert.ok(after.history.every(r => typeof r.at === 'string'), 'Accepted history must contain valid timestamp strings');
});

test('backup merge keeps the newer edit of an existing attempt', async () => {
  const seed = app();
  seed.run('A.chooseTransfer(A.tasks[0].id,true,false)');
  const draft = JSON.parse(JSON.stringify(seed.api.getTransfer()));
  draft.text = 'An older draft.';
  draft.updatedAt = '2026-10-20T02:00:00Z';
  const current = backup();
  const key = 'transfer:' + draft.taskId;
  current.drafts[key] = draft;
  const incoming = JSON.parse(JSON.stringify(current));
  incoming.drafts[key].text = 'The newer and more complete draft.';
  incoming.drafts[key].updatedAt = '2026-10-21T02:00:00Z';
  const a = app(current);
  await a.run(`A.importBackup({target:{files:[{size:1000,text:async()=>${JSON.stringify(JSON.stringify(incoming))}}]}})`);
  assert.equal(a.api.getDb().drafts[key].text, 'The newer and more complete draft.');
});

test('the app restores its own completed recall record and draft after serialization', () => {
  const initial = app();
  initial.run(`A.startRecall(A.articles[0].id,'cloze',true,false);
    const r=A.getRecall();
    r.answers=Object.fromEntries(A.recallItems().map(item=>[item.key,item.expected]));
    A.freezeRecall(); r.checked=true;
    A.recordAttempt('recall:'+r.articleId+':'+r.mode,{
      type:'recall',articleId:r.articleId,mode:r.mode,variant:r.variant,
      attemptId:r.attemptId,firstAccuracy:1,helpUsed:false,selfRated:false
    },'independent');
    r.recorded=true; A.persistRecall();`);
  const saved = JSON.parse(JSON.stringify(initial.api.getDb()));
  assert.equal(Object.keys(saved.records).length, 1);
  assert.equal(Object.keys(saved.drafts).length, 1);
  assert.equal(initial.run('window.StudyEngine.validateBackup(JSON.parse(JSON.stringify(A.getDb()))).valid'), true, 'Engine accepts normal app state');
  const restored = app(saved);
  assert.equal(Object.keys(restored.api.getDb().records).length, 1, 'A normal completed record must survive initial load');
  assert.equal(Object.keys(restored.api.getDb().drafts).length, 1, 'A normal draft must survive initial load');
  assert.equal(restored.api.getDb().history.length, 1);
  restored.run("A.startRecall('cet4-01','cloze',false,false)");
  assert.equal(restored.api.getRecall().recorded, true);
  assert.equal(Object.keys(restored.api.getRecall().firstAnswers).length, 4);
});

test('due cloze prioritizes the exact previously missed phrase ahead of rotating questions', () => {
  const a = app();
  a.run(`const source=A.articles[0];
    const index=source.sentences.length-1;
    const answer=source.sentences[index].targets.at(-1);
    A.getDb().records['recall:'+source.id+':cloze']={weakItems:[
      {sentenceIndex:index,answer}, {sentenceIndex:index,answer}
    ]};
    A.startRecall(source.id,'cloze',true,false,true);`);
  const items = a.api.recallItems();
  const source = a.api.articles[0];
  const index = source.sentences.length - 1;
  const answer = source.sentences[index].targets.at(-1);
  assert.equal(items[0].sentenceIndex, index);
  assert.equal(items[0].answer, answer, 'Restore the missed target, not another target from its sentence');
  assert.equal(items[0].before + items[0].answer + items[0].after, source.sentences[index].en);
  assert.equal(items.length, 4);
  assert.equal(new Set(items.map(item => item.sentenceIndex)).size, 4, 'Repeated weak records must not duplicate a sentence');
  assert.equal(a.api.getRecall().maxHint, 0);
  assert.equal(a.api.getRecall().firstAnswers, null, 'A due test starts without carried-over answers');
});

test('malformed or stale weak items fall back to valid cloze without crashing the interface', () => {
  const a = app();
  const values = [
    null, 'outdated format', { sentenceIndex: 0, answer: 'not an array' },
    [null, { sentenceIndex: -1, answer: 'out of bounds' }, { sentenceIndex: 9999, answer: 'expired' }, { sentenceIndex: 0, answer: 'not a real target <script>' }],
    [{ sentenceIndex: 0.5, answer: 'fractional index' }, { sentenceIndex: '0', answer: 'string index' }, { sentenceIndex: 0, answer: {} }, 'damaged item']
  ];
  for (const weakItems of values) {
    a.run(`A.getDb().records['recall:'+A.articles[0].id+':cloze']={weakItems:${JSON.stringify(weakItems)}};
      A.startRecall(A.articles[0].id,'cloze',true,false,true);`);
    assert.doesNotThrow(() => a.api.renderRecall());
    const items = a.api.recallItems();
    assert.equal(items.length, 4);
    for (const item of items) {
      const sentence = a.api.articles[0].sentences[item.sentenceIndex];
      assert.ok(sentence.targets.includes(item.answer));
      assert.equal(item.before + item.answer + item.after, sentence.en);
    }
  }
});

(function () {
  'use strict';
  const E = window.StudyEngine;
  const articles = window.ESSAY_DATA.articles;
  const tasks = window.TRANSFER_TASKS;
  const articleById = new Map(articles.map(a => [a.id, a]));
  const taskById = new Map(tasks.map(t => [t.id, t]));
  const images = articles.flatMap(a => a.images.map(i => ({ ...i, article: a })));
  const imageById = new Map(images.map(i => [i.id, i]));
  const STORAGE_KEY = 'essay-atlas:learning:v1';
  const MODES = { cloze: '词块', sentence: '句子', structure: '空白导图', paragraph: '段落', essay: '整篇' };
  const OUTCOMES = { independent: '独立完成', assisted: '借助提示完成', again: '仍需复习' };
  const main = document.getElementById('main');
  const viewer = document.getElementById('viewer');
  const utility = document.getElementById('utility');
  let storageAvailable = true, saveTimer, toastTimer;
  let db = loadDatabase();
  let screen = 'library';
  let galleryFilter = { level: '', kind: '', query: '', bookmarked: false };
  let transferFilter = { level: '', difficulty: 'near', mode: 'paragraph' };
  let recall = null, transfer = null, transferTab = 'text';
  let viewerImage = null, viewerZoom = false;

  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  const levelName = level => level === 'CET6' ? '六级' : '四级';
  const dateNow = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const isoNow = () => new Date().toISOString();
  const uuid = () => window.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2);
  const icon = (name) => {
    const paths = {
      bookmark: '<path d="M6 3h12v18l-6-4-6 4z"/>',
      search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
      close: '<path d="m6 6 12 12M6 18 18 6"/>',
      next: '<path d="m9 5 7 7-7 7"/>',
      previous: '<path d="m15 5-7 7 7 7"/>',
      refresh: '<path d="M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 3M18 18A8 8 0 0 1 5 15"/>',
      expand: '<path d="M9 3H3v6M15 3h6v6M21 15v6h-6M9 21H3v-6"/>',
      arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>'
    };
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.next}</svg>`;
  };
  function defaultDatabase() { return { version: 1, records: {}, drafts: {}, settings: { dailyLimit: 12 }, history: [], bookmarks: [] }; }
  function validTimestamp(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)); }
  function textMap(value, limit = 12000) { return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length <= 100 && Object.values(value).every(v => typeof v === 'string' && v.length <= limit); }
  function checkMap(value) { return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length <= 20 && Object.values(value).every(v => typeof v === 'boolean'); }
  function sanitizeDatabase(input) {
    const next = defaultDatabase();
    for (const [key, r] of Object.entries(input.records || {})) {
      if (!validRecord(key, r) || !Object.hasOwn(OUTCOMES, r.lastOutcome) || !Number.isInteger(r.intervalDays) || r.intervalDays < 1 || !Number.isInteger(r.streak) || r.streak < 0 || typeof r.dueAt !== 'string') continue;
      try { E.isDue(r, '2026-01-01'); } catch { continue; }
      next.records[key] = clone(r);
    }
    for (const [key, draft] of Object.entries(input.drafts || {})) if (validDraft(key, draft)) next.drafts[key] = clone(draft);
    next.history = (input.history || []).filter(r => validRecord(r.key, r) && validTimestamp(r.at) && Object.hasOwn(OUTCOMES, r.outcome)).slice(0, 500).map(clone);
    next.bookmarks = [...new Set((input.bookmarks || []).filter(id => imageById.has(id)))];
    next.settings.dailyLimit = Math.min(30, Math.max(3, Number(input.settings?.dailyLimit) || 12));
    return next;
  }
  function loadDatabase() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultDatabase();
      const checked = E.validateBackup(JSON.parse(raw));
      if (checked.valid) return sanitizeDatabase(checked.data);
      storageAvailable = false;
      return defaultDatabase();
    } catch { storageAvailable = false; return defaultDatabase(); }
  }
  function save(immediate = false) {
    clearTimeout(saveTimer);
    const write = () => {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(db)); storageAvailable = true; }
      catch { if (storageAvailable) toast('当前浏览器无法保存，请到设置中导出备份。'); storageAvailable = false; }
    };
    if (immediate) write(); else saveTimer = setTimeout(write, 180);
  }
  function toast(message) {
    const box = document.getElementById('toast');
    box.textContent = message; box.classList.add('visible');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => box.classList.remove('visible'), 4000);
  }
  function dueRecords() {
    return Object.entries(db.records).filter(([, r]) => {
      try { return E.isDue(r, dateNow()); } catch { return false; }
    }).sort((a, b) => a[1].dueAt.localeCompare(b[1].dueAt) || (a[1].lastOutcome === 'again' ? -1 : 1));
  }
  function recordAttempt(key, detail, outcome) {
    const previous = db.records[key];
    if (detail.attemptId && (previous?.attemptId === detail.attemptId || db.history.some(r => r.attemptId === detail.attemptId && r.key === key))) return previous;
    let scheduled = E.schedule(previous, outcome, dateNow());
    // Repeating a task on the same day is practice, not an extra delayed success.
    if (previous?.lastReviewedDay === dateNow() && outcome === 'independent' && previous.lastOutcome === 'independent') {
      scheduled = { intervalDays: previous.intervalDays, dueAt: previous.dueAt, streak: previous.streak, lastOutcome: outcome };
    }
    db.records[key] = { ...previous, ...scheduled, ...detail, lastReviewedDay: dateNow(), reviewedAt: isoNow() };
    db.history.unshift({ ...detail, key, outcome, at: isoNow() });
    db.history = db.history.slice(0, 500);
    save(true);
    return db.records[key];
  }
  function navigate(next) {
    screen = ['library', 'recall', 'transfer'].includes(next) ? next : 'library';
    if (location.hash !== '#' + screen) history.replaceState(null, '', '#' + screen);
    if (screen === 'recall' && !recall) startRecall(articles[0].id, 'cloze', false, false);
    if (screen === 'transfer' && !transfer) chooseTransfer(null, false, false);
    render();
    window.scrollTo(0, 0);
  }
  function render() {
    document.querySelectorAll('[data-nav]').forEach(a => {
      if (a.dataset.nav === screen) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    document.title = ({ library: '图像库', recall: '回忆训练', transfer: '迁移训练' }[screen]) + ' · 作文集';
    if (screen === 'library') renderLibrary();
    if (screen === 'recall') renderRecall();
    if (screen === 'transfer') renderTransfer();
  }

  // Image archive: image content, rather than page chrome, carries the color.
  function renderLibrary() {
    main.innerHTML = `<div class="page-heading"><div class="title-row"><h1>图像库</h1><span class="count" id="gallery-count"></span></div></div>
      <div class="toolbar"><div class="tabs" aria-label="级别筛选">${[['', '全部'], ['CET4', '四级'], ['CET6', '六级']].map(([v, label]) => `<button class="tab" data-level="${v}" aria-pressed="${galleryFilter.level === v}">${label}</button>`).join('')}</div>
      <span class="toolbar-divider" aria-hidden="true"></span><select class="flat-select" id="kind-filter" aria-label="图片类型"><option value="">全部类型</option>${['逐句拆解', '结构解析', '记忆导图', '主题迁移'].map(v => `<option ${galleryFilter.kind === v ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <button class="bookmark-button" id="bookmark-filter" aria-label="只看收藏" title="只看收藏" aria-pressed="${galleryFilter.bookmarked}">${icon('bookmark')}</button>
      <label class="search">${icon('search')}<input id="gallery-search" type="search" placeholder="搜索篇目" aria-label="搜索篇目" value="${esc(galleryFilter.query)}" maxlength="100"></label></div><div class="gallery" id="gallery-grid"></div>`;
    main.querySelectorAll('[data-level]').forEach(b => b.onclick = () => { galleryFilter.level = b.dataset.level; renderLibrary(); });
    document.getElementById('kind-filter').onchange = e => { galleryFilter.kind = e.target.value; renderGalleryResults(); };
    document.getElementById('gallery-search').oninput = e => { galleryFilter.query = e.target.value; renderGalleryResults(); };
    document.getElementById('bookmark-filter').onclick = e => { galleryFilter.bookmarked = !galleryFilter.bookmarked; e.currentTarget.setAttribute('aria-pressed', galleryFilter.bookmarked); renderGalleryResults(); };
    renderGalleryResults();
  }
  function filteredImages() {
    const query = galleryFilter.query.trim().toLowerCase();
    return images.filter(i => (!galleryFilter.level || i.article.level === galleryFilter.level) && (!galleryFilter.kind || i.kind === galleryFilter.kind) && (!galleryFilter.bookmarked || db.bookmarks.includes(i.id)) && (!query || (i.article.title + ' ' + i.article.titleEn + ' ' + i.kind).toLowerCase().includes(query))).sort((a, b) => {
      const kinds = ['记忆导图', '结构解析', '逐句拆解', '主题迁移'];
      return kinds.indexOf(a.kind) - kinds.indexOf(b.kind) || a.article.id.localeCompare(b.article.id);
    });
  }
  function renderGalleryResults() {
    const list = filteredImages();
    document.getElementById('gallery-count').textContent = list.length + ' 张';
    document.getElementById('gallery-grid').innerHTML = list.length ? list.map((i, n) => `<article class="image-card"><button class="poster-button" data-image="${i.id}" aria-label="查看${esc(i.article.title)}：${i.kind}"><img src="${i.thumb}" width="${i.width}" height="${i.height}" alt="${esc(i.article.title)} · ${i.kind}" loading="${n < 4 ? 'eager' : 'lazy'}" decoding="async"></button><div class="card-caption"><div><h2 class="card-title">${esc(i.article.title)}</h2><p class="card-meta">${levelName(i.article.level)} · ${i.kind}</p></div><button class="bookmark-button" data-bookmark="${i.id}" aria-pressed="${db.bookmarks.includes(i.id)}" aria-label="收藏${esc(i.article.title)}${i.kind}">${icon('bookmark')}</button></div></article>`).join('') : `<div class="empty-state">${galleryFilter.bookmarked ? '还没有符合条件的收藏。' : '没有找到图片。'}<br><button class="text-button" id="clear-filters">清除筛选</button></div>`;
    main.querySelectorAll('[data-image]').forEach(b => b.onclick = () => openImage(b.dataset.image));
    main.querySelectorAll('[data-bookmark]').forEach(b => b.onclick = () => {
      const id = b.dataset.bookmark;
      db.bookmarks = db.bookmarks.includes(id) ? db.bookmarks.filter(x => x !== id) : [...db.bookmarks, id];
      save();
      if (galleryFilter.bookmarked) renderGalleryResults(); else b.setAttribute('aria-pressed', db.bookmarks.includes(id));
    });
    const clear = document.getElementById('clear-filters');
    if (clear) clear.onclick = () => { galleryFilter = { level: '', kind: '', query: '', bookmarked: false }; renderLibrary(); };
  }
  function freezeRecall() {
    if (!recall) return;
    if (!recall.firstAnswers) recall.firstAnswers = clone(recall.answers);
  }
  function markReference(articleId) {
    if (recall && !recall.recorded && recall.articleId === articleId) { freezeRecall(); recall.helpUsed = true; persistRecall(); }
    if (transfer && !transfer.recorded) {
      const task = taskById.get(transfer.taskId);
      if (task && (task.difficulty === 'independent' || task.sourceIds.includes(articleId))) {
        if (!transfer.firstDraft) transfer.firstDraft = { text: transfer.text, outline: transfer.outline };
        transfer.helpUsed = true; persistTransfer();
      }
    }
  }
  function openImage(id) {
    const image = imageById.get(id); if (!image) return;
    markReference(image.article.id);
    viewerImage = image; viewerZoom = false; renderViewer();
    if (!viewer.open) viewer.showModal();
  }
  function renderViewer() {
    const i = viewerImage, a = i.article;
    viewer.innerHTML = `<div class="viewer-header"><h2 class="viewer-title">${esc(a.title)}<span>${levelName(a.level)}</span></h2><div class="viewer-actions"><button class="icon-button" id="previous-image" aria-label="上一张">${icon('previous')}</button><button class="icon-button" id="next-image" aria-label="下一张">${icon('next')}</button><button class="icon-button" id="zoom-image" aria-label="${viewerZoom ? '适应窗口' : '放大阅读'}" title="${viewerZoom ? '适应窗口' : '放大阅读'}">${icon('expand')}</button><button class="button small-button" id="image-to-recall">开始回忆</button><button class="icon-button" id="close-viewer" aria-label="关闭导图">${icon('close')}</button></div></div><div class="viewer-types">${a.images.map(x => `<button data-view-kind="${x.id}" aria-pressed="${i.id === x.id}">${x.kind}</button>`).join('')}</div><div class="viewer-canvas ${viewerZoom ? 'zoomed' : ''}"><img src="${i.src}" width="${i.width}" height="${i.height}" alt="${esc(a.title)} · ${i.kind}"></div>`;
    viewer.querySelectorAll('[data-view-kind]').forEach(b => b.onclick = () => { viewerImage = imageById.get(b.dataset.viewKind); renderViewer(); });
    document.getElementById('close-viewer').onclick = () => viewer.close();
    document.getElementById('zoom-image').onclick = () => { viewerZoom = !viewerZoom; renderViewer(); };
    document.getElementById('previous-image').onclick = () => moveImage(-1);
    document.getElementById('next-image').onclick = () => moveImage(1);
    document.getElementById('image-to-recall').onclick = () => { viewer.close(); startRecall(a.id, 'cloze', true); navigate('recall'); };
  }
  function moveImage(step) {
    let list = filteredImages(); if (!list.some(x => x.id === viewerImage.id)) list = images;
    viewerImage = list[(list.findIndex(x => x.id === viewerImage.id) + step + list.length) % list.length];
    markReference(viewerImage.article.id); renderViewer();
  }

  // Recall practice: drafts, first responses and assistance are saved separately.
  function recallKey(a = recall) { return 'recall:' + a.articleId + ':' + a.mode; }
  function startRecall(articleId, mode = 'cloze', fresh = false, draw = true, prioritizeWeak = false) {
    if (!articleById.has(articleId)) articleId = articles[0].id;
    if (!Object.hasOwn(MODES, mode)) mode = 'cloze';
    const key = 'recall:' + articleId + ':' + mode;
    const old = db.drafts[key];
    if (!fresh && validDraft(key, old)) {
      recall = clone(old);
      if (db.records[key]?.attemptId === recall.attemptId) recall.recorded = true;
      if (recall.recorded && db.records[key] && E.isDue(db.records[key], dateNow())) fresh = true;
    } else fresh = true;
    if (fresh) {
      const variant = Math.max(0, Number(old?.variant ?? db.records[key]?.variant ?? -1) + 1);
      recall = { articleId, mode, variant, answers: {}, firstAnswers: null, maxHint: 0, helpUsed: false, checked: false, recorded: false, selfChecks: {}, priorityItems: prioritizeWeak ? clone(db.records[key]?.weakItems || []) : [], attemptId: uuid(), createdAt: isoNow() };
      persistRecall();
    }
    if (draw && screen === 'recall') renderRecall();
  }
  function persistRecall() { if (recall) { recall.updatedAt = isoNow(); db.drafts[recallKey()] = clone(recall); save(); } }
  function recallItems() {
    const a = articleById.get(recall.articleId);
    if (recall.mode === 'cloze') {
      const priority = (Array.isArray(recall.priorityItems) ? recall.priorityItems : []).slice(0, 4).flatMap(x => {
        if (!x || !Number.isInteger(x.sentenceIndex) || typeof x.answer !== 'string') return [];
        const s = a.sentences[x.sentenceIndex];
        if (!s || !s.targets.includes(x.answer)) return [];
        const at = s.en.indexOf(x.answer);
        return [{ id: a.id + ':s' + x.sentenceIndex + ':t' + s.targets.indexOf(x.answer), sentenceIndex: x.sentenceIndex, before: s.en.slice(0, at), answer: x.answer, after: s.en.slice(at + x.answer.length), zh: s.zh, section: s.section }];
      });
      const seen = new Set();
      return [...priority, ...E.cloze(a, recall.variant, 4)].filter(x => { if (seen.has(x.sentenceIndex)) return false; seen.add(x.sentenceIndex); return true; }).slice(0, 4).map(x => ({ ...x, key: x.id, expected: x.answer }));
    }
    if (recall.mode === 'sentence') {
      const eligible = a.sentences.map((s, index) => ({ s, index })).filter(x => E.countWords(x.s.en) >= 6);
      return [0, 1].slice(0, eligible.length).map((_, n) => {
        const x = eligible[(recall.variant * 2 + n) % eligible.length];
        return { key: 'sentence-' + x.index, expected: x.s.en, zh: x.s.zh, section: x.s.section };
      });
    }
    if (recall.mode === 'structure') return a.structure.map((s, i) => ({ key: 'node-' + i, expected: s.label + '：' + s.summary, zh: s.summary, keywords: s.keywords }));
    if (recall.mode === 'paragraph') {
      const eligible = a.paragraphs.map((p, i) => ({ ...p, index: i })).filter(p => E.countWords(p.en) >= 15);
      const p = eligible[recall.variant % eligible.length];
      return [{ key: 'paragraph-' + p.index, expected: p.en, zh: p.zh, paragraphIndex: p.index }];
    }
    return [{ key: 'essay', expected: a.paragraphs.map(p => p.en).join('\n\n'), zh: a.structure.map(s => s.summary).join(' → ') }];
  }
  function renderRecall() {
    const a = articleById.get(recall.articleId), items = recallItems(), due = dueRecords();
    const completed = items.filter(x => String(recall.answers[x.key] || '').trim()).length;
    main.innerHTML = `<section class="practice-page"><div class="practice-heading"><select class="article-select" id="recall-article" aria-label="选择回忆篇目">${articles.map(x => `<option value="${x.id}" ${a.id === x.id ? 'selected' : ''}>${esc(x.title)} · ${levelName(x.level)}</option>`).join('')}</select><div class="practice-tools"><select id="recall-mode" aria-label="训练方式">${Object.entries(MODES).map(([v, label]) => `<option value="${v}" ${recall.mode === v ? 'selected' : ''}>${label}</option>`).join('')}</select></div></div>
      <div class="practice-subbar"><button class="text-button" id="start-due">${due.length ? '到期复习 ' + due.length : '今日暂无到期复习'}</button><button class="text-button" id="next-group">${recall.recorded ? '继续下一组' : '换一组'}</button></div>
      <form id="recall-form"><div class="practice-body">${recallBody(items)}</div>${renderHint(items)}<div class="practice-footer"><span class="counter" id="recall-counter">${recall.mode === 'essay' || recall.mode === 'paragraph' ? E.countWords(recall.answers[items[0].key] || '') + ' 词' : completed + ' / ' + items.length}</span><div class="button-row"><button type="button" class="button" id="hint-button" ${recall.recorded || recall.maxHint >= 3 ? 'disabled' : ''}>${recall.maxHint ? '更多提示' : '提示'}</button><button type="submit" class="button primary" ${recall.recorded ? 'disabled' : ''}>${recall.checked ? '重新检查' : '检查答案'}</button></div></div></form><div id="recall-feedback">${recall.checked ? recallFeedback(items) : ''}</div></section>`;
    document.getElementById('recall-article').onchange = e => startRecall(e.target.value, recall.mode);
    document.getElementById('recall-mode').onchange = e => startRecall(recall.articleId, e.target.value);
    document.getElementById('start-due').onclick = () => { if (due.length) startDue(due[0][0]); else toast('可以选择篇目开始新练习。'); };
    document.getElementById('next-group').onclick = () => {
      if (!recall.recorded && Object.values(recall.answers).some(v => String(v).trim())) {
        showQuestion('开始新一组？', '当前作答会被新练习替换。', () => startRecall(a.id, recall.mode, true));
      } else startRecall(a.id, recall.mode, true);
    };
    main.querySelectorAll('[data-answer]').forEach(input => input.oninput = () => {
      recall.answers[input.dataset.answer] = input.value;
      recall.selfChecks = {};
      persistRecall();
      const counter = document.getElementById('recall-counter');
      counter.textContent = recall.mode === 'essay' || recall.mode === 'paragraph' ? E.countWords(input.value) + ' 词' : items.filter(x => String(recall.answers[x.key] || '').trim()).length + ' / ' + items.length;
      if (recall.checked) {
        document.getElementById('recall-feedback').innerHTML = recallFeedback(items);
        bindRecallFeedback();
      }
    });
    document.getElementById('hint-button').onclick = () => { freezeRecall(); recall.helpUsed = true; recall.maxHint++; persistRecall(); renderRecall(); };
    document.getElementById('recall-form').onsubmit = e => { e.preventDefault(); checkRecall(); };
    bindRecallFeedback();
  }
  function recallBody(items) {
    if (recall.mode === 'cloze') return items.map((x, i) => `<div class="cloze-item"><span class="item-number">${String(i + 1).padStart(2, '0')}</span><label class="cloze-sentence">${esc(x.before)}<input data-answer="${esc(x.key)}" aria-label="第${i + 1}空" type="text" value="${esc(recall.answers[x.key] || '')}" style="width:${Math.min(440, Math.max(180, x.answer.length * 10))}px" maxlength="300" spellcheck="false" autocomplete="off" autocapitalize="off" ${recall.recorded ? 'readonly' : ''}>${esc(x.after)}</label></div>`).join('');
    if (recall.mode === 'sentence') return items.map((x, i) => `<div class="sentence-item"><p class="sentence-prompt"><span class="muted small">${String(i + 1).padStart(2, '0')}　</span>${esc(x.zh)}</p><textarea data-answer="${x.key}" aria-label="第${i + 1}句英文" spellcheck="false" maxlength="2000" ${recall.recorded ? 'readonly' : ''}>${esc(recall.answers[x.key] || '')}</textarea></div>`).join('');
    if (recall.mode === 'structure') return `<div class="structure-map">${items.map((x, i) => `<div class="structure-node"><label for="structure-${i}">${String(i + 1).padStart(2, '0')}</label><textarea id="structure-${i}" data-answer="${x.key}" placeholder="论点、理由或例子" aria-label="第${i + 1}个逻辑块" maxlength="1500" ${recall.recorded ? 'readonly' : ''}>${esc(recall.answers[x.key] || '')}</textarea></div>`).join('')}</div>`;
    return `<div class="writing-surface">${recall.mode === 'paragraph' ? `<p class="muted small">第 ${items[0].paragraphIndex + 1} 段</p>` : ''}<textarea class="writing-textarea" data-answer="${items[0].key}" aria-label="${MODES[recall.mode]}英文默写" spellcheck="false" maxlength="10000" ${recall.recorded ? 'readonly' : ''}>${esc(recall.answers[items[0].key] || '')}</textarea></div>`;
  }
  function renderHint(items) {
    if (!recall.maxHint) return '';
    let text;
    if (recall.maxHint === 1) text = items.map((x, i) => (i + 1) + '. ' + (recall.mode === 'structure' ? articleById.get(recall.articleId).structure[i].label : x.zh || x.section)).join('\n');
    else if (recall.maxHint === 2) text = items.map((x, i) => (i + 1) + '. ' + (recall.mode === 'structure' ? x.keywords.join(' / ') : x.expected.split(/\s+/).slice(0, 2).join(' ') + ' …')).join('\n');
    else text = items.map((x, i) => (i + 1) + '. ' + x.expected).join('\n\n');
    return `<aside class="hint-panel" aria-label="提示">${esc(text)}</aside>`;
  }
  function checkRecall() {
    const items = recallItems();
    if (!items.some(x => String(recall.answers[x.key] || '').trim())) { toast('先尝试写出你记得的内容。'); return; }
    freezeRecall(); recall.checked = true; persistRecall(); renderRecall();
    document.getElementById('recall-feedback').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function compareItems(items, answers) { return items.map(x => ({ ...x, comparison: E.compare(String(answers?.[x.key] || ''), x.expected) })); }
  function recallEligibility(items) {
    const filled = answers => items.every(x => String(answers?.[x.key] || '').trim());
    const selfChecked = recall.selfChecks.logic && recall.selfChecks.support;
    if (recall.mode === 'structure') return { independent: !recall.helpUsed && filled(recall.firstAnswers) && selfChecked && items.every(x => String(recall.firstAnswers[x.key]) === String(recall.answers[x.key])), assisted: filled(recall.answers) && selfChecked };
    return { independent: !recall.helpUsed && compareItems(items, recall.firstAnswers).every(x => x.comparison.correct), assisted: compareItems(items, recall.answers).every(x => x.comparison.correct) };
  }
  function recallFeedback(items) {
    const structural = recall.mode === 'structure';
    const results = structural ? [] : compareItems(items, recall.answers);
    const firstResults = structural ? [] : compareItems(items, recall.firstAnswers);
    const correct = results.filter(x => x.comparison.correct).length;
    const eligible = recallEligibility(items);
    const firstLabel = structural ? '对照结构' : '首答 ' + firstResults.filter(x => x.comparison.correct).length + ' / ' + items.length;
    return `<section class="review-panel" aria-label="回忆反馈"><div class="review-heading"><h2>${structural ? '核对逻辑' : '对照原文'}</h2><span class="small muted">${firstLabel}${recall.helpUsed ? ' · 使用过提示' : ''}</span></div>
      ${structural ? `<p class="feedback-note">比较论点与支持关系。合理的不同表述可以保留，由你自评。</p>${items.map((x, i) => `<div class="review-item"><p class="small muted">${i + 1}</p><p>${esc(recall.answers[x.key] || '（未填写）')}</p><p class="muted">参考：${esc(x.expected)}</p></div>`).join('')}<label class="check-row"><input type="checkbox" data-recall-check="logic" ${recall.selfChecks.logic ? 'checked' : ''} ${recall.recorded ? 'disabled' : ''}>主要论点齐全，顺序合理</label><label class="check-row"><input type="checkbox" data-recall-check="support" ${recall.selfChecks.support ? 'checked' : ''} ${recall.recorded ? 'disabled' : ''}>能解释理由或举例如何支持论点</label>` : `<p class="feedback-note">当前 ${correct} / ${items.length} 与原文一致。忽略大小写与标点；蓝色为遗漏，划线为多写。</p>${results.map((x, i) => `<div class="review-item"><p class="small muted">${i + 1}　${x.comparison.correct ? '一致' : '需要订正'}</p><div class="diff">${x.comparison.tokens.map(t => `<span class="diff-${t.type}">${esc(t.text)}</span>`).join(' ')}</div>${!x.comparison.correct ? `<details><summary class="small muted">原文</summary><p class="source">${esc(x.expected)}</p></details>` : ''}</div>`).join('')}`}
      ${recall.recorded ? `<p class="recorded">已记录 · 下次 ${esc(db.records[recallKey()]?.dueAt || '')}</p><div class="button-row"><button class="button primary" id="recall-next-due">下一项练习</button><button class="button quiet" id="recall-new-set">再练一组</button></div>` : `<div class="record-actions"><button class="button" data-recall-outcome="again">仍需复习</button><button class="button" data-recall-outcome="assisted" ${eligible.assisted && !eligible.independent ? '' : 'disabled'}>订正后完成</button><button class="button primary" data-recall-outcome="independent" ${eligible.independent ? '' : 'disabled'}>独立完成${structural ? '（自评）' : ''}</button></div>`}</section>`;
  }
  function bindRecallFeedback() {
    main.querySelectorAll('[data-recall-check]').forEach(b => b.onchange = () => {
      recall.selfChecks[b.dataset.recallCheck] = b.checked; persistRecall();
      const eligible = recallEligibility(recallItems());
      const independent = main.querySelector('[data-recall-outcome="independent"]');
      const assisted = main.querySelector('[data-recall-outcome="assisted"]');
      if (independent) independent.disabled = !eligible.independent;
      if (assisted) assisted.disabled = !eligible.assisted || eligible.independent;
    });
    main.querySelectorAll('[data-recall-outcome]').forEach(b => b.onclick = () => {
      if (recall.recorded) return;
      const outcome = b.dataset.recallOutcome, items = recallItems(), eligible = recallEligibility(items);
      if (outcome === 'independent' && !eligible.independent || outcome === 'assisted' && !eligible.assisted) return;
      const accuracy = recall.mode === 'structure' ? null : compareItems(items, recall.firstAnswers).reduce((sum, x) => sum + x.comparison.accuracy, 0) / items.length;
      const weakItems = recall.mode === 'cloze' ? compareItems(items, recall.firstAnswers).filter(x => !x.comparison.correct).map(x => ({ sentenceIndex: x.sentenceIndex, answer: x.answer })) : [];
      recordAttempt(recallKey(), { type: 'recall', articleId: recall.articleId, mode: recall.mode, variant: recall.variant, attemptId: recall.attemptId, firstAccuracy: accuracy, helpUsed: recall.helpUsed, selfRated: recall.mode === 'structure', weakItems }, outcome);
      recall.recorded = true; persistRecall(); renderRecall();
    });
    const next = document.getElementById('recall-next-due'); if (next) next.onclick = startNextPractice;
    const fresh = document.getElementById('recall-new-set'); if (fresh) fresh.onclick = () => startRecall(recall.articleId, recall.mode, true);
  }
  function startDue(key) {
    const record = db.records[key]; if (!record) return;
    if (utility.open) utility.close();
    if (record.type === 'transfer') {
      chooseTransfer(record.taskId, true, false); navigate('transfer');
    } else { startRecall(record.articleId, record.mode, true, false, true); navigate('recall'); }
  }
  function startNextPractice() {
    const due = dueRecords();
    if (due.length) { startDue(due[0][0]); return; }
    const mode = recall?.mode || 'cloze';
    const next = articles.find(a => !db.records['recall:' + a.id + ':' + mode]);
    if (next) startRecall(next.id, mode, true); else toast('到期练习已完成，可以选择其他训练方式。');
  }

  // Transfer: the source and commentary stay behind the learner's first attempt.
  function matchingTasks() { return tasks.filter(t => (!transferFilter.level || transferFilter.level === t.level) && (!transferFilter.difficulty || transferFilter.difficulty === t.difficulty) && (!transferFilter.mode || transferFilter.mode === t.mode)); }
  function transferKey(t = transfer) { return 'transfer:' + t.taskId; }
  function chooseTransfer(id, fresh = false, draw = true) {
    const list = matchingTasks();
    if (!id || !taskById.has(id)) {
      if (!list.length) { transfer = null; if (draw) renderTransfer(); return; }
      const position = transfer ? list.findIndex(t => t.id === transfer.taskId) : -1;
      id = list[(position + 1) % list.length].id;
    }
    const old = db.drafts['transfer:' + id];
    if (!fresh && validDraft('transfer:' + id, old)) {
      transfer = clone(old);
      if (db.records[transferKey()]?.attemptId === transfer.attemptId) transfer.recorded = true;
      if (transfer.recorded && db.records[transferKey()] && E.isDue(db.records[transferKey()], dateNow())) fresh = true;
    } else fresh = true;
    if (fresh) transfer = { taskId: id, text: '', outline: '', firstDraft: null, helpUsed: false, submitted: false, recorded: false, checks: {}, attemptId: uuid(), createdAt: isoNow() };
    transferTab = 'text'; if (fresh) persistTransfer();
    if (draw && screen === 'transfer') renderTransfer();
  }
  function persistTransfer() { if (transfer) { transfer.updatedAt = isoNow(); db.drafts[transferKey()] = clone(transfer); save(); } }
  function renderTransfer() {
    const t = transfer && taskById.get(transfer.taskId);
    main.innerHTML = `<div class="toolbar transfer-toolbar"><select id="transfer-level" aria-label="迁移训练级别">${[['', '全部级别'], ['CET4', '四级'], ['CET6', '六级']].map(([v, label]) => `<option value="${v}" ${transferFilter.level === v ? 'selected' : ''}>${label}</option>`).join('')}</select><select id="transfer-difficulty" aria-label="迁移距离">${[['near', '同题换情境'], ['cross', '跨主题与文体'], ['independent', '自主选材料'], ['', '全部训练']].map(([v, label]) => `<option value="${v}" ${transferFilter.difficulty === v ? 'selected' : ''}>${label}</option>`).join('')}</select><select id="transfer-mode" aria-label="迁移练习长度">${[['paragraph', '论证段'], ['essay', '整篇'], ['', '全部长度']].map(([v, label]) => `<option value="${v}" ${transferFilter.mode === v ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
      ${t ? `<div class="page-heading transfer-heading"><div><h1>${esc(t.title)}</h1><p>自拟练习 · ${levelName(t.level)}</p></div><button class="text-button" id="change-task">${icon('refresh')}换一题</button></div><div class="transfer-layout"><aside class="task-panel"><h2>题目</h2><p class="task-prompt">${esc(t.prompt)}</p><p class="task-meta">${t.minWords}–${t.maxWords} 词 · ${t.mode === 'paragraph' ? '论证段' : '整篇'}</p><button class="reference-button" id="open-source">查阅原文${icon('next')}</button><details class="task-requirements"><summary>任务要求</summary><ul>${t.requirements.map(x => `<li>${esc(x)}</li>`).join('')}</ul></details></aside><section class="editor-column"><div class="tabs editor-tabs" role="tablist" aria-label="写作阶段"><button class="tab" id="outline-tab" role="tab" aria-controls="transfer-writing" aria-selected="${transferTab === 'outline'}" tabindex="${transferTab === 'outline' ? '0' : '-1'}" data-editor-tab="outline">构思</button><button class="tab" id="text-tab" role="tab" aria-controls="transfer-writing" aria-selected="${transferTab === 'text'}" tabindex="${transferTab === 'text' ? '0' : '-1'}" data-editor-tab="text">正文</button></div><div id="transfer-writing" role="tabpanel" aria-labelledby="${transferTab === 'text' ? 'text' : 'outline'}-tab"><textarea id="transfer-editor" class="transfer-editor ${transferTab === 'outline' ? 'outline-editor' : ''}" aria-label="${transferTab === 'outline' ? '写作构思' : '英文正文'}" placeholder="${transferTab === 'outline' ? '选什么论点？怎样解释？用什么例子？' : ''}" maxlength="12000" spellcheck="${transferTab === 'text'}" ${transfer.recorded ? 'readonly' : ''}>${esc(transfer[transferTab] || '')}</textarea></div><div class="editor-footer"><span class="counter" id="transfer-word-count">${E.countWords(transfer.text)} 词</span><button class="button primary" id="submit-transfer" ${transfer.recorded ? 'disabled' : ''}>${transfer.submitted ? '重新检查' : '提交练习'}</button></div><div id="transfer-feedback">${transfer.submitted ? transferFeedback(t) : ''}</div></section></div>` : '<div class="empty-state">当前筛选没有练习，试试“全部长度”或“全部训练”。</div>'}`;
    [['transfer-level', 'level'], ['transfer-difficulty', 'difficulty'], ['transfer-mode', 'mode']].forEach(([id, field]) => document.getElementById(id).onchange = e => { transferFilter[field] = e.target.value; chooseTransfer(null); });
    if (!t) return;
    main.querySelectorAll('[data-editor-tab]').forEach(b => b.onclick = () => { transferTab = b.dataset.editorTab; renderTransfer(); document.getElementById('transfer-editor').focus(); });
    main.querySelector('.editor-tabs').onkeydown = e => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault(); transferTab = transferTab === 'text' ? 'outline' : 'text'; renderTransfer(); document.getElementById(transferTab === 'text' ? 'text-tab' : 'outline-tab').focus();
    };
    document.getElementById('transfer-editor').oninput = e => {
      transfer[transferTab] = e.target.value; transfer.checks = {}; persistTransfer();
      document.getElementById('transfer-word-count').textContent = E.countWords(transfer.text) + ' 词';
      if (transfer.submitted) { document.getElementById('transfer-feedback').innerHTML = transferFeedback(t); bindTransferFeedback(t); }
    };
    document.getElementById('submit-transfer').onclick = submitTransfer;
    document.getElementById('open-source').onclick = () => {
      if (!transfer.submitted && !transfer.outline.trim() && E.countWords(transfer.text) < 8) { toast('先写下你的构思或一小段正文，再查阅原文。'); return; }
      if (!transfer.firstDraft) transfer.firstDraft = { text: transfer.text, outline: transfer.outline };
      transfer.helpUsed = true; persistTransfer(); showTransferSources(t);
    };
    document.getElementById('change-task').onclick = () => chooseTransfer(null);
    bindTransferFeedback(t);
  }
  function assessTask(t, draft) { return E.assessTransfer({ ...t, sourceText: t.sourceIds.map(id => articleById.get(id)?.paragraphs.map(p => p.en).join('\n\n') || '').join('\n\n') }, draft); }
  function submitTransfer() {
    if (!transfer || transfer.recorded) return;
    if (E.countWords(transfer.text) < 8) { toast('先尝试写一小段英文，再检查。'); return; }
    if (!transfer.firstDraft) transfer.firstDraft = { text: transfer.text, outline: transfer.outline };
    transfer.submitted = true; persistTransfer(); renderTransfer();
    document.getElementById('transfer-feedback').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function transferEligibility(t) {
    const checked = t.rubric.every(r => transfer.checks[r.id]);
    const first = assessTask(t, transfer.firstDraft || { text: '', outline: '' });
    const current = assessTask(t, transfer);
    return { independent: checked && first.wordRange.within && first.paragraphRequirement.met && current.wordRange.within && current.paragraphRequirement.met && !transfer.helpUsed, assisted: checked && current.wordRange.within && current.paragraphRequirement.met };
  }
  function transferFeedback(t) {
    const assessment = assessTask(t, transfer), eligible = transferEligibility(t);
    const notes = [];
    if (!assessment.wordRange.within) notes.push(assessment.wordCount < t.minWords ? '篇幅偏短：先补充理由或具体例子。' : '篇幅偏长：删去重复表达，保留支持观点的内容。');
    if (!assessment.paragraphRequirement.met) notes.push(t.mode === 'paragraph' ? '本题练一个论证段，请把相关句子组织在同一段中。' : '检查分段是否清楚，每段是否有明确作用。');
    if (assessment.sourceOverlap.warning && notes.length < 2) notes.push('存在与参考文章较长的连续重合，请检查例子和对象是否已针对新题调整。');
    return `<section class="transfer-feedback" aria-label="迁移反馈"><div class="review-heading"><h2>检查与修改</h2><span class="small muted">${transfer.helpUsed ? '查阅过参考' : '未查阅参考'}</span></div><div class="fact-row"><span class="${assessment.wordRange.within ? '' : 'needs-work'}">${assessment.wordCount} / ${t.minWords}–${t.maxWords} 词</span><span class="${assessment.paragraphRequirement.met ? '' : 'needs-work'}">${assessment.paragraphCount} 段</span></div>${notes.slice(0, 2).map(n => `<p class="notice">${esc(n)}</p>`).join('')}<p class="feedback-note">长度与分段已检查；题意、论证和表达请逐项自查。完成记录采用你的自评。</p>${t.rubric.map(r => `<label class="check-row"><input type="checkbox" data-transfer-check="${esc(r.id)}" ${transfer.checks[r.id] ? 'checked' : ''} ${transfer.recorded ? 'disabled' : ''}><span>${esc(r.question)}</span></label>`).join('')}<details class="comparison-details"><summary>对照思路</summary><p>${esc(t.strategy)}</p><p><strong>需要改变：</strong>${esc(t.adapt)}</p><p><strong>适用边界：</strong>${esc(t.avoid)}</p><ol>${t.samplePlan.map(x => `<li>${esc(x)}</li>`).join('')}</ol><div class="feedback-source-links">${t.sourceIds.map(id => `<button data-transfer-source="${id}">${esc(articleById.get(id)?.title || '')}</button>`).join('')}</div></details>${transfer.recorded ? `<p class="recorded">已记录 · 下次 ${esc(db.records[transferKey()]?.dueAt || '')}</p><button class="button primary" id="transfer-next">下一题</button>` : `<div class="record-actions"><button class="button" data-transfer-outcome="again">仍需练习</button><button class="button" data-transfer-outcome="assisted" ${eligible.assisted && !eligible.independent ? '' : 'disabled'}>修改后完成</button><button class="button primary" data-transfer-outcome="independent" ${eligible.independent ? '' : 'disabled'}>独立完成（自评）</button></div>`}</section>`;
  }
  function bindTransferFeedback(t) {
    main.querySelectorAll('[data-transfer-check]').forEach(b => b.onchange = () => {
      transfer.checks[b.dataset.transferCheck] = b.checked; persistTransfer();
      const eligible = transferEligibility(t);
      const independent = main.querySelector('[data-transfer-outcome="independent"]');
      const assisted = main.querySelector('[data-transfer-outcome="assisted"]');
      if (independent) independent.disabled = !eligible.independent;
      if (assisted) assisted.disabled = !eligible.assisted || eligible.independent;
    });
    const comparison = main.querySelector('.comparison-details');
    if (comparison) {
      const markComparison = () => {
      if (!transfer.recorded) {
        transfer.helpUsed = true; persistTransfer();
        const eligible = transferEligibility(t);
        const independent = main.querySelector('[data-transfer-outcome="independent"]');
        const assisted = main.querySelector('[data-transfer-outcome="assisted"]');
        if (independent) independent.disabled = true;
        if (assisted) assisted.disabled = !eligible.assisted;
        const label = main.querySelector('.transfer-feedback .review-heading .muted'); if (label) label.textContent = '查阅过参考';
      }
      };
      comparison.querySelector('summary').onclick = () => { if (!comparison.open) markComparison(); };
      comparison.ontoggle = () => { if (comparison.open) markComparison(); };
    }
    main.querySelectorAll('[data-transfer-source]').forEach(b => b.onclick = () => { transfer.helpUsed = true; persistTransfer(); showSourceArticle(b.dataset.transferSource); });
    main.querySelectorAll('[data-transfer-outcome]').forEach(b => b.onclick = () => {
      if (transfer.recorded) return;
      const outcome = b.dataset.transferOutcome, eligible = transferEligibility(t);
      if (outcome === 'independent' && !eligible.independent || outcome === 'assisted' && !eligible.assisted) return;
      const first = assessTask(t, transfer.firstDraft);
      recordAttempt(transferKey(), { type: 'transfer', taskId: t.id, mode: t.mode, attemptId: transfer.attemptId, helpUsed: transfer.helpUsed, firstWordCount: first.wordCount, selfRated: true }, outcome);
      transfer.recorded = true; persistTransfer(); renderTransfer();
    });
    const next = document.getElementById('transfer-next'); if (next) next.onclick = () => chooseTransfer(null);
  }
  function showTransferSources(t) {
    showUtility('参考文章', `<div class="record-list">${t.sourceIds.map(id => `<p><button class="text-button" data-open-article="${id}">${esc(articleById.get(id)?.title || '')}</button></p>`).join('')}</div>`);
    utility.querySelectorAll('[data-open-article]').forEach(b => b.onclick = () => showSourceArticle(b.dataset.openArticle));
  }
  function showSourceArticle(id) {
    const a = articleById.get(id); if (!a) return;
    markReference(id);
    showUtility(a.title, `<div class="source-text">${a.paragraphs.map(p => `<p>${esc(p.en)}</p>`).join('')}</div>`);
  }

  // Quiet secondary surfaces for due work, records and portable backups.
  function showUtility(title, body) {
    utility.innerHTML = `<div class="modal-header"><h2>${esc(title)}</h2><button class="icon-button" id="close-utility" aria-label="关闭">${icon('close')}</button></div><div class="modal-content">${body}</div>`;
    document.getElementById('close-utility').onclick = () => utility.close();
    if (!utility.open) utility.showModal();
  }
  function recordTitle(record) { return record.type === 'transfer' ? taskById.get(record.taskId)?.title || '迁移训练' : articleById.get(record.articleId)?.title || '回忆训练'; }
  function recordMode(record) { return record.type === 'transfer' ? '迁移 · ' + (record.mode === 'paragraph' ? '论证段' : '整篇') : MODES[record.mode] || '回忆'; }
  function openSettings() {
    const due = dueRecords();
    showUtility('学习记录与设置', `<section class="modal-section"><h3>到期复习 <span class="count">${due.length}</span></h3>${due.length ? `<ul class="record-list">${due.slice(0, Number(db.settings.dailyLimit) || 12).map(([key, r]) => `<li><div>${esc(recordTitle(r))}<small>${esc(recordMode(r))} · ${esc(r.dueAt)}</small></div><button class="button small-button" data-due-key="${esc(key)}">开始</button></li>`).join('')}</ul>` : '<p class="small muted">当前没有到期项目。完成一轮练习后，会安排下一次复习。</p>'}</section>
      <section class="modal-section"><h3>最近练习</h3>${db.history.length ? `<ul class="record-list">${db.history.slice(0, 16).map(r => `<li><div>${esc(recordTitle(r))}<small>${esc(recordMode(r))} · ${new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric' }).format(new Date(r.at))}</small></div><span class="small muted">${esc(OUTCOMES[r.outcome] || r.outcome)}${r.selfRated ? ' · 自评' : ''}</span></li>`).join('')}</ul>` : '<p class="small muted">还没有完成记录。浏览图片与保存草稿不计为掌握。</p>'}</section>
      <section class="modal-section"><h3>练习设置</h3><label class="settings-row">一次展示的到期项目<input id="daily-limit" type="number" min="3" max="30" value="${Math.min(30, Math.max(3, Number(db.settings.dailyLimit) || 12))}"></label><p class="small muted">独立完成后逐渐拉开间隔；提示后完成或需要重练的项目次日再测。这是可调整的练习规则。</p></section>
      <section class="modal-section"><h3>数据备份</h3><p class="small muted">${storageAvailable ? '草稿和学习记录保存在当前浏览器。换设备或清理浏览器前，请导出备份。' : '当前浏览器存储不可用，请及时导出备份。'}</p><div class="button-row"><button class="button" id="export-backup">导出备份</button><button class="button" id="import-backup">导入备份</button><input id="backup-file" type="file" accept="application/json,.json" hidden></div><p class="small muted" style="margin:15px 0 0">导入会合并记录，并保留较新的作答。</p></section>`);
    utility.querySelectorAll('[data-due-key]').forEach(b => b.onclick = () => startDue(b.dataset.dueKey));
    document.getElementById('daily-limit').onchange = e => { db.settings.dailyLimit = Math.min(30, Math.max(3, Number(e.target.value) || 12)); e.target.value = db.settings.dailyLimit; save(); };
    document.getElementById('export-backup').onclick = exportBackup;
    document.getElementById('import-backup').onclick = () => document.getElementById('backup-file').click();
    document.getElementById('backup-file').onchange = importBackup;
  }
  function exportBackup() {
    save(true);
    const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = '作文集_学习备份_' + dateNow() + '.json';
    link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1500);
  }
  async function importBackup(event) {
    const file = event.target.files?.[0]; if (!file) return;
    if (file.size > 2 * 1024 * 1024) { toast('备份超过 2 MB，未导入。'); return; }
    try {
      const result = E.validateBackup(JSON.parse(await file.text()));
      if (!result.valid) throw new Error(result.errors[0]);
      const incoming = sanitizeDatabase(result.data);
      const nextDb = sanitizeDatabase(clone(db));
      for (const [key, value] of Object.entries(incoming.records)) {
        if (!nextDb.records[key] || (Date.parse(value.reviewedAt) || 0) > (Date.parse(nextDb.records[key].reviewedAt) || 0)) nextDb.records[key] = value;
      }
      for (const [key, draft] of Object.entries(incoming.drafts)) {
        if (!nextDb.drafts[key] || Date.parse(draft.updatedAt || draft.createdAt) > Date.parse(nextDb.drafts[key].updatedAt || nextDb.drafts[key].createdAt)) nextDb.drafts[key] = draft;
      }
      nextDb.bookmarks = [...new Set([...nextDb.bookmarks, ...incoming.bookmarks])];
      const seen = new Set();
      nextDb.history = [...nextDb.history, ...incoming.history].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).filter(r => { const key = r.attemptId || r.key + r.at; if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 500);
      db = nextDb;
      save(true); recall = null; transfer = null;
      if (screen === 'recall') startRecall(articles[0].id, 'cloze', false, false);
      if (screen === 'transfer') chooseTransfer(null, false, false);
      render(); openSettings(); toast('备份已合并。');
    } catch { toast('备份格式无效，当前数据未被替换。'); }
  }
  function validRecord(key, value) {
    if (!value || typeof value !== 'object') return false;
    return value.type === 'recall' ? articleById.has(value.articleId) && Object.hasOwn(MODES, value.mode) && key === 'recall:' + value.articleId + ':' + value.mode : value.type === 'transfer' && taskById.has(value.taskId) && key === 'transfer:' + value.taskId;
  }
  function validDraft(key, value) {
    if (!value || typeof value !== 'object' || typeof key !== 'string' || !validTimestamp(value.createdAt) || (value.updatedAt !== undefined && !validTimestamp(value.updatedAt)) || typeof value.attemptId !== 'string' || !value.attemptId || value.attemptId.length > 100 || typeof value.recorded !== 'boolean' || typeof value.helpUsed !== 'boolean') return false;
    if (key.startsWith('recall:')) return articleById.has(value.articleId) && Object.hasOwn(MODES, value.mode) && key === 'recall:' + value.articleId + ':' + value.mode && textMap(value.answers) && (value.firstAnswers === null || textMap(value.firstAnswers)) && checkMap(value.selfChecks) && Number.isInteger(value.variant) && value.variant >= 0 && value.variant <= 1000000 && Number.isInteger(value.maxHint) && value.maxHint >= 0 && value.maxHint <= 3 && typeof value.checked === 'boolean';
    return taskById.has(value.taskId) && key === 'transfer:' + value.taskId && typeof value.text === 'string' && value.text.length <= 12000 && typeof value.outline === 'string' && value.outline.length <= 12000 && typeof value.submitted === 'boolean' && checkMap(value.checks) && (value.firstDraft === null || value.firstDraft && typeof value.firstDraft.text === 'string' && value.firstDraft.text.length <= 12000 && typeof value.firstDraft.outline === 'string' && value.firstDraft.outline.length <= 12000);
  }
  function showQuestion(title, message, action) {
    showUtility(title, `<p class="notice">${esc(message)}</p><div class="button-row"><button class="button" id="cancel-question">保留当前作答</button><button class="button primary" id="confirm-question">开始新练习</button></div>`);
    document.getElementById('cancel-question').onclick = () => utility.close();
    document.getElementById('confirm-question').onclick = () => { utility.close(); action(); };
  }
  document.getElementById('settings-button').onclick = openSettings;
  document.getElementById('skip-link').onclick = e => { e.preventDefault(); main.focus(); main.scrollIntoView(); };
  window.addEventListener('hashchange', () => { if (location.hash !== '#main') navigate(location.hash.slice(1)); });
  window.addEventListener('pagehide', () => save(true));
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !viewer.open && !utility.open) { e.preventDefault(); if (screen === 'recall') checkRecall(); if (screen === 'transfer') submitTransfer(); }
  });
  viewer.addEventListener('click', e => { if (e.target === viewer && e.clientX < viewer.getBoundingClientRect().left) viewer.close(); });
  navigate(location.hash.slice(1));
})();

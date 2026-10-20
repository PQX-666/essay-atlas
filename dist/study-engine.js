(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StudyEngine = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var OUTCOMES = ['independent', 'assisted', 'again'];
  var INTERVALS = [1, 3, 7, 14, 30, 60];
  var FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
  var MAX_TEXT_LENGTH = 60000;
  var MAX_BACKUP_BYTES = 2 * 1024 * 1024;

  function requireText(value, label) {
    if (typeof value !== 'string') throw new TypeError((label || 'text') + ' must be a string');
    if (value.length > MAX_TEXT_LENGTH) throw new RangeError((label || 'text') + ' is too long');
    return value;
  }

  function words(value) {
    return requireText(value).normalize('NFKC').match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) || [];
  }

  function wordKey(value) {
    return value.toLowerCase().replace(/['’]/g, '');
  }

  function normalize(text) {
    return words(text).map(wordKey).join(' ');
  }

  function countWords(text) {
    return words(text).filter(function (word) { return /[a-z]/i.test(word); }).length;
  }

  // Word-level LCS keeps repeated words and omissions in their original order.
  // Essay inputs are small; the explicit cap prevents quadratic allocations on pasted books.
  function compare(actual, expected) {
    var actualWords = words(actual);
    var expectedWords = words(expected);
    if (actualWords.length > 2500 || expectedWords.length > 2500) {
      throw new RangeError('Compare at most 2500 words at a time');
    }
    var a = actualWords.map(wordKey);
    var b = expectedWords.map(wordKey);
    var columns = b.length + 1;
    var matrix = new Uint16Array((a.length + 1) * columns);
    var i, j;
    for (i = a.length - 1; i >= 0; i--) {
      for (j = b.length - 1; j >= 0; j--) {
        matrix[i * columns + j] = a[i] === b[j]
          ? matrix[(i + 1) * columns + j + 1] + 1
          : Math.max(matrix[(i + 1) * columns + j], matrix[i * columns + j + 1]);
      }
    }
    var tokens = [];
    var missingTokens = [];
    var extraTokens = [];
    var matched = 0;
    i = 0;
    j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        tokens.push({ text: expectedWords[j], type: 'equal' });
        matched++;
        i++;
        j++;
      } else if (j < b.length && (i === a.length || matrix[i * columns + j + 1] >= matrix[(i + 1) * columns + j])) {
        tokens.push({ text: expectedWords[j], type: 'missing' });
        missingTokens.push(expectedWords[j]);
        j++;
      } else {
        tokens.push({ text: actualWords[i], type: 'extra' });
        extraTokens.push(actualWords[i]);
        i++;
      }
    }
    var denominator = Math.max(a.length, b.length);
    return {
      correct: missingTokens.length === 0 && extraTokens.length === 0,
      accuracy: denominator ? matched / denominator : 1,
      missingTokens: missingTokens,
      extraTokens: extraTokens,
      tokens: tokens
    };
  }

  function cloze(article, variant, limit) {
    variant = variant === undefined ? 0 : variant;
    limit = limit === undefined ? 4 : limit;
    if (!Number.isInteger(variant) || variant < 0 || variant > 1000000) throw new RangeError('Invalid cloze variant');
    if (!Number.isInteger(limit) || limit < 1 || limit > 40) throw new RangeError('Invalid cloze limit');
    if (!article || !Array.isArray(article.sentences)) throw new TypeError('Article sentences are required');
    var candidates = [];
    article.sentences.forEach(function (sentence, index) {
      if (!sentence || typeof sentence.en !== 'string' || !Array.isArray(sentence.targets)) return;
      var seen = new Set();
      var targets = sentence.targets.filter(function (target) {
        if (typeof target !== 'string' || !target.trim() || seen.has(target) || sentence.en.indexOf(target) < 0) return false;
        seen.add(target);
        return true;
      });
      if (targets.length) candidates.push({ sentence: sentence, sentenceIndex: index, targets: targets });
    });
    if (!candidates.length) return [];
    var count = Math.min(limit, candidates.length);
    var start = variant * count;
    return Array.from({ length: count }, function (_, offset) {
      var position = start + offset;
      var candidate = candidates[position % candidates.length];
      var targetIndex = Math.floor(position / candidates.length) % candidate.targets.length;
      var answer = candidate.targets[targetIndex];
      var sentence = candidate.sentence;
      var at = sentence.en.indexOf(answer);
      return {
        id: String(article.id) + ':s' + candidate.sentenceIndex + ':t' + targetIndex,
        sentenceIndex: candidate.sentenceIndex,
        before: sentence.en.slice(0, at),
        answer: answer,
        after: sentence.en.slice(at + answer.length),
        zh: typeof sentence.zh === 'string' ? sentence.zh : '',
        section: sentence.section === undefined ? '' : sentence.section
      };
    });
  }

  function validDay(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    var year = Number(value.slice(0, 4));
    var month = Number(value.slice(5, 7));
    var day = Number(value.slice(8, 10));
    if (year < 1900 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
    var leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  }

  function shanghaiDay(value) {
    if (value === undefined) value = new Date().toISOString();
    if (validDay(value)) return value;
    if (typeof value !== 'string') throw new RangeError('Use YYYY-MM-DD or an ISO timestamp with a timezone');
    var match = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/);
    if (!match || !validDay(match[1]) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) {
      throw new RangeError('Invalid date or timestamp; include an explicit timezone');
    }
    if (match[6] !== 'Z' && (Number(match[8]) > 14 || Number(match[9]) > 59 || (Number(match[8]) === 14 && Number(match[9]) !== 0))) {
      throw new RangeError('Invalid timezone offset');
    }
    var instant = new Date(value);
    if (!Number.isFinite(instant.getTime())) throw new RangeError('Invalid timestamp');
    var parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(instant);
    var fields = {};
    parts.forEach(function (part) { fields[part.type] = part.value; });
    var result = fields.year + '-' + fields.month + '-' + fields.day;
    if (!validDay(result)) throw new RangeError('Date is outside the supported range');
    return result;
  }

  function addDays(day, amount) {
    var date = new Date(day + 'T00:00:00.000Z');
    date.setUTCDate(date.getUTCDate() + amount);
    var result = date.toISOString().slice(0, 10);
    if (!validDay(result)) throw new RangeError('Due date is outside the supported range');
    return result;
  }

  function schedule(previousRecord, outcome, nowISO) {
    if (OUTCOMES.indexOf(outcome) < 0) throw new RangeError('Invalid learning outcome');
    var today = shanghaiDay(nowISO);
    var previousStreak = previousRecord && previousRecord.lastOutcome === 'independent' && Number.isInteger(previousRecord.streak) && previousRecord.streak >= 0
      ? previousRecord.streak : 0;
    var streak = outcome === 'independent' ? Math.min(previousStreak + 1, 10000) : 0;
    var intervalDays = outcome === 'independent' ? INTERVALS[Math.min(streak - 1, INTERVALS.length - 1)] : 1;
    return { intervalDays: intervalDays, dueAt: addDays(today, intervalDays), streak: streak, lastOutcome: outcome };
  }

  function isDue(record, nowISO) {
    var today = shanghaiDay(nowISO);
    if (!record || !record.dueAt) return false;
    if (!validDay(record.dueAt)) throw new RangeError('Record dueAt must be a valid YYYY-MM-DD date');
    return record.dueAt <= today;
  }

  function overlapCheck(text, sourceText) {
    if (typeof sourceText !== 'string' || !sourceText.trim()) {
      return { checked: false, ratio: 0, longestMatchWords: 0, warning: '' };
    }
    var actual = words(text).map(wordKey);
    var source = words(sourceText).map(wordKey);
    if (actual.length > 2500 || source.length > 4000) throw new RangeError('Transfer text is too long to compare');
    var previous = new Uint16Array(source.length + 1);
    var marked = new Uint8Array(actual.length);
    var longest = 0;
    for (var i = 0; i < actual.length; i++) {
      var current = new Uint16Array(source.length + 1);
      for (var j = 0; j < source.length; j++) {
        if (actual[i] === source[j]) {
          current[j + 1] = previous[j] + 1;
          longest = Math.max(longest, current[j + 1]);
          if (current[j + 1] >= 8) {
            for (var k = i - 7; k <= i; k++) marked[k] = 1;
          }
        }
      }
      previous = current;
    }
    var matched = marked.reduce(function (sum, value) { return sum + value; }, 0);
    var ratio = actual.length ? matched / actual.length : 0;
    return {
      checked: true,
      ratio: ratio,
      longestMatchWords: longest,
      warning: actual.length >= 30 && ratio >= 0.45 && longest >= 12
        ? '正文与参考原文存在较长的连续重合，请检查对象、例子和措辞是否适合新题；这不是迁移能力评分。' : ''
    };
  }

  function assessTransfer(task, response) {
    task = task || {};
    response = response || {};
    var text = requireText(response.text === undefined ? '' : response.text, 'response text');
    var outline = requireText(response.outline === undefined ? '' : response.outline, 'outline');
    var essay = task.mode === 'essay';
    var minWords = Number.isInteger(task.minWords) && task.minWords >= 0 ? task.minWords : (essay ? 120 : 40);
    var maxWords = Number.isInteger(task.maxWords) && task.maxWords >= minWords ? task.maxWords : (essay ? Math.max(minWords, 200) : Math.max(minWords, 100));
    var minParagraphs = Number.isInteger(task.minParagraphs) && task.minParagraphs >= 1 ? task.minParagraphs : (essay ? 3 : 1);
    var maxParagraphs = Number.isInteger(task.maxParagraphs) && task.maxParagraphs >= minParagraphs ? task.maxParagraphs : (essay ? Math.max(minParagraphs, 6) : minParagraphs);
    var wordCount = countWords(text);
    // Each nonempty newline-delimited block is a paragraph; both single and blank-line separators work.
    var paragraphCount = text.split(/\r?\n+/).filter(function (part) { return part.trim(); }).length;
    var withinWords = wordCount >= minWords && wordCount <= maxWords;
    var withinParagraphs = paragraphCount >= minParagraphs && paragraphCount <= maxParagraphs;
    return {
      wordCount: wordCount,
      paragraphCount: paragraphCount,
      wordRange: { min: minWords, max: maxWords, within: withinWords },
      paragraphRequirement: { min: minParagraphs, max: maxParagraphs, met: withinParagraphs },
      hasOutline: Boolean(outline.trim()),
      sourceOverlap: overlapCheck(text, task.sourceText),
      checks: [
        { id: 'text', label: '已写正文', pass: Boolean(text.trim()) },
        { id: 'words', label: '符合本题词数范围', pass: withinWords },
        { id: 'paragraphs', label: '符合本题段落数量', pass: withinParagraphs },
        { id: 'outline', label: '已记录构思', pass: Boolean(outline.trim()) }
      ],
      notice: '这里只核对词数、段落及文本重合。是否切题、论证成立和表达自然，需要结合题目自行检查。'
    };
  }

  function plainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    var proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  function validateBackup(value) {
    try {
      var nodes = 0;
      var stringUnits = 0;
      var seen = new Set();
      function safeCopy(input, depth) {
        nodes++;
        if (nodes > 50000 || depth > 8) throw new Error('备份结构过大或嵌套过深');
        if (input === null || typeof input === 'boolean') return input;
        if (typeof input === 'number') {
          if (!Number.isFinite(input) || Math.abs(input) > Number.MAX_SAFE_INTEGER) throw new Error('备份含有无效数值');
          return input;
        }
        if (typeof input === 'string') {
          stringUnits += input.length;
          if (input.length > 50000 || stringUnits > MAX_BACKUP_BYTES) throw new Error('备份文字超过大小限制');
          return input;
        }
        if (typeof input !== 'object' || (!Array.isArray(input) && !plainObject(input))) throw new Error('备份只能包含普通 JSON 数据');
        if (seen.has(input)) throw new Error('备份存在循环或重复对象引用');
        seen.add(input);
        if (Object.getOwnPropertySymbols(input).length) throw new Error('备份含有无效字段');
        var names = Object.getOwnPropertyNames(input);
        for (var index = 0; index < names.length; index++) {
          var key = names[index];
          if (FORBIDDEN_KEYS.has(key)) throw new Error('备份含有不安全字段');
          var descriptor = Object.getOwnPropertyDescriptor(input, key);
          if (descriptor.get || descriptor.set) throw new Error('备份不能包含访问器');
        }
        if (Array.isArray(input)) {
          if (input.length > 3000 || names.some(function (name) { return name !== 'length' && !/^(0|[1-9]\d*)$/.test(name); })) throw new Error('备份数组无效或过长');
          return Array.from(input, function (item) { return safeCopy(item, depth + 1); });
        }
        if (names.length > 2000) throw new Error('备份对象字段过多');
        var output = Object.create(null);
        names.forEach(function (key) {
          if (key.length > 160) throw new Error('备份字段名称过长');
          output[key] = safeCopy(input[key], depth + 1);
        });
        return output;
      }
      var data = safeCopy(value, 0);
      if (!plainObject(data)) throw new Error('备份顶层格式无效');
      var expectedKeys = ['version', 'records', 'drafts', 'settings', 'history', 'bookmarks'];
      var actualKeys = Object.keys(data);
      if (actualKeys.length !== expectedKeys.length || expectedKeys.some(function (key) { return !Object.prototype.hasOwnProperty.call(data, key); })) throw new Error('备份字段不完整或含有未知字段');
      if (data.version !== 1) throw new Error('不支持此备份版本');
      if (!plainObject(data.records) || Object.keys(data.records).length > 1000) throw new Error('复习记录格式无效');
      Object.keys(data.records).forEach(function (key) {
        var record = data.records[key];
        if (!plainObject(record)) throw new Error('复习记录必须是对象');
        if (record.dueAt !== undefined && !validDay(record.dueAt)) throw new Error('复习日期无效');
        if (record.intervalDays !== undefined && (!Number.isInteger(record.intervalDays) || record.intervalDays < 1 || record.intervalDays > 365)) throw new Error('复习间隔无效');
        if (record.streak !== undefined && (!Number.isInteger(record.streak) || record.streak < 0 || record.streak > 10000)) throw new Error('独立完成次数无效');
        if (record.lastOutcome !== undefined && OUTCOMES.indexOf(record.lastOutcome) < 0) throw new Error('复习结果无效');
      });
      if (!plainObject(data.drafts) || Object.keys(data.drafts).length > 1000 || Object.values(data.drafts).some(function (draft) { return typeof draft !== 'string' && !plainObject(draft); })) throw new Error('草稿格式无效');
      if (!plainObject(data.settings)) throw new Error('设置格式无效');
      if (!Array.isArray(data.history) || data.history.length > 2000 || data.history.some(function (entry) { return !plainObject(entry); })) throw new Error('历史记录格式无效');
      if (!Array.isArray(data.bookmarks) || data.bookmarks.length > 200 || data.bookmarks.some(function (id) { return typeof id !== 'string' || !id.length || id.length > 160; }) || new Set(data.bookmarks).size !== data.bookmarks.length) throw new Error('收藏格式无效');
      var encoded = JSON.stringify(data);
      var bytes = typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(encoded).byteLength : encoded.length * 3;
      if (bytes > MAX_BACKUP_BYTES) throw new Error('备份不得超过 2 MB');
      return { valid: true, errors: [], data: data };
    } catch (error) {
      return { valid: false, errors: [error.message || '备份格式无效'], data: null };
    }
  }

  return Object.freeze({
    normalize: normalize,
    compare: compare,
    cloze: cloze,
    schedule: schedule,
    isDue: isDue,
    countWords: countWords,
    assessTransfer: assessTransfer,
    validateBackup: validateBackup
  });
});

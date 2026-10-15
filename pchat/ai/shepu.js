/**
 * SHEPU AI — v3.1 Core Engine (ported from shepu_ai_android/ai/app/old_versions/ai5.js)
 * ------------------------------------------------------------------------------------
 * This is the answer engine behind "Shepu-AI v3.1 | Pro Assistant".
 * It contains ONLY the intelligence (no DOM / no UI), so it can be reused
 * inside pchat as an in-chat bot (@shepu-ai).
 *
 * The behaviour is intentionally identical to v3.1 so that asking a question
 * here returns the exact same reply you would get in v3.1.
 *
 * Public API (window.Shepu):
 *   Shepu.init()               -> loads the knowledge .txt files (async)
 *   Shepu.findAnswer(query)    -> string reply (same algorithm as v3.1)
 *   Shepu.suggest(prefix)      -> array of matching question strings (autocomplete)
 */

const Shepu = (() => {
  // ── Embedded Q&A (identical to v3.1) ────────────────────────────
  const EMBEDDED_DB = [
    { q: "hi", a: "হ্যালো! আমি Shepu-AI। আপনাকে কীভাবে সাহায্য করতে পারি?" },
    { q: "who are you", a: "আমি **শেপু-আই v3.1**, আপনার স্মার্ট এআই অ্যাসিস্ট্যান্ট।" },
    { q: "bye", a: "বিদায়! আপনার দিনটি ভালো কাটুক।" },
    { q: "ki korte paro", a: "আমি অংক সমাধান করতে পারি, ফাইল থেকে তথ্য খুঁজতে পারি এবং আপনার যেকোনো প্রশ্নের উত্তর দেওয়ার চেষ্টা করতে পারি।" }
  ];

  let database = [];          // { q, a } — lowercase questions
  let conversationContext = { lastSubject: null, globalKeywords: new Set() };

  // ── Data loading (mirrors v3.1 loadData) ─────────────────────────
  // files are resolved relative to THIS script (ai/shepu-data/*.txt)
  const DATA_FILES = ['bar.txt', 'golpo.txt', 'new.txt', 'book.txt', 'knowledge.txt'];

  async function load() {
    EMBEDDED_DB.forEach(item => database.push({ q: item.q.toLowerCase(), a: item.a }));

    // Resolve data dir relative to this module's location.
    const here = (typeof document !== 'undefined' && document.currentScript && document.currentScript.src)
      ? document.currentScript.src.replace(/[^/]*$/, '')
      : 'ai/';
    const base = here + 'shepu-data/';

    for (let file of DATA_FILES) {
      try {
        let res = await fetch(base + file);
        if (res.ok) {
          let text = await res.text();
          let lines = text.split('\n');
          lines.forEach(line => {
            if (line.includes(';')) {
              const parts = line.split(';');
              if (parts.length >= 2) {
                const entry = {
                  q: parts[0].trim().toLowerCase(),
                  a: parts.slice(1).join(';').trim()
                };
                database.push(entry);
              }
            }
          });
        }
      } catch (e) { /* file missing — skip */ }
    }
  }

  function init() {
    if (init._promise) return init._promise;
    init._promise = load();
    return init._promise;
  }
  init._promise = null;

  // ── String similarity (verbatim from v3.1) ───────────────────────
  function similarity(s1, s2) {
    let longer = s1;
    let shorter = s2;
    if (s1.length < s2.length) { longer = s2; shorter = s1; }
    let longerLength = longer.length;
    if (longerLength == 0) return 1.0;
    return (longerLength - editDistance(longer, shorter)) / parseFloat(longerLength);
  }

  function editDistance(s1, s2) {
    let costs = new Array();
    for (let i = 0; i <= s1.length; i++) {
      let lastValue = i;
      for (let j = 0; j <= s2.length; j++) {
        if (i == 0) costs[j] = j;
        else {
          if (j > 0) {
            let newValue = costs[j - 1];
            if (s1.charAt(i - 1) != s2.charAt(j - 1)) newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
            costs[j - 1] = lastValue;
            lastValue = newValue;
          }
        }
      }
      if (i > 0) costs[s2.length] = lastValue;
    }
    return costs[s2.length];
  }

  // ── The answer engine (verbatim logic from v3.1 findAnswer) ──────
  function findAnswer(query) {
    query = query.toLowerCase().trim();
    if (!query) return null;

    const stopWords = ["is", "the", "a", "an", "are", "in", "on", "at", "to", "for", "with", "ki", "er", "e", "te", "kore", "kora", "theke", "thekai", "holo", "hoy", "hobe", "niye"];
    const extractKeywords = (str) => str.split(/\s+/).filter(w => w.length > 1 && !stopWords.includes(w));
    const userKeywords = extractKeywords(query);

    // Math evaluation (identical to v3.1)
    if (/^[\d\s\+\-\*\/\(\)\.\^\%]+$/.test(query) && /\d/.test(query) && !/[a-zA-Z]/.test(query)) {
      try {
        let result = Function('"use strict";return (' + query.replace(/\^/g, '**') + ')')();
        return `আমি আপনার জন্য হিসাব করেছি: **${result}**`;
      } catch (e) { }
    }

    let processedQuery = query;
    const pronouns = ["k", "ki", "tar", "oita", "ota", "oitar", "সে কে", "তার নাম"];
    if (query.split(' ').length <= 3 && conversationContext.lastSubject) {
      if (pronouns.some(p => query.includes(p))) {
        processedQuery = conversationContext.lastSubject + " " + query;
      }
    }

    userKeywords.forEach(kw => conversationContext.globalKeywords.add(kw));

    const segments = processedQuery.split(/[?.!,]+/).map(s => s.trim()).filter(s => s.length > 1);
    let finalAnswers = [];
    let usedAnswers = new Set();

    segments.forEach(segment => {
      let bestSegmentMatch = null;
      let highestScore = -1;

      database.forEach(item => {
        let score = 0;
        const dbQ = item.q.toLowerCase().trim();
        const seg = segment.toLowerCase().trim();

        if (seg === dbQ) {
          score = 1.0;
        } else if (seg.includes(dbQ) || dbQ.includes(seg)) {
          const segWords = seg.split(/\s+/);
          const dbWords = dbQ.split(/\s+/);
          const matches = segWords.filter(w => dbWords.includes(w)).length;
          const overlap = matches / Math.max(segWords.length, dbWords.length);

          score = overlap * 0.9;
          if (seg.includes(dbQ) && dbWords.length > 1) score += 0.05;
        } else {
          const sim = similarity(seg, dbQ);
          if (sim > 0.8) score = sim * 0.8;
        }

        if (score > highestScore) {
          highestScore = score;
          bestSegmentMatch = item;
        }
      });

      if (bestSegmentMatch && highestScore > 0.65) {
        if (!usedAnswers.has(bestSegmentMatch.a)) {
          finalAnswers.push(bestSegmentMatch.a);
          usedAnswers.add(bestSegmentMatch.a);
          const words = bestSegmentMatch.q.split(' ');
          if (words.length > 0) conversationContext.lastSubject = words[0];
        }
      }
    });

    if (finalAnswers.length > 0) {
      if (finalAnswers.length === 1) return beautifyResponse(finalAnswers[0]);

      let response = "";
      finalAnswers.forEach(ans => {
        response += `• ${ans}\n\n`;
      });
      return response.trim();
    }

    let bestGlobalMatch = null;
    let highestGlobalScore = -1;
    const cleanQuery = query.replace(/[?.!,]/g, ' ').trim();

    database.forEach(item => {
      const dbQ = item.q.toLowerCase().trim();
      const dbKeywords = extractKeywords(dbQ);

      const keywordMatches = userKeywords.filter(w => dbKeywords.includes(w)).length;
      const keywordScore = userKeywords.length > 0 ? (keywordMatches / userKeywords.length) : 0;

      const sim = similarity(cleanQuery, dbQ);
      const qWords = cleanQuery.split(/\s+/);
      const dbWords = dbQ.split(/\s+/);
      const matches = qWords.filter(w => dbWords.includes(w)).length;
      const overlap = matches / Math.max(qWords.length, dbWords.length);

      const score = (sim * 0.2) + (overlap * 0.3) + (keywordScore * 0.5);

      if (score > highestGlobalScore) {
        highestGlobalScore = score;
        bestGlobalMatch = item;
      }
    });

    if (bestGlobalMatch && highestGlobalScore > 0.1) {
      return beautifyResponse(bestGlobalMatch.a);
    }

    return "আমি আপনার প্রশ্নের কাছাকাছি কোনো উত্তর খুঁজে পাচ্ছি না। দয়া করে একটু অন্যভাবে জিজ্ঞাসা করুন!";
  }

  function beautifyResponse(text) {
    if (text.length > 100 && !text.includes('\n')) {
      return text.split('. ').join('.\n- ');
    }
    return text;
  }

  // ── Suggestion / autocomplete (mirrors v3.1 handleSuggestions) ────
  function suggest(val, limit) {
    if (!val) return [];
    val = val.toLowerCase().trim();
    if (val.length < 1) return [];
    limit = limit || 5;

    return database.filter(item => item.q.includes(val))
      .sort((a, b) => {
        const aStarts = a.q.startsWith(val);
        const bStarts = b.q.startsWith(val);
        if (aStarts && !bStarts) return -1;
        if (!aStarts && bStarts) return 1;
        return a.q.length - b.q.length;
      })
      .slice(0, limit)
      .map(item => item.q);
  }

  return {
    init,
    findAnswer,
    suggest,
  };
})();

// Expose globally
window.Shepu = Shepu;

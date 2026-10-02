// ==UserScript==
// @name         韓国小説 丸ごと翻訳
// @namespace    ikasumi-novel-tl
// @version      10.2
// @description  韓国語・中国語・英語の小説を、ページを開いたまま自然な日本語に翻訳
// @match        *://*.ridibooks.com/*
// @match        *://page.kakao.com/*
// @match        *://*.page.kakao.com/*
// @match        *://*.kakao.com/*
// @match        *://*/*
// @exclude      *://accounts.google.com/*
// @exclude      *://*.google.com/*
// @exclude      *://console.anthropic.com/*
// @exclude      *://aistudio.google.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @connect      generativelanguage.googleapis.com
// @connect      api.anthropic.com
// @connect      api.deepseek.com
// @connect      api.github.com
// @connect      gist.githubusercontent.com
// @connect      *
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/ikazu23/novel-translator/main/korean-novel-translator.user.js
// @updateURL    https://raw.githubusercontent.com/ikazu23/novel-translator/main/korean-novel-translator.user.js
// ==/UserScript==

const KZ_SET = GM_setValue;
(function () {
  'use strict';
  // 訳の記録が変わったら、クラウドへの自動バックアップの印を付ける
  let backupDirty = false, backupTimer = 0;
  const GM_setValue = (k, v) => {
    KZ_SET(k, v);
    if (/^(cache2?:|live:|para:|sheet:|tail:|ep:)/.test(k)) { backupDirty = true; scheduleBackup(); }
  };

  // ---------- 原文の言語（韓国語・中国語・英語）----------
  // ko(s)：原文の言語の文字数。中国語は漢字が日本語と重なるので「漢字 − かな×3」、英語は「英字 − (かな+漢字)×5」で数える
  //   （日本語の文はかながあるので0になる＝訳し終わった文・日本語のメニューは原文として数えない）
  const KO = /[\uAC00-\uD7A3]/g, HAN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g, KANA = /[\u3041-\u30FF]/g, LAT = /[A-Za-z]/g;
  const cnt = (s, re) => ((s || '').match(re) || []).length;
  const countAs = (lang, s) => {
    s = String(s || '');
    if (lang === 'zh') return Math.max(0, cnt(s, HAN) - cnt(s, KANA) * 3);
    if (lang === 'en') { s = s.replace(/<\/?t\d+\/?>/g, ''); return Math.max(0, cnt(s, LAT) - (cnt(s, KANA) + cnt(s, HAN)) * 5); }
    return cnt(s, KO);
  };
  const LANGS = {
    ko: { name: '韓国語', novel: '韓国語ウェブ小説', min: 2,
      names: '人名はカタカナ表記。店名・施設名・組織名・スキル名・アイテム名など意味のある固有名詞は、音をそのままカタカナにせず、意味が伝わる日本語にする（例：책방=本屋、固有の部分だけカタカナ）。' },
    zh: { name: '中国語', novel: '中国語ウェブ小説', min: 4,
      names: '人名・地名は原文の漢字を日本の字体（新字体）に直して使う。簡体字・繁体字のまま残さない。門派・組織・功法・スキル・アイテムなどの固有名詞は漢字を活かしつつ、日本の読者に意味が伝わる表記にする。' },
    en: { name: '英語', novel: '英語のウェブ小説', min: 8,
      names: '人名はカタカナ表記。店名・施設名・組織名・スキル名・アイテム名など意味のある固有名詞は、音をそのままカタカナにせず、意味が伝わる日本語にする（例：The Rusty Anchor=錆びた錨亭）。' },
  };
  const LANG_OPT = { auto: '自動', ko: '韓国語', zh: '中国語', en: '英語' };
  // 自動のときは本文の文字から判定（ページが変わるか数秒たつと判定し直す）
  // small=true：本文の場所が分かっている（イカ墨ノベルなど）ので、短い文でも判定する
  // 文字のまとまり（テキストノード）ごとに数えて足す：日本語のメニューやボタンが混ざっていても引きずられない
  const textsOf = root => {
    const out = [];
    try {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n, i = 0; (n = w.nextNode()) && i < 20000; i++) {
        const p = n.parentElement;
        if (p && (p.closest('#kztl-host') || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(p.tagName))) continue;
        if (n.nodeValue.trim()) out.push(n.nodeValue);
      }
    } catch { /* 読めない */ }
    return out;
  };
  const koNodes = root => (root ? textsOf(root).reduce((a, t) => a + ko(t), 0) : 0);
  function detectLang(texts, small) {
    const sc = { ko: 0, zh: 0, en: 0 };
    for (const t of texts) {
      sc.ko += cnt(t, KO);
      sc.zh += Math.max(0, countAs('zh', t));
      sc.en += Math.max(0, countAs('en', t)) / 4; // 英語は4文字≒1字として比べる
    }
    const min = small ? { ko: 2, zh: 4, en: 3 } : { ko: 20, zh: 50, en: 75 };
    const best = Object.keys(sc).filter(x => sc[x] >= min[x]).sort((x, y) => sc[y] - sc[x])[0];
    return { lang: best || 'ko', sure: !!best };
  }
  // 一度はっきり判定できた話は、その話の間は言語を変えない（訳して日本語になった後に判定がずれないように）
  const langSticky = new Map();
  const resetLang = () => { langCache.at = 0; langSticky.clear(); };
  let langCache = { at: 0, id: '', lang: 'ko' };
  function curLang() {
    const now = Date.now();
    let id = '';
    try { id = pageId(); } catch { /* 準備前 */ }
    if (now - langCache.at < 2500 && langCache.id === id) return langCache.lang;
    let set = 'auto';
    try { set = (GM_getValue('cfg', {}) || {}).lang || 'auto'; } catch { /* 準備前 */ }
    let lang = set;
    if (set === 'auto') {
      if (langSticky.has(id)) lang = langSticky.get(id);
      else if (/ridibooks|kakao\.com/.test(location.host)) lang = 'ko'; // 韓国のサイトはいつも韓国語
      else if (/(^|\.)jjwxc\.(net|com)$/.test(location.host)) lang = 'zh'; // 晋江はいつも中国語
      else {
        let mb = null, texts = [];
        try {
          mb = document.querySelector('[data-kztl-body]');
          // シャドウDOM・iframeの中の本文も見る
          texts = mb ? textsOf(mb) : deepRoots().filter(r => r !== document.body).concat(document.body ? [document.body] : []).flatMap(textsOf);
        } catch { /* 準備前 */ }
        const r = detectLang(texts, !!mb);
        lang = r.lang;
        if (r.sure) langSticky.set(id, lang);
      }
    }
    langCache = { at: now, id, lang: LANGS[lang] ? lang : 'ko' };
    return langCache.lang;
  }
  const L = () => LANGS[curLang()];
  const ko = s => countAs(curLang(), s);
  // 訳文に原文の言語が残っているか（残りの文字数。少しなら0）
  const leftIn = t => { const n = ko(t); return n >= L().min ? n : 0; };
  const hash = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36) + s.length; };

  // イカ墨ノベルなど、ページ側が作品・話の目印を出しているときはそれを使う
  //   <html data-kztl-work="作品ID" data-kztl-title="作品名" data-kztl-ep="話ID" data-kztl-ep-title="話のタイトル">
  //   本文の入れ物には data-kztl-body
  const mark = () => document.documentElement.dataset;
  const pageTitle = () => {
    const d = mark();
    return d.kztlWork ? [d.kztlTitle, d.kztlEpTitle].filter(Boolean).join(' ') || document.title : document.title;
  };

  const MODELS = { gemini: 'gemini-3.5-flash', claude: 'claude-sonnet-5', openai: 'deepseek-chat' };
  // 一覧に出す候補
  const CANDIDATES = { claude: ['claude-sonnet-5', 'claude-opus-5-5', 'claude-haiku-4-5-20251001'] };
  // 混雑時の予備（賢いモデルのみ。Lite系は入れない）
  const FALLBACKS = { gemini: 'gemini-3-flash-preview, gemini-2.5-flash', claude: '', openai: '' };
  // 作品メモの更新に使う安いモデル（空欄なら翻訳と同じモデル）
  const SHEET_MODELS = { claude: 'claude-haiku-4-5-20251001', gemini: '', openai: '' };
  const DEF = {
    mode: 'inplace', provider: 'gemini', key: '', model: '', baseUrl: 'https://api.deepseek.com', chunk: 4000, instructions: '', fallback: '', parallel: 2, adult: true, autoSheet: true, quickStart: true,
    glossary: '',
  };
  // APIキー・モデル・予備モデルはエンジンごとに別々に保存（切り替えても入れ直さなくていい）
  const cfg = () => {
    const c = Object.assign({}, DEF, GM_getValue('cfg', {}));
    const p = c.provider;
    c.keys = Object.assign({}, c.keys); c.models = Object.assign({}, c.models); c.fallbacks = Object.assign({}, c.fallbacks); c.sheetModels = Object.assign({}, c.sheetModels);
    // 旧バージョンの保存形式から引き継ぎ
    if (c.key && !(p in c.keys)) c.keys[p] = c.key;
    if (c.model && !(p in c.models)) c.models[p] = c.model;
    if (c.fallback && !(p in c.fallbacks)) c.fallbacks[p] = c.fallback;
    c.key = c.keys[p] || ''; c.model = c.models[p] || ''; c.fallback = c.fallbacks[p] || ''; c.sheetModel = c.sheetModels[p] || '';
    return c;
  };

  const sys = () => { const l = L(); return `あなたは${l.novel}を日本語に訳す文芸翻訳者です。
ルール:
- 要約・省略・加筆をしない。原文の内容をすべて訳す。
- 段落構成を保つ。入力と同じ段落数で出力し、段落の間は空行1つ。
- 直訳ではなく、日本の小説として自然な文体にする。語順・主語の省略・語尾は日本語として自然に整える。
- 会話文は人物の性格・関係性に合った口語にする。
- 与えられた文脈（話全体の原文、直前の訳文）を踏まえ、呼称・一人称・口調・代名詞を一貫させる。
- 用語集・作品メモがある場合、その訳語に必ず従う。
- ${l.names}
- 出力は訳文のみ。前置き、注釈、見出しは一切付けない。
- 文字化け・機械音声・呪文のような崩れた文や繰り返し、文字の間の空白などの演出も、${l.name}のまま残さず、同じ雰囲気の日本語で再現する。
- 原文を出力に含めない。「原文 -> 訳文」や「原文（訳文）」のような対訳形式にしない。作中のルール文・システムメッセージ・標語・引用文なども含め、${l.name}の文は一文字も残さない。表や記号（| など）の形はそのまま保ち、中の${l.name}だけを日本語にする。`; };

  const sysNum = () => sys() + `
- 入力の各段落の先頭には [[番号]] が付いている。出力でも各段落の先頭に同じ [[番号]] を同じ順で付ける。1つの番号に1段落。番号の追加・削除・統合・分割をしない。
- 段落内の <t1>…</t1> や <t2/> のようなタグは、太字・斜体・取り消し線・文字色などの装飾の目印。訳文でも、対応する語句を同じ番号のタグで囲む。タグの番号・数・入れ子を変えず、消さず、新しく作らない。<t2/> のような単独タグは対応する位置に置く。`;

  // ---------- 本文検出 ----------
  // 本文が入っていそうな場所をすべて集める：ページ本体・シャドウDOM・同じドメインのiframe
  function deepRoots() {
    const roots = [];
    const scan = (node, depth) => {
      for (const el of node.querySelectorAll('*')) {
        if (el.id === 'kztl-host') continue;
        if (el.shadowRoot) { roots.push(el.shadowRoot); scan(el.shadowRoot, depth); }
        if (el.tagName === 'IFRAME' && depth < 2) {
          try {
            const d = el.contentDocument;
            if (d && d.body) { roots.push(d.body); scan(d, depth + 1); }
          } catch { /* 別ドメインのiframeは読めない */ }
        }
      }
    };
    if (document.body) { roots.push(document.body); scan(document, 0); }
    return roots;
  }
  const koDeep = () => {
    const quick = ko(document.body?.textContent);
    if (quick > 300) return quick;
    // 本文が小さなグループに分かれている場合もあるので合計で数える
    return deepRoots().reduce((sum, r) => sum + ko(r.textContent), 0);
  };

  // その場所の中で、韓国語の85%以上を含むいちばん内側の要素
  function narrow(root, total) {
    const isFrag = root.nodeType === 11;
    let best = isFrag ? null : root, bestLen = isFrag ? Infinity : (root.innerText || root.textContent || '').length;
    for (const el of root.querySelectorAll('div,section,article,main')) {
      if (el.id === 'kztl-host' || ko(el.textContent) < total * 0.85) continue;
      const t = el.innerText || el.textContent;
      if (t && t.length <= bestLen && ko(t) >= total * 0.85) { best = el; bestLen = t.length; }
    }
    return best || root;
  }

  // 本文のまとまり（グループ）をすべて返す。カカオのように本文が小さなグループに分かれていても全部まとめて訳す
  // 本文ではない場所（コメント・前後の話へのリンク・おすすめ作品・メニューなど）
  const NON_BODY = /comment|reply|review|recommend|related|banner|footer|header|(^|[\s_-])nav|gnb|lnb|toolbar|sidebar|share|ranking|popular|advert|(^|[\s_-])ad([\s_-]|$)|episode[-_]?list|series[-_]?list|other[-_]?(book|work)|댓글|추천|리뷰/i;
  // 名前に comment などが入っていても本文の入れ物（晋江の段落コメント付き本文など）
  const BODY_OK = /paragraph_?comment_?content|noveltext|novelbody|userstuff|chapter[-_]?(content|text|body)|read[-_]?content/i;
  function inNonBody(el, stopAt) {
    for (let e = el; e && e.nodeType === 1 && e !== stopAt; e = e.parentElement) {
      if (/^(A|BUTTON|NAV|HEADER|FOOTER|ASIDE|FORM|TEXTAREA|INPUT|SELECT)$/.test(e.tagName)) return true;
      const role = e.getAttribute('role');
      if (role && /navigation|button|banner|complementary|contentinfo|dialog|form|search/.test(role)) return true;
      const idc = (e.id || '') + ' ' + (typeof e.className === 'string' ? e.className : '');
      if (idc.trim() && NON_BODY.test(idc) && !BODY_OK.test(idc)) return true;
    }
    return false;
  }
  // 本文の段落がいちばん集まっている入れ物を選ぶ（コメント欄やおすすめ欄に韓国語が多くても引きずられない）
  function bestContainer(root) {
    const paras = collectParas(root).filter(p => !inNonBody(p, root) && !isUiWord(p.textContent));
    if (!paras.length) return null;
    const score = new Map();
    for (const p of paras) {
      const k = ko(p.textContent) + (p.textContent.length > 20 ? 20 : 0);
      let e = p.parentElement, lvl = 0;
      while (e && lvl < 4 && (root.nodeType === 11 ? root.contains(e) : (e === root || root.contains(e)))) {
        score.set(e, (score.get(e) || 0) + k * [1, 0.8, 0.6, 0.4][lvl]);
        e = e.parentElement; lvl++;
      }
    }
    let best = null, bs = 0;
    for (const [e, v] of score) if (v > bs) { bs = v; best = e; }
    return best;
  }

  const markedBody = () => {
    const el = document.querySelector('[data-kztl-body]');
    return el && koNodes(el) > 0 ? el : null;
  };
  function findBodies() {
    const mb = markedBody();
    if (mb) return mark().kztlEp ? [mb] : []; // 目印のあるアプリで話をひらいていないとき（本棚・目次）は訳さない
    const sb = siteBody();
    if (sb && ko(sb.textContent) > 0) return [sb];
    const saved = GM_getValue('sel:' + location.host);
    if (saved) {
      const el = document.querySelector(saved);
      if (el && ko(el.innerText || el.textContent) > 100) return [el];
    }
    const roots = deepRoots().map(r => [r, ko(r.textContent)]).filter(([, k]) => k > 0);
    const total = roots.reduce((a, [, k]) => a + k, 0);
    if (total < 30) return [];
    const [top, topK] = roots.slice().sort((a, b) => b[1] - a[1])[0];
    // 1か所にほぼ全部あるなら、今まで通りその1か所だけ
    if (topK >= total * 0.8 && topK >= 300) {
      // カカオ以外（Ridiなど）は、コメントやおすすめ作品を避けて本文の入れ物を選ぶ
      if (!/kakao/.test(location.host)) { const b = bestContainer(top); if (b) return [b]; }
      return [narrow(top, topK)];
    }
    // 複数のグループ：韓国語が少しでもあるまとまりを、ページの順番どおりに全部使う
    // ページ本体（メニューやボタンの文字が多い）は、本文が十分あるときだけ含める
    return roots.filter(([r, k]) => k >= 2 && !(r === document.body && k < total * 0.2)).map(([r, k]) => narrow(r, k));
  }

  function findBody() {
    const mb = markedBody();
    if (mb) return mark().kztlEp ? mb : null;
    const sb = siteBody();
    if (sb && ko(sb.textContent) > 0) return sb;
    const saved = GM_getValue('sel:' + location.host);
    if (saved) {
      const el = document.querySelector(saved);
      if (el && ko(el.innerText) > 100) return el;
    }
    // 韓国語がいちばん多い場所（ページ本体・シャドウDOM・iframe）を選ぶ
    const [root, total] = deepRoots().map(r => [r, ko(r.textContent)]).sort((a, b) => b[1] - a[1])[0] || [];
    if (!root || total < 300) return null;
    const isFrag = root.nodeType === 11;
    let best = isFrag ? null : root, bestLen = isFrag ? Infinity : (root.innerText || '').length;
    for (const el of root.querySelectorAll('div,section,article,main')) {
      if (el.id === 'kztl-host' || ko(el.textContent) < total * 0.85) continue;
      const t = el.innerText || el.textContent;
      if (t && t.length <= bestLen && ko(t) >= total * 0.85) { best = el; bestLen = t.length; } // 同じ長さなら内側の要素を優先
    }
    return best || (isFrag ? root.firstElementChild : root);
  }

  function cssPath(el) {
    const parts = [];
    while (el && el.nodeType === 1 && el !== document.body) {
      if (el.id) { parts.unshift('#' + CSS.escape(el.id)); return parts.join(' > '); }
      let s = el.tagName.toLowerCase();
      const sib = [...el.parentNode.children].filter(c => c.tagName === el.tagName);
      if (sib.length > 1) s += `:nth-of-type(${sib.indexOf(el) + 1})`;
      parts.unshift(s);
      el = el.parentElement;
    }
    parts.unshift('body');
    return parts.join(' > ');
  }

  function pick() {
    let cur = null;
    const over = e => { if (cur) cur.style.outline = ''; cur = e.target; cur.style.outline = '3px solid #d0406f'; };
    const click = e => {
      e.preventDefault(); e.stopPropagation();
      if (cur) cur.style.outline = '';
      document.removeEventListener('mouseover', over, true);
      document.removeEventListener('click', click, true);
      GM_setValue('sel:' + location.host, cssPath(cur));
      alert('本文エリアを保存しました（' + ko(cur.innerText) + '文字の' + L().name + 'を検出）');
    };
    document.addEventListener('mouseover', over, true);
    document.addEventListener('click', click, true);
  }

  // ---------- API ----------
  // sse：{ parse, onText } を渡すと、ストリーミングで届いた途中の訳文を onText に流す（料金は同じ）
  function req(url, headers, body, sse) {
    return new Promise((res, rej) => {
      let lastLen = 0, lastAt = 0, handled = false;
      const progress = t => {
        if (!sse || !sse.onText || !t || t.length === lastLen) return;
        const now = Date.now();
        if (now - lastAt < 250) return;
        lastLen = t.length; lastAt = now;
        try { sse.onText(sse.parse(t).text); } catch { /* 途中の表示に失敗しても本体には影響しない */ }
      };
      const finish = (status, txt, headersText) => {
        // ストリーム受信ではステータスが取れないことがあるので、中身から判断する
        if (!status) {
          status = 200;
          try {
            const j = JSON.parse(txt);
            if (j.error) status = j.error.code || (j.error.type === 'rate_limit_error' ? 429 : j.error.type === 'overloaded_error' ? 529 : 400);
          } catch { /* SSEなら正常 */ }
        }
        if (status >= 400) {
          let msg = txt.slice(0, 200);
          try { msg = JSON.parse(txt).error?.message || msg; } catch { /* JSONでない */ }
          const err = new Error(status + ': ' + msg);
          const ra = /retry-after:\s*(\d+)/i.exec(headersText || '');
          err.retryAfter = ra ? +ra[1] : 0; // サーバーが指定した待ち時間（秒）
          return rej(err);
        }
        if (sse) {
          try { return res(sse.parse(txt)); } catch { return rej(new Error('応答を読めません (' + status + ')')); }
        }
        try { res(JSON.parse(txt)); } catch { rej(new Error('応答を読めません (' + status + ')')); }
      };
      // Firefox以外（Chrome・Edge・Safari）では拡張経由だと最後にまとめて届くことがあるので、まずブラウザの通信で直接受け取る
      if (sse && sse.onText && !noDirect && !/Firefox\//.test(navigator.userAgent)) {
        directStream(url, headers, body, progress).then(r => {
          if (r) finish(r.status, r.txt, r.headers); else viaGM();
        }, e => rej(e));
        return;
      }
      viaGM();
      function viaGM() {
      // Tampermonkeyは「stream」で受け取ると途中経過が届く。ほかの拡張は onprogress で届く場合だけ途中表示
      const useStream = !!(sse && sse.onText) && typeof GM_info !== 'undefined' && /tampermonkey/i.test(GM_info.scriptHandler || '');
      GM_xmlhttpRequest({
        method: 'POST', url, timeout: 300000,
        headers: Object.assign({ 'content-type': 'application/json' }, headers),
        data: JSON.stringify(body),
        ...(useStream ? { responseType: 'stream' } : {}),
        onloadstart: async r => {
          const stream = r && r.response;
          if (!useStream || !stream || typeof stream.getReader !== 'function') return;
          handled = true;
          const reader = stream.getReader(), dec = new TextDecoder();
          let txt = '';
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              txt += typeof value === 'string' ? value : dec.decode(value, { stream: true });
              progress(txt);
            }
          } catch (e) { return rej(new Error('通信エラー（' + (e && e.message) + '）')); }
          finish(r.status, txt, r.responseHeaders);
        },
        onprogress: r => { if (!handled) progress(r && r.responseText); },
        onreadystatechange: r => { if (!handled && r.readyState === 3) progress(r.responseText); },
        onload: r => { if (!handled) finish(r.status, r.responseText || '', r.responseHeaders); },
        onerror: r => rej(new Error('通信エラー（' + [r && r.status, r && (r.error || r.statusText)].filter(Boolean).join(' ') + '）')),
        ontimeout: () => rej(new Error('タイムアウト')),
      });
      }
    });
  }

  // ブラウザの通信（fetch）で直接ストリーミング受信。サイトの制限で使えなければ null を返して拡張経由に切り替える
  let noDirect = false;
  async function directStream(url, headers, body, progress) {
    let r;
    try {
      r = await fetch(url, {
        method: 'POST', mode: 'cors', credentials: 'omit',
        headers: Object.assign({ 'content-type': 'application/json' }, headers),
        body: JSON.stringify(body),
      });
    } catch { noDirect = true; return null; } // ページ側の制限（CSPなど）で送れない
    const hs = [...r.headers].map(([k, v]) => k + ': ' + v).join('\n');
    if (!r.body || !r.body.getReader) return { status: r.status, txt: await r.text(), headers: hs };
    const reader = r.body.getReader(), dec = new TextDecoder();
    let txt = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        txt += dec.decode(value, { stream: true });
        progress(txt);
      }
    } catch (e) { throw new Error('通信エラー（' + (e && e.message) + '）'); }
    return { status: r.status, txt, headers: hs };
  }

  // メインのモデル → 混雑時は予備モデルへ
  function modelList(c) {
    const main = c.model.trim() || MODELS[c.provider];
    const fb = (c.fallback.trim() || FALLBACKS[c.provider]).split(/[,\s]+/).filter(Boolean);
    return [...new Set([main, ...fb])];
  }

  // Geminiで今使えるモデル一覧（Lite・画像・音声系は除外）
  function listGeminiModels(key) {
    return new Promise((res, rej) => GM_xmlhttpRequest({
      method: 'GET', url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',
      headers: { 'x-goog-api-key': key }, timeout: 30000,
      onload: r => {
        try {
          const j = JSON.parse(r.responseText);
          if (r.status >= 400) return rej(new Error(r.status + ': ' + (j.error?.message || '')));
          res((j.models || [])
            .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
            .map(m => m.name.replace(/^models\//, ''))
            .filter(n => /^gemini-\d/.test(n) && !/lite|image|tts|audio|live|embed|robotics|computer|nano/i.test(n))
            .sort().reverse());
        } catch (e) { rej(e); }
      },
      onerror: () => rej(new Error('通信エラー')), ontimeout: () => rej(new Error('タイムアウト')),
    }));
  }

  // ---------- ストリーミング応答の読み取り ----------
  const sseEvents = t => t.split(/\r?\n/).filter(l => l.startsWith('data:'))
    .map(l => { try { return JSON.parse(l.slice(5).trim()); } catch { return null; } }).filter(Boolean);
  const parseClaude = t => {
    let text = '', stop = '', err = null;
    for (const e of sseEvents(t)) {
      if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') text += e.delta.text;
      else if (e.type === 'message_delta' && e.delta?.stop_reason) stop = e.delta.stop_reason;
      else if (e.type === 'error') err = e.error || { message: 'error' };
    }
    return { text, stop, err };
  };
  const parseGemini = t => {
    let text = '', block = '', finish = '', err = null;
    for (const e of sseEvents(t)) {
      if (e.error) err = e.error;
      if (e.promptFeedback?.blockReason) block = e.promptFeedback.blockReason;
      const cand = e.candidates?.[0];
      for (const p of cand?.content?.parts || []) if (!p.thought) text += p.text || '';
      if (cand?.finishReason) finish = cand.finishReason;
    }
    return { text, block, finish, err };
  };
  const parseOpenAI = t => {
    let text = '';
    for (const e of sseEvents(t)) text += e.choices?.[0]?.delta?.content || '';
    return { text };
  };

  async function llm(c, system, user, modelOverride, onText) {
    const model = modelOverride || c.model.trim() || MODELS[c.provider];
    const ctx = user && typeof user === 'object' ? user.ctx : '';
    const msg = user && typeof user === 'object' ? user.msg : user;
    const flat = ctx + msg; // 共通部分を先頭に置く（Geminiの自動キャッシュが効きやすい）
    if (c.provider === 'gemini') {
      // 翻訳に「考える時間」は不要なので思考をオフ／最小にして高速化
      const gc = { temperature: 0.8, maxOutputTokens: 32768 };
      if (/gemini-2\.5-flash(?!-lite)/.test(model)) gc.thinkingConfig = { thinkingBudget: 0 };
      // 3系：Flashは最小（minimal）、Proは最小がlow
      else if (/gemini-3/.test(model)) gc.thinkingConfig = { thinkingLevel: /pro/.test(model) ? 'low' : 'minimal' };
      // 小説の翻訳なので、成人向け表現のブロックを外せるようにする（未成年に関わる内容などはGoogle側で常にブロック）
      const safetySettings = c.adult ? ['HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_HATE_SPEECH',
        'HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_DANGEROUS_CONTENT'].map(category => ({ category, threshold: 'BLOCK_NONE' })) : undefined;
      const key = c.key;
      const call = () => req(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
        { 'x-goog-api-key': key }, {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: flat }] }],
          generationConfig: gc,
          safetySettings,
        }, { parse: parseGemini, onText });
      let j;
      try { j = await call(); }
      catch (e) {
        if (!(/^400/.test(e.message) && /think/i.test(e.message)) || !gc.thinkingConfig) throw e;
        // minimalが使えないモデルならlowで再送
        if (gc.thinkingConfig.thinkingLevel === 'minimal') gc.thinkingConfig = { thinkingLevel: 'low' };
        else delete gc.thinkingConfig;
        j = await call();
      }
      if (j.err) throw new Error((j.err.code || 500) + ': ' + (j.err.message || 'error'));
      if (j.block) throw new Error('BLOCKED: ' + j.block);
      if (!j.text.trim() && j.finish && j.finish !== 'STOP') throw new Error('BLOCKED: ' + j.finish);
      return j.text;
    }
    if (c.provider === 'claude') {
      const j = await req('https://api.anthropic.com/v1/messages', {
        'x-api-key': c.key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true',
      }, {
        model, max_tokens: 32000, stream: true,
        // 話全体の原文などの共通部分をキャッシュ：2回目以降の塊は入力が約1/10の料金になり、回数制限にも当たりにくくなる
        system: [{ type: 'text', text: system },
          ...(ctx ? [{ type: 'text', text: ctx, cache_control: { type: 'ephemeral' } }] : [])],
        messages: [{ role: 'user', content: msg }],
      }, { parse: parseClaude, onText });
      if (j.err) {
        // 途中で混雑・回数制限になった場合も、待って再試行できるようにする
        const code = j.err.type === 'overloaded_error' ? 529 : j.err.type === 'rate_limit_error' ? 429 : 500;
        throw new Error(code + ': ' + (j.err.message || j.err.type));
      }
      if (j.stop === 'refusal') throw new Error('BLOCKED: refusal');
      return j.text;
    }
    const j = await req(c.baseUrl.replace(/\/$/, '') + '/chat/completions', { authorization: 'Bearer ' + c.key }, {
      model, max_tokens: 8192, temperature: 1.0, stream: true,
      messages: [{ role: 'system', content: system }, { role: 'user', content: flat }],
    }, { parse: parseOpenAI, onText });
    return j.text;
  }

  // 混雑(503)・回数制限(429)は、まず予備モデルに即切り替え。全部だめなときだけ待って再試行
  // 待ち中の表示：429は回数制限、それ以外は混雑
  const waitMsg = (ms, n, code, count) => {
    const sec = Math.round(ms / 1000);
    if (code === 429) return `回数制限中… ${sec}秒後に再試行（${n}回目）。頻繁に出るなら「同時に送る数」を減らしてください`;
    return `${count > 1 ? '全モデル' : ''}混雑中… ${sec}秒後に再試行（${n}回目）`;
  };
  const badModels = new Set(); // 存在しなかったモデルは以後使わない
  async function withRetry(fn, models, onWait) {
    let list = models.filter(m => !badModels.has(m)), lastErr = new Error('使えるモデルがありません。設定のモデル名を確認してください');
    let lastCode = 0, retryAfter = 0;
    for (let round = 0; ; round++) {
      for (const m of [...list]) {
        try { return await fn(m); }
        catch (e) {
          lastErr = e;
          const code = +((e.message.match(/^(\d{3})/) || [])[1] || 0);
          if (code === 404) { badModels.add(m); list = list.filter(x => x !== m); continue; }
          // 1日の無料枠切れは待っても戻らないので、そのモデルは今日は使わない
          if (code === 429 && /per ?day|PerDay|daily/i.test(e.message)) {
            badModels.add(m); list = list.filter(x => x !== m);
            lastErr = new Error(`今日の無料枠を使い切りました（${m}）。明日また使えます`);
            continue;
          }
          // 529はClaudeの混雑
          const temporary = [429, 500, 502, 503, 504, 529].includes(code) || /通信エラー|タイムアウト/.test(e.message);
          if (temporary) { lastCode = code; retryAfter = Math.max(retryAfter, e.retryAfter || 0); }
          if (!temporary) throw e;
        }
      }
      if (!list.length || round >= 4) throw lastErr;
      const wait = Math.min(90000, Math.max(5000 * 2 ** round, retryAfter * 1000 + 500));
      onWait(wait, round + 1, lastCode, list.length);
      retryAfter = 0;
      await new Promise(r => setTimeout(r, wait));
    }
  }

  // ---------- 分割・並列 ----------
  // 最初の塊は小さくしてすぐ表示、残りは並列で処理
  // quick=true：冒頭だけ先に小さく送ってすぐ表示。false：最初から上限まで詰める（1話1回で済むことが多く安い）
  function makeChunks(lens, limit, quick = true) {
    const first = quick ? Math.min(1200, limit) : limit, chunks = [];
    let buf = [], len = 0;
    lens.forEach((l, i) => {
      const lim = chunks.length ? limit : first;
      if (buf.length && len + l > lim) { chunks.push(buf); buf = []; len = 0; }
      buf.push(i); len += l + 8;
    });
    if (buf.length) chunks.push(buf);
    return chunks;
  }

  async function pool(n, count, worker) {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, count) }, async () => {
      while (next < count) await worker(next++);
    }));
  }

  // ---------- 作品メモ（人物・用語・口調を話をまたいで共有） ----------
  // タイトルの数字（話数）を伏せたものを作品のキーにする
  // ---------- 作品ごとの記録（人物・用語メモと「前の話の最後」）----------
  // 作品の見分け方：カカオはアドレスの作品番号、それ以外はタイトルから話数やサイト名を除いたもの
  const workName = () => (mark().kztlWork ? mark().kztlTitle || mark().kztlWork : document.title)
    .replace(/\s*[|｜\-–:]\s*(카카오페이지|카카오 페이지|리디북스|리디|RIDI|RIDIBOOKS|네이버 ?시리즈|NAVER|문피아|MUNPIA|노벨피아|NOVELPIA|조아라|JOARA|포스타입|POSTYPE|블라이스|BLICE|원스토리|ONESTORE|밀리의 ?서재|북큐브|미스터블루|봄툰|레진|교보문고|예스24|알라딘)[^|｜]*$/i, '')
    .replace(/\d+\s*(화|話|권|편|회|부)?/g, '#').replace(/\s+/g, ' ').trim();
  function workKey() {
    if (mark().kztlWork) return 'ikasumi:' + mark().kztlWork;
    const m = location.pathname.match(/\/content\/(\d+)/);
    if (/kakao/.test(location.host) && m) return 'kakao:' + m[1];
    return location.host + ':' + workName();
  }
  const oldSheetKey = () => 'sheet:' + location.host + ':' + document.title.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  const sheetKey = () => 'sheet:' + workKey();
  const getSheet = () => {
    let v = GM_getValue(sheetKey(), '');
    if (!v) { // 前のバージョンの保存場所から引き継ぐ
      const old = GM_getValue(oldSheetKey(), '');
      if (old) { GM_setValue(sheetKey(), old); v = old; }
    }
    return v;
  };

  // この作品で最後に訳した話の終わりの部分。次の話を訳すとき、話の続きとして文体・呼称をそろえるのに使う
  const tailKey = () => 'tail:' + workKey();
  function saveTail(text) {
    const t = String(text || '').replace(/<\/?t\d+\/?>/g, '').trim();
    if (t) GM_setValue(tailKey(), { ep: pageId(), text: t.slice(-1500), at: Date.now() });
  }
  // 段落ごとの訳の記録（作品ごと）。ページの作りが端末で違っても、同じ段落なら記録から出せる
  // ---------- エンジンごとに訳を分けて保存（Claude版とGemini版を両方残す）----------
  const prov = () => cfg().provider || 'gemini';
  const PROV_NAME = { gemini: 'Gemini', claude: 'Claude', openai: 'DeepSeek' };
  const provName = () => PROV_NAME[prov()] || prov();
  const legacyDone = new Set();
  // 前のバージョンの記録（エンジン名なし）は、そのエンジンでまだ訳していなければ引き継ぐ
  function tagged(base) {
    const k = base + '@' + prov();
    if (!legacyDone.has(k)) {
      legacyDone.add(k);
      if (GM_getValue(k, null) == null) { const old = GM_getValue(base, null); if (old != null) KZ_SET(k, old); }
    }
    return k;
  }
  const paraKey = () => tagged('para:' + workKey());
  const getParaMap = () => GM_getValue(paraKey(), null) || {};
  function saveParas(srcs, tr) {
    const m = getParaMap();
    let n = 0;
    srcs.forEach((src, i) => { if (tr[i] != null && !needsFix(tr[i]) && m[src] !== tr[i]) { m[src] = tr[i]; n++; } });
    if (n) GM_setValue(paraKey(), m);
  }

  function prevTail() {
    const v = GM_getValue(tailKey(), null);
    return v && v.ep !== pageId() ? v.text : '';
  }

  // 訳し終わったあとに裏で更新する（読むのは待たせない）
  async function updateSheet(c, src, trText) {
    if (!c.autoSheet || !trText.trim()) return;
    const k = sheetKey(), old = GM_getValue(k, '');
    const user = `【現在のメモ】\n${old || '（なし）'}\n\n【今回の話の原文】\n${src.slice(0, 30000)}\n\n【今回の訳文】\n${trText.slice(0, 30000)}\n\n`
      + `今回の訳文で実際に使われた訳し方に合わせて、メモを更新した全文を出力してください。\n`
      + `人物は1行に「原語=訳語｜性別｜一人称｜話し方・呼び方・関係」、用語は「原語=訳語｜用語｜短い説明」。\n`
      + `登場人物と繰り返し出る固有名詞だけ、最大50行。既存の項目は矛盾がない限り変えない。メモ本文のみ出力。`;
    try {
      const sm = c.sheetModel.trim() || SHEET_MODELS[c.provider];
      const models = sm ? [sm, ...modelList(c)] : modelList(c); // 安いモデルが使えなければ翻訳用のモデルで
      const res = await withRetry(m => llm(c, `あなたは${L().novel}を日本語に訳すための人物・用語メモを管理する編集者です。`, user, m), models, () => {});
      const sheet = res.replace(/^```\w*\n?|```$/g, '').trim().slice(0, 6000);
      if (sheet) GM_setValue(k, sheet);
    } catch { /* メモの更新に失敗しても翻訳には影響しない */ }
  }

  // ctx：その話の中で毎回同じ部分（キャッシュされる）／msg：塊ごとに変わる部分
  function buildUser(c, whole, ref, refLabel, body) {
    let user = `【ページタイトル】${pageTitle()}\n\n`;
    if (c.instructions.trim()) user += `【追加の指示（必ず従う。作品名の指定がある行は、ページタイトルが一致する作品にだけ適用）】\n${c.instructions.trim()}\n\n`;
    if (c.glossary.trim()) user += `【用語集（原語=訳語）】\n${c.glossary.trim()}\n\n`;
    const sheet = getSheet();
    if (sheet) user += `【この作品の人物・用語メモ（訳語・一人称・口調・呼び方はこれに合わせる）】\n${sheet}\n\n`;
    const tail = prevTail();
    if (tail) user += `【この作品の前に読んだ話の最後の訳文（話の続きとして、文体・呼称・一人称をそろえる。ここは訳さない）】\n${tail}\n\n`;
    if (whole) user += `【この話の原文全体（文脈把握用。ここは訳さない）】\n${whole}\n\n`;
    let msg = '';
    if (ref) msg += `【${refLabel}（文体・呼称・一人称を合わせる）】\n${ref.slice(-1500)}\n\n`;
    msg += `【今回訳す部分】\n${body}`;
    return { ctx: user, msg };
  }

  // ---------- 晋江文学城など：本文の場所・<br>区切り ----------
  // サイトごとの本文の入れ物（見つからなければ自動で探す）
  const SITE_BODY = [
    [/(^|\.)jjwxc\.(net|com)$/, 'div.noveltext, #novelbody, .noveltext, #content'],
    [/(^|\.)(archiveofourown\.org|ao3\.org)$/, '#workskin, #chapters'], // AO3：題名・あらすじ・前書き・本文・後書き
  ];
  const siteBody = () => {
    for (const [re, sel] of SITE_BODY) if (re.test(location.host)) { const el = document.querySelector(sel); if (el) return el; }
    return null;
  };
  const isJJ = () => /(^|\.)jjwxc\.(net|com)$/.test(location.host);

  // 「文<br>文<br><br>文」のように<br>だけで区切られた本文を、1行ずつの段落に分ける（見た目は同じ）
  const BLOCK_TAG = /^(P|DIV|H[1-6]|UL|OL|LI|BLOCKQUOTE|TABLE|SECTION|ARTICLE|HR|PRE|FIGURE|DL|DD|DT|FORM|CENTER)$/;
  function splitBr(root) {
    // 改行文字で行を分けている作り（white-space: pre など）は、先に<br>に直す
    for (const el of [root, ...root.querySelectorAll('*')]) {
      if (el.closest('#kztl-host') || !/^pre|break-spaces/.test(getComputedStyle(el).whiteSpace)) continue;
      for (const n of [...el.childNodes]) {
        if (n.nodeType !== 3 || !n.nodeValue.includes('\n') || !ko(n.nodeValue)) continue;
        const frag = el.ownerDocument.createDocumentFragment();
        n.nodeValue.split('\n').forEach((line, i) => { if (i) frag.appendChild(el.ownerDocument.createElement('br')); if (line) frag.appendChild(el.ownerDocument.createTextNode(line)); });
        el.replaceChild(frag, n);
      }
    }
    const isInline = n => n.nodeType === 3 || (n.nodeType === 1 && !BLOCK_TAG.test(n.tagName) && n.tagName !== 'BR');
    const targets = [root, ...root.querySelectorAll('*')].filter(el => el.nodeType === 1 && !el.closest('#kztl-host') &&
      [...el.childNodes].filter(n => n.nodeName === 'BR').length >= 2 &&
      [...el.childNodes].some(n => isInline(n) && ko(n.textContent) > 0)); // 文字が<span>や<font>に入っていてもOK
    let made = 0;
    for (const el of targets) {
      let run = [];
      const flush = br => {
        const has = run.some(n => (n.textContent || '').trim());
        if (has) {
          const d = el.ownerDocument.createElement('div');
          d.className = 'kztl-line';
          el.insertBefore(d, run[0]);
          run.forEach(n => d.appendChild(n));
          if (br) br.remove(); // 行の終わりの<br>は段落が代わりをする（空行の<br>は残す）
          made++;
        }
        run = [];
      };
      for (const n of [...el.childNodes]) {
        if (n.nodeName === 'BR') flush(n);
        else if (!isInline(n)) flush(null);
        else run.push(n);
      }
      flush(null);
    }
    return made;
  }

  // 訳す前の下ごしらえ（晋江だけ：<br>区切りの段落分け・見えない字と透かしの文を消す）
  async function prepBodies(c, roots) {
    // <br>だけで区切られた本文は1行ずつの段落に。韓国語は今までどおり（保存済みの訳と段落がずれて訳し直しにならないように）
    if (curLang() !== 'ko' || isJJ()) roots.forEach(splitBr);
    if (!isJJ()) return { err: null };
    for (const root of roots) {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n; (n = w.nextNode());) {
        const v = n.nodeValue.replace(/‌/g, '').replace(/@?无限好文，?尽在晋江文学城/g, '');
        if (v !== n.nodeValue) n.nodeValue = v;
      }
    }
    return { err: null };
  }

  // ---------- 翻訳 ----------
  let busy = false;
  const setBusy = v => { busy = v; try { ui.setBusy(v); } catch { /* 画面の準備前 */ } if (!v) try { snapLater(); if (keep) setTimeout(reapplyKeep, 50); } catch { /* 準備前 */ } };
  let lastText = '', lastHref = '';
  let copyCtx = null; // 上書きモードのとき：ページの並びどおりにコピーを組み立てるための情報
  // 話の見分けはアドレスの「?」「#」より前だけで行う（読み進めると末尾が変わるサイトがあるため）
  const pageId = () => location.host + location.pathname + (mark().kztlEp ? '#' + mark().kztlEp : '');
  function setLast(t) { lastText = t || ''; lastHref = pageId(); ui.canCopy(!!lastText); }
  function copyText() {
    if (!lastText) {
      // 開き直した直後でも、この話で訳した記録があればそれをコピーする
      const ld = liveData && liveData.key === liveKey() ? liveData : GM_getValue(liveKey(), null);
      if (ld) { liveData = ld; liveData.key = liveKey(); if (liveEntries().length) setLast(liveText()); }
    }
    if (!lastText || lastHref !== pageId()) return ui.toast('この話の訳がまだありません', 2500);
    let text = lastText;
    if (copyCtx && copyCtx.href === pageId()) {
      try { text = buildCopy(copyCtx) || lastText; } catch { /* 失敗したら単純なコピー */ }
    }
    try { GM_setClipboard(text, 'text'); }
    catch { navigator.clipboard?.writeText(text); }
    ui.toast(`訳文をコピーしました（${text.length}字）`, 2500);
  }

  // ---------- 訳したページを見た目ごとHTMLファイルに保存 ----------
  const SAVE_PROPS = ['display', 'color', 'background-color', 'font-weight', 'font-style', 'font-size', 'font-family',
    'text-decoration-line', 'text-decoration-color', 'text-align', 'text-indent', 'line-height', 'letter-spacing', 'white-space',
    'vertical-align', 'margin-top', 'margin-bottom', 'margin-left', 'margin-right', 'padding-top', 'padding-bottom',
    'padding-left', 'padding-right', 'border-top', 'border-bottom', 'border-left', 'border-right', 'border-radius'];
  const BOX_PROPS = ['width', 'height']; // 黒塗りの箱など、中身のない装飾だけ大きさも残す

  function pageBackground(el) {
    for (let e = el; e && e.nodeType === 1; e = e.parentElement || (e.getRootNode() && e.getRootNode().host)) {
      const bg = getComputedStyle(e).backgroundColor;
      if (bg && bg !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(bg)) return bg;
    }
    return '#ffffff';
  }

  // 色の透明度（スクロール演出で薄くなっている文字など）は外して保存する
  const solid = v => String(v).replace(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*(0?\.\d+|1)\)/g, (m, r, g, b, a) => (+a > 0 ? `rgb(${r}, ${g}, ${b})` : m));

  function inlineClone(src) {
    const clone = src.cloneNode(true);
    const a = [src, ...src.querySelectorAll('*')], b = [clone, ...clone.querySelectorAll('*')];
    a.forEach((o, i) => {
      const c = b[i];
      if (!c) return;
      if (/^(SCRIPT|STYLE|NOSCRIPT|IFRAME|BUTTON|INPUT)$/.test(o.tagName) || o.id === 'kztl-host') { c.remove(); return; }
      const cs = getComputedStyle(o);
      if (cs.display === 'none') { c.remove(); return; }
      const props = [...SAVE_PROPS];
      if (!o.textContent.trim()) props.push(...BOX_PROPS);
      c.setAttribute('style', props.map(p => `${p}:${solid(cs.getPropertyValue(p))}`).join(';'));
      for (const at of [...c.attributes]) if (/^on/i.test(at.name) || at.name === 'class' || at.name === 'id') c.removeAttribute(at.name);
      if (c.tagName === 'IMG' && o.src) c.setAttribute('src', o.src);
      if (c.tagName === 'A') c.removeAttribute('href');
    });
    return clone;
  }

  function saveHtml() {
    if (!copyCtx && (liveData?.key === liveKey() || GM_getValue(liveKey(), null))) {
      if (!liveData || liveData.key !== liveKey()) liveData = GM_getValue(liveKey(), null);
      return liveSaveHtml();
    }
    const ctx = copyCtx;
    if (!ctx || ctx.href !== pageId() || !inPlaceOn) return ui.toast('先にこの話を「訳」で翻訳してください', 3000);
    const roots = ctx.roots || [ctx.root];
    const firstEl = roots.map(r => (r.nodeType === 11 ? r.firstElementChild : r)).find(Boolean) || document.body;
    // グループごとに複製して、元の見た目（計算済みのスタイル）を直接書き込む
    const parts = roots.map(r => {
      const wrap = document.createElement('div');
      (r.nodeType === 11 ? [...r.children] : [r]).forEach(e => wrap.appendChild(inlineClone(e)));
      return wrap.innerHTML;
    });
    const src = firstEl;
    const bodyHtml = parts.join('\n<div style="height:2em"></div>\n');
    const title = pageTitle().replace(/\s+/g, ' ').trim() || 'translation';
    const esc = t => t.replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
    const w = Math.round(src.getBoundingClientRect().width) || 720;
    let data = null;
    try { data = episodeData(ctx); } catch { /* リーダー用データが作れなくても保存はする */ }
    snapshotEp();
    const dataTag = data ? `<script type="application/json" id="kztl-episode">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>\n` : '';
    const html = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}（翻訳）</title>
${dataTag}</head>
<body style="margin:0;background:${pageBackground(src)}">
<main style="max-width:${Math.max(w, 320)}px;margin:0 auto;padding:16px;box-sizing:border-box">
${bodyHtml}
</main></body></html>`;
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) + '（' + provName() + '）.html';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    ui.toast('この話をHTMLファイルで保存しました（ダウンロードを確認してください）', 3500);
  }

  // ページの見た目どおりにコピー用テキストを作る：
  // ＊＊＊ などの区切りや韓国語のない行も含め、段落の間の空き具合を空行の数で再現する
  // グループごとに並べ、グループの間には空行を1つ以上入れる
  function layoutLines(ctx) {
    const roots = ctx.roots || [ctx.root];
    const out = [];
    roots.forEach((root, gi) => {
      const lines = layoutRoot({ ...ctx, root });
      if (gi > 0 && lines.length && out.length) lines[0].blanks = Math.max(1, lines[0].blanks);
      out.push(...lines);
    });
    return out;
  }

  function layoutRoot({ root, els, tr, srcs }) {
    const idx = new Map(els.map((e, i) => [e, i]));
    const isBlock = e => {
      const d = getComputedStyle(e).display;
      return d !== 'none' && d !== 'contents' && !d.startsWith('inline');
    };
    const inTranslated = e => { for (const p of idx.keys()) if (p !== e && p.contains(e)) return true; return false; };
    const items = []; // { el, text } または { empty: true }
    for (const e of root.querySelectorAll('*')) {
      if (e.closest('#kztl-host')) continue;
      if (idx.has(e)) {
        const i = idx.get(e);
        items.push({ el: e, text: toPlain(e, tr[i] ?? srcs[i]) });
        continue;
      }
      if (!isBlock(e) || inTranslated(e) || (!/kakao/.test(location.host) && inNonBody(e, root))) continue;
      const hasBlockChild = [...e.children].some(ch => isBlock(ch) && getComputedStyle(ch).display !== 'none');
      if (hasBlockChild) continue;
      const t = (e.innerText || e.textContent || '').replace(/\u00a0/g, ' ').trim();
      if (t && !isReadable(e, true)) continue; // 画面では見えない文字の行は入れない
      if (t) items.push({ el: e, text: t });
      else if (e.tagName !== 'IMG') items.push({ empty: true }); // 空の段落 = 空行
    }
    const lines = items.filter(x => !x.empty);
    if (!lines.length) return [];

    // 画面上の位置が取れるなら、段落の間の空きから空行の数を計算する
    const rects = lines.map(x => x.el.getBoundingClientRect());
    const gaps = [];
    for (let k = 1; k < lines.length; k++) {
      const a = rects[k - 1], b = rects[k];
      gaps.push(a.height > 0 && b.height > 0 && b.top >= a.bottom - 2 ? b.top - a.bottom : null);
    }
    const valid = gaps.filter(g => g != null).sort((x, y) => x - y);
    const useRects = valid.length >= Math.max(1, gaps.length * 0.6);
    let g0 = 0, pitch = 1;
    if (useRects) {
      g0 = valid[Math.floor(valid.length / 4)]; // ふつうの段落間の空き（空行のある所より小さい側を採用）
      // 1行の高さ：いちばん低い段落（1行だけの段落）の高さ。取れなければCSSから
      const hs = rects.map(r => r.height).filter(h => h > 0);
      const cs = getComputedStyle(lines[0].el);
      const lh = (hs.length ? Math.min(...hs) : 0) || parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 16) * 1.6;
      pitch = Math.max(8, lh + Math.max(0, g0));
    }

    // 並びどおりに、各行の前に入る空行の数を決める（空の段落の数、または見た目の空き）
    const res = [];
    let li = 0, emptyRun = 0;
    for (const x of items) {
      if (x.empty) { emptyRun++; continue; }
      let blanks = 0;
      if (li > 0) {
        blanks = emptyRun;
        if (useRects && gaps[li - 1] != null) blanks = Math.max(0, Math.round((gaps[li - 1] - g0) / pitch));
      }
      res.push({ el: x.el, text: x.text, blanks: Math.min(blanks, 10) });
      li++; emptyRun = 0;
    }
    return res;
  }

  function buildCopy(ctx) {
    return layoutLines(ctx).map((x, k) => (k ? '\n' + '\n'.repeat(x.blanks) : '') + x.text).join('');
  }

  // ---------- 小説リーダー用のデータ（保存したHTMLに埋め込む） ----------
  const escHtml = t => t.replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
  const INLINE_KEYS = [['fontWeight', 'font-weight'], ['fontStyle', 'font-style'], ['color', 'color'],
    ['backgroundColor', 'background-color'], ['textDecorationLine', 'text-decoration-line'], ['fontSize', 'font-size'],
    ['verticalAlign', 'vertical-align'], ['letterSpacing', 'letter-spacing']];

  // 段落の中身を、装飾をstyle付きのspanにしたHTMLにする（サイトのclassに頼らない形）
  function inlineHtml(el) {
    const walk = (node, base) => {
      let out = '';
      for (const ch of node.childNodes) {
        if (ch.nodeType === 3) { out += escHtml(ch.nodeValue); continue; }
        if (ch.nodeType !== 1) continue;
        const tag = ch.tagName;
        if (tag === 'BR') { out += '<br>'; continue; }
        if (tag === 'SCRIPT' || tag === 'STYLE') continue;
        const cs = getComputedStyle(ch);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        if (tag === 'IMG') { out += inlineImgHtml(ch); continue; }
        const diff = INLINE_KEYS.filter(([k]) => solid(cs[k]) !== solid(base[k])).map(([k, css]) => `${css}:${solid(cs[k])}`);
        const inner = walk(ch, cs);
        if (!inner.trim()) {
          // 中身のない装飾（黒塗りの箱など）は大きさも含めて残す
          if (cs.backgroundColor && !/rgba\([^)]*,\s*0\)$|transparent/.test(cs.backgroundColor)) {
            out += `<span style="display:inline-block;width:${cs.width};height:${cs.height};background-color:${cs.backgroundColor};vertical-align:${cs.verticalAlign}"></span>`;
          } else out += inner;
          continue;
        }
        out += diff.length ? `<span style="${diff.join(';')}">${inner}</span>` : inner;
      }
      return out;
    };
    return walk(el, getComputedStyle(el)).replace(/\s+/g, ' ').trim();
  }

  function episodeData(ctx) {
    const lines = layoutLines(ctx);
    if (!lines.length) return null;
    // いちばん多い文字色・文字サイズを「ふつう」とみなし、違う段落だけ指定する
    const mode = arr => { const m = new Map(); arr.forEach(v => m.set(v, (m.get(v) || 0) + 1)); return [...m].sort((a, b) => b[1] - a[1])[0]?.[0]; };
    const styles = lines.map(x => getComputedStyle(x.el));
    const baseColor = mode(styles.map(c => solid(c.color)));
    const baseSize = parseFloat(mode(styles.map(c => c.fontSize))) || 16;
    const baseWeight = mode(styles.map(c => c.fontWeight)), baseStyle = mode(styles.map(c => c.fontStyle));
    const paras = [];
    lines.forEach((x, k) => {
      for (let b = 0; b < x.blanks; b++) paras.push({ blank: true });
      const cs = styles[k];
      let html = inlineHtml(x.el);
      const wrap = [];
      if (cs.fontWeight !== baseWeight) wrap.push('font-weight:' + cs.fontWeight);
      if (cs.fontStyle !== baseStyle) wrap.push('font-style:' + cs.fontStyle);
      if (cs.textDecorationLine && cs.textDecorationLine !== 'none') wrap.push('text-decoration-line:' + cs.textDecorationLine);
      if (wrap.length) html = `<span style="${wrap.join(';')}">${html}</span>`;
      const para = { html, text: x.text };
      const al = cs.textAlign === 'start' || cs.textAlign === 'justify' ? 'left' : cs.textAlign === 'end' ? 'right' : cs.textAlign;
      if (al && al !== 'left') para.align = al;
      if (solid(cs.color) !== baseColor) para.color = solid(cs.color);
      const ratio = (parseFloat(cs.fontSize) || baseSize) / baseSize;
      if (Math.abs(ratio - 1) > 0.05) para.sizeRatio = Math.round(ratio * 100) / 100;
      paras.push(para);
    });
    return { v: 1, title: pageTitle().replace(/\s+/g, ' ').trim(), source: location.href, baseSize, paras };
  }
  async function translate(force) {
    if (busy) return;
    const el = findBody();
    ui.open();
    if (!el) return ui.status('本文が見つかりません。拡張メニューの「本文エリアを手動で選ぶ」を使ってください');
    await prepBodies(cfg(), [el]);
    const paras = el.innerText.split(/\n+/).map(s => s.trim()).filter(Boolean);
    const src = paras.join('\n\n');
    const key = tagged('cache:' + hash(location.pathname + location.search + src));

    const cached = !force && GM_getValue(key);
    if (cached) { const cc = cleanBlock(cached); ui.render(cc); setLast(cc); return ui.status(`保存済みの${provName()}版の訳を表示中`); }

    const c = cfg();
    if (!c.key) { ui.status('APIキーを設定してください'); return ui.settings(true); }

    const chunks = makeChunks(paras.map(p => p.length), c.chunk, c.quickStart);
    const whole = chunks.length > 1 && src.length <= 30000 ? src : '';
    const par = Math.max(1, +c.parallel || 1);

    setBusy(true);
    const out = new Array(chunks.length).fill(null);
    let finished = 0, blocked = 0;
    ui.render('');
    ui.status(`本文${src.length}字・${paras.length}段落 / 翻訳中 0 / ${chunks.length}`);
    const doChunk = async k => {
      const ref = par > 1 ? (k ? out[0] : '') : out.slice(0, k).join('\n\n');
      const user = buildUser(c, whole, ref, par > 1 ? 'この話の冒頭の訳文' : '直前までの訳文の末尾',
        chunks[k].map(i => paras[i]).join('\n\n'));
      try {
        const onText = part => {
          if (out.slice(0, k).some(t => t == null)) return; // 前の塊が終わっていなければ表示しない
          ui.render([...out.slice(0, k), part].join('\n\n'));
        };
        out[k] = cleanBlock(await withRetry(m => llm(c, sys(), user, m, onText), modelList(c),
          (...a) => ui.status(waitMsg(...a)))).trim();
      } catch (e) {
        if (!/^BLOCKED/.test(e.message)) throw e;
        out[k] = chunks[k].map(i => paras[i]).join('\n\n'); blocked += chunks[k].length;
      }
      finished++;
      const prefix = [];
      for (const t of out) { if (t == null) break; prefix.push(t); }
      ui.render(prefix.join('\n\n'));
      setLast(prefix.join('\n\n'));
      ui.status(`本文${src.length}字・${paras.length}段落 / 翻訳中 ${finished} / ${chunks.length}`);
    };
    try {
      await doChunk(0);
      await pool(par, chunks.length - 1, i => doChunk(i + 1));
      GM_setValue(key, out.join('\n\n'));
      saveTail(out.join('\n\n'));
      updateSheet(c, src, out.join('\n\n'));
      ui.status(blocked ? `完了（${blocked}段落はブロックされ原文のまま）` : `完了（${paras.length}段落 / ${chunks.length}回）`);
    } catch (e) {
      ui.status('エラー: ' + e.message);
    } finally {
      setBusy(false);
    }
  }

  // ---------- 元のページに上書き ----------
  const applied = new Map(); // 要素 → 元のHTML
  let inPlaceOn = false;

  function collectParas(root) {
    const set = new Set();
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode());) {
      if (!ko(n.nodeValue)) continue;
      const b = n.parentElement.closest('p,div,li,h1,h2,h3,h4,h5,h6,blockquote,td,dd');
      if (b && root.contains(b) && !b.closest('#kztl-host')) set.add(b);
    }
    const list = [...set];
    return list.filter(el => !list.some(o => o !== el && el.contains(o)));
  }

  // モデルが「原文 -> 訳文」や原文の繰り返しを返したときに原文部分を取り除く
  function clean(t, src = '') {
    if (t == null) return t;
    t = stripGloss(t.trim());
    if (src && t.startsWith(src) && t.length > src.length) t = t.slice(src.length).replace(/^\s*(?:->|→|⇒|=>)?\s*/, '');
    const parts = t.split(/\s*(?:->|→|⇒)\s*/);
    if (parts.length > 1 && (curLang() === 'ko' ? ko(parts[0]) > 0 : leftIn(parts[0]) > 0)) {
      const rest = parts.slice(1).join(' → ');
      if (ko(rest) < ko(parts[0]) / 2) t = rest.trim();
    }
    return t;
  }
  // 「韓国語（日本語訳）」の形で返ってきたら訳の部分だけ残す
  const KO_GLOSS = /((?:[\u4E00-\u9FFF](?=[\uAC00-\uD7A3]))?[\uAC00-\uD7A3][\uAC00-\uD7A3\u3130-\u318F0-9A-Za-z\s.,!?~·…'"\-]*?)\s*[（(]([^）)\uAC00-\uD7A3]+)[）)]/g;
  const stripGloss = t => t.replace(KO_GLOSS, (m, kor, ja) => (ko(kor) ? ja.trim() : m));
  const cleanBlock = text => text.split(/\n\s*\n/).map(p => clean(p)).join('\n\n');

  function parseNum(text) {
    const m = new Map();
    for (const x of text.matchAll(/\[\[(\d+)\]\]\s*([\s\S]*?)(?=\s*\[\[\d+\]\]|\s*$)/g)) m.set(+x[1], x[2].trim());
    return m;
  }

  // ---------- 装飾（太字・斜体・取り消し線・色など）の保持 ----------
  const TAG_RE = /<\/?t\d+\/?>/g;
  const stripTags = t => (t == null ? t : t.replace(TAG_RE, ''));
  const tplMap = new WeakMap(); // 段落要素 → { 番号: 元の装飾要素 }
  const STYLE_KEYS = ['fontWeight', 'fontStyle', 'color', 'backgroundColor', 'fontSize', 'fontFamily', 'textDecorationLine', 'verticalAlign'];

  // 段落を「<t1>太字</t1>」のような目印付きテキストにする。見た目が親と同じだけの<span>などは目印にしない
  // 画面で読める文字か：透明・背景と同じ色・極小の文字・画面の横の外にある文字は、見えないので記録しない
  function colorDist(a, b) {
    const p = v => {
      const h = String(v).match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
      if (h) { const x = h[1].length === 3 ? h[1].split('').map(c => c + c) : h[1].match(/../g); return x.map(c => parseInt(c, 16)); }
      return (String(v).match(/[\d.]+/g) || []).map(Number);
    };
    const x = p(a), y = p(b);
    if (x.length < 3 || y.length < 3) return 999;
    return Math.abs(x[0] - y[0]) + Math.abs(x[1] - y[1]) + Math.abs(x[2] - y[2]);
  }
  function isReadable(el, strict) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    if (cs.fontSize && parseFloat(cs.fontSize) < 5) return false;
    const a = (String(cs.color).match(/rgba\([^)]*,\s*([\d.]+)\)/) || [])[1];
    if (a != null && +a < 0.1) return false;
    if (cs.color && colorDist(solid(cs.color), pageBackground(el)) < 12) return false;
    if (!strict) return true;
    // 行としての判定：画面の横の外に置かれた文字や、重ねて透明にした文字も除く
    const r = el.getBoundingClientRect(), vw = el.ownerDocument.defaultView || window;
    if (r.width && (r.right < -5 || r.left > vw.innerWidth + 5)) return false;
    let op = 1;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement || (e.getRootNode() && e.getRootNode().host)) {
      const o = getComputedStyle(e).opacity;
      if (o !== '') op *= +o;
    }
    return op >= 0.05;
  }

  function serialize(el) {
    const tpl = {};
    let count = 0;
    const walk = node => {
      let out = '';
      for (const ch of node.childNodes) {
        if (ch.nodeType === 3) { out += ch.nodeValue; continue; }
        if (ch.nodeType !== 1) continue;
        const tag = ch.tagName;
        if (tag === 'BR' || tag === 'WBR') { out += ' '; continue; }
        if (tag === 'SCRIPT' || tag === 'STYLE') continue;
        const cs = getComputedStyle(ch);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        if (!isReadable(ch) || (cs.opacity !== '' && +cs.opacity === 0)) continue; // 見えない文字は入れない
        const ps = getComputedStyle(ch.parentElement);
        const styled = tag === 'IMG' || tag === 'A' || STYLE_KEYS.some(k => cs[k] !== ps[k]);
        if (!styled) { out += walk(ch); continue; }
        const n = ++count;
        tpl[n] = ch;
        const inner = walk(ch);
        out += inner.trim() ? `<t${n}>${inner}</t${n}>` : `<t${n}/>`;
      }
      return out;
    };
    let text = walk(el).replace(/\s+/g, ' ').trim();
    // 1文字ずつ装飾されている演出などで目印が多すぎると訳が崩れるので、その段落は装飾なしで訳す
    if (count > 12) { text = stripTags(text); count = 0; }
    if (count) tplMap.set(el, tpl); else tplMap.delete(el);
    return text;
  }

  // 文の中の小さな画像（絵文字・アイコン）は、画像のアドレスを参照して表示する（画像のデータ自体は保存しない）
  function inlineImgHtml(img) {
    const r = img.getBoundingClientRect ? img.getBoundingClientRect() : { height: 0 };
    // 設定で「代わりに入れる文字」を決めていれば、小さな画像はその文字（絵文字など）にする
    const ch = (cfg().imgChar || '').trim();
    if (ch && !(r.height && r.height > 64)) return escHtml(img.alt || ch);
    const src = img.currentSrc || img.src || '';
    if (!/^https?:/i.test(src) || (r.height && r.height > 64)) return img.alt ? escHtml(img.alt) : '■■■';
    return `<img src="${escHtml(src)}" alt="${escHtml(img.alt || '')}" style="height:1.2em;width:auto;vertical-align:-0.2em">`;
  }

  // コピー用の文字列：中身のない装飾（黒塗り・伏せ字のブロックなど）は ■■■ にして残す。画像は代替テキスト
  function toPlain(el, t) {
    if (t == null) return t;
    const tpl = tplMap.get(el) || {};
    return t.replace(/<t(\d+)\/>/g, (m, n) => {
      const src = tpl[n];
      if (src && src.tagName === 'IMG' && src.alt) return src.alt;
      return '■■■';
    }).replace(TAG_RE, '');
  }

  // 目印付きの訳文から、元の装飾要素を複製して段落を組み立て直す
  function rebuild(el, t) {
    const tpl = tplMap.get(el);
    if (!tpl || !/<\/?t\d+\/?>/.test(t)) { el.textContent = stripTags(t); return; }
    const frag = document.createDocumentFragment();
    const stack = [{ node: frag, n: 0 }];
    const re = /<(\/?)t(\d+)(\/?)>/g;
    let last = 0, m;
    while ((m = re.exec(t))) {
      const top = stack[stack.length - 1].node;
      if (m.index > last) top.append(t.slice(last, m.index));
      last = re.lastIndex;
      const n = +m[2], src = tpl[n];
      if (!src) continue;
      if (m[3]) { top.append(src.cloneNode(true)); continue; }
      if (!m[1]) {
        const c = src.cloneNode(false);
        top.append(c);
        stack.push({ node: c, n });
      } else {
        let idx = -1;
        for (let j = stack.length - 1; j > 0; j--) if (stack[j].n === n) { idx = j; break; }
        if (idx > 0) stack.length = idx;
      }
    }
    stack[stack.length - 1].node.append(t.slice(last));
    el.replaceChildren(frag);
  }

  // ---------- 訳文の漢字を日本の字形で表示 ----------
  // 韓国のサイトは韓国語用フォントなので、漢字だけ韓国風の形になる。訳した部分の漢字・かなだけ日本語フォントに切り替える
  const JA_RANGE = 'U+3000-30FF, U+3190-319F, U+31F0-31FF, U+3400-4DBF, U+4E00-9FFF, U+F900-FAFF, U+FF00-FFEF';
  const JA_SERIF = ['Hiragino Mincho ProN', 'HiraMinProN-W3', 'Yu Mincho', 'YuMincho', 'Noto Serif CJK JP', 'NotoSerifCJKjp-Regular', 'Noto Serif JP', 'Source Han Serif JP', 'SourceHanSerifJP-Regular', 'MS PMincho'];
  const JA_SANS = ['Hiragino Sans', 'HiraginoSans-W3', 'Hiragino Kaku Gothic ProN', 'HiraKakuProN-W3', 'Yu Gothic', 'YuGothic', 'Noto Sans CJK JP', 'NotoSansCJKjp-Regular', 'Noto Sans JP', 'Source Han Sans JP', 'SourceHanSansJP-Regular', 'Meiryo'];
  let jaStyleDone = false;
  function jaStyle() {
    if (jaStyleDone) return; jaStyleDone = true;
    const face = (name, list) => `@font-face { font-family: "${name}"; src: ${list.map(n => `local("${n}")`).join(', ')}; unicode-range: ${JA_RANGE}; }`;
    const st = document.createElement('style');
    st.id = 'kztl-ja-font';
    st.textContent = face('kzja-serif', JA_SERIF) + '\n' + face('kzja-sans', JA_SANS);
    (document.head || document.documentElement).appendChild(st);
  }
  const jaOrig = new Map();
  const isSerif = ff => {
    const first = String(ff || '').split(',')[0];
    return /(serif|明朝|명조|바탕|batang|myeongjo|mincho|song)/i.test(first) && !/(sans|gothic|고딕|돋움|dotum|gulim|굴림)/i.test(first);
  };
  function markJa(el) {
    if (!el || !el.isConnected || cfg().jaFont === false) return;
    jaStyle();
    const one = e => {
      if (jaOrig.has(e)) return;
      const ff = getComputedStyle(e).fontFamily || '';
      if (/kzja-/.test(ff)) return;
      jaOrig.set(e, { lang: e.getAttribute('lang'), ff: e.style.fontFamily });
      e.setAttribute('lang', 'ja');
      // サイトの韓国語フォントは後ろに回さない（漢字の一部だけ韓国フォントで混ざるのを防ぐ）。lang="ja" で端末の日本語フォントが選ばれる
      const serif = isSerif(ff);
      e.style.setProperty('font-family', serif ? '"kzja-serif", "Noto Serif CJK JP", "Noto Serif JP", "Hiragino Mincho ProN", "Yu Mincho", serif' : '"kzja-sans", "Noto Sans CJK JP", "Noto Sans JP", "Hiragino Sans", "Yu Gothic", sans-serif', 'important');
    };
    one(el);
    // 中の装飾で別のフォントが指定されている部分も
    for (const d of el.querySelectorAll('*')) {
      if (d.parentElement && getComputedStyle(d).fontFamily !== getComputedStyle(d.parentElement).fontFamily) one(d);
    }
  }
  function unmarkJa() {
    for (const [e, o] of jaOrig) {
      if (!e.isConnected) continue;
      if (o.lang == null) e.removeAttribute('lang'); else e.setAttribute('lang', o.lang);
      e.style.removeProperty('font-family'); if (o.ff) e.style.fontFamily = o.ff;
    }
    jaOrig.clear();
  }

  function applyTr(els, tr) {
    els.forEach((el, i) => {
      if (tr[i] == null || !el.isConnected) return;
      if (!applied.has(el)) applied.set(el, el.innerHTML);
      rebuild(el, tr[i]);
      el.setAttribute('data-kztl-tr', ''); // 訳文を表示中の印（ページ側が編集前に確認できるように）
      markJa(el);
    });
    inPlaceOn = true;
    ui.fabLabel('原');
    startKeep();
  }

  function restore() {
    stopLive();
    clearOverlays();
    restoreText();
    unmarkJa();
    for (const [el, html] of applied) if (el.isConnected) { el.innerHTML = html; el.removeAttribute('data-kztl-tr'); }
    applied.clear();
    inPlaceOn = false;
    ui.fabLabel('訳');
    stopKeep();
  }

  // ---------- 訳の表示を保つ（数秒ごとに本文を描き直すサイト向け：晋江など）----------
  // 訳を表示中にサイトが本文を元に戻したら、段落ごとの訳の記録からすぐ入れ直す（料金なし）。「原」を押すと止まる
  let keep = null, keepBusy = false;
  function startKeep() {
    if (keep && keep.id === pageId()) return;
    stopKeep();
    const id = pageId();
    const obs = new MutationObserver(recs => {
      if (busy || keepBusy || !keep || pageId() !== id) return;
      // 本文の中で何か変わったときだけ（広告や時計など本文の外の変化は無視）
      const roots = keep.roots || [];
      const inBody = !roots.length || roots.some(r => !r.isConnected) ||
        recs.some(m => roots.some(r => r.contains(m.target)));
      if (inBody) reapplyKeep();
    });
    obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    keep = { id, obs, roots: null, visionAt: 0 };
  }
  function stopKeep() { if (keep) keep.obs.disconnect(); keep = null; }
  async function reapplyKeep() {
    if (!keep || keepBusy || busy) return;
    keepBusy = true;
    try {
      for (const el of [...applied.keys()]) if (!el.isConnected) applied.delete(el); // 描き直しで消えた要素の記録は捨てる
      const roots = findBodies();
      if (!roots.length) return;
      keep.roots = roots;
      if (roots.reduce((a, r) => a + koNodes(r), 0) < 4) return; // 原文がほぼ無い＝訳を表示中のまま
      await prepBodies(cfg(), roots, true);
      const els = roots.flatMap(r => collectParas(r).filter(el => !inNonBody(el, r) && !isUiWord(el.textContent)));
      const srcs = els.map(serialize);
      const pm = getParaMap();
      const tr = srcs.map(x => (pm[x] != null ? pm[x] : null));
      if (!tr.some(t => t != null)) return;
      applyTr(els, tr);
      copyCtx = { roots, els, tr, srcs, href: pageId() };
      setLast(tr.map((t, i) => toPlain(els[i], t ?? srcs[i])).join('\n\n'));
    } catch { /* 入れ直せなくても次の変化でまた試す */ } finally {
      // 自分で書き換えた分の通知は無視する
      setTimeout(() => { keepBusy = false; }, 0);
    }
  }

  // 韓国語が残っている（または訳が抜けた）段落か
  const needsFix = t => t == null || leftIn(t) > 0;

  // 韓国語が残った段落だけ、小さく分けて最大2回まで訳し直す
  async function fixLeftovers(c, els, srcs, tr, whole, ref, skip) {
    let err = null;
    for (let round = 1; round <= 2; round++) {
      const redo = srcs.map((_, i) => i).filter(i => !skip.has(i) && needsFix(tr[i]));
      if (!redo.length) break;
      ui.toast(`${L().name}が残った${redo.length}段落を自動で訳し直し中…${round > 1 ? '（2回目）' : ''}`);
      const groups = makeChunks(redo.map(i => srcs[i].length), Math.min(c.chunk, 3000)).map(g => g.map(j => redo[j]));
      await pool(Math.max(1, +c.parallel || 1), groups.length, async g => {
        const ids = groups[g];
        const user = buildUser(c, whole, ref, 'この話の冒頭の訳文', ids.map(i => `[[${i + 1}]] ${srcs[i]}`).join('\n\n'));
        user.msg += `\n\n（注意：前回これらの段落は${L().name}のまま返ってきました。必ず各段落の先頭に [[番号]] を付け、${L().name}を一文字も残さず日本語だけで訳してください）`;
        try {
          const m = parseNum(await withRetry(mm => llm(c, sysNum(), user, mm), modelList(c), (...a) => ui.toast(waitMsg(...a))));
          for (const i of ids) {
            if (!m.has(i + 1)) continue;
            const t = clean(m.get(i + 1), srcs[i]);
            if (t && (tr[i] == null || leftIn(t) < leftIn(tr[i]))) tr[i] = t;
          }
        } catch (e) {
          if (/^BLOCKED/.test(e.message)) ids.forEach(i => skip.add(i));
          else err = e;
        }
        applyTr(els, tr);
        setLast(tr.map((t, i) => toPlain(els[i], t ?? srcs[i])).join('\n\n'));
      });
    }
    return { left: srcs.filter((_, i) => !skip.has(i) && needsFix(tr[i])).length, err };
  }

  // 下までスクロールして、あとから読み込まれる本文を全部読み込ませる（終わったら元の位置に戻す）
  async function preloadAll() {
    const cands = [document.scrollingElement || document.documentElement,
      ...[...document.querySelectorAll('div,main,section')].filter(e => e.scrollHeight > e.clientHeight + 200 && /auto|scroll/.test(getComputedStyle(e).overflowY))];
    const sc = cands.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
    if (!sc) return;
    const start = sc.scrollTop;
    let last = -1, same = 0;
    autoScrolling = true; // ライブ翻訳は自動スクロール中の文を拾わない
    for (let i = 0; i < 300 && same < 3; i++) {
      sc.scrollTop += sc.clientHeight * 0.9;
      ui.toast(`本文を読み込み中…（${i + 1}）`);
      await new Promise(r => setTimeout(r, 180));
      if (sc.scrollTop === last) same++; else same = 0;
      last = sc.scrollTop;
    }
    sc.scrollTop = start;
    await new Promise(r => setTimeout(r, 300));
    autoScrolling = false;
  }


  // ---------- 表示中の文だけ訳す（カカオの演出ビューアなど、1文ずつ表示される作り向け） ----------
  let liveOn = false, liveBusy = false, autoScrolling = false;
  let liveData = null;          // { order: [原文...], map: { 原文: 訳 }, meta: { 原文: {group, html, align} } }
  const liveQueue = new Map();  // 原文 → 要素（訳待ち）
  const groupIds = new WeakMap();
  let groupSeq = 0;
  const liveKey = () => tagged('live:' + location.host + location.pathname);
  const liveSave = () => { try { GM_setValue(liveKey(), liveData); } catch { /* 保存できなくても続ける */ } };

  function groupOf(el) {
    const r = el.getRootNode();
    const g = r && r.host ? r.host : el.parentElement || el;
    if (!groupIds.has(g)) groupIds.set(g, ++groupSeq);
    return groupIds.get(g);
  }

  // 読んだ順の並び。「訳」を押したときに見えていた文のまとまりを1場面として記録する
  // （同じ文が別の場面でくり返し出てきても、その場面の分としてちゃんと残る）
  // ビューアのボタンなどでよく出る言葉（本文ではない）
  const UI_WORDS = /^(다음|이전|다음화|이전화|다음 화|이전 화|목록|댓글|홈|설정|보기 ?설정|자동 ?스크롤|자동|스크롤|관심 ?작품 ?목록|구매|대여|닫기|확인|취소|공유|메뉴|더보기|이어보기|첫화 ?보기|아래 ?화살표|위 ?화살표)$/;
  const isUiWord = t => UI_WORDS.test(String(t || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());

  // 2つの場面で同じ行がいくつあるか（くり返しの行も数える）
  function overlapCount(a, b) {
    const m = new Map();
    b.forEach(x => m.set(x, (m.get(x) || 0) + 1));
    let c = 0;
    for (const x of a) { const n = m.get(x); if (n) { c++; m.set(x, n - 1); } }
    return c;
  }
  // 同じ場面の行を、順番を保ったまま1つにまとめる。
  // 今回見えていた行は見た目（空行・大きさなど）を新しい記録で更新し、まだ記録にない行は正しい位置に差し込む
  function mergeLines(oldS, oldL, newS, newL) {
    const resS = oldS.slice(), resL = (oldL || []).slice();
    while (resL.length < resS.length) resL.push(undefined);
    let pos = -1;
    for (let j = 0; j < newS.length; j++) {
      let k = -1;
      for (let q = pos + 1; q < resS.length && q <= pos + 60; q++) if (resS[q] === newS[j]) { k = q; break; }
      let lay = newL ? newL[j] : undefined;
      if (k >= 0) {
        // 今回の最初の行は、その前の行が画面になかったので空行の数は前の記録を使う
        if (j === 0 && lay && resL[k]) lay = Object.assign({}, lay, { blanks: resL[k].blanks });
        if (lay) resL[k] = lay;
        pos = k;
      } else {
        resS.splice(pos + 1, 0, newS[j]);
        resL.splice(pos + 1, 0, lay);
        pos++;
      }
    }
    return [resS, resL];
  }

  // 同じ場面の押し直し・行が増えた・行が順番に表示される・ボタンの文字が混ざった、などは同じ場面として1つにまとめる
  function mergeScene(list, lays, srcs, lay) {
    let best = -1, bestOv = 0;
    list.forEach((sc, i) => { const ov = overlapCount(srcs, sc); if (ov > bestOv) { bestOv = ov; best = i; } });
    if (best >= 0) {
      const small = Math.min(srcs.length, list[best].length);
      const same = small < 3 ? srcs.join('\u0001') === list[best].join('\u0001') : bestOv >= small * 0.5;
      if (same) {
        const [ms, ml] = mergeLines(list[best], lays[best], srcs, lay);
        list[best] = ms; lays[best] = ml;
        return best;
      }
    }
    list.push(srcs); lays.push(lay);
    return list.length - 1;
  }


  function liveSeq() {
    if (!liveData) return [];
    if (Array.isArray(liveData.scenes) && liveData.scenes.length) {
      // 前のバージョンで重複して記録された場面も、ここでまとめ直す
      const list = [], lays = [];
      liveData.scenes.forEach((sc, i) => {
        const L = (liveData.layouts || [])[i] || [];
        const keep = sc.map((src, j) => [src, L[j]]).filter(([src]) => !isUiWord(src));
        if (keep.length) mergeScene(list, lays, keep.map(x => x[0]), keep.map(x => x[1]));
      });
      return list.flatMap((sc, i) => sc.map((src, j) => ({ src, scene: i, lay: (lays[i] || [])[j] })));
    }
    return liveData.order.filter(src => !isUiWord(src)).map(src => ({ src, scene: liveData.meta[src]?.group ?? 0 }));
  }
  function liveEntries() {
    return liveSeq().filter(x => liveData.map[x.src] != null).map(x => x.src);
  }


  // 場面を記録して、その場面の番号を返す。layout は各行の見た目（空行の数・文字サイズ・色など）
  function recordScene(srcs, layout) {
    const keep = srcs.map((src, j) => [src, layout[j]]).filter(([src]) => !isUiWord(src));
    if (!keep.length) return -1;
    const sc = liveData.scenes || (liveData.scenes = []);
    const L = liveData.layouts || (liveData.layouts = []);
    return mergeScene(sc, L, keep.map(x => x[0]), keep.map(x => x[1]));
  }

  // 今見えている行の見た目を記録：行の前の空行の数（画面上の空き具合から）、段落全体の文字サイズ・太さ・斜体・線・色・配置・フォント
  function sceneLayout(els) {
    const rects = els.map(e => e.getBoundingClientRect());
    const gaps = rects.map((r, k) => {
      if (!k) return null;
      const a = rects[k - 1];
      return a.height > 0 && r.height > 0 && r.top >= a.bottom - 2 ? r.top - a.bottom : null;
    });
    const valid = gaps.filter(g => g != null).sort((x, y) => x - y);
    const g0 = valid.length ? valid[Math.floor(valid.length / 4)] : 0;
    const hs = rects.map(r => r.height).filter(h => h > 0);
    const pitch = Math.max(8, (hs.length ? Math.min(...hs) : 24) + Math.max(0, g0));
    return els.map((e, k) => {
      const cs = getComputedStyle(e);
      return {
        blanks: gaps[k] != null && valid.length ? Math.min(10, Math.max(0, Math.round((gaps[k] - g0) / pitch))) : 0,
        fs: cs.fontSize, fw: cs.fontWeight, fst: cs.fontStyle, ff: cs.fontFamily.replace(/"/g, "'"), lh: cs.lineHeight, ls: cs.letterSpacing,
        col: solid(cs.color), td: cs.textDecorationLine, tdc: solid(cs.textDecorationColor), tds: cs.textDecorationStyle,
        al: cs.textAlign === 'start' || cs.textAlign === 'justify' ? 'left' : cs.textAlign === 'end' ? 'right' : cs.textAlign,
        ti: cs.textIndent,
      };
    });
  }
  const layStyle = l => !l ? '' : [
    `font-size:${l.fs}`, `font-weight:${l.fw}`, `font-style:${l.fst}`, `font-family:${l.ff}`, `color:${l.col}`,
    l.lh && l.lh !== 'normal' ? `line-height:${l.lh}` : '', l.ls && l.ls !== 'normal' ? `letter-spacing:${l.ls}` : '',
    l.td && l.td !== 'none' ? `text-decoration-line:${l.td};text-decoration-color:${l.tdc};text-decoration-style:${l.tds}` : '',
    l.al && l.al !== 'left' ? `text-align:${l.al}` : '', l.ti && parseFloat(l.ti) ? `text-indent:${l.ti}` : '',
  ].filter(Boolean).join(';').split(';').filter(d => /:\s*\S/.test(d)).join(';'); // 値が空の指定は落とす

  // 読んだ順に、グループの切れ目には空行を入れたテキスト
  // 場面（グループ）の区切りに入れる印。本文の「＊＊＊」と見分けやすい形にしてある
  const SCENE_MARK = '◇　◇　◇';

  function liveText() {
    let out = '', lastS = null;
    for (const { src, scene, lay } of liveSeq()) {
      if (liveData.map[src] == null) continue;
      if (out) out += lastS != null && scene !== lastS ? `\n\n${SCENE_MARK}\n\n` : '\n' + '\n'.repeat(lay?.blanks || 0);
      out += stripTags(String(liveData.map[src]).replace(/<t\d+\/>/g, '■'));
      lastS = scene;
    }
    return out;
  }

  // ページは書き換えず、保存用に装飾つきの訳文HTMLと配置だけ記録する
  function applyLive(el, src) {
    const t = liveData.map[src];
    if (t == null) return;
    const cs = el.isConnected ? getComputedStyle(el) : null;
    liveData.meta[src] = Object.assign(liveData.meta[src] || {}, {
      html: el.isConnected ? tagsToHtml(el, t) : escHtml(stripTags(t)),
      align: cs && (cs.textAlign === 'center' || cs.textAlign === 'right') ? cs.textAlign : liveData.meta[src]?.align,
    });
  }

  // 目印付きの訳文を、元の装飾（色・太字など）を style に書いたHTMLにする
  function tagsToHtml(el, t) {
    const tpl = tplMap.get(el) || {};
    const base = getComputedStyle(el);
    const esc = escHtml(t).replace(/&lt;(\/?)t(\d+)(\/?)&gt;/g, '<$1t$2$3>');
    return esc.replace(/<(\/?)t(\d+)(\/?)>/g, (m, close, n, self) => {
      const src = tpl[n];
      if (!src) return '';
      if (close) return '</span>';
      const cs = getComputedStyle(src);
      if (self) {
        if (src.tagName === 'IMG') return inlineImgHtml(src);
        return `<span style="display:inline-block;width:${cs.width};height:${cs.height};background-color:${solid(cs.backgroundColor)}"></span>`;
      }
      const diff = INLINE_KEYS.filter(([k]) => solid(cs[k]) !== solid(base[k])).map(([k, css]) => `${css}:${solid(cs[k])}`);
      return `<span style="${diff.join(';')}">`;
    });
  }

  // 読み上げ用の隠し文字（1pxの要素や切り抜き）だけ除く。
  // 画面の外にある行や、演出でまだ透明な行も、同じ場面の本文なのでまとめて訳す
  function isOnScreen(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const cs = getComputedStyle(el);
    if (/rect\(0|inset\(50%/.test(cs.clip + ' ' + cs.clipPath)) return false;
    return true;
  }


  // ボタン・ナビ・固定表示の部品（「다음」など）は本文ではないので除く
  function isUiText(el) {
    if (el.closest('button,a,nav,header,footer,[role="button"],[role="navigation"],[role="dialog"]')) return true;
    const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (isUiWord(txt)) return true;
    // 押せる部品（指のカーソルになる要素）の短い文字も、ボタン扱いで除く
    if (txt.length <= 10) {
      for (let e = el, k = 0; e && e.nodeType === 1 && k < 4; e = e.parentElement, k++) {
        if (getComputedStyle(e).cursor === 'pointer') return true;
      }
    }
    // 画面に固定された細いバー（上下のメニューなど）の中の文字も除く。画面いっぱいの固定ビューアは本文なので除かない
    for (let e = el; e && e.nodeType === 1; e = e.parentElement || (e.getRootNode() && e.getRootNode().host)) {
      const pos = getComputedStyle(e).position;
      if ((pos === 'fixed' || pos === 'sticky') && e.getBoundingClientRect().height < 150) return true;
    }
    return false;
  }


  // 今表示されている文を集める：訳し済みならすぐ反映、未訳なら訳す列に入れる
  // 場面の記録用に、本文の行を全部（韓国語のない行「♪♪♪」「……!」「＊＊＊」なども）ページの順番どおりに集める
  function sceneBlocks() {
    const out = [];
    const isBlock = e => { const d = getComputedStyle(e).display; return d !== 'none' && d !== 'contents' && !d.startsWith('inline'); };
    for (const root of deepRoots()) {
      const kor = new Set(collectParas(root));
      const list = [];
      for (const e of root.querySelectorAll('*')) {
        if (e.id === 'kztl-host' || e.closest('#kztl-host')) continue;
        if (kor.has(e)) { list.push(e); continue; }
        if (!isBlock(e) || [...kor].some(k => k.contains(e) || e.contains(k))) continue;
        if ([...e.children].some(ch => isBlock(ch) && (ch.textContent || '').trim())) continue;
        const t = (e.textContent || '').replace(/\u00a0/g, ' ').trim();
        if (!t || /^\d+\s*\/\s*\d+$/.test(t) || /^\d+(\.\d+)?\s*%$/.test(t)) continue; // 空・ページ番号（「16 / 21」「35%」）だけ除く。「3.」のようなカウントダウンや「-----」は残す
        if (!isReadable(e, true)) continue; // 画面では見えない文字の行は記録しない
        list.push(e);
      }
      out.push(...list.filter(e => !isUiText(e) && isOnScreen(e)));
    }
    return out;
  }

  // 今表示されている本文の文を集める（ページは書き換えない）
  function scanShown(force) {
    const items = [];
    const els = deepRoots().flatMap(r => collectParas(r)).filter(el => !isUiText(el) && isOnScreen(el));
    for (const el of els) {
      const src = serialize(el);
      if (ko(src) < 1) continue;
      if (force) delete liveData.map[src];
      if (!liveData.order.includes(src)) {
        liveData.order.push(src);
        liveData.meta[src] = { group: groupOf(el) };
      }
      items.push({ el, src });
      if (liveData.map[src] == null) liveQueue.set(src, el);
    }
    return items;
  }


  let liveErr = null;
  async function liveTranslate(note, limit) {
    const c = cfg();
    if (!c.key) { ui.open(); ui.status('APIキーを設定してください'); ui.settings(true); return false; }
    liveBusy = true;
    // 1回に送る量は設定の「1回に送る文字数」まで（段落数の上限はなし）
    const batch = [];
    let len = 0;
    for (const e of liveQueue.entries()) {
      if (batch.length && len + e[0].length > (limit || +c.chunk || 4000)) break;
      batch.push(e); len += e[0].length + 8;
    }
    batch.forEach(([k]) => liveQueue.delete(k));
    const srcs = batch.map(([k]) => k);
    // 直前に訳した文を文脈として一緒に送る
    const prev = liveEntries().slice(-25).map(k => stripTags(liveData.map[k])).join('\n');
    const user = buildUser(c, '', prev, '直前までの訳文', srcs.map((t, i) => `[[${i + 1}]] ${t}`).join('\n\n'));
    if (note) user.msg += '\n\n' + note;
    try {
      ui.toast(`翻訳中…（${srcs.length}段落）`);
      // 訳し終わった段落から順に、その場で差し替える
      const onText = part => {
        const pm = parseNum(part);
        if (!pm.size) return;
        const maxN = Math.max(...pm.keys());
        srcs.forEach((src, i) => {
          if (i + 1 < maxN && pm.has(i + 1) && liveData.map[src] == null) {
            liveData.map[src] = clean(pm.get(i + 1), src);
            applyText(batch[i][1], liveData.map[src], src);
          }
        });
      };
      const m = parseNum(await withRetry(mm => llm(c, sysNum(), user, mm, onText), modelList(c), (...a) => ui.toast(waitMsg(...a))));
      srcs.forEach((src, i) => {
        if (m.has(i + 1)) liveData.map[src] = clean(m.get(i + 1), src);
        else liveQueue.set(src, batch[i][1]); // 抜けたら次でもう一度
      });
      batch.forEach(([src, el]) => { if (liveData.map[src] != null && el.textContent !== textApplied.get(el)) applyText(el, liveData.map[src], src); });
      batch.forEach(([src, el]) => applyLive(el, src));
      liveSave();
      setLast(liveText());
    } catch (e) {
      if (/^BLOCKED/.test(e.message)) srcs.forEach(src => { liveData.map[src] = src; });
      else { liveErr = e; ui.toast('エラー: ' + e.message, 4000); liveQueue.clear(); }
    } finally {
      liveBusy = false;
    }
    return true;
  }

  // 「訳」を押したときに表示されている文だけを訳す。1文だけでもOK。訳した文は記録して、あとでまとめて保存できる
  // 「訳」を押したときに表示されている文だけを訳して、画面下のカードに出す。1文だけでもOK
  // ページ自体は書き換えないので、スクロールなどサイトの動きは邪魔しない
  let lastCardKey = '';
  // ---------- 重ね表示：元の文の真上に、同じ見た目（大きさ・太さ・色・配置）で訳文を重ねる ----------
  // サイトの要素は一切書き換えないので、ビューアの演出やスクロールは壊れない
  const overlays = []; // { el, src, text, node }
  let ovRaf = 0;
  const OV_KEYS = ['font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing',
    'text-align', 'text-indent', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'writing-mode', 'word-break'];

  function frameOffset(el) {
    let x = 0, y = 0;
    for (let w = el.ownerDocument.defaultView; w && w !== window && w.frameElement; w = w.parent) {
      const r = w.frameElement.getBoundingClientRect();
      x += r.left; y += r.top;
    }
    return { x, y };
  }

  function placeOverlays() {
    ovRaf = 0;
    for (let i = overlays.length - 1; i >= 0; i--) {
      const o = overlays[i];
      // サイトが次の文に切り替えた・消えたら、その重ね表示は外す
      if (!o.el.isConnected || o.el.textContent !== o.text) { o.node.remove(); overlays.splice(i, 1); continue; }
      const r = o.el.getBoundingClientRect(), off = frameOffset(o.el);
      Object.assign(o.node.style, { left: r.left + off.x + 'px', top: r.top + off.y + 'px', width: r.width + 'px', minHeight: r.height + 'px' });
    }
    if (overlays.length) ovRaf = requestAnimationFrame(placeOverlays);
  }

  function clearOverlays() {
    overlays.splice(0).forEach(o => o.node.remove());
    if (ovRaf) cancelAnimationFrame(ovRaf), ovRaf = 0;
  }

  function showOverlay(el, src) {
    const t = liveData.map[src];
    if (t == null || !el.isConnected) return;
    const old = overlays.findIndex(o => o.el === el);
    if (old >= 0) { overlays[old].node.remove(); overlays.splice(old, 1); }
    const cs = getComputedStyle(el);
    const node = document.createElement('div');
    node.className = 'ov';
    node.style.cssText = OV_KEYS.map(k => `${k}:${cs.getPropertyValue(k)}`).join(';')
      + `;color:${solid(cs.color)};background:${pageBackground(el)}`;
    node.innerHTML = tagsToHtml(el, t);
    ui.layer().appendChild(node);
    overlays.push({ el, src, text: el.textContent, node });
    if (!ovRaf) ovRaf = requestAnimationFrame(placeOverlays);
    placeOverlays();
  }

  // ---------- 文字だけ差し替え：要素の作りはそのままに、中の文字（テキスト）だけ訳文に入れ替える ----------
  // カカオのビューアは要素を作り替えると画面が壊れるので、サイトの部品・装飾・演出は全部残して文字だけ替える
  const textOrig = new Map();   // テキストノード → 元の文字
  const textApplied = new Map(); // 要素 → 差し替え後の文字（サイトが文を切り替えたか判定用）

  function textSlots(el) {
    const tpl = tplMap.get(el) || {};
    const rev = new Map(Object.entries(tpl).map(([n, e]) => [e, +n]));
    const slots = new Map(); // 0 = 装飾なしの部分、n = <tn> の部分
    const w = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode());) {
      let id = 0;
      for (let p = n.parentElement; p && p !== el; p = p.parentElement) if (rev.has(p)) { id = rev.get(p); break; }
      if (!slots.has(id)) slots.set(id, []);
      slots.get(id).push(n);
    }
    return slots;
  }

  const elSrc = new WeakMap(); // 差し替えた要素 → 元の原文（場面の記録用）
  let curSrc = null;
  function applyText(el, t, src) {
    curSrc = src || null;
    if (t == null || !el.isConnected) return;
    // 訳文を「どの装飾の中の文字か」ごとに分ける
    const segs = new Map();
    const stack = [0];
    let buf = '', last = 0, m;
    const flush = () => { const id = stack[stack.length - 1]; if (!segs.has(id)) segs.set(id, []); segs.get(id).push(buf); buf = ''; };
    const re = /<(\/?)t(\d+)(\/?)>/g;
    while ((m = re.exec(t))) {
      buf += t.slice(last, m.index); last = re.lastIndex;
      if (m[3]) continue;
      flush();
      if (!m[1]) stack.push(+m[2]); else if (stack.length > 1) stack.pop();
    }
    buf += t.slice(last); flush();
    const slots = textSlots(el);
    let leftover = '';
    for (const [id, parts0] of segs) if (!slots.has(id)) leftover += parts0.join('');
    for (const [id, nodes] of slots) {
      const textNodes = nodes.filter(n => n.nodeValue.trim());
      let parts = (segs.get(id) || []).filter(x => x.trim());
      if (id === 0 && leftover) parts = parts.concat(leftover);
      textNodes.forEach((n, i) => {
        if (!textOrig.has(n)) textOrig.set(n, n.nodeValue);
        let v = i < parts.length ? parts[i] : '';
        if (i === textNodes.length - 1 && parts.length > textNodes.length) v += parts.slice(textNodes.length).join('');
        n.nodeValue = v;
      });
    }
    textApplied.set(el, el.textContent);
    if (curSrc) elSrc.set(el, curSrc);
    markJa(el);
  }

  function restoreText() {
    for (const [n, v] of textOrig) if (n.isConnected) n.nodeValue = v;
    textOrig.clear();
    textApplied.clear();
    unmarkJa();
  }

  // 一度差し替えた要素を、元の文字に戻してから新しい訳で入れ直す
  function reapplyText(el, t) {
    if (!el.isConnected || t == null) return;
    const w = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode());) if (textOrig.has(n)) n.nodeValue = textOrig.get(n);
    applyText(el, t, elSrc.get(el));
  }

  const shownTranslated = () => [...textApplied].filter(([el, txt]) => el.isConnected && el.textContent === txt).map(([el]) => el);

  // 「訳」を押したときに表示されている文だけを、その場で訳文に差し替える（見た目はページのまま）。1文だけでもOK
  // 訳待ちの文を「同時に送る数」に分けて並列で送る（Claudeなど出力が遅いモデルで速くなる）
  async function runParallel(note) {
    const c = cfg();
    const par = Math.max(1, +c.parallel || 1);
    const total = [...liveQueue.keys()].reduce((a, k) => a + k.length + 8, 0);
    const limit = Math.min(+c.chunk || 4000, Math.max(1200, Math.ceil(total / par)));
    const worker = async () => {
      while (liveQueue.size && !liveErr) { if (!(await liveTranslate(note, limit))) break; }
    };
    await Promise.all(Array.from({ length: Math.min(par, Math.ceil(total / 1200) || 1) }, worker));
  }

  async function translateShown(force) {
    if (liveBusy) return;
    liveData = liveData && liveData.key === liveKey() ? liveData : (GM_getValue(liveKey(), null) || { order: [], map: {}, meta: {} });
    liveData.key = liveKey();
    copyCtx = null;
    const items = scanShown(force);
    // 新しい韓国語がなく、訳を表示中の文があるなら、押すと原文に戻す
    if (!items.length) {
      if (shownTranslated().length) { restoreText(); ui.fabLabel('訳'); return ui.toast('原文に戻しました', 1500); }
      return ui.toast('今の画面に訳せる文が見つかりません', 2500);
    }
    // 場面の記録：韓国語の行に加えて、韓国語のない行（記号や「……!」など）もそのまま入れる
    const blocks = sceneBlocks();
    const bSrcs = blocks.map(el => {
      const it = items.find(x => x.el === el);
      if (it) return it.src;
      if (elSrc.has(el) && textApplied.get(el) === el.textContent) return elSrc.get(el); // 訳を表示中の行は元の原文で
      const src = serialize(el);
      if (!ko(src) && liveData.map[src] == null) { liveData.map[src] = src; liveData.meta[src] = Object.assign(liveData.meta[src] || {}, { html: tagsToHtml(el, src) }); }
      return src;
    });
    if (bSrcs.length) recordScene(bSrcs, sceneLayout(blocks));
    else recordScene(items.map(x => x.src), sceneLayout(items.map(x => x.el)));
    items.forEach(({ el, src }) => { applyLive(el, src); applyText(el, liveData.map[src], src); });
    liveErr = null;
    const hasKo = src => liveData.map[src] == null || leftIn(liveData.map[src]) > 0;
    let didWork = false;
    if (liveQueue.size) {
      setBusy(true); didWork = true;
      try {
        await runParallel();
        items.forEach(({ el, src }) => { if (el.textContent !== textApplied.get(el)) applyText(el, liveData.map[src], src); });
        // 韓国語が残った文・抜けた文は、最大2回まで自動で訳し直す
        for (let round = 1; round <= 2 && !liveErr; round++) {
          const bad = items.filter(({ src }) => hasKo(src));
          if (!bad.length) break;
          ui.toast(`${L().name}が残った${bad.length}文を訳し直し中…${round > 1 ? '（2回目）' : ''}`);
          const before = {};
          bad.forEach(({ el, src }) => { before[src] = liveData.map[src]; delete liveData.map[src]; liveQueue.set(src, el); });
          await runParallel(`（注意：前回これらの文は${L().name}が残りました。必ず各段落の先頭に [[番号]] を付け、${L().name}を一文字も残さず日本語だけで訳してください）`);
          bad.forEach(({ el, src }) => {
            const old = before[src], cur = liveData.map[src];
            if (old != null && (cur == null || leftIn(cur) > leftIn(old))) liveData.map[src] = old; // 前より悪くなったら前の訳を使う
            reapplyText(el, liveData.map[src], src);
          });
        }
      } finally {
        setBusy(false);
      }
    }
    items.forEach(({ el, src }) => applyLive(el, src));
    if (textApplied.size) ui.fabLabel('原');
    liveSave();
    setLast(liveText());
    if (didWork) {
      saveTail(liveText());
      // 作品メモ（人物・用語）も、新しく40文ほど訳すごとに裏で更新する
      liveData.sheetPending = (liveData.sheetPending || 0) + items.length;
      if (liveData.sheetPending >= 40) {
        const recent = liveEntries().slice(-liveData.sheetPending);
        liveData.sheetPending = 0;
        liveSave();
        updateSheet(cfg(), recent.map(stripTags).join('\n'), recent.map(k => stripTags(liveData.map[k])).join('\n'));
      }
    }
    const left = items.filter(({ src }) => hasKo(src)).length;
    if (liveErr) ui.toast('エラー: ' + liveErr.message + (left ? `（${left}文は未訳）` : ''), 6000);
    else if (left) ui.toast(`完了（${left}文は${L().name}のまま。メニューの「この話を翻訳し直す」で再挑戦できます）`, 6000);
    else ui.toast(didWork ? `翻訳完了（この場面 ${items.length}文・これまで ${liveEntries().length}文）` : `保存済みの${provName()}版の訳を表示中`, 3000);
  }




  const canSave = () => inPlaceOn || !!(liveData && liveData.key === liveKey() && liveEntries().length);

  function stopLive() {
    liveQueue.clear();
    if (liveData) liveSave();
  }

  // ライブ翻訳で読んだ分を、グループをまとめて1つのHTMLに
  function liveSaveHtml() {
    const b = liveBuild();
    if (!b) return ui.toast('まだ訳した文がありません', 3000);
    downloadHtml(b.html, b.title);
    ui.toast(`${b.scenes}場面・${b.keys.length}文を保存しました（最後：「${stripTags(liveData.map[b.keys[b.keys.length - 1]]).slice(0, 20)}」）`, 6000);
  }
  function liveBuild() {
    if (!liveData) return null;
    const seq = liveSeq().filter(x => liveData.map[x.src] != null);
    const keys = seq.map(x => x.src);
    if (!keys.length) return null;
    // いちばん多い文字サイズ・色などを「ふつう」とし、リーダー用データではそれと違う所だけ指定する
    const mode = arr => { const m = new Map(); arr.forEach(v => v != null && m.set(v, (m.get(v) || 0) + 1)); return [...m].sort((a, b) => b[1] - a[1])[0]?.[0]; };
    const lays = seq.map(x => x.lay).filter(Boolean);
    const base = { fs: mode(lays.map(l => l.fs)), col: mode(lays.map(l => l.col)), fw: mode(lays.map(l => l.fw)), fst: mode(lays.map(l => l.fst)), ff: mode(lays.map(l => l.ff)), lh: mode(lays.map(l => l.lh)) };
    const baseSize = parseFloat(base.fs) || 18;
    const blankH = base.lh && base.lh !== 'normal' ? base.lh : '1.9em';
    const paras = [];
    let lastG = null, body = '';
    for (const { src: k, scene, lay } of seq) {
      const meta = liveData.meta[k] || {};
      if (lastG != null && scene !== lastG) {
        paras.push({ blank: true }, { html: SCENE_MARK, text: SCENE_MARK, align: 'center', color: 'rgb(150, 150, 150)' }, { blank: true });
        body += `<p style="margin:0;height:${blankH}"></p>\n<p style="margin:0;text-align:center;color:#999;letter-spacing:.2em">${SCENE_MARK}</p>\n<p style="margin:0;height:${blankH}"></p>\n`;
      } else if (lay && lay.blanks) {
        for (let b = 0; b < lay.blanks; b++) { paras.push({ blank: true }); body += `<p style="margin:0;height:${blankH}"></p>\n`; }
      }
      const inner = meta.html || escHtml(stripTags(liveData.map[k]));
      // HTML：ページで見えていた段落の見た目をそのまま
      body += `<p style="margin:0 0 .6em;${lay ? layStyle(lay) : (meta.align ? 'text-align:' + meta.align : '')}">${inner}</p>\n`;
      // リーダー用：段落全体の太字・斜体・線は span で包み、色・大きさ・配置は段落の設定に
      let html = inner;
      const para = { text: stripTags(liveData.map[k]) };
      if (lay) {
        const wrap = [];
        if (lay.fw !== base.fw) wrap.push('font-weight:' + lay.fw);
        if (lay.fst !== base.fst) wrap.push('font-style:' + lay.fst);
        if (lay.td && lay.td !== 'none') wrap.push(`text-decoration-line:${lay.td};text-decoration-color:${lay.tdc}`);
        if (lay.ff !== base.ff) wrap.push('font-family:' + lay.ff);
        if (wrap.length) html = `<span style="${wrap.join(';')}">${html}</span>`;
        if (lay.al && lay.al !== 'left') para.align = lay.al;
        if (lay.col !== base.col) para.color = lay.col;
        const r = (parseFloat(lay.fs) || baseSize) / baseSize;
        if (Math.abs(r - 1) > 0.05) para.sizeRatio = Math.round(r * 100) / 100;
      } else if (meta.align) para.align = meta.align;
      para.html = html;
      paras.push(para);
      lastG = scene;
    }
    const title = pageTitle().replace(/\s+/g, ' ').trim() || 'translation';
    const data = { v: 1, title, source: location.href, baseSize, paras };
    const html = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title)}（翻訳）</title>
<script type="application/json" id="kztl-episode">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>
</head>
<body style="margin:0;background:#fff;color:${base.col || '#1a1a1a'};font-size:${base.fs || '18px'};font-family:${(base.ff || "'Noto Serif JP',serif").replace(/"/g, "'")};line-height:${base.lh && base.lh !== 'normal' ? base.lh : 1.9}">
<main style="max-width:720px;margin:0 auto;padding:24px 16px;box-sizing:border-box">
${body}</main></body></html>`;
    return { html, title, data, keys, scenes: new Set(seq.map(x => x.scene)).size };
  }

  // ---------- 作品ごとに全話まとめて保存 ----------
  // 訳した話は「リーダー用データ」をこの端末に控えておく（ページを開かなくても後でまとめて書き出せる）
  const epKey = () => 'ep:' + workKey() + '|' + pageId() + '@' + prov();
  const epNum = t => { const m = String(t || '').match(/(\d+)\s*(?:화|話|회|回)/) || String(t || '').match(/(\d+)(?!.*\d)/); return m ? +m[1] : null; };
  let snapTimer = 0;
  const snapLater = () => { clearTimeout(snapTimer); snapTimer = setTimeout(snapshotEp, 800); };
  function snapshotEp() {
    try {
      let data = null;
      if (liveData && liveData.key === liveKey()) data = liveBuild()?.data || null;
      else if (copyCtx && copyCtx.href === pageId() && inPlaceOn) data = episodeData(copyCtx);
      if (!data || !data.paras || !data.paras.length) return;
      const k = epKey(), old = GM_getValue(k, null);
      const n = data.paras.filter(x => !x.blank).length;
      if (old && old.n > n) return; // 途中までしか表示されていないときは、前の多い方を残す
      GM_setValue(k, { work: workName(), wk: workKey(), title: data.title, num: epNum(data.title), prov: prov(), at: Date.now(), n, data });
    } catch { /* 控えられなくても翻訳は続ける */ }
  }
  function epHtml(data) {
    const blankH = '1.9em';
    let body = '';
    for (const p of data.paras) {
      if (p.blank) { body += `<p style="margin:0;height:${blankH}"></p>\n`; continue; }
      const st = [];
      if (p.align) st.push('text-align:' + p.align);
      if (p.color) st.push('color:' + p.color);
      if (p.sizeRatio) st.push('font-size:' + p.sizeRatio + 'em');
      body += `<p style="margin:0 0 .6em;${st.join(';')}">${p.html || escHtml(p.text || '')}</p>\n`;
    }
    return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(data.title || '')}（翻訳）</title>
<script type="application/json" id="kztl-episode">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>
</head>
<body style="margin:0;background:#fff;color:#1a1a1a;font-size:${data.baseSize || 18}px;font-family:'Noto Serif JP','Hiragino Mincho ProN','Yu Mincho',serif;line-height:1.9">
<main style="max-width:720px;margin:0 auto;padding:24px 16px;box-sizing:border-box">
${body}</main></body></html>`;
  }
  // 圧縮なしのZIPを作る（外部ライブラリなし）
  const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = u8 => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  function makeZip(files) {
    const enc = new TextEncoder(), parts = [], central = [];
    let off = 0;
    const d = new Date();
    const dosT = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosD = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    for (const f of files) {
      const name = enc.encode(f.name), data = enc.encode(f.text), crc = crc32(data);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint16(10, dosT, true); h.setUint16(12, dosD, true); h.setUint32(14, crc, true);
      h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
      parts.push(h.buffer, name, data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
      c.setUint16(12, dosT, true); c.setUint16(14, dosD, true); c.setUint32(16, crc, true);
      c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true);
      c.setUint32(42, off, true);
      central.push(c.buffer, name);
      off += 30 + name.length + data.length;
    }
    const cSize = central.reduce((a, b) => a + (b.byteLength ?? b.length), 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, cSize, true); e.setUint32(16, off, true);
    return new Blob([...parts, ...central, e.buffer], { type: 'application/zip' });
  }
  // 作品の一覧（この端末に控えた話の数つき）
  function epWorks() {
    const works = new Map();
    for (const k of GM_listValues()) {
      if (!k.startsWith('ep:')) continue;
      const v = GM_getValue(k, null); if (!v) continue;
      const w = works.get(v.wk) || { wk: v.wk, work: v.work, pages: new Map() };
      const page = k.slice(3).replace(/@[^@]*$/, '');
      const list = w.pages.get(page) || []; list.push(v); w.pages.set(page, list);
      works.set(v.wk, w);
    }
    return [...works.values()].sort((a, b) => a.work.localeCompare(b.work));
  }
  function saveWorkZip(wk) {
    const w = epWorks().find(x => x.wk === wk);
    if (!w) return ui.toast('この作品の控えがまだありません。訳した話を一度開いて「訳」を押すと控えられます', 5000);
    const eps = [...w.pages.values()].map(list => list.find(v => v.prov === prov()) || list.sort((a, b) => b.at - a.at)[0]);
    eps.sort((a, b) => (a.num ?? 1e9) - (b.num ?? 1e9) || a.at - b.at);
    const safe = t => String(t || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 70);
    const files = eps.map((v, i) => ({ name: String(v.num ?? i + 1).padStart(4, '0') + '_' + safe(v.title) + '.html', text: epHtml(v.data) }));
    const blob = makeZip(files);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = safe(w.work || 'novel') + '（' + eps.length + '話）.zip';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    const nums = eps.map(v => v.num).filter(n => n != null);
    ui.toast(`「${w.work}」${eps.length}話をまとめて保存しました${nums.length ? `（${Math.min(...nums)}〜${Math.max(...nums)}話）` : ''}`, 5000);
  }
  function showWorkList() {
    ui.open();
    const ws = epWorks();
    ui.workList(ws.map(w => ({ wk: w.wk, work: w.work, n: w.pages.size, here: w.wk === workKey() })));
    ui.status(ws.length ? '作品を選ぶと、訳した話をまとめてZIPで保存します' : 'まだ控えた話がありません');
  }

  function downloadHtml(html, title) {
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) + '（' + provName() + '）.html';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  async function translateInPlace(force) {
    if (busy) return;
    // カカオの演出ビューアのように、表示中の数文だけが文字になっている作りなら「表示中の文だけ訳す」
    // カカオページは、グループの大小に関係なくいつも「表示中の文を文字だけ差し替え」で訳す
    // （要素を作り替えるとビューアが壊れるため。訳した文は全グループ分まとめて記録・保存される）
    if (/page\.kakao/.test(location.host)) return translateShown(force);
    const live = [...applied.keys()].some(e => e.isConnected);
    if (inPlaceOn && live && !force) return restore();
    if (inPlaceOn && (!live || force)) restore();

    const roots = findBodies();
    if (!roots.length) return ui.toast('本文が見つかりません。拡張メニューの「本文エリアを手動で選ぶ」か「診断」を使ってください');
    await prepBodies(cfg(), roots);
    // コメント・前後の話へのリンク・おすすめ作品などの段落は訳さない
    const els = roots.flatMap(r => collectParas(r).filter(el => !inNonBody(el, r) && !isUiWord(el.textContent)));
    copyCtx = null;
    const srcs = els.map(serialize);
    const src = srcs.map(stripTags).join('\n\n');
    const key = tagged('cache2:' + hash(location.pathname + location.search + src));

    if (force) GM_deleteValue(key + ':fx');
    let cached = !force && GM_getValue(key);
    if (cached) cached = cached.map((t, i) => clean(t, srcs[i]));
    if (cached) {
      saveParas(srcs, cached);
      applyTr(els, cached);
      copyCtx = { roots, els, tr: cached, srcs, href: pageId() };
      setLast(cached.map((t, i) => toPlain(els[i], t ?? srcs[i])).join('\n\n'));
      const c0 = cfg();
      const bad = cached.filter(needsFix).length;
      // 自動修正は1話につき1回だけ（わざと韓国語の演出などで毎回料金がかかるのを防ぐ）
      if (!bad || !c0.key || GM_getValue(key + ':fx')) return ui.toast(bad ? `保存済みの${provName()}版の訳を表示中（${bad}段落は${L().name}のまま。「再翻訳」で訳し直せます）` : `保存済みの${provName()}版の訳を表示中`, bad ? 4000 : 2500);
      GM_setValue(key + ':fx', 1);
      // 保存済みの訳に韓国語が残っていたら、その段落だけ自動で直す
      setBusy(true);
      try {
        const tr0 = cached.slice();
        copyCtx.tr = tr0;
        const fx = await fixLeftovers(c0, els, srcs, tr0, src.length <= 30000 ? src : '', tr0.slice(0, 10).filter(Boolean).map(stripTags).join('\n\n'), new Set());
        GM_setValue(key, tr0);
        ui.toast(fx.left ? `保存済みの訳を表示中（${fx.left}段落は${L().name}のまま${fx.err ? '／エラー: ' + fx.err.message : ''}）` : '保存済みの訳の韓国語部分を直しました', 5000);
      } catch (e) {
        ui.toast('エラー: ' + e.message);
      } finally {
        setBusy(false);
      }
      return;
    }

    const c = cfg();
    if (!c.key) { ui.open(); ui.status('APIキーを設定してください'); return ui.settings(true); }

    // 段落ごとの記録にある段落は、そのまま使う（料金なし）
    const pm = force ? {} : getParaMap();
    const tr = srcs.map(x => (pm[x] != null ? pm[x] : null));
    const need = srcs.map((_, i) => i).filter(i => tr[i] == null);
    if (!need.length) {
      applyTr(els, tr);
      copyCtx = { roots, els, tr, srcs, href: pageId() };
      GM_setValue(key, tr);
      setLast(tr.map((t, i) => toPlain(els[i], t ?? srcs[i])).join('\n\n'));
      return ui.toast('保存済みの訳を表示中（段落ごとの記録から）', 2500);
    }
    if (need.length < srcs.length) { applyTr(els, tr); ui.toast(`記録にある${srcs.length - need.length}段落はそのまま表示、残り${need.length}段落を翻訳します`, 2500); }
    const chunks = makeChunks(need.map(i => srcs[i].length), c.chunk, c.quickStart).map(g => g.map(j => need[j]));
    const whole = (chunks.length > 1 || need.length < srcs.length) && src.length <= 30000 ? src : '';
    const par = Math.max(1, +c.parallel || 1);

    copyCtx = { roots, els, tr, srcs, href: pageId() };
    let finished = 0, blocked = 0, lastErr = null;
    const blockedSet = new Set();
    setBusy(true);
    ui.toast(`本文${src.length}字・${els.length}段落 / 翻訳中 0 / ${chunks.length}`);
    const joinIdx = ids => ids.map(i => tr[i]).filter(t => t != null).map(stripTags).join('\n\n');
    const doChunk = async k => {
      const ref = par > 1 ? (k ? joinIdx(chunks[0]) : '') : joinIdx(chunks.slice(0, k).flat());
      const user = buildUser(c, whole, ref, par > 1 ? 'この話の冒頭の訳文' : '直前までの訳文の末尾',
        chunks[k].map(i => `[[${i + 1}]] ${srcs[i]}`).join('\n\n'));
      let res;
      try {
        // 訳し終わった段落から順に、その場でページに反映する
        const onText = part => {
          const m = parseNum(part);
          if (!m.size) return;
          const maxN = Math.max(...m.keys());
          let changed = false;
          for (const i of chunks[k]) {
            const n = i + 1;
            if (n < maxN && m.has(n) && tr[i] == null) { tr[i] = clean(m.get(n), srcs[i]); changed = true; }
          }
          if (changed) {
            applyTr(els, tr);
            ui.toast(`翻訳中… ${tr.filter(t => t != null).length} / ${els.length}段落`);
          }
        };
        res = await withRetry(m => llm(c, sysNum(), user, m, onText), modelList(c),
          (...a) => ui.toast(waitMsg(...a)));
      } catch (e) {
        res = '';
        if (/^BLOCKED/.test(e.message)) { blocked += chunks[k].length; chunks[k].forEach(i => blockedSet.add(i)); }
        else lastErr = e; // 1つの塊が失敗しても止めず、あとで訳し直す
      }
      const m = parseNum(res);
      for (const i of chunks[k]) if (m.has(i + 1)) tr[i] = clean(m.get(i + 1), srcs[i]);
      finished++;
      applyTr(els, tr);
      setLast(tr.map((t, i) => toPlain(els[i], t ?? srcs[i])).join('\n\n'));
      ui.toast(`本文${src.length}字・${els.length}段落 / 翻訳中 ${finished} / ${chunks.length}`);
    };
    try {
      await doChunk(0);
      await pool(par, chunks.length - 1, i => doChunk(i + 1));

      // 韓国語が残った段落・抜けた段落だけ自動で訳し直す
      const fx = await fixLeftovers(c, els, srcs, tr, whole, joinIdx(chunks[0]), blockedSet);
      const left = fx.left;
      if (fx.err) lastErr = fx.err;
      GM_setValue(key, tr);
      saveParas(srcs, tr);
      saveTail(tr.filter(t => t != null).join('\n'));
      updateSheet(c, src, tr.filter(t => t != null).map(stripTags).join('\n\n'));
      const msgs = [];
      if (blocked) msgs.push(`${blocked}段落はブロックされ原文のまま`);
      if (left) msgs.push(`${left}段落は${L().name}のまま。「再翻訳」を試してください`);
      if (left && lastErr) msgs.push('エラー: ' + lastErr.message);
      ui.toast(msgs.length ? `完了（${msgs.join('／')}）` : `完了（${els.length}段落）`, msgs.length ? 6000 : 3000);
    } catch (e) {
      ui.toast('エラー: ' + e.message);
    } finally {
      setBusy(false);
    }
  }

  // ---------- 訳の記録の書き出し・読み込み（ほかの端末へ移す） ----------
  const DATA_PREFIX = /^(cache2?:|live:|para:|sheet:|tail:|sel:|pos:|force:|ep:)/;
  function backupJson() {
    const data = {};
    for (const k of GM_listValues()) if (DATA_PREFIX.test(k)) data[k] = GM_getValue(k);
    // 設定（用語集・指示・モデルなど）も一緒に。APIキーとGitHubの鍵は入れない
    const settings = Object.assign({}, GM_getValue('cfg', {}));
    delete settings.keys; delete settings.key; delete settings.gistToken; delete settings.gistId;
    return { json: JSON.stringify({ kztl: 1, exportedAt: new Date().toISOString(), data, settings }), n: Object.keys(data).length };
  }

  // ---------- クラウド（GitHub Gist・非公開）への自動バックアップ ----------
  const GIST_FILE = 'novel-translator-backup.json';
  function gh(method, url, token, body) {
    return new Promise((ok, ng) => GM_xmlhttpRequest({
      method, url, data: body ? JSON.stringify(body) : undefined,
      headers: Object.assign({ Accept: 'application/vnd.github+json' }, token ? { Authorization: 'Bearer ' + token } : {}, body ? { 'Content-Type': 'application/json' } : {}),
      onload: r => (r.status >= 200 && r.status < 300 ? ok(r.responseText) : ng(new Error(r.status + ' ' + (r.responseText || '').slice(0, 120)))),
      onerror: () => ng(new Error('通信エラー')), ontimeout: () => ng(new Error('時間切れ')), timeout: 60000,
    }));
  }
  async function backupNow(manual) {
    const c = GM_getValue('cfg', {});
    const token = (c.gistToken || '').trim();
    if (!token) { if (manual) ui.toast('設定でGitHubのトークンを入れてください', 4000); return; }
    const { json, n } = backupJson();
    const body = { description: '韓国小説 丸ごと翻訳のバックアップ', files: { [GIST_FILE]: { content: json } } };
    try {
      if (c.gistId) await gh('PATCH', 'https://api.github.com/gists/' + c.gistId, token, body);
      else {
        const r = JSON.parse(await gh('POST', 'https://api.github.com/gists', token, Object.assign({ public: false }, body)));
        KZ_SET('cfg', Object.assign({}, GM_getValue('cfg', {}), { gistId: r.id }));
      }
      backupDirty = false;
      KZ_SET('backupAt', Date.now());
      if (manual) ui.toast(`クラウドに保存しました（${n}件）`, 3000);
    } catch (e) {
      if (manual) ui.toast('クラウド保存に失敗：' + e.message, 5000);
    }
  }
  function scheduleBackup() {
    clearTimeout(backupTimer);
    // 訳が続いている間はまとめて、最後の変更から1分後に1回だけ送る
    backupTimer = setTimeout(() => {
      const c = GM_getValue('cfg', {});
      if (backupDirty && c.gistToken && c.autoBackup !== false) backupNow(false);
    }, 60000);
  }
  async function restoreFromCloud() {
    const c = GM_getValue('cfg', {});
    const token = (c.gistToken || '').trim();
    if (!token) return ui.toast('設定でGitHubのトークンを入れてください', 4000);
    try {
      let id = c.gistId;
      if (!id) { // 新しい端末ではIDが無いので、自分のGistから探す
        const list = JSON.parse(await gh('GET', 'https://api.github.com/gists?per_page=100', token));
        const g = list.find(x => x.files && x.files[GIST_FILE]);
        if (!g) return ui.toast('クラウドにバックアップが見つかりません', 4000);
        id = g.id;
        KZ_SET('cfg', Object.assign({}, GM_getValue('cfg', {}), { gistId: id }));
      }
      const g = JSON.parse(await gh('GET', 'https://api.github.com/gists/' + id, token));
      const file = g.files && g.files[GIST_FILE];
      if (!file) return ui.toast('クラウドにバックアップが見つかりません', 4000);
      const text = file.truncated ? await gh('GET', file.raw_url, token) : file.content;
      importData(text);
    } catch (e) { ui.toast('クラウドから読み込めません：' + e.message, 5000); }
  }

  function exportData() {
    const { json } = backupJson();
    const data = JSON.parse(json).data;
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'novel-translator-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    ui.toast(`訳の記録と設定を書き出しました（${Object.keys(data).length}件）。APIキーは含まれません`, 4000);
  }

  // 同じ話の記録が両方にあるときは合わせる（訳は多い方・新しい方を残す）
  function mergeValue(k, cur, inc) {
    if (cur == null) return inc;
    if (k.startsWith('para:') && typeof cur === 'object') return Object.assign({}, cur, inc);
    if (k.startsWith('live:') && typeof cur === 'object') {
      const out = Object.assign({}, cur);
      out.map = Object.assign({}, inc.map || {}, cur.map || {});
      out.meta = Object.assign({}, inc.meta || {}, cur.meta || {});
      const cnt = v => (v.scenes || []).reduce((a, x) => a + x.length, 0);
      if (cnt(inc) > cnt(cur)) { out.scenes = inc.scenes; out.layouts = inc.layouts; }
      out.order = [...new Set([...(cur.order || []), ...(inc.order || [])])];
      return out;
    }
    if (k.startsWith('tail:')) return (inc.at || 0) > (cur.at || 0) ? inc : cur;
    if (Array.isArray(cur) && Array.isArray(inc)) return cur.map((t, i) => t ?? inc[i]);
    return cur; // 作品メモなど：今の端末のものを優先
  }

  function importData(text) {
    let j;
    try { j = JSON.parse(text); } catch { return ui.toast('読み込めません：ファイルの形式が違います', 4000); }
    if (!j || !j.data || typeof j.data !== 'object') return ui.toast('読み込めません：このスクリプトの書き出しファイルではありません', 4000);
    let n = 0;
    for (const [k, v] of Object.entries(j.data)) {
      if (!DATA_PREFIX.test(k)) continue;
      GM_setValue(k, mergeValue(k, GM_getValue(k, null), v));
      n++;
    }
    let setMsg = '';
    if (j.settings && typeof j.settings === 'object') {
      const cur = GM_getValue('cfg', {});
      const inc = Object.assign({}, j.settings); delete inc.keys; delete inc.key; delete inc.gistToken; delete inc.gistId;
      // こっちの端末のAPIキー・GitHubの鍵はそのまま残す
      KZ_SET('cfg', Object.assign({}, cur, inc, { keys: cur.keys || {} }));
      setMsg = '・設定も反映';
    }
    liveData = null;
    ui.toast(`訳の記録を読み込みました（${n}件${setMsg}）。APIキーだけ入れ直してください`, 5000);
  }

  // ---------- UI ----------
  const ui = (() => {
    const host = document.createElement('div');
    host.id = 'kztl-host';
    const root = host.attachShadow({ mode: 'open' });
    const STYLE = `<style>
      :host { all: initial; }
      [hidden] { display: none !important; }
      .dock { --ac: #5465e8; --ac2: #3b4bd0; --on: #12a58a; --on2: #0b8a73;
        position: fixed; right: 16px; bottom: 18px; z-index: 2147483647; display: grid;
        grid-template-columns: auto auto; gap: 10px; align-items: center; justify-items: center;
        touch-action: none; opacity: .88; transition: opacity .2s; }
      .dock:hover, .dock:active, .dock.dragging { opacity: 1; }
      .dock.dragging .fab { transform: scale(1.06); box-shadow: 0 10px 24px rgba(20,24,40,.3); }
      .fab { position: relative; width: 54px; height: 54px; padding: 0; border: 0; border-radius: 50%; cursor: pointer;
        background: linear-gradient(145deg, var(--ac), var(--ac2)); color: #fff;
        font: 700 19px/1 system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif; letter-spacing: 0;
        box-shadow: 0 4px 14px rgba(59,75,208,.38), 0 1px 3px rgba(0,0,0,.18);
        transition: transform .12s ease, box-shadow .2s ease, filter .12s ease, background .25s ease;
        -webkit-tap-highlight-color: transparent; }
      .fab.sub { width: 42px; height: 42px; font-size: 15px; font-weight: 600; color: #2b3447;
        background: rgba(255,255,255,.94); border: 1px solid rgba(20,30,60,.08);
        box-shadow: 0 3px 10px rgba(20,24,40,.16); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); }
      @media (prefers-color-scheme: dark) {
        .fab.sub { color: #e7e9f2; background: rgba(38,42,56,.92); border-color: rgba(255,255,255,.08); }
      }
      .fab.main.on { background: linear-gradient(145deg, var(--on), var(--on2)); box-shadow: 0 4px 14px rgba(11,138,115,.38), 0 1px 3px rgba(0,0,0,.18); }
      /* 押した瞬間：沈み込む */
      .fab.pressed, .fab:active { transform: scale(.86); filter: brightness(.9); }
      /* 押したあと：波紋が広がる */
      .fab.flash { animation: kz-ring .5s ease-out; }
      .fab.sub.flash { animation: kz-ring-sub .5s ease-out; }
      @keyframes kz-ring { 0% { box-shadow: 0 0 0 0 rgba(84,101,232,.55), 0 4px 14px rgba(59,75,208,.38); }
        100% { box-shadow: 0 0 0 16px rgba(84,101,232,0), 0 4px 14px rgba(59,75,208,.38); } }
      @keyframes kz-ring-sub { 0% { box-shadow: 0 0 0 0 rgba(84,101,232,.45), 0 3px 10px rgba(20,24,40,.16); }
        100% { box-shadow: 0 0 0 13px rgba(84,101,232,0), 0 3px 10px rgba(20,24,40,.16); } }
      /* 翻訳中：ボタンのまわりをくるくる */
      .fab.main.busy::before { content: ""; position: absolute; inset: -5px; border-radius: 50%;
        border: 3px solid rgba(84,101,232,.18); border-top-color: var(--ac); animation: kz-spin .8s linear infinite; }
      .fab.main.on.busy::before { border-color: rgba(18,165,138,.18); border-top-color: var(--on); }
      @keyframes kz-spin { to { transform: rotate(360deg); } }
      .fab:focus-visible, button:focus-visible { outline: 2px solid #7d8cf5; outline-offset: 2px; }
      .panel { --ac: #5465e8; --bg: #f3f4f8; --card: #fff; --line: rgba(20,30,60,.1); --mute: #6a7285;
        position: fixed; inset: 0; z-index: 2147483647; display: flex; flex-direction: column;
        background: var(--bg); color: #1d2330; }
      @media (prefers-color-scheme: dark) { .panel { --bg: #13151c; --card: #1c1f29; --line: rgba(255,255,255,.08); --mute: #9aa1b3; color: #e2e5ee; } }
      .bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 10px 14px;
        background: var(--card); border-bottom: 1px solid var(--line); font: 14px system-ui, sans-serif;
        box-shadow: 0 1px 8px rgba(0,0,0,.04); }
      button { font: 500 14px system-ui, sans-serif; padding: 8px 14px; border-radius: 10px; border: 1px solid var(--line, rgba(127,127,127,.3));
        background: var(--card, transparent); color: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent;
        transition: transform .1s ease, background .15s ease, box-shadow .15s ease; }
      button:hover { background: rgba(84,101,232,.08); }
      button:active, button.pressed { transform: scale(.95); background: rgba(84,101,232,.18); }
      button.primary { background: var(--ac); border-color: var(--ac); color: #fff; box-shadow: 0 2px 8px rgba(84,101,232,.3); }
      button.primary:hover { background: #4757da; }
      button.primary:active, button.primary.pressed { background: #3b4bd0; }
      .st { margin-left: auto; color: var(--mute); font-size: 13px; }
      .scroll { flex: 1; overflow: auto; }
      .text { max-width: 36em; margin: 0 auto; padding: 32px 20px 120px; letter-spacing: .02em;
        font: 18px/2 "Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif; }
      .text p { margin: 0 0 1em; }
      .cfg { max-width: 36em; margin: 16px auto 40px; padding: 20px 18px; display: grid; gap: 16px; font: 14px/1.5 system-ui, sans-serif;
        background: var(--card); border: 1px solid var(--line); border-radius: 16px; box-shadow: 0 2px 12px rgba(0,0,0,.04); }
      .cfg label { display: grid; gap: 6px; color: var(--mute); font-size: 13px; }
      .cfg label > input, .cfg label > select, .cfg label > textarea { color: #1d2330; font-size: 15px; }
      @media (prefers-color-scheme: dark) { .cfg label > input, .cfg label > select, .cfg label > textarea { color: #e2e5ee; } }
      input, select, textarea { font: inherit; padding: 10px 12px; border-radius: 10px; color: inherit;
        border: 1px solid var(--line, rgba(127,127,127,.35)); background: var(--bg, transparent); outline: none;
        transition: border-color .15s ease, box-shadow .15s ease; }
      input:focus, select:focus, textarea:focus { border-color: var(--ac); box-shadow: 0 0 0 3px rgba(84,101,232,.18); }
      input[type=checkbox] { width: 20px; height: 20px; padding: 0; accent-color: var(--ac); flex: none; }
      textarea { min-height: 10em; line-height: 1.6; }
      .row { display: flex; gap: 8px; flex-wrap: wrap; }
      .row button { flex: 1; }
      .cfg label.check { display: flex; gap: 10px; align-items: center; color: inherit; font-size: 14px; }
      .cfg .sec { margin: 10px 0 -4px; padding-top: 14px; border-top: 1px solid var(--line); font-weight: 700; font-size: 12px; letter-spacing: .08em; color: var(--ac); }
      .fab { -webkit-touch-callout: none; user-select: none; -webkit-user-select: none; touch-action: none; }
      .fab.main { grid-column: 2; grid-row: 2; }
      .fab.gear { grid-column: 1; grid-row: 2; font-size: 19px; }
      .fab.save { grid-column: 1; grid-row: 1; }
      .fab.copy { grid-column: 2; grid-row: 1; }
      .text { user-select: text; -webkit-user-select: text; }
      .card { position: fixed; left: 12px; right: 12px; bottom: calc(env(safe-area-inset-bottom, 0px) + 130px); z-index: 2147483646;
        max-height: 40vh; overflow: auto; padding: 14px 40px 14px 16px; border-radius: 12px; background: rgba(255,255,255,.97);
        color: #1a1a1a; box-shadow: 0 4px 18px rgba(0,0,0,.18); font: 17px/1.8 "Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif; }
      @media (prefers-color-scheme: dark) { .card { background: rgba(28,32,40,.97); color: #e6e8ec; } }
      .card p { margin: 0 0 .4em; }
      .card p:last-child { margin-bottom: 0; }
      .card-x { position: absolute; top: 6px; right: 6px; width: 30px; height: 30px; padding: 0; border: 0; font-size: 18px; opacity: .6; }
      .ov-layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483645; overflow: hidden; }
      .ov { position: fixed; box-sizing: border-box; pointer-events: none; margin: 0; }
      .toast { position: fixed; left: 50%; transform: translateX(-50%); width: max-content; max-width: calc(100vw - 32px); box-sizing: border-box;
        top: calc(env(safe-area-inset-top, 0px) + 14px); z-index: 2147483647; padding: 10px 16px;
        border-radius: 14px; background: rgba(24,28,40,.9); color: #fff; font: 500 13.5px/1.55 system-ui, sans-serif;
        box-shadow: 0 8px 24px rgba(0,0,0,.22); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
        animation: kz-pop .22s ease-out; }
      @keyframes kz-pop { from { opacity: 0; transform: translate(-50%, -8px); } to { opacity: 1; transform: translate(-50%, 0); } }
      iframe.panel { position: fixed; inset: 0; width: 100%; height: 100%; border: 0; padding: 0; margin: 0;
        z-index: 2147483647; background: transparent; display: block; }
    </style>`;
    // 設定・読書パネルはiframeの中に置く。サイト側のキー操作やタップ判定（ページ送りなど）に入力を奪われないようにするため
    const PANEL = `<div class="panel">
      <div class="bar">
        <button data-a="close">閉じる</button>
        <button data-a="redo">再翻訳</button>
        <button data-a="copy">コピー</button>
        <button data-a="set">設定</button>
        <button data-a="works">作品ごとに保存</button>
        <span class="st"></span>
      </div>
      <div class="scroll">
        <div class="text"></div>
        <div class="cfg" hidden>
          <div class="sec" style="border-top:0;padding-top:0;margin-top:0">翻訳エンジン</div>
          <label>表示方法
            <select name="mode">
              <option value="inplace">元のページに上書き（サイトの見た目のまま）</option>
              <option value="overlay">別画面で読む</option>
            </select></label>
          <label>原文の言語（自動なら本文の文字から判定）
            <select name="lang">
              <option value="auto">自動</option>
              <option value="ko">韓国語</option>
              <option value="zh">中国語</option>
              <option value="en">英語</option>
            </select></label>
          <label>エンジン
            <select name="provider">
              <option value="gemini">Gemini</option>
              <option value="claude">Claude</option>
              <option value="openai">OpenAI互換（DeepSeekなど）</option>
            </select></label>
          <label>APIキー（エンジンごとに保存） <input name="key" type="password" autocomplete="off"></label>
          <label>モデル名（空欄で既定） <input name="model"></label>
          <label>一覧から選ぶ <select name="modelPick"><option value="">（選ぶとモデル名に入ります）</option></select></label>
          <label>予備モデル（混雑時に順番に切り替え。カンマ区切り、空欄で既定） <input name="fallback"></label>
          <div class="sec">表示と送り方</div>
          <label>文の中の小さな画像（絵文字・アイコン）の代わりに入れる文字（空欄なら画像のまま） <input name="imgChar" placeholder="例：😄"></label>
          <label class="check"><input type="checkbox" name="jaFont"> 訳文の漢字を日本の字形で表示（韓国風の漢字に違和感があるとき）</label>
          <label class="check"><input type="checkbox" name="adult"> 成人向け表現のブロックを外す（Geminiのみ）</label>
          <label>ベースURL（OpenAI互換のみ） <input name="baseUrl"></label>
          <label class="check"><input type="checkbox" name="quickStart"> 冒頭を先に表示する（オフにすると1話を1回で送れて安くなるが、表示まで待つ）</label>
          <label>同時に送る数（1で順番に。多いほど速いが回数制限に当たりやすい） <input name="parallel" type="number" min="1" max="6"></label>
          <label>1回に送る文字数 <input name="chunk" type="number" min="1000" step="500"></label>
          <div class="sec">用語・作品メモ</div>
          <label>用語集（1行に「原語=訳語」） <textarea name="glossary" placeholder="例：&#10;김독자=キム・ドクシャ&#10;도깨비=トッケビ"></textarea></label>
          <label class="check"><input type="checkbox" name="autoSheet"> 作品メモを自動で作る（人物・一人称・口調を話をまたいで統一）</label>
          <label>作品メモの更新に使うモデル（空欄で既定。ClaudeはHaikuで安く） <input name="sheetModel"></label>
          <label><span class="sheet-title">この作品のメモ</span>（自動更新・手で直してもOK。作品のページで開いたときに表示） <textarea name="sheet"></textarea></label>
          <label>追加の指示（1行に1つ。作品ごとに書き分けてOK） <textarea name="instructions" placeholder="例：『作品名』主人公ソン・ユハン（男）の一人称は地の文・台詞とも「俺」"></textarea></label>
          <div class="row"><button data-a="save" class="primary">保存</button><button data-a="cancel">戻る</button></div>
          <div class="sec">記録の引っ越し・バックアップ</div>
          <label>訳の記録（ほかの端末へ移すとき。APIキーは含まれません）</label>
          <div class="row"><button data-a="export">記録を書き出す</button><button data-a="import">記録を読み込む</button></div>
          <label>クラウドに自動バックアップ（GitHubのトークン。gist の権限だけでOK。スマホを無くしても別の端末で戻せます） <input name="gistToken" type="password" autocomplete="off" placeholder="github_pat_… / ghp_…"></label>
          <label class="check"><input type="checkbox" name="autoBackup"> 訳すたびに自動でクラウドへ保存（最後の変更から1分後）</label>
          <div class="row"><button data-a="cloudSave" class="primary">今すぐクラウドに保存</button><button data-a="cloudLoad">クラウドから戻す</button></div>
          <input type="file" name="importFile" accept=".json,application/json" hidden>
        </div>
      </div>
    </div>`;
    root.innerHTML = STYLE + `
    <div class="dock">
      <button class="fab sub save" title="訳したページを保存" hidden>保</button>
      <button class="fab sub copy" title="訳文をコピー" hidden>写</button>
      <button class="fab sub gear" title="設定">⚙</button>
      <button class="fab main" title="この話を翻訳（ドラッグで移動）">訳</button>
    </div>
    <div class="ov-layer"></div>
    <div class="toast" hidden></div>
    <div class="card" hidden><button class="card-x" title="閉じる">×</button><div class="card-body"></div></div>
    <iframe class="panel" hidden title="翻訳パネル"></iframe>`;
    document.documentElement.appendChild(host);
    const frame = root.querySelector('iframe.panel');
    let pd = frame.contentDocument;
    if (pd) {
      pd.open();
      pd.write(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${STYLE}</head><body style="margin:0">${PANEL}</body></html>`);
      pd.close();
    } else {
      // iframeが使えない環境では従来どおりシャドウDOM内に置く
      frame.remove();
      const t = document.createElement('template');
      t.innerHTML = PANEL.replace('<div class="panel">', '<div class="panel" hidden>');
      root.append(t.content);
      pd = root;
    }

    const $ = s => root.querySelector(s) || pd.querySelector(s);
    const copyBtn = $('.copy'), gearBtn = $('.gear'), saveBtn = $('.save');
    const fab = $('.fab.main'), dock = $('.dock'), panel = $('.panel'), text = $('.text'), form = $('.cfg'), st = $('.st');
    const f = n => form.querySelector(`[name=${n}]`);

    let draft = { keys: {}, models: {}, fallbacks: {}, sheetModels: {} }, curProv = 'gemini';
    // トークンだけ先に保存（保存ボタンを押さずにクラウドのボタンを押したとき用）
    const saveGist = () => KZ_SET('cfg', Object.assign({}, GM_getValue('cfg', {}), { gistToken: f('gistToken').value.trim() }));
    const stash = () => {
      draft.keys[curProv] = f('key').value.trim();
      draft.models[curProv] = f('model').value.trim();
      draft.fallbacks[curProv] = f('fallback').value.trim();
      draft.sheetModels[curProv] = f('sheetModel').value.trim();
    };
    function settings(show) {
      form.hidden = !show; text.hidden = show;
      if (!show) return;
      const c = cfg();
      draft = { keys: c.keys, models: c.models, fallbacks: c.fallbacks, sheetModels: c.sheetModels };
      curProv = c.provider;
      f('lang').value = c.lang || 'auto';
      for (const k of ['mode', 'provider', 'key', 'model', 'fallback', 'baseUrl', 'chunk', 'parallel', 'glossary', 'instructions']) f(k).value = c[k];
      f('model').placeholder = MODELS[c.provider];
      f('fallback').placeholder = FALLBACKS[c.provider] || 'なし';
      f('adult').checked = !!c.adult;
      f('imgChar').value = c.imgChar || '';
      f('jaFont').checked = c.jaFont !== false;
      f('gistToken').value = c.gistToken || ''; f('autoBackup').checked = c.autoBackup !== false;
      f('autoSheet').checked = !!c.autoSheet;
      f('quickStart').checked = c.quickStart !== false;
      f('sheet').value = getSheet();
      $('.sheet-title').textContent = `この作品のメモ【${workName().slice(0, 30) || workKey()}】`;
      f('sheetModel').value = c.sheetModel;
      f('sheetModel').placeholder = SHEET_MODELS[c.provider] || '翻訳と同じモデル';
      fillModels();
    }

    // モデル一覧：Geminiはキーがあれば実際に使えるものを取得、なければ既定の候補
    async function fillModels() {
      const sel = f('modelPick'), prov = f('provider').value, key = f('key').value.trim();
      const put = (list, note) => {
        sel.replaceChildren(new Option(note, ''), ...list.map(n => new Option(n, n)));
      };
      const base = [...new Set([MODELS[prov], ...(FALLBACKS[prov] || '').split(/[,\s]+/), ...(CANDIDATES[prov] || [])].filter(Boolean))];
      put(base, '（選ぶとモデル名に入ります）');
      if (prov !== 'gemini' || !key) return;
      try { put(await listGeminiModels(key), '（選ぶとモデル名に入ります・取得済み）'); }
      catch { /* 取得できなければ既定の候補のまま */ }
    }
    f('importFile').addEventListener('change', async e => {
      const inp = e.currentTarget || e.target;
      const file = inp.files && inp.files[0];
      if (file) importData(await file.text());
      try { inp.value = ''; } catch { /* 同じファイルを選び直せるようにするだけ */ }
    });
    f('modelPick').addEventListener('change', e => { if (e.target.value) f('model').value = e.target.value; });
    f('key').addEventListener('change', fillModels);
    f('provider').addEventListener('change', () => {
      stash();
      curProv = f('provider').value;
      f('key').value = draft.keys[curProv] || '';
      f('model').value = draft.models[curProv] || '';
      f('fallback').value = draft.fallbacks[curProv] || '';
      f('sheetModel').value = draft.sheetModels[curProv] || '';
      f('sheetModel').placeholder = SHEET_MODELS[curProv] || '翻訳と同じモデル';
      f('model').placeholder = MODELS[curProv]; f('fallback').placeholder = FALLBACKS[curProv] || 'なし';
      fillModels();
    });

    // タップで翻訳。設定は ⚙ ボタン（または「訳」の長押し）
    const openSettings = () => { panel.hidden = false; fab.hidden = true; copyBtn.hidden = true; saveBtn.hidden = true; gearBtn.hidden = true; settings(true); };
    fab.addEventListener('click', () => (cfg().mode === 'inplace' ? translateInPlace(false) : translate(false)));
    fab.addEventListener('contextmenu', e => { e.preventDefault(); if (!moved) openSettings(); });
    gearBtn.addEventListener('click', openSettings);

    // ドラッグで移動（位置はサイトごとに保存）
    const posKey = 'pos:' + location.host;
    function place(l, t) {
      const r = dock.getBoundingClientRect();
      l = Math.max(0, Math.min(innerWidth - r.width, l));
      t = Math.max(0, Math.min(innerHeight - r.height, t));
      Object.assign(dock.style, { left: l + 'px', top: t + 'px', right: 'auto', bottom: 'auto' });
      return { l, t };
    }
    let drag = null, moved = false;
    dock.addEventListener('pointerdown', e => {
      const r = dock.getBoundingClientRect();
      drag = { x: e.clientX, y: e.clientY, l: r.left, t: r.top, id: e.pointerId };
      moved = false;
    });
    window.addEventListener('pointermove', e => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!moved && Math.hypot(dx, dy) < 8) return;
      moved = true;
      dock.classList.add('dragging');
      drag.pos = place(drag.l + dx, drag.t + dy);
      e.preventDefault();
    }, { capture: true, passive: false });
    const endDrag = () => {
      if (drag && moved && drag.pos) GM_setValue(posKey, drag.pos);
      drag = null;
      dock.classList.remove('dragging');
    };
    window.addEventListener('pointerup', endDrag, true);
    window.addEventListener('pointercancel', endDrag, true);
    // ドラッグ直後はタップ扱いにしない
    dock.addEventListener('click', e => { if (moved) { moved = false; e.stopPropagation(); e.preventDefault(); } }, true);
    const saved = GM_getValue(posKey);
    if (saved) requestAnimationFrame(() => place(saved.l, saved.t));
    addEventListener('resize', () => { if (dock.style.left) place(parseFloat(dock.style.left), parseFloat(dock.style.top)); });
    const onClick = e => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'close') { panel.hidden = true; fab.hidden = false; }
      if (a === 'redo') {
        settings(false);
        if (cfg().mode === 'inplace') { panel.hidden = true; fab.hidden = false; translateInPlace(true); }
        else translate(true);
      }
      if (a === 'set') settings(form.hidden);
      if (a === 'copy') copyText();
      if (a === 'cancel') settings(false);
      if (a === 'export') exportData();
      if (a === 'cloudSave') { saveGist(); backupNow(true); }
      if (a === 'cloudLoad') { saveGist(); restoreFromCloud(); }
      if (a === 'zip') saveWorkZip(e.target.closest('[data-a]').dataset.wk);
      if (a === 'works') showWorkList();
      if (a === 'import') f('importFile').click();
      if (a === 'save') {
        stash();
        const prev = GM_getValue('cfg', {});
        KZ_SET('cfg', {
          gistId: prev.gistId || '', gistToken: f('gistToken').value.trim(), autoBackup: f('autoBackup').checked,
          mode: f('mode').value, provider: f('provider').value, lang: f('lang').value,
          keys: draft.keys, models: draft.models, fallbacks: draft.fallbacks, sheetModels: draft.sheetModels,
          baseUrl: f('baseUrl').value.trim(), chunk: Math.max(1000, +f('chunk').value || DEF.chunk),
          parallel: Math.min(6, Math.max(1, +f('parallel').value || DEF.parallel)),
          glossary: f('glossary').value, instructions: f('instructions').value, adult: f('adult').checked, imgChar: f('imgChar').value.trim(), jaFont: f('jaFont').checked, autoSheet: f('autoSheet').checked, quickStart: f('quickStart').checked,
        });
        resetLang();
        if (f('sheet').value.trim()) GM_setValue(sheetKey(), f('sheet').value.trim());
        else GM_deleteValue(sheetKey());
        settings(false); st.textContent = '設定を保存しました';
      }
    };
    root.addEventListener('click', onClick);
    if (pd !== root) pd.addEventListener('click', onClick);
    const onKey = e => { if (e.key === 'Escape' && !panel.hidden) { panel.hidden = true; fab.hidden = false; } };
    document.addEventListener('keydown', onKey);
    if (pd !== root) pd.addEventListener('keydown', onKey);

    // 押したのが分かるように：押している間は沈み、離したら波紋
    const press = scope => {
      scope.addEventListener('pointerdown', e => {
        const b = e.target.closest && e.target.closest('button'); if (!b) return;
        b.classList.add('pressed');
        const up = () => { setTimeout(() => b.classList.remove('pressed'), 90); window.removeEventListener('pointerup', up, true); window.removeEventListener('pointercancel', up, true); };
        window.addEventListener('pointerup', up, true); window.addEventListener('pointercancel', up, true);
      }, true);
      scope.addEventListener('click', e => {
        const b = e.target.closest && e.target.closest('button.fab'); if (!b) return;
        b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash');
        setTimeout(() => b.classList.remove('flash'), 520);
      }, true);
    };
    press(root); if (pd !== root) press(pd);
    const toastEl = $('.toast');
    const cardEl = $('.card'), cardBody = $('.card-body');
    $('.card-x').addEventListener('click', () => { cardEl.hidden = true; });
    let hasCopy = false;
    copyBtn.addEventListener('click', copyText);
    saveBtn.addEventListener('click', saveHtml);
    let toastTimer;
    return {
      host,
      layer: () => $('.ov-layer'),
      card: html => { cardBody.innerHTML = html; cardEl.hidden = false; },
      cardOpen: () => !cardEl.hidden,
      cardClose: () => { cardEl.hidden = true; },
      toast: (m, hideMs) => {
        clearTimeout(toastTimer);
        if (toastEl.hidden) { toastEl.style.animation = 'none'; void toastEl.offsetWidth; toastEl.style.animation = ''; }
        toastEl.textContent = m; toastEl.hidden = false;
        if (hideMs) toastTimer = setTimeout(() => { toastEl.hidden = true; }, hideMs);
      },
      fabText: () => fab.textContent,
      fabLabel: t => { fab.textContent = t; fab.classList.toggle('on', t === '原'); fab.title = t === '原' ? '原文に戻す' : 'この話を翻訳'; },
      setBusy: v => fab.classList.toggle('busy', !!v),
      showFab: v => { if (panel.hidden) { fab.hidden = !v; gearBtn.hidden = !v; copyBtn.hidden = !v || !hasCopy; saveBtn.hidden = !v || !hasCopy || !canSave(); } },
      canCopy: v => { hasCopy = v; copyBtn.hidden = !v || fab.hidden; saveBtn.hidden = !v || fab.hidden || !canSave(); },
      open: () => { panel.hidden = false; fab.hidden = true; settings(false); $('.scroll').scrollTop = 0; },
      status: m => { st.textContent = m; },
      workList: list => {
        settings(false);
        text.replaceChildren(...list.map(w => {
          const b = document.createElement('button');
          b.dataset.a = 'zip'; b.dataset.wk = w.wk; b.className = w.here ? 'primary' : '';
          b.style.cssText = 'display:block;width:100%;text-align:left;margin:0 0 10px;font:500 15px/1.5 system-ui,sans-serif;padding:12px 14px';
          b.textContent = `${w.work || '（名前なし）'}　— ${w.n}話${w.here ? '（今開いている作品）' : ''}`;
          return b;
        }));
      },
      settings,
      render: s => {
        text.replaceChildren(...s.split(/\n\s*\n/).filter(Boolean).map(t => {
          const p = document.createElement('p'); p.textContent = t; return p;
        }));
      },
    };
  })();

  let scanId = '', scanLeft = 0, scanHit = false, scanTick = 0;
  const snapDone = new Set();
  const check = () => {
    if ((inPlaceOn || textApplied.size) && !busy && !snapDone.has(pageId() + prov())) { snapDone.add(pageId() + prov()); snapLater(); }
    if (liveData && liveData.key !== liveKey()) clearOverlays(); // 別の話に移ったら重ね表示を外す
    if (!overlays.length && !inPlaceOn && !shownTranslated().length && ui.fabText() === '原') ui.fabLabel('訳');
    if (lastText && lastHref !== pageId()) setLast('');
    if (inPlaceOn && !liveOn && !(keep && keep.id === pageId()) && ![...applied.keys()].some(e => e.isConnected)) { applied.clear(); inPlaceOn = false; ui.fabLabel('訳'); }
    // Ridi・カカオページ以外の kakao.com では、iframeの中（ビューア）か、手動で有効にしたときだけ出す
    const reader = /ridibooks|page\.kakao/.test(location.host);
    const forced = GM_getValue('force:' + location.host, false);
    const active = inPlaceOn || textApplied.size > 0 || !!(liveData && liveData.key === liveKey() && liveEntries().length) || forced;
    let many;
    if (mark().kztlEp) many = koNodes(markedBody()) > 0; // イカ墨ノベルなど：短い文でもボタンを出す
    else if (siteBody()) many = koNodes(siteBody()) > 0; // 晋江など本文の場所が分かっているサイト
    else if (reader) many = koDeep() > 20; // Ridi・カカオページは本文が少しずつ出る作りでも出す
    else {
      // その他のサイト：重くならないよう、ページが変わった直後の数回だけ韓国語の量を数える
      if (scanId !== pageId()) { scanId = pageId(); scanLeft = 6; scanHit = false; }
      if (!scanHit && (scanLeft > 0 || ++scanTick % 4 === 0)) { scanLeft = Math.max(0, scanLeft - 1); scanHit = koDeep() > 300; } // あとから本文が出るページも、ゆっくり見続ける
      many = scanHit;
    }
    if (GM_getValue('hide:' + location.host, false) && !active) many = false; // このサイトでは出さない設定
    ui.showFab(active || many);
  };
  check();
  setInterval(check, 3000);

  // ---------- メニュー ----------
  GM_registerMenuCommand('設定を開く', () => { ui.open(); ui.settings(true); });
  GM_registerMenuCommand('この話を翻訳し直す（上書き表示）', () => translateInPlace(true));
  GM_registerMenuCommand('訳文をコピー', copyText);
  GM_registerMenuCommand('訳したページをHTMLで保存', saveHtml);
  GM_registerMenuCommand('ボタンの位置をリセット', () => { GM_deleteValue('pos:' + location.host); location.reload(); });
  GM_registerMenuCommand('下まで読み込んでから翻訳（本文が途中までしか訳されないとき）', async () => {
    if (busy) return;
    await preloadAll();
    translateInPlace(true);
  });
  GM_registerMenuCommand('本文エリアを手動で選ぶ', pick);
  GM_registerMenuCommand('このサイトでボタンを常に表示（切り替え）', () => {
    const k = 'force:' + location.host, v = !GM_getValue(k, false);
    GM_setValue(k, v);
    alert(v ? 'このサイトでは常にボタンを表示します' : '自動に戻しました');
    check();
  });
  GM_registerMenuCommand('このサイトではボタンを出さない（切り替え）', () => {
    const k = 'hide:' + location.host, v = !GM_getValue(k, false);
    GM_setValue(k, v);
    alert(v ? 'このサイトではボタンを出しません（メニューの「設定を開く」などはそのまま使えます）' : 'このサイトでもボタンを出すように戻しました');
    check();
  });
  GM_registerMenuCommand('診断（ボタンが出ないとき）', () => {
    const L = [];
    L.push('場所: ' + location.host + location.pathname.slice(0, 40));
    L.push('フレーム: ' + (window.top === window.self ? 'ページ本体' : 'iframeの中'));
    L.push('本体の韓国語: ' + ko(document.body?.textContent) + '字');
    let sh = 0, shk = 0;
    const walk = n => { for (const el of n.querySelectorAll('*')) if (el.shadowRoot && el.id !== 'kztl-host') { sh++; shk += ko(el.shadowRoot.textContent); walk(el.shadowRoot); } };
    walk(document);
    L.push('シャドウDOM: ' + sh + '個（韓国語 ' + shk + '字）');
    const frames = [...document.querySelectorAll('iframe')];
    L.push('iframe: ' + frames.length + '個');
    frames.slice(0, 5).forEach((f, i) => {
      let info;
      try { info = f.contentDocument ? '同じドメイン・韓国語 ' + ko(f.contentDocument.body?.textContent) + '字' : '読めない'; }
      catch { info = '別ドメイン'; }
      let host = '';
      try { host = new URL(f.src || 'about:blank', location.href).host || (f.src || 'srcdoc'); } catch { host = f.src || ''; }
      L.push('  ' + (i + 1) + ': ' + (host || 'about:blank') + '（' + info + '）');
    });
    L.push('canvas: ' + document.querySelectorAll('canvas').length + '個 / 画像: ' + document.querySelectorAll('img').length + '枚');
    try {
      const bodies = findBodies();
      const n = bodies.reduce((a, r) => a + ko(r.textContent), 0);
      L.push('見つかった本文: ' + bodies.length + 'グループ・韓国語 ' + n + '字');
      const els = bodies.flatMap(r => collectParas(r));
      L.push('段落: ' + els.length + '個');
      if (els[0]) L.push('最初の段落: ' + els[0].tagName.toLowerCase() + '.' + String(els[0].className || '').slice(0, 30));
    } catch (e) { L.push('本文検出エラー: ' + e.message); }
    try {
      const ld = GM_getValue(liveKey(), null);
      if (ld) {
        const saved = liveData && liveData.key === liveKey() ? liveData : ld;
        const seqAll = (Array.isArray(saved.scenes) && saved.scenes.length) ? saved.scenes.flat() : saved.order;
        const done = seqAll.filter(k => saved.map[k] != null);
        L.push('この話の記録: ' + (saved.scenes ? saved.scenes.length + '場面・' : '') + done.length + '文（未訳 ' + (seqAll.length - done.length) + '）');
        if (done.length) L.push('記録の最後: ' + stripTags(saved.map[done[done.length - 1]]).slice(0, 24));
      }
      const shownNow = deepRoots().flatMap(r => collectParas(r));
      L.push('今のページの韓国語の段落: ' + shownNow.filter(e => ko(e.textContent) > 0).length + '個（除外 ' + shownNow.filter(e => ko(e.textContent) > 0 && (isUiText(e) || !isOnScreen(e))).length + '）');
    } catch (e) { L.push('記録確認エラー: ' + e.message); }
    alert(L.join('\n'));
  });
  GM_registerMenuCommand('本文エリア設定をリセット', () => { GM_deleteValue('sel:' + location.host); alert('リセットしました'); });
  GM_registerMenuCommand('この話の並びを記録し直す（話が書き直されたとき・訳は残す）', () => {
    const ld = GM_getValue(liveKey(), null);
    if (!ld) return alert('この話の記録はまだありません');
    if (!confirm('この話の「場面と行の並び」だけを消します。訳そのものは残るので、もう一度「訳」を押しながら読めば、変わっていない文は料金なしで出ます。よろしいですか？')) return;
    ld.scenes = []; ld.layouts = []; ld.order = [];
    GM_setValue(liveKey(), ld);
    liveData = null;
    setLast('');
    alert('並びをリセットしました。最初から「訳」を押しながら読み進めてください');
  });
  GM_registerMenuCommand('この話の訳の記録を消す（カカオの表示中翻訳）', () => {
    if (!confirm('この話で訳した文の記録を消します。よろしいですか？')) return;
    GM_deleteValue(liveKey());
    liveData = null;
    ui.cardClose();
    setLast('');
    alert('この話の記録を消しました');
  });
  GM_registerMenuCommand('この作品の「前の話の続き」をリセット', () => {
    GM_deleteValue(tailKey());
    alert('リセットしました（人物・用語メモはそのまま）');
  });
  GM_registerMenuCommand('訳の記録を書き出す（ほかの端末へ）', exportData);
  GM_registerMenuCommand('エンジンを切り替え（Claude ⇄ Gemini）', () => {
    const c = GM_getValue('cfg', {});
    const next = (c.provider || 'gemini') === 'claude' ? 'gemini' : 'claude';
    KZ_SET('cfg', Object.assign({}, c, { provider: next }));
    alert(`${PROV_NAME[next]}に切り替えました。ページを開き直すので「訳」を押してください（${PROV_NAME[next]}版の訳があればそれが出ます）`);
    location.reload();
  });
  GM_registerMenuCommand('原文の言語を切り替え（自動→韓→中→英）', () => {
    const c = GM_getValue('cfg', {}), order = ['auto', 'ko', 'zh', 'en'];
    const next = order[(order.indexOf(c.lang || 'auto') + 1) % order.length];
    KZ_SET('cfg', Object.assign({}, c, { lang: next }));
    resetLang();
    const now = curLang();
    ui.toast(`原文の言語：${LANG_OPT[next]}${next === 'auto' ? `（今のページは${LANGS[now].name}と判定）` : ''}`, 3500);
  });
  GM_registerMenuCommand('作品ごとに全話まとめて保存（ZIP）', showWorkList);
  GM_registerMenuCommand('クラウドに今すぐ保存', () => backupNow(true));
  GM_registerMenuCommand('クラウドから戻す', restoreFromCloud);
  GM_registerMenuCommand('保存済みの訳を全削除', () => {
    const keys = GM_listValues().filter(k => k.startsWith('cache') || k.startsWith('live:') || k.startsWith('para:'));
    keys.forEach(GM_deleteValue);
    alert(keys.length + '件削除しました');
  });
})();

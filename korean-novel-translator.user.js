// ==UserScript==
// @name         韓国小説 丸ごと翻訳
// @name:ja      イカ墨翻訳
// @namespace    ikasumi-novel-tl
// @version      10.5.14
// @description  韓国語・中国語・英語の小説を、ページを開いたまま自然な日本語に翻訳。漫画・ウェブトゥーンの吹き出しも翻訳（WTモード）
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
// @grant        GM.xmlHttpRequest
// @grant        unsafeWindow
// @connect      generativelanguage.googleapis.com
// @connect      api.anthropic.com
// @connect      api.deepseek.com
// @connect      api.github.com
// @connect      gist.githubusercontent.com
// @connect      fonts.googleapis.com
// @connect      fonts.gstatic.com
// @connect      kakao.com
// @connect      kakaocdn.net
// @connect      ridibooks.com
// @connect      ridicdn.net
// @connect      naver.com
// @connect      pstatic.net
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
    let r, timedOut = false, timer = 0;
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    // 何も届かないまま4分たったら止める（電波の切り替えなどで固まらないように）
    const arm = () => { clearTimeout(timer); if (ac) timer = setTimeout(() => { timedOut = true; ac.abort(); }, 240000); };
    arm();
    try {
      r = await fetch(url, {
        method: 'POST', mode: 'cors', credentials: 'omit', signal: ac ? ac.signal : undefined,
        headers: Object.assign({ 'content-type': 'application/json' }, headers),
        body: JSON.stringify(body),
      });
    } catch { clearTimeout(timer); if (timedOut) throw new Error('タイムアウト'); noDirect = true; return null; } // ページ側の制限（CSPなど）で送れない
    const hs = [...r.headers].map(([k, v]) => k + ': ' + v).join('\n');
    if (!r.body || !r.body.getReader) { try { return { status: r.status, txt: await r.text(), headers: hs }; } finally { clearTimeout(timer); } }
    const reader = r.body.getReader(), dec = new TextDecoder();
    let txt = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        arm();
        txt += dec.decode(value, { stream: true });
        progress(txt);
      }
    } catch (e) { throw new Error(timedOut ? 'タイムアウト' : '通信エラー（' + (e && e.message) + '）'); }
    finally { clearTimeout(timer); }
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
    if (!applied.size) return; // まだ1段落も訳せていないときは「原」にしない
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
  const liveSave = () => { try { if (liveData) GM_setValue(liveData.key || liveKey(), liveData); } catch { /* 保存できなくても続ける */ } };

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
        ui.toast(fx.left ? `保存済みの訳を表示中（${fx.left}段落は${L().name}のまま${fx.err ? '／エラー: ' + fx.err.message : ''}）` : `保存済みの訳の${L().name}部分を直しました`, 5000);
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
      // 1段落も訳せなかった（キー間違いなど）ときは保存せずにエラーを出す
      if (lastErr && !need.some(i => tr[i] != null)) throw lastErr;

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
  function backupJson(remote) {
    const data = {};
    for (const k of GM_listValues()) if (DATA_PREFIX.test(k)) data[k] = GM_getValue(k);
    // クラウドにだけある記録（ほかの端末で訳した分など）も残す
    if (remote && typeof remote === 'object') for (const [k, v] of Object.entries(remote)) if (DATA_PREFIX.test(k)) data[k] = mergeValue(k, data[k] ?? null, v);
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
  // 自分のGistからバックアップを探す（新しい端末でも、前のバックアップに足していく）
  async function findGist(token) {
    const list = JSON.parse(await gh('GET', 'https://api.github.com/gists?per_page=100', token));
    const g = Array.isArray(list) ? list.find(x => x && x.files && x.files[GIST_FILE]) : null;
    return g ? g.id : '';
  }
  async function readGist(id, token) {
    const g = JSON.parse(await gh('GET', 'https://api.github.com/gists/' + id, token));
    const file = g.files && g.files[GIST_FILE];
    if (!file) return null;
    return file.truncated ? await gh('GET', file.raw_url, token) : file.content;
  }
  let backupRunning = false;
  async function backupNow(manual) {
    const c = GM_getValue('cfg', {});
    const token = (c.gistToken || '').trim();
    if (!token) { if (manual) ui.toast('設定でGitHubのトークンを入れてください', 4000); return; }
    if (backupRunning) { if (manual) ui.toast('クラウドに保存中です', 2000); return; }
    backupRunning = true;
    backupDirty = false; // 送っている間に増えた訳は、次の回で送る
    try {
      let id = c.gistId || await findGist(token);
      // クラウドの記録と合わせてから上書きする（ほかの端末の訳を消さない）
      let remote = null;
      if (id) {
        try { const t = await readGist(id, token); remote = t ? JSON.parse(t).data : null; }
        catch (e) { if (/^404/.test(e.message)) id = ''; else throw e; }
      }
      const { json, n } = backupJson(remote);
      const body = { description: '韓国小説 丸ごと翻訳のバックアップ', files: { [GIST_FILE]: { content: json } } };
      if (id) await gh('PATCH', 'https://api.github.com/gists/' + id, token, body);
      else id = JSON.parse(await gh('POST', 'https://api.github.com/gists', token, Object.assign({ public: false }, body))).id;
      if (id !== c.gistId) KZ_SET('cfg', Object.assign({}, GM_getValue('cfg', {}), { gistId: id }));
      KZ_SET('backupAt', Date.now());
      if (manual) ui.toast(`クラウドに保存しました（${n}件）`, 3000);
    } catch (e) {
      backupDirty = true;
      if (manual) ui.toast('クラウド保存に失敗：' + e.message, 5000);
    } finally { backupRunning = false; }
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
        id = await findGist(token);
        if (!id) return ui.toast('クラウドにバックアップが見つかりません', 4000);
        KZ_SET('cfg', Object.assign({}, GM_getValue('cfg', {}), { gistId: id }));
      }
      const text = await readGist(id, token);
      if (!text) return ui.toast('クラウドにバックアップが見つかりません', 4000);
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
    ui.toast(`訳の記録を読み込みました（${n}件${setMsg}）。APIキーは含まれていません`, 5000);
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
      .cfg-novel, .cfg-wt { display: grid; gap: 16px; }
      .cfg-novel[hidden], .cfg-wt[hidden], .wt-work[hidden] { display: none; }
      .wt-work { display: grid; gap: 16px; }
      .cfg .hint { color: var(--mute); font-size: 12px; margin-top: -8px; }
      .wtsw { display: flex !important; align-items: center; gap: 12px; padding: 14px 16px; border-radius: 14px; border: 2px solid var(--line); background: var(--bg); cursor: pointer; color: inherit !important; transition: border-color .2s, background .2s; }
      .wtsw.on { border-color: var(--ac); background: rgba(84,101,232,.08); }
      .wtsw-text { flex: 1; display: grid; gap: 2px; }
      .wtsw-text b { font-size: 16px; }
      .wtsw-host { color: var(--mute); font-size: 12px; }
      .wtsw-st { font-size: 13px; font-weight: 700; color: var(--mute); }
      .wtsw.on .wtsw-st { color: var(--ac); }
      .wtsw input { position: absolute; opacity: 0; width: 1px; height: 1px; }
      .wtsw .sw { position: relative; flex: none; width: 52px; height: 30px; border-radius: 15px; background: #c3c7d4; transition: background .2s; }
      .wtsw .sw::after { content: ""; position: absolute; top: 3px; left: 3px; width: 24px; height: 24px; border-radius: 50%; background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.25); transition: transform .2s; }
      .wtsw.on .sw { background: var(--ac); }
      .wtsw.on .sw::after { transform: translateX(22px); }
      .wtsw input:focus-visible + .sw { outline: 2px solid #7d8cf5; outline-offset: 2px; }
      .modesw { display: flex; gap: 4px; padding: 4px; border-radius: 14px; background: var(--bg); border: 1px solid var(--line); position: sticky; top: 0; z-index: 2; }
      .modesw button { flex: 1; border: 0; background: transparent; font: 700 15px system-ui, sans-serif; padding: 11px 8px; border-radius: 10px; color: var(--mute); box-shadow: none; }
      .modesw button:hover { background: rgba(84,101,232,.06); }
      .modesw button svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linejoin: round; stroke-linecap: round; vertical-align: -3.5px; margin-right: 6px; }
      .modesw button { letter-spacing: .04em; }
      .cfg .modehint { margin-top: -6px; text-align: center; }
      .modesw button.on { background: var(--card); color: var(--ac); box-shadow: 0 1px 6px rgba(0,0,0,.12); }
      .cfg .sec { margin: 10px 0 -4px; padding-top: 14px; border-top: 1px solid var(--line); font-weight: 700; font-size: 12px; letter-spacing: .08em; color: var(--ac); }
      .fab { -webkit-touch-callout: none; user-select: none; -webkit-user-select: none; touch-action: none; }
      .fab.main { grid-column: 2; grid-row: 2; }
      .dock.wt .fab.main { visibility: hidden; pointer-events: none; }
      .dock.wt .fab.copy, .dock.wt .fab.save { display: none; }
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
          <div class="modesw" role="tablist">
            <button data-a="mode-novel" class="on" role="tab"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5C4 4.7 4.7 4 5.5 4H11v15H5.5C4.7 19 4 18.3 4 17.5z"/><path d="M13 4h5.5c.8 0 1.5.7 1.5 1.5v12c0 .8-.7 1.5-1.5 1.5H13z"/></svg>小説</button>
            <button data-a="mode-wt" role="tab"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="3.5" width="16" height="17" rx="2"/><path d="M4 11h16M12 11v9.5"/><path d="M8.5 6.8h5"/></svg>WT</button>
          </div>
          <div class="hint modehint"></div>
          <div class="cfg-novel">
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
          <div class="cfg-wt" hidden>
          <div class="hint">漫画・ウェブトゥーンの吹き出しを読み取って、訳を吹き出しの上に重ねます。WTモードでは「WT」ボタンを押すと、そのページの翻訳が始まります（訳したことのある画像は、押さなくても最初から表示）。</div>
          <div class="sec">翻訳エンジン</div>
          <label>Gemini APIキー（空欄なら小説と同じキー） <input name="wt_k" type="password" autocomplete="off"></label>
          <label>モデル（混雑時は左から順に切り替え。カンマ区切り） <input name="wt_m"></label>
          <label>訳す言語 <input name="wt_t"></label>
          <label>同時に送る数（多いほど速いが回数制限に当たりやすい） <input name="wt_par" type="number" min="1" max="6"></label>
          <div class="sec">表示と送り方</div>
          <label>縦書き <select name="wt_v"><option value="auto">縦長の吹き出しは縦書き</option><option value="off">常に横書き</option></select></label>
          <label>文字の大きさ：<span class="wt-tsv"></span>% <input name="wt_ts" type="range" min="70" max="130" step="5"></label>
          <label>絵の上の文字の隠し方 <select name="wt_am2"><option value="erase">文字の形だけ消す（絵が残る）</option><option value="label">白い札で隠す（読みやすい）</option></select></label>
          <label>セリフの文字 <select name="wt_fnt"><option value="manga">漫画風（かなは明朝・漢字はゴシック）</option><option value="gothic">ゴシック（原文に近い）</option><option value="maru">丸ゴシック（やわらかい）</option></select></label>
          <label class="check"><input type="checkbox" name="wt_sfx"> 効果音も訳す</label>
          <label>無視する小さい画像（px未満） <input name="wt_min" type="number" min="50" step="10"></label>
          <label class="check"><input type="checkbox" name="wt_dbg"> 確認モード（読んだ画像をピンクの点線、見つけた文字を青枠で表示）</label>
          <div class="sec">用語・作品メモ</div>
          <label>全作品共通の固定訳（1行に「原語=訳語」） <textarea name="wt_g" placeholder="例：&#10;김독자=キム・ドクチャ"></textarea></label>
          <label class="check"><input type="checkbox" name="wt_am"> 訳した内容から作品メモを自動で更新</label>
          <div class="wt-work">
            <label><span class="wt-wn">この作品のメモ</span>（人物の訳名・性別・一人称・口調、用語） <textarea name="wt_memo" placeholder="김독자=キム・ドクチャ｜男｜俺｜ぶっきらぼう"></textarea></label>
            <div class="hint wt-memost"></div>
            <label>これまでのあらすじ（自動。直してもOK） <textarea name="wt_story"></textarea></label>
            <div class="row"><button data-a="wt-memoNow">今すぐメモを更新</button><button data-a="wt-wex">この作品を書き出す</button><button data-a="wt-wclr">この作品の記録を消す</button></div>
          </div>
          <div class="row"><button data-a="wt-save" class="primary">保存</button><button data-a="cancel">戻る</button></div>
          <div class="sec">訳し直し</div>
          <div class="row"><button data-a="wt-redo">この画面を訳し直す</button><button data-a="wt-redoAll">この話を全部訳し直す</button></div>
          <div class="sec">記録の引っ越し・バックアップ</div>
          <div class="row"><button data-a="wt-ex">記録を書き出す</button><button data-a="wt-im">記録を読み込む</button></div>
          <label>クラウドに自動バックアップ（GitHubのトークン。空欄なら小説と同じ） <input name="wt_gt" type="password" autocomplete="off" placeholder="github_pat_… / ghp_…"></label>
          <label class="check"><input type="checkbox" name="wt_ab"> 訳が増えたら自動でクラウドへ保存</label>
          <div class="row"><button data-a="wt-cs" class="primary">今すぐクラウドに保存</button><button data-a="wt-cl">クラウドから戻す</button></div>
          <div class="row"><button data-a="wt-clr">保存したWTの訳を全部消す</button></div>
          <input type="file" name="wt_imf" accept=".json,application/json" hidden>
          </div>
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
    let sheetLoaded = '';
    function settings(show) {
      if (!show && !form.hidden && typeof applyMode === 'function') applyMode(curTab); // 閉じたときのタブでモードを決める
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
      f('sheet').value = sheetLoaded = getSheet();
      $('.sheet-title').textContent = `この作品のメモ【${workName().slice(0, 30) || workKey()}】`;
      f('sheetModel').value = c.sheetModel;
      f('sheetModel').placeholder = SHEET_MODELS[c.provider] || '翻訳と同じモデル';
      fillModels();
      try { setMode(GM_getValue(wtKey(), false) ? 'wt' : 'novel'); } catch { setMode('novel'); } // 今のモードのタブで開く（閉じてもモードが勝手に変わらない）
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
      try { const list = await listGeminiModels(key); if (f('provider').value === 'gemini') put(list, '（選ぶとモデル名に入ります・取得済み）'); }
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
    const openSettings = tab => {
      panel.hidden = false; fab.hidden = true; copyBtn.hidden = true; saveBtn.hidden = true; gearBtn.hidden = true; settings(true);
      if (wtApi) wtApi.show(false);
      setMode(typeof tab === 'string' ? tab : (GM_getValue(wtKey(), false) ? 'wt' : 'novel'));
    };
    // ---- 設定画面：小説 ⇄ WT（まんが）の切り替え ----
    const wf = n => form.querySelector(`[name=wt_${n}]`);
    const wq = s => form.querySelector(s);
    const WT_VAL = ['k', 'm', 't', 'v', 'ts', 'am2', 'fnt', 'g', 'par', 'min', 'memo', 'story', 'gt'], WT_CHK = ['sfx', 'dbg', 'am', 'ab'];
    let curTab = 'novel';
    function setMode(m) {
      curTab = m === 'wt' ? 'wt' : 'novel';
      wq('.modehint').textContent = `このタブのまま閉じると、このサイトは${curTab === 'wt' ? 'WT' : '小説'}モードになります`;
      wq('.cfg-novel').hidden = m === 'wt'; wq('.cfg-wt').hidden = m !== 'wt';
      wq('[data-a="mode-novel"]').classList.toggle('on', m !== 'wt'); wq('[data-a="mode-wt"]').classList.toggle('on', m === 'wt');
      if (m === 'wt') fillWT();
    }
    function wtReady() { if (!wtApi && window.top === window.self) startWT(false); return wtApi; }
    function fillWT() {
      const api = wtReady();
      const v = api ? api.load() : wtStoredVals();
      WT_VAL.forEach(k => { if (v[k] != null) wf(k).value = v[k]; });
      WT_CHK.forEach(k => { wf(k).checked = !!v[k]; });
      wtMemoBase = { memo: wf('memo').value, story: wf('story').value };
      wq('.wt-tsv').textContent = wf('ts').value;
      wq('.wt-work').hidden = !api;
      if (api) { wq('.wt-wn').textContent = v.wn || 'この作品のメモ'; wq('.wt-memost').textContent = v.memost || ''; }
    }
    let wtMemoBase = { memo: null, story: null };
    // メモ・あらすじは手で書き換えたときだけ渡す（開いている間に裏で更新された新しいメモを、古い内容で上書きしない）
    const wtVals = () => {
      const o = {}; WT_VAL.forEach(k => { o[k] = wf(k).value; }); WT_CHK.forEach(k => { o[k] = wf(k).checked; });
      if (o.memo === wtMemoBase.memo) delete o.memo;
      if (o.story === wtMemoBase.story) delete o.story;
      return o;
    };
    function wtAction(a) {
      const api = wtReady();
      if (!api) return ui.toast('このページではWTの設定を変えられません（ページの中の小さな画面のため）', 4000);
      if (a === 'wt-save') {
        api.save(wtVals());
        settings(false); st.textContent = 'WTの設定を保存しました';
        check();
        return;
      }
      if (a === 'wt-im') return wf('imf').click();
      api.act(a.slice(3), wtVals());
      if (['wt-redo', 'wt-redoAll'].includes(a)) { panel.hidden = true; fab.hidden = false; check(); }
      else setTimeout(fillWT, 800);
    }
    // WTの設定は変えたらすぐ反映（保存ボタンを押し忘れても大丈夫なように）
    let wtAutoTimer = 0;
    form.querySelector('.cfg-wt').addEventListener('change', e => {
      const n = e.target && e.target.name;
      if (!n || !n.startsWith('wt_') || n === 'wt_imf') return;
      clearTimeout(wtAutoTimer);
      wtAutoTimer = setTimeout(() => { const api = wtReady(); if (api) { api.save(wtVals()); st.textContent = 'WTの設定を反映しました'; } }, 250);
    });
    wf('ts').addEventListener('input', () => { wq('.wt-tsv').textContent = wf('ts').value; if (wtApi) wtApi.preview(wf('ts').value); });
    wf('imf').addEventListener('change', async e => {
      const inp = e.currentTarget || e.target; const file = inp.files && inp.files[0];
      if (file && wtReady()) wtApi.importText(await file.text());
      inp.value = '';
    });
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
      if (wtPageNow && wtApi) wtApi.placeAt(fab.getBoundingClientRect()); // WTボタンも一緒に動かす
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
      if (a === 'close') { if (!form.hidden) applyMode(curTab); panel.hidden = true; fab.hidden = false; }
      if (a === 'redo') {
        settings(false);
        if (cfg().mode === 'inplace') { panel.hidden = true; fab.hidden = false; translateInPlace(true); }
        else translate(true);
      }
      if (a === 'set') settings(form.hidden);
      if (a === 'copy') copyText();
      if (a === 'cancel') settings(false);
      if (a === 'mode-novel') setMode('novel');
      if (a === 'mode-wt') setMode('wt');
      if (a && a.startsWith('wt-')) wtAction(a);
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
        // 作品メモは手で直したときだけ保存（開いている間に裏で更新された新しいメモを古い内容で上書きしない）
        if (f('sheet').value !== sheetLoaded) {
          if (f('sheet').value.trim()) GM_setValue(sheetKey(), f('sheet').value.trim());
          else GM_deleteValue(sheetKey());
        }
        settings(false); st.textContent = '設定を保存しました';
      }
    };
    root.addEventListener('click', onClick);
    if (pd !== root) pd.addEventListener('click', onClick);
    const onKey = e => { if (e.key === 'Escape' && !panel.hidden) { if (!form.hidden) applyMode(curTab); panel.hidden = true; fab.hidden = false; } };
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
    toastEl.addEventListener('click', () => { clearTimeout(toastTimer); toastEl.hidden = true; });
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
        // エラーなどは少し長めに出して消す（タップでも消える）
        if (!hideMs && /エラー|失敗|見つかりません|読み込めません|できません/.test(m)) hideMs = 8000;
        if (hideMs) toastTimer = setTimeout(() => { toastEl.hidden = true; }, hideMs);
      },
      fabText: () => fab.textContent,
      fabLabel: t => { fab.textContent = t; fab.classList.toggle('on', t === '原'); fab.title = t === '原' ? '原文に戻す' : 'この話を翻訳'; },
      setBusy: v => fab.classList.toggle('busy', !!v),
      showFab: v => { if (panel.hidden) { fab.hidden = !v; gearBtn.hidden = !v; copyBtn.hidden = !v || !hasCopy; saveBtn.hidden = !v || !hasCopy || !canSave(); } },
      wtLayout: v => { dock.classList.toggle('wt', !!v); if (v) { copyBtn.hidden = true; saveBtn.hidden = true; } },
      mainRect: () => fab.getBoundingClientRect(),
      // WTボタンをドラッグしたときは、⚙ごと（ボタン一式）動かす
      dockDrag: (() => {
        let st = null;
        return {
          start: () => { const r = dock.getBoundingClientRect(); st = { l: r.left, t: r.top, pos: null }; },
          move: (dx, dy) => { if (!st) return; st.pos = place(st.l + dx, st.t + dy); if (wtApi) wtApi.placeAt(fab.getBoundingClientRect()); },
          end: () => { if (st && st.pos) GM_setValue(posKey, st.pos); st = null; },
        };
      })(),
      canCopy: v => { hasCopy = v; copyBtn.hidden = !v || fab.hidden; saveBtn.hidden = !v || fab.hidden || !canSave(); },
      openSettings: tab => openSettings(tab),
      isOpen: () => !panel.hidden,
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
    // WTモードのサイトでは、小説の「訳」の代わりにWTボタンを出す
    const wtPage = !!(wtApi && GM_getValue(wtKey(), false));
    wtPageNow = wtPage;
    if (wtApi) wtApi.sync();
    if (wtApi) wtApi.show(wtPage && !ui.isOpen()); // 設定画面を開いている間はWTボタンを隠す
    // 漫画のページ：小説の「訳」の場所にWTボタンを置き、設定ボタンは残す
    ui.wtLayout(wtPage);
    ui.showFab(wtPage || active || many);
    if (wtPage) syncWT();
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
    const next = (c.provider || 'gemini') === 'gemini' ? 'claude' : 'gemini';
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
  GM_registerMenuCommand('WT（まんが・ウェブトゥーン）翻訳をこのサイトで使う（切り替え）', toggleWT);
  GM_registerMenuCommand('保存済みの訳を全削除', () => {
    if (!confirm('この端末に保存した小説の訳を全部消します（作品メモ・設定は残ります）。元に戻せません。よろしいですか？')) return;
    const keys = GM_listValues().filter(k => k.startsWith('cache') || k.startsWith('live:') || k.startsWith('para:') || k.startsWith('ep:') || k.startsWith('tail:'));
    keys.forEach(GM_deleteValue);
    alert(keys.length + '件削除しました');
  });

  // ================= WT（まんが・ウェブトゥーン）翻訳モード =================
  // 画像の吹き出しを読み取って、訳を吹き出しの上に重ねる。サイトごとにオン／オフ（メニュー・設定から）
  const wtKey = () => 'wt:' + location.hostname;
  const novelGeminiKey = () => { try { const c = cfg(); return (c.keys && c.keys.gemini) || ''; } catch { return ''; } };
  const novelGistToken = () => { try { return GM_getValue('cfg', {}).gistToken || ''; } catch { return ''; } };
  var wtStarted = false, wtApi = null, wtSeenPage = '', wtPageNow = false;
  // WTボタンを⚙の横にぴったり合わせる。画面の大きさが変わったとき（アドレスバーの出し入れ・回転）もすぐ合わせ直す
  function syncWT() {
    if (!wtApi || !wtPageNow) return;
    const r = ui.mainRect();
    if (r && r.width) wtApi.placeAt(r);
  }
  let syncRaf = 0;
  const syncSoon = () => { cancelAnimationFrame(syncRaf); syncRaf = requestAnimationFrame(() => { syncWT(); setTimeout(syncWT, 250); }); };
  addEventListener('resize', syncSoon);
  addEventListener('orientationchange', syncSoon);
  if (window.visualViewport) { visualViewport.addEventListener('resize', syncSoon); } // var：上の check() から先に参照されるため
  // WTが動いていないページ（iframeの中など）でも、保存してある設定は表示できるように
  function wtStoredVals() {
    let S = {};
    try { const r = GM_getValue('ezc_settings', null); S = typeof r === 'string' ? JSON.parse(r) : (r || {}); } catch { /* 読めない */ }
    return { k: S.apiKey || '', m: S.models || 'gemini-3.8-flash', t: S.target || '日本語', v: S.vertical || 'auto', ts: S.textScale || 100,
      am2: S.artMode || 'erase', fnt: S.font || 'manga', g: S.glossary || '', par: S.parallel || 3, min: S.minSize || 250,
      sfx: !!S.sfx, dbg: !!S.debug, am: S.autoMemo !== false, ab: S.autoBackup !== false, gt: S.gistToken || '' };
  }
  // 小説モード ⇄ WTモード（サイトごと）
  function applyMode(tab) {
    const wt = tab === 'wt', was = !!GM_getValue(wtKey(), false);
    if (wt === was) return;
    KZ_SET(wtKey(), wt);
    if (wt) {
      if (window.top !== window.self) { alert('WTモードにしました。ページを開き直してください'); return; }
      if (wtApi) wtApi.setOn(true); else startWT();
    } else if (wtApi) wtApi.setOn(false);
    ui.toast(wt ? 'このサイトはWTモードにしました（WTボタンを押すと翻訳）' : 'このサイトは小説モードにしました', 3000);
    setTimeout(check, 50);
  }
  function toggleWT() { applyMode(GM_getValue(wtKey(), false) ? 'novel' : 'wt'); }
  function startWT() {
    if (wtStarted || window.top !== window.self) return;
    wtStarted = true;

  /* ---------------- 設定・保存 ---------------- */
  const DEFAULTS = {
    apiKey: '',
    models: 'gemini-3.8-flash', // 混雑・エラー時は左から順に切り替え（カンマ区切り）
    target: '日本語',
    sfx: false,          // 効果音も訳す
    vertical: 'auto',    // auto: 縦長の吹き出しは縦書き / off: 常に横書き
    glossary: '',        // 固定訳（例: 김독자=キム・ドクチャ）
    minSize: 250,        // これより小さい画像は無視(px)
    autoHosts: {},       // サイトごとの自動翻訳ON
    gistToken: '',       // クラウドバックアップ用（GitHubのgist権限だけのトークン）
    gistId: '',
    autoBackup: true,
    autoMemo: true,      // 作品の翻訳メモ（人物・一人称・用語）を自動で更新
    debug: false,        // どの画像を読んだか・何を見つけたかを枠で表示
    textScale: 100,      // 文字の大きさ（%）
    parallel: 3,         // 同時に送る数
    artMode: 'erase',    // 絵の上の文字：erase=文字の形だけ消す / label=白い札で隠す
    font: 'manga',       // manga: セリフはアンチック風（かなは明朝・漢字はゴシック） / gothic / maru
    pos: { right: 16, bottom: 18 },
  };

  const store = {
    get(k, d) {
      try {
        let v;
        if (typeof GM_getValue === 'function') v = GM_getValue(k);
        else v = localStorage.getItem(k);
        if (v === undefined || v === null) return d;
        return typeof v === 'string' ? JSON.parse(v) : v;
      } catch (e) { return d; }
    },
    set(k, v) {
      try {
        const s = JSON.stringify(v);
        if (typeof GM_setValue === 'function') GM_setValue(k, s);
        else localStorage.setItem(k, s);
      } catch (e) {}
    },
  };

  let S = Object.assign({}, DEFAULTS, store.get('ezc_settings', {}));
  const saveS = () => store.set('ezc_settings', S);
  if (/gemini-2\.5/.test(S.models)) { S.models = DEFAULTS.models; saveS(); } // 提供終了モデルを置き換え
  const HOST = location.hostname;
  // キー・トークンが空欄なら、小説翻訳の設定のものを使う
  const keyOf = () => (S.apiKey || novelGeminiKey() || '').trim();
  const tokOf = () => (S.gistToken || novelGistToken() || '').trim();

  // 翻訳キャッシュ（画像ごと、最大20000件。古いものから消す）
  // 翻訳の保存：画像の「中身」から作った指紋で保存する。
  // RidiのようにURLが毎回変わる(blob:)サイトでも、同じ画像なら再翻訳しない（API代の節約）
  const CIDX = 'ezc_cidx', CMAX = 20000;
  function del(k) {
    try {
      if (typeof GM_deleteValue === 'function') GM_deleteValue(k);
      else if (typeof GM_setValue === 'function') GM_setValue(k, 'null');
      else localStorage.removeItem(k);
    } catch (e) {}
  }
  function cacheGet(k) { return k ? store.get('ezc_c:' + k, null) : null; }
  // 保存した順番（新しいほど大きい）
  let recency = null;
  function recencyMap() {
    if (!recency) { recency = new Map(); store.get(CIDX, []).forEach((k, i) => recency.set(k, i)); }
    return recency;
  }
  function cachePut(k, v) {
    if (!k) return;
    store.set('ezc_c:' + k, v);
    const idx = store.get(CIDX, []);
    const i = idx.indexOf(k);
    if (i >= 0) idx.splice(i, 1);
    idx.push(k);
    while (idx.length > CMAX) { const o = idx.shift(); del('ezc_c:' + o); del('ezc_t:' + o); del('ezc_e:' + o); }
    store.set(CIDX, idx);
    recency = null;
    markDirty();
  }
  // 別名：画像のURL・指紋 → 保存先。作品の見分け方が変わったり、画像の画素がわずかに変わったりしても見つけられる
  // 別名は「見た目の指紋」(dh) が近いときだけ使う。カカオのように別の画像が同じURLの形になるサイトで、違う画像の訳を出さないため
  function aliasKey(k, dh) {
    if (!k) return null;
    const v = store.get('ezc_a:' + k, null);
    if (!v) return null;
    if (typeof v === 'string') return k.startsWith('u:') ? null : v; // 古い形式のURL別名は信用しない
    return v.dh && dh && hamming(v.dh, dh) <= 6 ? v.fk : null;
  }
  function setAlias(k, fk, dh) { if (k && fk && dh) store.set('ezc_a:' + k, { fk, dh }); }
  // 見た目の指紋（縮小した画像の明るさの左右差、64ビット）。透かしなどの細かい違いでは変わらない
  const dcv = document.createElement('canvas');
  const dg = dcv.getContext('2d', { willReadFrequently: true });
  function dHash(d) {
    dcv.width = 9; dcv.height = 8;
    dg.drawImage(d.src, 0, 0, d.w, d.h, 0, 0, 9, 8);
    const p = dg.getImageData(0, 0, 9, 8).data;
    let bits = '';
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const o = (y * 9 + x) * 4, q = o + 4;
      bits += (p[o] * 3 + p[o + 1] * 6 + p[o + 2]) < (p[q] * 3 + p[q + 1] * 6 + p[q + 2]) ? '1' : '0';
    }
    let hex = '';
    for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    return hex;
  }
  // ---------- 見た目で探す索引 ----------
  // カカオのように画像に毎回ちがう見えない透かしが入るサイトでは、画素から作る指紋(imageKey)が毎回変わって再翻訳になる。
  // 細かい違いでは変わらない256ビットの見た目の指紋で、同じサイト・同じ大きさの画像の中から探す
  const rcv = document.createElement('canvas');
  const rg = rcv.getContext('2d', { willReadFrequently: true });
  function rHash(d) {
    rcv.width = 17; rcv.height = 16;
    rg.drawImage(d.src, 0, 0, d.w, d.h, 0, 0, 17, 16);
    const p = rg.getImageData(0, 0, 17, 16).data;
    const L = [];
    for (let i = 0; i < 17 * 16; i++) L.push(p[i * 4] * 0.299 + p[i * 4 + 1] * 0.587 + p[i * 4 + 2] * 0.114);
    const mean = L.reduce((a, b) => a + b, 0) / L.length;
    const sd = Math.sqrt(L.reduce((a, b) => a + (b - mean) * (b - mean), 0) / L.length);
    if (sd < 8) return null; // ほぼ真っ黒・真っ白の画像は見分けられないので索引に使わない
    let bits = '';
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) bits += L[y * 17 + x] + 2 < L[y * 17 + x + 1] ? '1' : '0';
    let hex = '';
    for (let i = 0; i < 256; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    return hex;
  }
  const hIdxKey = (d) => 'ezc_h:' + strHash(location.hostname + '|' + d.w + 'x' + d.h);
  const hIdxMem = new Map(); // 読み込みは重いので、この画面の間は覚えておく
  function hIndexArr(d) {
    const k = hIdxKey(d);
    if (!hIdxMem.has(k)) hIdxMem.set(k, store.get(k, null) || []);
    return hIdxMem.get(k);
  }
  // 似ている順に候補の保存先を返す（本当に同じ画像かは、あとで縮小画像で確かめる）
  // 似ている候補が複数あるときは、新しく保存した方を先に試す。
  // （カカオなどは読み込むたびに見えない透かしで指紋が変わるので、訳し直した新しい訳より古い訳が先に見つかることがあった）
  function hIndexKeys(d) {
    if (!d.rh) return [];
    const rank = recencyMap();
    return hIndexArr(d).map((e) => [hamming(e.h, d.rh), e.k]).filter((x) => x[0] <= 24)
      .sort((a, b) => (rank.get(b[1]) ?? -1) - (rank.get(a[1]) ?? -1) || a[0] - b[0]).slice(0, 5).map((x) => x[1]);
  }
  // ---------- 本当に同じ画像かの確認 ----------
  // 幅16マスの白黒の縮小画像（明るさ16段階）。透かし・JPEGの劣化ではほぼ変わらず、
  // 文字や絵がちがえば、どこかのマスが大きく変わる
  const tcv = document.createElement('canvas');
  const tg = tcv.getContext('2d', { willReadFrequently: true });
  function thumbOf(d) {
    const TW = 24, TH = Math.max(4, Math.min(72, Math.round(24 * d.h / d.w)));
    tcv.width = TW * 4; tcv.height = TH * 4;
    tg.drawImage(d.src, 0, 0, d.w, d.h, 0, 0, TW * 4, TH * 4);
    const p = tg.getImageData(0, 0, TW * 4, TH * 4).data;
    let out = '';
    for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) {
      let sum = 0;
      for (let yy = 0; yy < 4; yy++) for (let xx = 0; xx < 4; xx++) {
        const o = ((y * 4 + yy) * TW * 4 + x * 4 + xx) * 4;
        sum += p[o] * 0.299 + p[o + 1] * 0.587 + p[o + 2] * 0.114;
      }
      out += Math.min(15, Math.round(sum / 16 / 17)).toString(16);
    }
    return out;
  }
  function thumbMatch(a, b) {
    if (!a || !b) return null; // 縮小画像が無い（バックアップから戻した直後など）ときは比べられない
    if (a.length !== b.length) return null; // 作り方が違う（前の版）ので比べられない
    let tot = 0;
    for (let i = 0; i < a.length; i++) {
      const df = Math.abs(parseInt(a[i], 16) - parseInt(b[i], 16));
      if (df > 2) return false; // 1マスでも大きく違えば別の画像
      tot += df;
    }
    return tot / a.length <= 0.6;
  }
  // 文字の部分だけの細かい縮小画像（訳1つごと）。背景が同じで文字だけ違う画像を見分けるのに使う
  const scv = document.createElement('canvas');
  const sg2 = scv.getContext('2d', { willReadFrequently: true });
  function boxSig(d, it) {
    const x0 = Math.max(0, it.x * d.w), y0 = Math.max(0, it.y * d.h);
    const x1 = Math.min(d.w, (it.x + it.w) * d.w), y1 = Math.min(d.h, (it.y + it.h) * d.h);
    if (x1 - x0 < 4 || y1 - y0 < 4) return null;
    const GW = 24, GH = Math.max(3, Math.min(24, Math.round(24 * (y1 - y0) / (x1 - x0))));
    scv.width = GW * 3; scv.height = GH * 3;
    sg2.drawImage(d.src, x0, y0, x1 - x0, y1 - y0, 0, 0, GW * 3, GH * 3);
    const p = sg2.getImageData(0, 0, GW * 3, GH * 3).data;
    let out = GW + 'x' + GH + ':';
    for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
      let sum = 0;
      for (let yy = 0; yy < 3; yy++) for (let xx = 0; xx < 3; xx++) {
        const o = ((y * 3 + yy) * GW * 3 + x * 3 + xx) * 4;
        sum += p[o] * 0.299 + p[o + 1] * 0.587 + p[o + 2] * 0.114;
      }
      out += Math.min(15, Math.round(sum / 9 / 17)).toString(16);
    }
    return out;
  }
  // 保存された訳の文字の部分が、今の画像と同じか。true/false、確かめる材料がなければ null
  function itemsMatch(items, d) {
    let checked = 0;
    for (const it of items) {
      if (!it.sig) continue;
      const now = boxSig(d, it);
      if (!now || now.split(':')[0] !== it.sig.split(':')[0]) return false;
      const a = it.sig.split(':')[1], b = now.split(':')[1];
      let big = 0, tot = 0;
      for (let i = 0; i < a.length; i++) { const df = Math.abs(parseInt(a[i], 16) - parseInt(b[i], 16)); tot += df; if (df > 3) big++; }
      if (big > a.length * 0.02 || tot / a.length > 0.8) return false;
      checked++;
    }
    return checked ? true : null;
  }

  // 同じURLの画像どうし用のゆるい比較（見えない透かしが少し強めでも通す。まったく別の絵なら通さない）
  function thumbClose(a, b) {
    if (!a || !b || a.length !== b.length) return null;
    let tot = 0, big = 0;
    for (let i = 0; i < a.length; i++) { const df = Math.abs(parseInt(a[i], 16) - parseInt(b[i], 16)); tot += df; if (df > 4) big++; }
    return big <= a.length * 0.03 && tot / a.length <= 1.2;
  }
  const thumbGet = (key) => (key ? store.get('ezc_t:' + key, null) : null);
  function thumbPut(key, d) { if (key && d.th && thumbGet(key) !== d.th) store.set('ezc_t:' + key, d.th); }
  function hIndexPut(d, key) {
    if (!d.rh || !key) return;
    const k = hIdxKey(d);
    const old = hIndexArr(d);
    if (old.some((e) => e.k === key && e.h === d.rh)) return; // もう入っている
    const arr = old.filter((e) => e.k !== key);
    arr.push({ h: d.rh, k: key });
    while (arr.length > 3000) arr.shift();
    hIdxMem.set(k, arr);
    store.set(k, arr);
  }

  function hamming(a, b) {
    let n = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) { let x = parseInt(a[i], 16) ^ parseInt(b[i], 16); while (x) { n += x & 1; x >>= 1; } }
    return n + Math.abs(a.length - b.length) * 4;
  }
  function cacheClear() {
    for (const k of dataKeys()) del(k);
    for (const k of store.get(CIDX, [])) del('ezc_c:' + k);
    store.set(CIDX, []);
  }
  if (store.get('ezc_cache', null)) del('ezc_cache'); // 旧形式の保存を片付け
  // この作品の記録だけ（訳・話の記録・メモ）
  function workDataKeys(h) {
    return dataKeys().filter((k) => k.startsWith('ezc_c:' + h + '|') || k.startsWith('ezc_e:' + h + '|') || k.startsWith('ezc_t:' + h + '|') || k === 'ezc_w:' + h
      || (k.startsWith('ezc_p:') && (store.get(k, null) || {}).wk === h));
  }
  function workClear(h) {
    const ks = workDataKeys(h);
    ks.forEach(del);
    const gone = new Set(ks.filter((k) => k.startsWith('ezc_c:')).map((k) => k.slice(6)));
    store.set(CIDX, store.get(CIDX, []).filter((k) => !gone.has(k)));
    return ks.length;
  }

  // ---------- 作品の見分け方（小説スクリプトと同じ：タイトルから話数やサイト名を除いたもの）----------
  const SITE_RE = /\s*[|｜\-–:]\s*(카카오페이지|카카오 페이지|카카오웹툰|리디북스|리디|RIDI|RIDIBOOKS|네이버 ?(웹툰|시리즈)|NAVER( WEBTOON)?|레진|봄툰|투믹스|탑툰|미스터블루|교보문고|예스24|알라딘|WEBTOON)[^|｜]*$/i;
  const cleanTitle = (t) => String(t || '').replace(SITE_RE, '').replace(/^\s*(네이버 ?웹툰|NAVER WEBTOON)\s*$/i, '')
    .replace(/\d+\s*(화|話|권|편|회|부)?/g, '#').replace(/\s+/g, ' ').trim();
  // 作品の番号がURLにあるサイトはそれで見分ける（タイトルが「네이버 웹툰」だけ、などでも分かれる）
  function workId() {
    const h = location.hostname;
    let m;
    if (/naver\.com$/.test(h) && (m = /[?&]titleId=(\d+)/.exec(location.search))) return 'naver:' + m[1];
    if (/kakao\.com$/.test(h) && (m = /\/content\/(\d+)/.exec(location.pathname))) return 'kakao:' + m[1];
    return null;
  }
  // 作品名：ページの共有用タイトル(og:title) → タブのタイトル → 見出し の順に、サイト名だけでないものを使う
  function workName() {
    const og = document.querySelector('meta[property="og:title"]');
    // 見出しなどページの中身は読み込みのタイミングで変わり、保存先がずれるので使わない
    const cands = [og && og.content, document.title];
    for (const c of cands) { const t = cleanTitle(c); if (t && t.replace(/[#\s]/g, '').length >= 2 && t.length < 80) return t; }
    return location.host;
  }
  const displayName = () => workName().replace(/\s*#\s*/g, ' ').replace(/[\s\-–:|｜]+$/, '').trim();
  const workKey = () => workId() || location.host + ':' + workName();
  const wkh = () => strHash(workKey());
  const workRecKey = () => 'ezc_w:' + wkh();
  function getWork() {
    const w = store.get(workRecKey(), null) || { name: displayName(), key: workKey(), memo: '', tail: null, eps: {} };
    if (!w.name || w.name === location.host) w.name = displayName(); // 作品名が取れていなかったら取り直す
    return w;
  }
  function putWork(w) { w.at = Date.now(); store.set(workRecKey(), w); markDirty(); }

  // ---------- 話ごとの記録（ページの何枚目の画像か → 訳）----------
  // 画像の指紋が端末やブラウザで微妙に変わっても、同じ話の同じ位置・同じ大きさの画像なら記録から出す
  function strHash(t) {
    let h = 0x811c9dc5;
    for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 0x01000193) >>> 0;
    return h.toString(36);
  }
  const pageKey = () => 'ezc_p:' + strHash(location.host + location.pathname + location.search);
  const imgIndex = (img) => Array.prototype.indexOf.call(document.images, img);
  function pageKeyAt(img, d) {
    const p = store.get(pageKey(), null);
    const e = p && p.idx && p.idx[imgIndex(img)];
    // 位置と大きさが同じでも、見た目の指紋が違えば別の画像（古い記録で指紋がないものは使わない）
    return e && e.w === d.w && e.h === d.h && e.dh && d.dh && hamming(e.dh, d.dh) <= 6 ? e.key : null;
  }
  function pageRemember(img, d, key) {
    if (!key) return;
    const k = pageKey();
    const p = store.get(k, null) || { title: document.title, url: location.href, idx: {} };
    const i = imgIndex(img), old = p.idx[i];
    const same = old && old.key === key && old.w === d.w && old.h === d.h;
    p.title = document.title; p.at = Date.now(); p.wk = wkh();
    p.idx[i] = { w: d.w, h: d.h, key, dh: d.dh };
    store.set(k, p);
    if (!same) markDirty(); // 保存から表示しただけなら、バックアップは送り直さない
  }

  // この話で訳したセリフ（原文 → 訳）を読む順に記録。次の話への引き継ぎと翻訳メモの更新に使う
  const pageLines = () => (store.get(pageKey(), null) || {}).lines || [];
  let memoTimer = 0;
  function addLines(items) {
    const add = items.filter((it) => it.src).map((it) => `${String(it.src).replace(/\s+/g, ' ').slice(0, 80)} → ${it.tr.replace(/\s+/g, ' ').slice(0, 80)}`);
    if (!add.length) return;
    const k = pageKey();
    const p = store.get(k, null) || { title: document.title, url: location.href, idx: {} };
    const have = new Set(p.lines || []);
    p.lines = (p.lines || []).concat(add.filter((l) => !have.has(l))).slice(-400);
    p.wk = wkh();
    store.set(k, p);
    const w = getWork();
    w.tail = { ep: k, lines: p.lines.slice(-30) };
    w.eps = w.eps || {};
    w.eps[k] = document.title;
    putWork(w);
    // 前は「止まってから90秒後」だけだったので、読み続けたり次の話に移ったりすると一度も更新されなかった。
    // 新しいセリフが30行たまったらすぐ、そうでなければ45秒止まったら更新する
    clearTimeout(memoTimer);
    if (pendingMemoLines() >= 30) updateMemo(false);
    else memoTimer = setTimeout(() => updateMemo(false), 45000);
  }
  // この作品で、まだメモに反映していないセリフ（どの話の分も）
  function pendingMemoPages() {
    const w = getWork(), out = [];
    for (const k of Object.keys(w.eps || {})) {
      const p = store.get(k, null);
      if (!p || !p.lines) continue;
      const rest = p.lines.slice(p.memoAt || 0);
      if (rest.length) out.push({ k, rest, n: p.lines.length });
    }
    return out;
  }
  const pendingMemoLines = () => pendingMemoPages().reduce((a, x) => a + x.rest.length, 0);
  // 前の話の最後のセリフ（今の話と違う話のときだけ）
  function prevTail() {
    const w = getWork();
    return w.tail && w.tail.ep !== pageKey() ? w.tail.lines || [] : [];
  }

  // 作品の翻訳メモ：人物の訳名・性別・一人称・口調、用語。この話の訳を元にGeminiが裏で更新する
  let memoBusy = false, memoFailAt = 0;
  async function updateMemo(manual) {
    if ((!S.autoMemo && !manual) || memoBusy) return;
    if (!manual && Date.now() - memoFailAt < 5 * 60000) return; // 失敗した直後は、画像ごとに何度も頼まない（翻訳の回数制限を食わないように）
    if (!keyOf()) { if (manual) toast('APIキーを入れてね'); return; }
    const pages = pendingMemoPages();
    const lines = pages.flatMap((x) => x.rest);
    if (lines.length < (manual ? 1 : 8)) { if (manual) toast('メモに足す新しいセリフがまだない'); return; }
    memoBusy = true;
    if (manual) toast('翻訳メモを更新中…');
    try {
      const w = getWork();
      const prompt = `あなたは「${w.name}」という漫画を${S.target}に訳すための人物・用語メモを管理する編集者です。
【現在のメモ】
${w.memo || '（なし）'}

【新しく訳したセリフ（原文 → 訳）】
${lines.join('\n').slice(-20000)}

【これまでのあらすじ】
${w.story || '（なし）'}

次の2つを、見出しの行も含めてこの形のまま出力してください（前置き・説明・コードブロックは不要）。
=== メモ ===
今回の訳で実際に使われた訳し方に合わせて更新したメモの全文。
人物は1行に「原語=訳語｜性別｜一人称｜話し方・呼び方・関係」、用語は「原語=訳語｜用語｜短い説明」。
登場人物と繰り返し出る固有名詞だけ、最大50行。分からない欄は「?」。既存の項目は矛盾がない限り変えない。
=== あらすじ ===
これまでのあらすじに今回の内容を足して、${S.target}で400字以内にまとめ直したもの。直近の出来事と、今どういう状況・関係で話が終わっているかを必ず含める。`;
      const res = await geminiRaw([{ text: prompt }], { temperature: 0.2, maxOutputTokens: 5000 });
      const clean = res.replace(/^```\w*\n?|```$/g, '').trim();
      const mm = /===\s*メモ\s*===\s*([\s\S]*?)(?:===\s*あらすじ\s*===\s*([\s\S]*))?$/.exec(clean);
      const memo = (mm ? mm[1] : clean).trim().slice(0, 6000);
      const story = mm && mm[2] ? mm[2].trim().slice(0, 1200) : '';
      if (!memo) throw new Error('空の返事');
      const w2 = getWork(); w2.memo = memo; if (story) w2.story = story; w2.memoAt = Date.now(); delete w2.memoErr; putWork(w2);
      for (const x of pages) { const p2 = store.get(x.k, null); if (p2) { p2.memoAt = x.n; store.set(x.k, p2); } }
      if (manual) toast('翻訳メモを更新した');
      $('memo').value = memo; if (story) $('story').value = story; // 設定欄も新しいメモにしておく（古い内容で上書きしないように）
    } catch (e) {
      memoFailAt = Date.now();
      const w3 = getWork(); w3.memoErr = String(e.message || e).slice(0, 120); putWork(w3);
      if (manual) toast('メモの更新に失敗：' + w3.memoErr);
    }
    memoBusy = false;
  }
  // 開いたときに、前の話で反映しそびれたセリフがあれば更新しておく
  setTimeout(() => updateMemo(false), 8000);

  // ---------- 記録の書き出し・読み込み・クラウド（GitHub Gist・非公開）バックアップ ----------
  const DATA_PREFIX = /^ezc_(c|p|w|a|h|e|t):/;
  let backupDirty = false, backupTimer = 0;
  function markDirty() {
    backupDirty = true;
    clearTimeout(backupTimer);
    // 訳が続いている間はまとめて、最後の変更から1分後に1回だけ送る
    backupTimer = setTimeout(() => { if (backupDirty && tokOf() && S.autoBackup) backupNow(false); }, 60000);
  }
  function dataKeys() {
    if (typeof GM_listValues === 'function') return GM_listValues().filter((k) => DATA_PREFIX.test(k));
    return Object.keys(localStorage).filter((k) => DATA_PREFIX.test(k));
  }
  function backupJson(onlyWork, remote) {
    const data = {};
    // 見た目の索引・別名・縮小画像は端末で作り直せるので、バックアップには入れない（大きくなりすぎるため）
    for (const k of onlyWork ? workDataKeys(onlyWork) : dataKeys()) {
      if (/^ezc_(h|a|t):/.test(k)) continue;
      const v = store.get(k, null); if (v != null) data[k] = v;
    }
    // クラウドにだけある記録（ほかの端末で訳した分など）も残す。両方にあるものはこの端末を優先して合わせる
    if (remote && typeof remote === 'object') {
      for (const [k, rv] of Object.entries(remote)) {
        if (!DATA_PREFIX.test(k) || /^ezc_(h|a|t):/.test(k) || rv == null) continue;
        const cur = data[k];
        if (cur == null) { data[k] = rv; continue; }
        if (k.startsWith('ezc_p:') && typeof cur === 'object') {
          const v = Object.assign({}, cur, { idx: Object.assign({}, rv.idx || {}, cur.idx || {}) });
          if ((rv.lines || []).length > (cur.lines || []).length) v.lines = rv.lines;
          data[k] = v;
        } else if (k.startsWith('ezc_w:') && typeof cur === 'object') {
          data[k] = Object.assign({}, cur, { eps: Object.assign({}, rv.eps || {}, cur.eps || {}) });
        }
      }
    }
    const settings = Object.assign({}, S);
    delete settings.apiKey; delete settings.gistToken; delete settings.gistId; delete settings.pos;
    return { json: JSON.stringify({ ezc: 1, exportedAt: new Date().toISOString(), data, settings }), n: Object.keys(data).length };
  }
  const GIST_FILE = 'manga-bubble-translator-backup.json';
  function gh(method, url, body) {
    return xhr({
      method, url, data: body ? JSON.stringify(body) : undefined, timeout: 60000,
      headers: Object.assign({ Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + tokOf() },
        body ? { 'Content-Type': 'application/json' } : {}),
    }).then((r) => {
      if (r.status >= 200 && r.status < 300) return r.responseText;
      throw new Error(r.status + ' ' + (r.responseText || '').slice(0, 120));
    });
  }
  async function findGist() {
    const list = JSON.parse(await gh('GET', 'https://api.github.com/gists?per_page=100'));
    const g = Array.isArray(list) ? list.find((x) => x && x.files && x.files[GIST_FILE]) : null;
    return g ? g.id : '';
  }
  async function readGist(id) {
    const g = JSON.parse(await gh('GET', 'https://api.github.com/gists/' + id));
    const file = g.files && g.files[GIST_FILE];
    if (!file) return null;
    return file.truncated ? await gh('GET', file.raw_url) : file.content;
  }
  let backupRunning = false;
  async function backupNow(manual) {
    if (!tokOf()) { if (manual) toast('設定でGitHubのトークンを入れてね'); return; }
    if (backupRunning) { if (manual) toast('クラウドに保存中'); return; }
    backupRunning = true;
    backupDirty = false; // 送っている間に増えた訳は、次の回で送る
    try {
      let id = S.gistId || await findGist();
      // クラウドの記録と合わせてから上書きする（ほかの端末の訳を消さない）
      let remote = null;
      if (id) {
        try { const t = await readGist(id); remote = t ? JSON.parse(t).data : null; }
        catch (e) { if (/^404/.test(e.message)) id = ''; else throw e; }
      }
      const { json, n } = backupJson(null, remote);
      const body = { description: 'まんが吹き出し翻訳のバックアップ', files: { [GIST_FILE]: { content: json } } };
      if (id) await gh('PATCH', 'https://api.github.com/gists/' + id, body);
      else id = JSON.parse(await gh('POST', 'https://api.github.com/gists', Object.assign({ public: false }, body))).id;
      if (id !== S.gistId) { S.gistId = id; saveS(); }
      if (manual) toast(`クラウドに保存した（${n}件）`);
    } catch (e) {
      backupDirty = true;
      if (manual) toast('クラウド保存に失敗：' + e.message);
    } finally { backupRunning = false; }
  }
  async function restoreFromCloud() {
    if (!tokOf()) return toast('設定でGitHubのトークンを入れてね');
    try {
      if (!S.gistId) { // 新しい端末ではIDが無いので、自分のGistから探す
        const id = await findGist();
        if (!id) return toast('クラウドにバックアップが見つからない');
        S.gistId = id; saveS();
      }
      const text = await readGist(S.gistId);
      if (!text) return toast('クラウドにバックアップが見つからない');
      importData(text);
    } catch (e) { toast('クラウドから読み込めない：' + e.message); }
  }
  function exportData(onlyWork) {
    const { json, n } = backupJson(onlyWork);
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = (onlyWork ? getWork().name.replace(/[\\/:*?"<>|]/g, '_') + '-' : 'manga-bubble-translator-backup-') + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast(`訳の記録と設定を書き出した（${n}件）。APIキーは入ってない`);
  }
  function importData(text) {
    let j;
    try { j = JSON.parse(text); } catch (e) { return toast('読み込めない：ファイルの形式が違う'); }
    if (!j || !j.data || typeof j.data !== 'object') return toast('読み込めない：このスクリプトの書き出しファイルじゃない');
    const idx = store.get(CIDX, []);
    const have = new Set(idx);
    let n = 0;
    for (const [k, v] of Object.entries(j.data)) {
      if (!DATA_PREFIX.test(k)) continue;
      const cur = store.get(k, null);
      if (k.startsWith('ezc_p:') && cur && cur.idx) {
        v.idx = Object.assign({}, v.idx || {}, cur.idx); // 話の記録は合わせる
        if ((cur.lines || []).length > (v.lines || []).length) v.lines = cur.lines;
      } else if (k.startsWith('ezc_w:') && cur) {
        v.eps = Object.assign({}, v.eps || {}, cur.eps || {});
        if (cur.memo) v.memo = cur.memo; // メモはこっちの端末のものを優先
        if (cur.tail && (cur.at || 0) > (v.at || 0)) v.tail = cur.tail;
      } else if (cur != null) continue; // 訳はこっちの端末のものを優先
      store.set(k, v);
      if (k.startsWith('ezc_c:') && !have.has(k.slice(6))) { idx.push(k.slice(6)); have.add(k.slice(6)); }
      n++;
    }
    store.set(CIDX, idx);
    recency = null;
    let setMsg = '';
    if (j.settings && typeof j.settings === 'object') {
      const inc = Object.assign({}, j.settings);
      delete inc.apiKey; delete inc.gistToken; delete inc.gistId; delete inc.pos;
      S = Object.assign({}, S, inc); saveS();
      setMsg = '・設定も反映';
    }
    toast(`訳の記録を読み込んだ（${n}件${setMsg}）`);
    if (isOn()) translateVisibleNow();
  }

  // 画像を小さく縮めた画素から指紋を作る（URLに依存しない）
  const hcv = document.createElement('canvas');
  const hg = hcv.getContext('2d', { willReadFrequently: true });
  function imageKey(d) {
    const tw = 32, th = Math.max(1, Math.min(512, Math.round((d.h / d.w) * 32)));
    hcv.width = tw; hcv.height = th;
    hg.drawImage(d.src, 0, 0, d.w, d.h, 0, 0, tw, th);
    const px = hg.getImageData(0, 0, tw, th).data;
    let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995;
    for (let i = 0; i < px.length; i += 4) {
      // 色の誤差に強いよう上位ビットだけ使う
      const v = ((px[i] >> 3) << 10) | ((px[i + 1] >> 3) << 5) | (px[i + 2] >> 3);
      h1 = Math.imul(h1 ^ v, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ (v + i), 0x85ebca6b) >>> 0;
    }
    return `${d.w}x${d.h}:${h1.toString(36)}${h2.toString(36)}`;
  }

  /* ---------------- 通信 ---------------- */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function xhr(opt) {
    return new Promise((res, rej) => {
      const f = typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest
        : (typeof GM !== 'undefined' && GM.xmlHttpRequest);
      if (!f) return rej(new Error('GM_xmlhttpRequest が使えません'));
      f(Object.assign({}, opt, {
        timeout: opt.timeout || 120000,
        onload: (r) => res(r),
        onerror: () => rej(new Error('通信エラー')),
        ontimeout: () => rej(new Error('タイムアウト')),
      }));
    });
  }

  function blobToB64(blob) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result).split(',')[1]);
      fr.onerror = rej;
      fr.readAsDataURL(blob);
    });
  }

  // 表示中の画像要素をそのまま使えるか（blob:/data: や同一オリジンなら描画・読み取りできる）
  function drawableFromImg(img) {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0, 1, 1);
      g.getImageData(0, 0, 1, 1); // 読み取れなければここで例外
      return { src: img, w: img.naturalWidth, h: img.naturalHeight, keep: true };
    } catch (e) { return null; }
  }

  async function getDrawable(img) {
    const src = img.currentSrc || img.src;
    if (/^(blob|data):/.test(src)) {
      const d = drawableFromImg(img);
      if (d) return d;
      // 拡張の分離環境ではページのblobをfetchできないことがあるので、ページ側のfetchも試す
      const pf = (typeof unsafeWindow !== 'undefined' && unsafeWindow.fetch) ? unsafeWindow.fetch.bind(unsafeWindow) : fetch;
      const blob = await (await pf(src)).blob();
      return loadDrawable(blob);
    }
    return loadDrawable(await getImageBlob(img));
  }

  async function getImageBlob(img) {
    const src = img.currentSrc || img.src;
    try {
      const r = await xhr({ method: 'GET', url: src, responseType: 'arraybuffer', headers: { Referer: location.href } });
      if (r.status >= 200 && r.status < 300 && r.response) {
        const m = /content-type:\s*([^\r\n;]+)/i.exec(r.responseHeaders || '');
        return new Blob([r.response], { type: m ? m[1] : 'image/jpeg' });
      }
    } catch (e) {}
    // 最後の手段: 表示中の画像から直接（同一オリジンかCORS許可時のみ）
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    return await new Promise((r, j) => {
      try { c.toBlob((b) => (b ? r(b) : j(new Error('画像を読めません'))), 'image/jpeg', 0.9); }
      catch (e) { j(new Error('画像を読めません（サイトの保護）')); }
    });
  }

  async function loadDrawable(blob) {
    if (typeof createImageBitmap === 'function') {
      try { const b = await createImageBitmap(blob); return { src: b, w: b.width, h: b.height }; } catch (e) {}
    }
    const url = URL.createObjectURL(blob);
    const im = new Image();
    await new Promise((r, j) => { im.onload = r; im.onerror = () => j(new Error('画像のデコード失敗')); im.src = url; });
    return { src: im, w: im.naturalWidth, h: im.naturalHeight };
  }

  /* ---------------- Gemini ---------------- */
  const SCHEMA = {
    type: 'ARRAY',
    items: {
      type: 'OBJECT',
      properties: {
        box_2d: { type: 'ARRAY', items: { type: 'INTEGER' } },
        area_2d: { type: 'ARRAY', items: { type: 'INTEGER' } },
        src: { type: 'STRING' },
        tr: { type: 'STRING' },
        kind: { type: 'STRING', enum: ['speech', 'narration', 'sfx', 'sign'] },
        img: { type: 'INTEGER' },
        color: { type: 'STRING' },
        stroke: { type: 'STRING' },
      },
      required: ['img', 'box_2d', 'src', 'tr', 'kind'],
    },
  };

  function buildPrompt() {
    const t = S.target;
    let p = `あなたは漫画・ウェブトゥーンのプロ翻訳者です。画像内の文字を見つけて${t}に翻訳してください。
- 吹き出し・テキスト枠ごとに1項目。同じ吹き出し・同じ枠の複数行は、画像の区切りをまたいでいても必ず1項目にまとめる（行ごとに分けない）。枠なしの文も、続いている1つの文なら行ごとに文字の大きさ・色・縁取りが違っても1項目にまとめ、box_2d は全部の行を囲む（途中の行だけ囲まない）。
- 画像は縦に続く1つの場面を上から順に区切ったもの（区切りの境目は少し重なっている）。各項目の img にその文字がある画像番号を入れる。
- box_2d は [ymin, xmin, ymax, xmax]、その画像に対する0〜1000の整数。原文の文字そのものだけをぴったり囲む（吹き出しの余白は含めない）。
- area_2d も同じ形式で、訳を書いてよい範囲。吹き出しなら吹き出しの線の内側（線や外の絵は含めない）。枠の無い文字は box_2d と同じでいい。
- kind: speech=吹き出しのセリフ、narration=ナレーション・独白（四角い枠の文、枠なしで白地や絵の上に直接書かれた文、色付きの文字も含む）、sfx=擬音語・擬態語だけ（「ドン」「ザワ」など）、sign=看板・スマホ画面など作中の文字。
- 枠や吹き出しが無くても、文になっている文字は必ず拾う（見落とさない）。白地や絵の上に大きく書かれた文字、装飾文字、紫・緑など色付きの文字の独白も全部含める。文になっているものは sfx にしない。
- 画像の端で途中から始まる・途中で切れている文も、見えている部分を拾う。
- 大きな文字を1文字ずつ縦に並べた縦書きの文も、1つの文なら1項目。列が複数あって1つの文になっていれば、読む順につないで1項目にし、box_2d は全部の列を囲む。
- color: 原文の文字色を #RRGGBB で。stroke: 原文の文字にフチ（縁取り）があればその色を #RRGGBB で、なければ空文字。
- 訳は漫画として自然な話し言葉にし、キャラの口調・感情・語尾のニュアンスを残す。説明的にしない。長さは原文と同程度に。
- 人名：韓国の人名は姓も名も全部カタカナにする（姓だけ漢字にしない。例：김독자→キム・ドクチャ、이현성→イ・ヒョンソン）。姓と名の間は「・」。中国の人名は日本の漢字（新字体）。英語の人名はカタカナ。
- 会社・組織・場所・技・アイテムなど意味のある固有名詞は、音をそのままカタカナにせず意味が伝わる日本語にする（例：백일몽→白日夢）。
- 原文がすでに${t}なら tr は原文のまま。
- 日本語・中国語の訳では単語の間に空白を入れない。改行は意味の切れ目で入れてよい（原文の改行位置に合わせなくていい）。
- 読む順に並べる。文字が無ければ空配列。`;
    if (!S.sfx) p += `\n- 効果音(sfx)は含めない。`;
    const w = getWork();
    if (w.story) p += `\n\nこれまでのあらすじ（話の流れ・人間関係を踏まえて、続き物として自然に訳す）:\n${w.story}`;
    if (w.memo) p += `\n\nこの作品の翻訳メモ（人物の訳名・一人称・口調、用語。必ず従う）:\n${w.memo}`;
    if (S.glossary.trim()) p += `\n\n固定訳（必ずこの訳を使う）:\n${S.glossary.trim()}`;
    const cur = pageLines();
    const tail = cur.length < 20 ? prevTail() : [];
    if (tail.length) p += `\n\n前の話の最後のセリフ（この話はこの続き。口調・呼び方・話の流れをつなげる）:\n${tail.slice(-(30 - Math.min(cur.length, 20))).join('\n')}`;
    if (cur.length) p += `\n\nこの話のここまでの訳（口調・呼び方・用語をそろえる）:\n${cur.slice(-25).join('\n')}`;
    return p;
  }

  // 回数制限：429が来たら全体で待つ。無料枠の「1分N回」を検知したら自動で間隔をあける
  let pauseUntil = 0, minGap = 0, lastReq = 0, rpmNotified = false;
  let gate = Promise.resolve();
  function waitTurn() {
    const p = gate.then(async () => {
      for (;;) {
        const now = Date.now();
        const t = Math.max(pauseUntil, lastReq + minGap);
        if (t <= now) break;
        await sleep(t - now + 50);
      }
      lastReq = Date.now();
    });
    gate = p.catch(() => {});
    return p;
  }

  async function callGemini(b64list, onWait) {
    const parts = [];
    b64list.forEach((b, i) => {
      parts.push({ text: `画像${i}:` });
      parts.push({ inline_data: { mime_type: 'image/jpeg', data: b } });
    });
    parts.push({ text: buildPrompt() });
    const text = await geminiRaw(parts, { responseMimeType: 'application/json', responseSchema: SCHEMA, temperature: 0.3 }, onWait);
    const clean = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
    const arr = clean ? JSON.parse(clean) : [];
    return Array.isArray(arr) ? arr : [];
  }

  async function geminiRaw(parts, generationConfig, onWait) {
    if (!keyOf()) throw new Error('APIキー未設定（WTボタン長押しで設定）');
    // 漫画の暴力表現・叫び（「살려」など）で返事を止められないように、安全フィルターをゆるめる
    const safetySettings = ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT']
      .map((category) => ({ category, threshold: 'BLOCK_NONE' }));
    const models = S.models.split(',').map((s) => s.trim()).filter(Boolean);
    // 考える時間を短くする（小説版と同じ）。文字の位置を出すのも、考えさせない方が速くて正確
    const thinkFor = (m) => (/gemini-2\.5-flash(?!-lite)/.test(m) ? { thinkingBudget: 0 } : /gemini-2\.5-pro/.test(m) ? { thinkingBudget: 128 }
      : /gemini-3/.test(m) ? { thinkingLevel: /pro/.test(m) ? 'low' : 'minimal' } : null);
    const bodyFor = (m, think) => JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: Object.assign({}, generationConfig, think ? { thinkingConfig: think } : {}), safetySettings });
    let last = new Error('モデル未設定');
    for (let mi = 0; mi < models.length; mi++) {
      const m = models[mi];
      let think = thinkFor(m);
      for (let attempt = 0; attempt < 6; attempt++) {
        await waitTurn();
        const r = await xhr({
          method: 'POST',
          url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`,
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': keyOf() },
          data: bodyFor(m, think),
          timeout: 180000,
        });
        if (r.status === 200) {
          const j = JSON.parse(r.responseText);
          const cand = j.candidates && j.candidates[0];
          const text = ((cand && cand.content && cand.content.parts) || []).map((p) => p.text || '').join('');
          // 返事を止められた（安全フィルター・著作物判定など）ときは「文字なし」ではなく失敗にする。
          // 前は空の返事を「0件」として保存してしまい、二度と訳されなかった
          const reason = (j.promptFeedback && j.promptFeedback.blockReason) || (cand && cand.finishReason);
          if (!text.trim() && reason && reason !== 'STOP') {
            last = new Error(`${m}: 返事を止められた（${reason}）`);
            if (/RECITATION|SAFETY|PROHIBITED|BLOCKLIST|OTHER/.test(reason) && mi < models.length - 1) break; // ほかのモデルなら通るかも
            throw last;
          }
          return text;
        }
        let msg = '';
        try { msg = JSON.parse(r.responseText).error.message; } catch (e) {}
        last = new Error(`${m}: ${r.status} ${msg.split('\n')[0].slice(0, 160)}`.trim());
        // このモデルが「考える時間」の設定に対応していなければ、設定をゆるめて送り直す
        if (r.status === 400 && /think/i.test(msg) && think) {
          think = think.thinkingLevel === 'minimal' ? { thinkingLevel: 'low' } : null;
          continue;
        }
        // 提供終了モデル：エラー文の後継モデルに自動で切り替えて設定も更新
        const sug = r.status === 404 && /use models\/([\w.\-]+)/.exec(msg);
        if (sug && !models.includes(sug[1])) {
          models.splice(mi + 1, 0, sug[1]);
          S.models = models.filter((x) => x !== m).join(', ');
          saveS();
          toast(`モデルを ${sug[1]} に切り替えた`);
          break;
        }
        if (r.status === 404 && mi < models.length - 1) break;
        if (r.status === 429) {
          // 1日の上限は待っても無駄なので次のモデルへ
          if (/per[_ ]?day|PerDay|requests_per_day/i.test(msg)) break;
          const lim = /free_tier_requests, limit: (\d+)/.exec(msg);
          if (lim) {
            minGap = Math.max(minGap, Math.ceil(60000 / Number(lim[1])) + 500);
            if (!rpmNotified) { rpmNotified = true; toast(`無料枠（1分${lim[1]}回）なので間隔をあけて訳すね`); }
          }
          const sec = /retry in ([\d.]+)s/i.exec(msg);
          pauseUntil = Math.max(pauseUntil, Date.now() + (sec ? Number(sec[1]) * 1000 + 500 : 8000));
          if (onWait) onWait();
          continue;
        }
        if (r.status >= 500) {
          if (attempt < 1) { await sleep(2500); continue; }
          break; // 次のモデルへ
        }
        throw last; // キー間違いなどは切り替えても無駄
      }
    }
    throw last;
  }

  /* ---------------- 画像の分割・解析 ---------------- */
  // 縦長ウェブトゥーンは座標精度のため分割。重なり部分は「担当範囲」で重複を除く
  function planChunks(W, H) {
    const ch = Math.round(W * 1.5), ov = Math.round(W * 0.3);
    if (H <= ch * 1.15) return [{ y: 0, h: H, own0: 0, own1: H }];
    const out = [];
    let y = 0;
    for (;;) {
      const h = Math.min(ch, H - y);
      out.push({ y, h });
      if (y + h >= H) break;
      y += ch - ov;
    }
    out.forEach((c, i) => {
      c.own0 = i === 0 ? 0 : c.y + ov / 2;
      c.own1 = i === out.length - 1 ? H : c.y + c.h - ov / 2;
    });
    return out;
  }

  // 上下に隙間なく並んだ画像（ウェブトゥーンの1枚が複数画像に分かれているもの）を探す
  function neighbors(img) {
    const r = img.getBoundingClientRect();
    let prev = null, next = null;
    for (const o of document.images) {
      if (o === img || !o.complete || !o.naturalWidth || o.closest('.ezc-ov')) continue;
      const q = o.getBoundingClientRect();
      if (Math.abs(q.left - r.left) > r.width * 0.05 || Math.abs(q.width - r.width) > r.width * 0.05) continue;
      if (Math.abs(q.bottom - r.top) <= 6) prev = o;
      else if (Math.abs(q.top - r.bottom) <= 6) next = o;
    }
    return { prev, next };
  }

  // 複数画像を縦につないだ「仮想の1枚」から、指定範囲を描く（巨大canvasを作らない）
  function drawStrip(g, st, vx, vy, vw, vh, dx, dy, dw, dh) {
    const sx = dw / vw, sy = dh / vh;
    for (const p of st.parts) {
      const a = Math.max(vy, p.vy), b = Math.min(vy + vh, p.vy + p.vh);
      if (b <= a) continue;
      const f = st.W / p.d.w; // 元画像→仮想座標の倍率
      g.drawImage(p.d.src,
        vx / f, p.sy + (a - p.vy) / f, vw / f, (b - a) / f,
        dx, dy + (a - vy) * sy, vw * sx, (b - a) * sy);
    }
  }

  async function chunkToB64(st, c) {
    const sc = Math.min(1, 1024 / st.W);
    const cw = Math.round(st.W * sc), chh = Math.max(1, Math.round(c.h * sc));
    const cv = document.createElement('canvas');
    cv.width = cw; cv.height = chh;
    const g = cv.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, cw, chh);
    drawStrip(g, st, 0, c.y, st.W, c.h, 0, 0, cw, chh);
    const bl = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.85));
    return blobToB64(bl);
  }

  const sampler = document.createElement('canvas');
  sampler.width = sampler.height = 24;
  const sg = sampler.getContext('2d', { willReadFrequently: true });

  // 吹き出しの地の色をとって、上に置く背景色・文字色を決める
  function sampleColors(st, vx, vy, vw, vh) {
    try {
      sg.fillStyle = '#fff'; sg.fillRect(0, 0, 24, 24);
      drawStrip(sg, st, vx, vy, Math.max(1, vw), Math.max(1, vh), 0, 0, 24, 24);
      const px = sg.getImageData(0, 0, 24, 24).data;
      const counts = new Map();
      for (let i = 0; i < px.length; i += 4) {
        const k = ((px[i] >> 4) << 8) | ((px[i + 1] >> 4) << 4) | (px[i + 2] >> 4);
        counts.set(k, (counts.get(k) || 0) + 1);
      }
      let best = 0, bk = 0xfff;
      counts.forEach((n, k) => { if (n > best) { best = n; bk = k; } });
      const r = ((bk >> 8) & 15) * 17, g = ((bk >> 4) & 15) * 17, b = (bk & 15) * 17;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      // uni：いちばん多い色が占める割合。吹き出しの中は高く、絵の上の文字は低い
      return { bg: `rgb(${r},${g},${b})`, fg: lum > 140 ? '#141414' : '#fafafa', uni: best / (px.length / 4) };
    } catch (e) {
      return { bg: '#fff', fg: '#141414', uni: 1 };
    }
  }

  // 吹き出しの外の文字か（枠なしの文・看板・効果音など）
  // 判定は種類だけでなく、文字の下の色のばらつきでも見る（Geminiが絵の上の独白を「吹き出し」と言うこともある）
  function isFree(it) {
    const uni = it.uni == null ? 1 : it.uni;
    if (uni < 0.4) return true;              // 下が絵（色がばらばら）
    if (it.kind === 'speech') return false;
    const a = it.area;
    return uni < 0.6 || !a || a.w * a.h < it.w * it.h * 1.6;
  }

  // 周りの絵の色だけで文字の部分を埋めた、小さな色の板（8×8）を作る。
  // さらに、原文の文字が囲みより外まではみ出していないか（ロゴの飾り・フチ・光など）を画素で調べて、隠す範囲を広げる
  // 範囲は文字の3倍。戻り値の cb は「隠す範囲」（板に対する割合）
  function makePatch(st, vx, vy, vw, vh) {
    const G = 8, R = 72;
    const cv = document.createElement('canvas');
    cv.width = cv.height = R;
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#fff'; g.fillRect(0, 0, R, R);
    // 画像の外にはみ出した部分は描かず、色も取らない（ずらして描くと色の位置がずれる）
    const sx0 = Math.max(0, vx), sx1 = Math.min(st.W, vx + vw), sy0 = Math.max(0, vy), sy1 = Math.min(st.H, vy + vh);
    if (sx1 <= sx0 || sy1 <= sy0) throw new Error('outside');
    const dx0 = (sx0 - vx) / vw * R, dx1 = (sx1 - vx) / vw * R, dy0 = (sy0 - vy) / vh * R, dy1 = (sy1 - vy) / vh * R;
    drawStrip(g, st, sx0, sy0, sx1 - sx0, sy1 - sy0, dx0, dy0, dx1 - dx0, dy1 - dy0);
    const px = g.getImageData(0, 0, R, R).data;
    const inside = (x, y) => x >= dx0 && x < dx1 && y >= dy0 && y < dy1;
    const cell = R / G;
    const buildGrid = (ex) => { // ex: 使わない範囲 [x0,y0,x1,y1]
      const sum = [], cnt = [];
      for (let i = 0; i < G * G; i++) { sum.push([0, 0, 0]); cnt.push(0); }
      for (let y = 0; y < R; y++) for (let x = 0; x < R; x++) {
        if (!inside(x, y)) continue;
        if (x >= ex[0] && x < ex[2] && y >= ex[1] && y < ex[3]) continue;
        const k = Math.floor(y / cell) * G + Math.floor(x / cell), o = (y * R + x) * 4;
        sum[k][0] += px[o]; sum[k][1] += px[o + 1]; sum[k][2] += px[o + 2]; cnt[k]++;
      }
      const col = sum.map((v, i) => (cnt[i] ? v.map((c) => c / cnt[i]) : null));
      for (let pass = 0; pass < 16 && col.some((c) => !c); pass++) {
        const next = col.slice();
        for (let i = 0; i < G * G; i++) {
          if (col[i]) continue;
          const x = i % G, y = (i / G) | 0, acc = [0, 0, 0];
          let n = 0;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= G || yy >= G || !col[yy * G + xx]) continue;
            const c = col[yy * G + xx]; acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]; n++;
          }
          if (n) next[i] = acc.map((v) => v / n);
        }
        col.splice(0, col.length, ...next);
      }
      return col.map((c) => c || [255, 255, 255]);
    };
    // 1回目：文字のあたり（真ん中の1/3を少し広げた範囲）を除いて色を取る
    const core = [R * 0.22, R * 0.22, R * 0.78, R * 0.78]; // 文字（板の真ん中半分）を少し広げた範囲
    let col = buildGrid(core);
    // 板の色と違う画素＝文字（の一部）
    const at = (x, y) => col[Math.min(G - 1, (y / cell) | 0) * G + Math.min(G - 1, (x / cell) | 0)];
    const diff = new Uint8Array(R * R);
    for (let y = 0; y < R; y++) for (let x = 0; x < R; x++) {
      const o = (y * R + x) * 4, c = at(x, y);
      if (!inside(x, y)) continue;
      diff[y * R + x] = Math.max(Math.abs(px[o] - c[0]), Math.abs(px[o + 1] - c[1]), Math.abs(px[o + 2] - c[2])) > 48 ? 1 : 0;
    }
    // 囲みから外へ、文字っぽい画素が続く限り広げる（上限は文字の約1.5倍）。
    // ただし周りが細かい絵（板の色と違う画素だらけ）なら、絵まで消してしまうので広げない
    let t = R / 4, b = R * 3 / 4, l = R / 4, r = R * 3 / 4;
    const lim0 = R * 0.12, lim1 = R * 0.88;
    let ringN = 0, ringD = 0;
    for (let y = 0; y < R; y++) for (let x = 0; x < R; x++) {
      if (!inside(x, y) || (x >= lim0 && x < lim1 && y >= lim0 && y < lim1)) continue;
      ringN++; ringD += diff[y * R + x];
    }
    const busy = ringN > 0 && ringD / ringN > 0.2;
    const rowFrac = (y) => { let n = 0; for (let x = l | 0; x < r; x++) n += diff[y * R + x]; return n / Math.max(1, r - l); };
    const colFrac = (x) => { let n = 0; for (let y = t | 0; y < b; y++) n += diff[y * R + x]; return n / Math.max(1, b - t); };
    for (let round = 0; round < (busy ? 0 : 2); round++) {
      while (t > lim0 && (rowFrac((t - 1) | 0) > 0.05 || rowFrac((t - 2) | 0) > 0.05)) t--;
      while (b < lim1 && (rowFrac(b | 0) > 0.05 || rowFrac((b + 1) | 0) > 0.05)) b++;
      while (l > lim0 && (colFrac((l - 1) | 0) > 0.05 || colFrac((l - 2) | 0) > 0.05)) l--;
      while (r < lim1 && (colFrac(r | 0) > 0.05 || colFrac((r + 1) | 0) > 0.05)) r++;
    }
    // 2回目：広げた範囲を除いて色を取り直す
    col = buildGrid([l - cell * 0.5, t - cell * 0.5, r + cell * 0.5, b + cell * 0.5]);
    const hex = col.map((c) => c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')).join('');
    return { hex, col, cb: { x: l / R, y: t / R, w: (r - l) / R, h: (b - t) / R } };
  }
  // 文字の形だけを消す板。四角ごとぼかすと絵（顔など）まで消えるので、
  // 「周りの色と違う画素」＝文字とフチの画素だけを、周りの色で塗った透明な画像を作る
  // st: 仮想の1枚 / pv: 色の板の範囲（仮想座標）/ col: 色の板 8×8 / cbv: 消す範囲（仮想座標）/ fg, stroke: 原文の文字色・フチ色
  function makeGlyphCover(st, pv, col, cbv, fg, stroke) {
    const G = 8;
    const MW = 140, MH = Math.max(8, Math.min(320, Math.round(MW * cbv.h / Math.max(1, cbv.w))));
    const cv = document.createElement('canvas');
    cv.width = MW; cv.height = MH;
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.clearRect(0, 0, MW, MH);
    const sx0 = Math.max(0, cbv.x), sx1 = Math.min(st.W, cbv.x + cbv.w), sy0 = Math.max(0, cbv.y), sy1 = Math.min(st.H, cbv.y + cbv.h);
    if (sx1 <= sx0 || sy1 <= sy0) throw new Error('outside');
    const dx0 = (sx0 - cbv.x) / cbv.w * MW, dy0 = (sy0 - cbv.y) / cbv.h * MH;
    drawStrip(g, st, sx0, sy0, sx1 - sx0, sy1 - sy0, dx0, dy0, (sx1 - sx0) / cbv.w * MW, (sy1 - sy0) / cbv.h * MH);
    const im = g.getImageData(0, 0, MW, MH), px = im.data;
    // 色の板をなめらかに（双線形補間）
    const bil = (u, v) => { // u,v: 板の中の0〜1
      const fx = Math.min(G - 1.001, Math.max(0, u * G - 0.5)), fy = Math.min(G - 1.001, Math.max(0, v * G - 0.5));
      const x0 = fx | 0, y0 = fy | 0, ax = fx - x0, ay = fy - y0;
      const c = (x, y) => col[Math.min(G - 1, y) * G + Math.min(G - 1, x)];
      const a = c(x0, y0), b = c(x0 + 1, y0), cc = c(x0, y0 + 1), d = c(x0 + 1, y0 + 1);
      return [0, 1, 2].map((k) => (a[k] * (1 - ax) + b[k] * ax) * (1 - ay) + (cc[k] * (1 - ax) + d[k] * ax) * ay);
    };
    const hexRGB = (h) => (h ? [1, 3, 5].map((i) => parseInt(h.substr(i, 2), 16)) : null);
    let tf = hexRGB(fg), ts = hexRGB(stroke);
    const near = (o, c) => c && Math.abs(px[o] - c[0]) + Math.abs(px[o + 1] - c[1]) + Math.abs(px[o + 2] - c[2]) < 150;
    const mask = new Uint8Array(MW * MH), fill = new Array(MW * MH), dif = new Uint8Array(MW * MH);
    for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) {
      const i = y * MW + x, o = i * 4;
      if (px[o + 3] === 0) continue; // 画像の外
      const vx = cbv.x + (x + 0.5) / MW * cbv.w, vy = cbv.y + (y + 0.5) / MH * cbv.h;
      const c = bil((vx - pv.x) / pv.w, (vy - pv.y) / pv.h);
      fill[i] = c;
      dif[i] = Math.max(Math.abs(px[o] - c[0]), Math.abs(px[o + 1] - c[1]), Math.abs(px[o + 2] - c[2])) > 40 ? 1 : 0;
    }
    // 文字色が分からない（古い保存）ときは、真ん中あたりで周りと違う画素のうち、多い色2つを文字色・フチ色とみなす
    if (!tf && !ts) {
      const cnt = new Map();
      for (let y = (MH * 0.2) | 0; y < MH * 0.8; y++) for (let x = (MW * 0.2) | 0; x < MW * 0.8; x++) {
        const i = y * MW + x, o = i * 4;
        if (!dif[i]) continue;
        const k = ((px[o] >> 5) << 6) | ((px[o + 1] >> 5) << 3) | (px[o + 2] >> 5);
        cnt.set(k, (cnt.get(k) || 0) + 1);
      }
      const top = [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2);
      const tot = [...cnt.values()].reduce((a, b) => a + b, 0) || 1;
      const toRGB = (k) => [((k >> 6) & 7) * 32 + 16, ((k >> 3) & 7) * 32 + 16, (k & 7) * 32 + 16];
      if (top[0] && top[0][1] / tot > 0.15) tf = toRGB(top[0][0]);
      if (top[1] && top[1][1] / tot > 0.1) ts = toRGB(top[1][0]);
    }
    let on = 0, all = 0;
    for (let i = 0; i < MW * MH; i++) {
      if (px[i * 4 + 3] === 0) continue;
      all++;
      // 文字色・フチ色に近い画素だけ（絵の線を巻き込みにくい）
      if (dif[i] && (!tf && !ts || near(i * 4, tf) || near(i * 4, ts))) { mask[i] = 1; on++; }
    }
    // ほとんど全部が「文字」になる＝見分けられていない。そのときは範囲全体をふちぼかしで塗る
    const solid = all > 0 && on / all > 0.55;
    if (solid) {
      mask.fill(1);
      // グラデーションの四角は汚く見えるので、平均の1色にする
      const avg = [0, 0, 0]; let n = 0;
      for (const c of fill) if (c) { avg[0] += c[0]; avg[1] += c[1]; avg[2] += c[2]; n++; }
      if (n) { const a = avg.map((v) => v / n); for (let i = 0; i < fill.length; i++) if (fill[i]) fill[i] = a; }
    }
    // 2画素ふくらませて（文字のにじみ・フチの外側まで）、少しぼかす
    const grow = (m) => { const n = new Uint8Array(m); for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) if (m[y * MW + x]) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < MW && yy < MH) n[yy * MW + xx] = 1; } return n; };
    const m2 = grow(grow(mask));
    for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) {
      const i = y * MW + x, o = i * 4;
      let a = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < MW && yy < MH) { a += m2[yy * MW + xx]; n++; } }
      const c = fill[i] || [255, 255, 255];
      // ふちに近いほど薄く（四角い切れ目が出ないように）
      const f = Math.max(2, Math.min(MW, MH) * (solid ? 0.22 : 0.08));
      // 縦横のふちの近さを掛け合わせる → 角が丸くふんわり消える
      const edge = Math.min(1, Math.min(x, MW - 1 - x) / f) * Math.min(1, Math.min(y, MH - 1 - y) / f);
      px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = Math.round(255 * a / n * edge);
    }
    g.putImageData(im, 0, 0);
    return cv.toDataURL('image/png');
  }

  // 絵の上の文字用の消し板を作って it に入れる（cimg：画像、crect：画像に対する位置）
  function buildCover(it, st, W, H, offY) {
    const pr = { x: it.x - it.w * 0.5, y: it.y - it.h * 0.5, w: it.w * 2, h: it.h * 2 };
    const pv = { x: pr.x * W, y: offY + pr.y * H, w: pr.w * W, h: pr.h * H };
    const mp = makePatch(st, pv.x, pv.y, pv.w, pv.h);
    const cb = mp.cb, pad = 0.09; // 文字のまわり（板の9%＝文字の約2割）まで見る。消すのは文字色の画素だけなので広くても絵は残る
    const cr = { x: pr.x + (cb.x - pad) * pr.w, y: pr.y + (cb.y - pad) * pr.h, w: (cb.w + pad * 2) * pr.w, h: (cb.h + pad * 2) * pr.h };
    const cbv = { x: cr.x * W, y: offY + cr.y * H, w: cr.w * W, h: cr.h * H };
    it.cimg = makeGlyphCover(st, pv, mp.col, cbv, it.fgHex, it.stroke);
    it.crect = cr;
    delete it.patch; delete it.pr; delete it.cb;
  }

  // 保存済みの訳に、新しい塗り方に必要な情報（下の色のばらつき・周りの色の板）を後から足す。画像を見るだけなのでAPI代なし
  // 戻り値：保存し直す必要があるか。消し板の画像(cimg)は大きいので保存せず、表示のたびにここで作る
  function enrichItems(items, d) {
    const st = { W: d.w, H: d.h, parts: [{ d, sy: 0, vy: 0, vh: d.h }] };
    let changed = false;
    for (const it of items) {
      if (it.cimg) changed = true; // 前の版は消し板の画像まで保存していた → 消して保存し直す
      try {
        if (!(it.v >= 7)) {
          if (!it.v && !it.area) it.old = 1; // v1.8より前の保存：枠が吹き出し全体
          const sc = sampleColors(st, it.x * d.w, it.y * d.h, it.w * d.w, it.h * d.h);
          it.uni = sc.uni;
          delete it.patch; delete it.pr; delete it.cb; // 前の版の板は捨てて作り直す
          if (!it.bg) { it.bg = sc.bg; it.fg = sc.fg; }
          it.v = 7;
          changed = true;
        }
        if (!it.sig) { try { it.sig = boxSig(d, it); if (it.sig) changed = true; } catch (e) { /* なし */ } }
        delete it.cimg; delete it.crect;
        if (isFree(it)) buildCover(it, st, d.w, d.h, 0);
      } catch (e) { /* 足せなければ今までの塗り方のまま */ }
    }
    return changed;
  }
  // 保存用：消し板の画像は外す
  const forSave = (items) => items.map((it) => { const o = Object.assign({}, it); delete o.cimg; return o; });

  const patchURL = new Map();
  function patchToURL(hex) {
    if (patchURL.has(hex)) return patchURL.get(hex);
    const G = 8, cv = document.createElement('canvas');
    cv.width = cv.height = G;
    const g = cv.getContext('2d'), im = g.createImageData(G, G);
    for (let i = 0; i < G * G; i++) {
      im.data[i * 4] = parseInt(hex.substr(i * 6, 2), 16);
      im.data[i * 4 + 1] = parseInt(hex.substr(i * 6 + 2, 2), 16);
      im.data[i * 4 + 2] = parseInt(hex.substr(i * 6 + 4, 2), 16);
      im.data[i * 4 + 3] = 255;
    }
    g.putImageData(im, 0, 0);
    const u = cv.toDataURL('image/png');
    patchURL.set(hex, u);
    return u;
  }

  // ---------- Geminiの返事を、つないだ1枚（ストリップ）の座標にそろえる ----------
  function normalizeRaw(arr, c) {
    const raw = [];
    for (const a of arr) {
      if (!a || !Array.isArray(a.box_2d) || a.box_2d.length !== 4 || !a.tr) continue;
      // 文になっているのに効果音扱いされたものはナレーションとして拾う
      if (a.kind === 'sfx' && String(a.src || '').replace(/\s/g, '').length >= 6 && /\s|[.,!?…。、]/.test(String(a.src).trim())) a.kind = 'narration';
      if (!S.sfx && a.kind === 'sfx') continue;
      let [y0, x0, y1, x1] = a.box_2d.map(Number);
      if (y1 < y0) [y0, y1] = [y1, y0];
      if (x1 < x0) [x0, x1] = [x1, x0];
      const r = { a, x0: x0 / 1000, x1: x1 / 1000, y0: c.y + (y0 / 1000) * c.h, y1: c.y + (y1 / 1000) * c.h,
        src: String(a.src || '').trim(), tr: String(a.tr).trim(), kind: a.kind, ar: null };
      if (Array.isArray(a.area_2d) && a.area_2d.length === 4) {
        let [ay0, ax0, ay1, ax1] = a.area_2d.map(Number);
        if (ay1 < ay0) [ay0, ay1] = [ay1, ay0];
        if (ax1 < ax0) [ax0, ax1] = [ax1, ax0];
        r.ar = { x0: ax0 / 1000, x1: ax1 / 1000, y0: c.y + (ay0 / 1000) * c.h, y1: c.y + (ay1 / 1000) * c.h };
      }
      if (r.x1 > r.x0 && r.y1 > r.y0) raw.push(r);
    }
    return raw;
  }

  // 1つの枠・吹き出しなのに行ごとに分けて返されたものを1つにまとめる
  function mergeRaw(raw, W) {
    const iou = (p, q) => {
      const ix = Math.max(0, Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0)), iy = Math.max(0, Math.min(p.y1, q.y1) - Math.max(p.y0, q.y0)) / W;
      const A = (p.x1 - p.x0) * (p.y1 - p.y0) / W, B = (q.x1 - q.x0) * (q.y1 - q.y0) / W;
      return ix * iy / Math.max(1e-9, A + B - ix * iy);
    };
    const joinTr = (t1, t2) => {
      const cjk = /^(ja|zh)/.test(langTag());
      for (let k = Math.min(t1.length, t2.length, 12); k >= 2; k--) if (t1.endsWith(t2.slice(0, k))) return t1 + t2.slice(k); // 重なった言葉は1回に
      return t1 + (cjk ? '' : ' ') + t2;
    };
    const sameBox = (p, q) => {
      if (p.kind === 'sfx' || q.kind === 'sfx') return false;
      if (p.ar && q.ar && iou(p.ar, q.ar) > 0.5) return true; // 同じ枠の中
      const ov = Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0);
      if (ov < 0.4 * Math.min(p.x1 - p.x0, q.x1 - q.x0)) return false;
      const [u, l] = p.y0 <= q.y0 ? [p, q] : [q, p];
      const gap = l.y0 - u.y1, lh = Math.min(u.y1 - u.y0, l.y1 - l.y0);
      const cxd = Math.abs((p.x0 + p.x1) / 2 - (q.x0 + q.x1) / 2);
      // 行と行のすき間が1行ぶんより狭く、中央がそろっている（または左がそろっている）
      return gap > -lh * 0.5 && gap < lh * 0.6 && (cxd < 0.08 || Math.abs(p.x0 - q.x0) < 0.04);
    };
    for (let changed = true; changed;) {
      changed = false;
      for (let i = 0; i < raw.length && !changed; i++) for (let j = i + 1; j < raw.length && !changed; j++) {
        if (!sameBox(raw[i], raw[j])) continue;
        const [u, l] = raw[i].y0 <= raw[j].y0 ? [raw[i], raw[j]] : [raw[j], raw[i]];
        u.tr = joinTr(u.tr, l.tr);
        u.src = (u.src + ' ' + l.src).trim();
        u.x0 = Math.min(u.x0, l.x0); u.x1 = Math.max(u.x1, l.x1); u.y0 = Math.min(u.y0, l.y0); u.y1 = Math.max(u.y1, l.y1);
        if (l.ar) u.ar = u.ar ? { x0: Math.min(u.ar.x0, l.ar.x0), x1: Math.max(u.ar.x1, l.ar.x1), y0: Math.min(u.ar.y0, l.ar.y0), y1: Math.max(u.ar.y1, l.ar.y1) } : l.ar;
        if (u.kind !== l.kind && (u.kind === 'narration' || l.kind === 'narration')) u.kind = 'narration';
        raw.splice(raw.indexOf(l), 1);
        changed = true;
      }
    }
    return raw;
  }

  // ストリップ座標の1項目を、その画像（span：ストリップ上の位置）用の表示データにする
  function makeItem(r, st, span, d) {
    const W = st.W, H = span.vh, a = r.a;
    const py0 = r.y0, py1 = r.y1;
    const it = {
      x: r.x0, w: r.x1 - r.x0,
      y: (py0 - span.vy) / H, h: (py1 - py0) / H, // 画像の外にはみ出す値もあり
      area: null, tr: r.tr, kind: r.kind, src: r.src,
    };
    if (it.w <= 0 || it.h <= 0) return null;
    if (r.ar) {
      // 文字を含まない・大きすぎる範囲は信用しない
      const ar = { x: r.ar.x0, w: r.ar.x1 - r.ar.x0, y: (r.ar.y0 - span.vy) / H, h: (r.ar.y1 - r.ar.y0) / H };
      const contains = ar.x <= it.x + it.w * 0.3 && ar.x + ar.w >= it.x + it.w * 0.7 && ar.y <= it.y + it.h * 0.3 && ar.y + ar.h >= it.y + it.h * 0.7;
      if (ar.w > 0 && ar.h > 0 && contains && ar.w * ar.h < it.w * it.h * 12) it.area = ar;
    }
    Object.assign(it, sampleColors(st, it.x * W, py0, it.w * W, py1 - py0));
    // 原文の文字色が背景と見分けられる色なら、その色で書く（色付きの独白など）
    const m = /^#?([0-9a-f]{6})$/i.exec(String(a.color || '').trim());
    if (m) {
      const n = parseInt(m[1], 16), lum = (c) => 0.299 * (c >> 16 & 255) + 0.587 * (c >> 8 & 255) + 0.114 * (c & 255);
      const bg = /rgb\((\d+),(\d+),(\d+)\)/.exec(it.bg);
      const bl = bg ? 0.299 * bg[1] + 0.587 * bg[2] + 0.114 * bg[3] : 255;
      if (Math.abs(lum(n) - bl) > 90) it.fg = '#' + m[1];
      it.fgHex = '#' + m[1]; // 原文の文字色（消す画素を見分ける用）
    }
    const sm = /^#?([0-9a-f]{6})$/i.exec(String(a.stroke || '').trim());
    if (sm) it.stroke = '#' + sm[1];
    // 吹き出しの外（絵の上）の文字は、周りの絵の色から埋める板を作る（表示用。保存はしない）
    if (isFree(it)) {
      try { buildCover(it, st, W, H, span.vy); } catch (e) { console.warn('[吹き出し翻訳] 消し板を作れません', e); }
    }
    it.v = 8; // 8 = つないで読む方式（v3）で訳したもの
    try { it.sig = boxSig(d, it); } catch (e) { /* 比べる材料なし */ }
    return it;
  }

  /* ---------------- 重ねて表示 ---------------- */
  const css = document.createElement('style');
  css.textContent = `
.ezc-layer{position:absolute!important;left:0!important;top:0!important;width:0!important;height:0!important;overflow:visible!important;z-index:2147483000!important;pointer-events:none!important;margin:0!important;padding:0!important;border:0!important;transform:none!important;}
.ezc-ov{position:absolute!important;left:0;top:0;pointer-events:none!important;z-index:10;container-type:inline-size;margin:0!important;padding:0!important;border:0!important;background:none!important;}
.ezc-off .ezc-ov{display:none!important}
.ezc-b{position:absolute;box-sizing:border-box;display:flex;align-items:center;justify-content:center;text-align:center;pointer-events:auto;cursor:pointer;
font-family:"Hiragino Sans","Noto Sans CJK JP","Noto Sans JP","Yu Gothic",system-ui,sans-serif;font-weight:700;line-height:1.22;letter-spacing:0;
line-break:strict;overflow-wrap:anywhere;word-break:auto-phrase;white-space:pre-wrap;padding:.25em .35em;transition:opacity .15s;-webkit-tap-highlight-color:transparent;text-shadow:none;}
.ezc-b.ezc-sp.ezc-fm{font-family:"ezc-kana","Hiragino Sans","Noto Sans CJK JP","Noto Sans JP","Yu Gothic",system-ui,sans-serif}
.ezc-b.ezc-fr{font-family:"ezc-maru","Hiragino Maru Gothic ProN","Noto Sans CJK JP",system-ui,sans-serif}
.ezc-c{position:absolute;pointer-events:none;transition:opacity .15s}
.ezc-c.ezc-peek{opacity:0}
.ezc-b.ezc-v{writing-mode:vertical-rl;text-orientation:mixed;line-height:1.3}
.ezc-b.ezc-peek{opacity:0}
.ezc-ov.ezc-dbg{outline:2px dashed rgba(255,0,140,.85)!important;outline-offset:-2px}
.ezc-dbg .ezc-b{outline:2px solid rgba(0,160,255,.9)}
.ezc-dbg .ezc-c{outline:2px dotted rgba(255,160,0,.95)}
.ezc-dbgl{position:absolute;left:4px;top:4px;font:600 11px/1.2 system-ui,sans-serif;padding:3px 6px;border-radius:4px;background:rgba(255,0,140,.85);color:#fff}
.ezc-badge{position:absolute;top:8px;right:8px;pointer-events:auto;font:600 12px/1.2 system-ui,sans-serif;padding:6px 10px;border-radius:999px;background:rgba(24,24,32,.82);color:#fff;max-width:70%;}
`;
  document.head.appendChild(css);

  const overlays = new Map(); // img -> overlay div
  const doneSrc = new WeakMap(); // img -> 翻訳済みのsrc

  function placeOverlay(img, ov) {
    if (!img.isConnected) { ov.remove(); overlays.delete(img); return; }
    if (ov.style.display) ov.style.display = '';
    // 位置は層（ページ左上）からの差で決める。変わっていなければ書き込まない（スクロール中のカクつき防止）
    const ir = img.getBoundingClientRect(), lr = (ov.parentNode || getLayer()).getBoundingClientRect();
    const st = ov.style, L = (ir.left - lr.left) + 'px', T = (ir.top - lr.top) + 'px', W = ir.width + 'px', H = ir.height + 'px';
    if (st.left !== L) st.left = L;
    if (st.top !== T) st.top = T;
    if (st.width !== W) st.width = W;
    if (st.height !== H) st.height = H;
    // 大きさが変わったら（読み込み中の仮の高さ→本当の高さ など）文字サイズを測り直す
    const fw = +ov.dataset.fw || 0, fh = +ov.dataset.fh || 0;
    if (ir.width > 0 && ir.height > 0 && (ov.dataset.fitted !== '1' || Math.abs(ir.width - fw) > 2 || Math.abs(ir.height - fh) > 2)) fitAll(ov);
  }

  // 訳はページの画像の箱の中ではなく、ページ全体に1枚かぶせた層に描く。
  // サイトの画像の箱は「はみ出しを切る」設定のことが多く、画像の境目をまたぐ訳が途中で切れてしまうため
  let layer = null;
  function getLayer() {
    if (!layer || !layer.isConnected) {
      layer = document.createElement('div');
      layer.className = 'ezc-layer';
      (document.body || document.documentElement).appendChild(layer);
    }
    return layer;
  }
  function getOverlay(img) {
    let ov = overlays.get(img);
    if (!ov) {
      ov = document.createElement('div');
      ov.className = 'ezc-ov';
      ov.lang = langTag(); // 漢字を日本の字形で出す（ページが韓国語だと中国・韓国風の字形になる）
      getLayer().appendChild(ov);
      overlays.set(img, ov);
      ro.observe(img);
    } else if (!ov.isConnected) getLayer().appendChild(ov); // サイトが画面を作り直したときは付け直す
    return ov;
  }

  function setBadge(img, text, onTap) {
    if (text && !onTap && !S.debug && /^(翻訳中|翻訳待ち|回数制限のため待機中)/.test(text)) text = null; // 途中経過は画像に出さない（WTボタンで分かる）
    const ov = getOverlay(img);
    let b = ov.querySelector('.ezc-badge');
    if (!text) { if (b) b.remove(); return; }
    if (!b) { b = document.createElement('div'); b.className = 'ezc-badge'; ov.appendChild(b); }
    b.textContent = text;
    b.onclick = onTap ? (e) => { e.stopPropagation(); e.preventDefault(); onTap(); } : null;
    placeOverlay(img, ov);
  }

  // ---------- 漫画っぽいフォント（Google Fontsから、使う文字の分だけ取ってくる）----------
  const loadedChars = { kana: new Set(), maru: new Set() };
  let fontWant = '', fontTimer = 0;
  function loadFonts(text) {
    fontWant += text;
    clearTimeout(fontTimer);
    fontTimer = setTimeout(flushFonts, 250);
  }
  async function flushFonts() {
    const text = fontWant; fontWant = '';
    const isKana = (c) => /[　-ヿ！-～…―〜]/.test(c);
    const jobs = S.font === 'maru'
      ? [{ fam: 'ezc-maru', set: loadedChars.maru, gf: 'Zen+Maru+Gothic:wght@700', w: '700', chars: [...new Set(text)] }]
      : [{ fam: 'ezc-kana', set: loadedChars.kana, gf: 'Shippori+Mincho+B1:wght@800', w: '700', chars: [...new Set(text)].filter(isKana) }];
    for (const j of jobs) {
      const need = j.chars.filter((c) => !j.set.has(c) && c.trim());
      if (!need.length) continue;
      need.forEach((c) => j.set.add(c));
      try {
        const cssR = await xhr({ method: 'GET', url: `https://fonts.googleapis.com/css2?family=${j.gf}&text=${encodeURIComponent(need.join(''))}&display=swap` });
        const m = /url\((https:[^)]+)\)/.exec(cssR.responseText || '');
        if (!m) throw new Error('no font url');
        const fr = await xhr({ method: 'GET', url: m[1], responseType: 'arraybuffer' });
        const range = need.map((c) => 'U+' + c.codePointAt(0).toString(16)).join(',');
        // 取ってきた文字だけを担当させる（ほかの字は今までのフォントのまま）
        const face = new FontFace(j.fam, fr.response, { weight: j.w, unicodeRange: range });
        await face.load();
        document.fonts.add(face);
        overlays.forEach((ov) => { ov.dataset.fitted = '0'; fitAll(ov); });
      } catch (e) {
        need.forEach((c) => j.set.delete(c)); // 失敗したら次の機会にもう一度
      }
    }
  }

  // 訳の文字のフチ。絵の上の文字は、どんな背景でも読めるように必ず文字色と反対の色でフチを付ける
  function lumOf(c) {
    let m = /^#([0-9a-f]{6})$/i.exec(c || '');
    if (m) { const n = parseInt(m[1], 16); return 0.299 * (n >> 16 & 255) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255); }
    m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(c || '');
    return m ? 0.299 * m[1] + 0.587 * m[2] + 0.114 * m[3] : 128;
  }
  function outlineFor(it) {
    const free = !!(it.cimg || it.patch);
    const fgL = lumOf(it.fg);
    let st = it.stroke && Math.abs(lumOf(it.stroke) - fgL) >= 110 ? it.stroke : null; // 文字色に近いフチは潰れるので使わない
    if (!st && free) st = fgL > 128 ? '#111111' : '#ffffff';
    if (!st) return `0 0 2px ${it.bg}, 0 0 2px ${it.bg}`;
    const w = 0.06;
    return [[1, 0], [-1, 0], [0, 1], [0, -1], [.7, .7], [-.7, .7], [.7, -.7], [-.7, -.7]]
      .map(([x, y]) => `${(x * w).toFixed(3)}em ${(y * w).toFixed(3)}em 0 ${st}`).join(',') + `, 0 0 0.15em ${st}`;
  }

  function langTag() {
    const t = S.target;
    if (/日本|japan/i.test(t)) return 'ja';
    if (/韓国|korean/i.test(t)) return 'ko';
    if (/繁体|台湾|香港/.test(t)) return 'zh-Hant';
    if (/中国|簡体|chinese/i.test(t)) return 'zh-Hans';
    if (/英|english/i.test(t)) return 'en';
    return 'ja';
  }

  function render(img, items) {
    const ov = getOverlay(img);
    ov.querySelectorAll('.ezc-b, .ezc-c, .ezc-dbgl').forEach((n) => n.remove());
    ov.lang = langTag();
    if (S.font !== 'gothic' && langTag() === 'ja') loadFonts(items.map((it) => it.tr).join(''));
    ov.classList.toggle('ezc-dbg', !!S.debug);
    if (S.debug) {
      const l = document.createElement('div');
      l.className = 'ezc-dbgl';
      l.textContent = `#${imgIndex(img)} ${img.naturalWidth}×${img.naturalHeight} ／ ${items.length}件 ／ ${img.dataset.ezcHow || ''}`;
      ov.appendChild(l);
    }
    const imgRatio = (img.naturalHeight || 1) / (img.naturalWidth || 1);
    for (const it of items) {
      // ① 原文の文字だけを、吹き出しの地の色でふんわり消す（吹き出し全体は塗らない）
      const hasArea = !!it.area;
      // 古い保存（v1.8より前）は枠が吹き出し全体なので、広げずに少し内側だけ塗る
      const ex = it.kind === 'sfx' ? 0.04 : it.old ? -0.06 : 0.12;
      const padX = it.old ? 0 : 0.008, padY = padX / imgRatio;      // 最低でも画像幅の0.8%は余白
      const cx = it.x - it.w * ex - padX, cy = it.y - it.h * ex - padY;
      const cw = it.w * (1 + ex * 2) + padX * 2, ch = it.h * (1 + ex * 2) + padY * 2;
      const c = document.createElement('div');
      c.className = 'ezc-c';
      if (it.crect && S.artMode === 'label') {
        // 白い札で隠す（読みやすさ優先）
        Object.assign(c.style, {
          left: it.crect.x * 100 + '%', top: it.crect.y * 100 + '%', width: it.crect.w * 100 + '%', height: it.crect.h * 100 + '%',
          background: 'rgba(255,255,255,.94)', borderRadius: '14px', boxShadow: '0 1px 6px rgba(0,0,0,.18)',
        });
      } else if (it.cimg && it.crect) {
        // 絵の上の文字：文字の形の部分だけを周りの色で消す（絵はそのまま残る）
        Object.assign(c.style, {
          left: it.crect.x * 100 + '%', top: it.crect.y * 100 + '%', width: it.crect.w * 100 + '%', height: it.crect.h * 100 + '%',
          backgroundImage: `url(${it.cimg})`, backgroundSize: '100% 100%',
        });
      } else if (it.patch && it.pr) {
        // 絵の上の文字：周りの色から作った板を、ふちをぼかして重ねる（中央＝文字の部分は完全に隠れる）
        // 隠す範囲(cb)を外接する楕円の内側は完全に隠し、その外へふんわり消える
        const cb = it.cb || { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
        // 楕円だと文字の四角より7割も広く消えてしまうので、四角のふちだけをぼかす（横と縦のぼかしを重ねる）
        const pad = 2.5, fe = 5; // 文字の外に2.5%だけ余白、そこから5%でふわっと消える（板に対する%）
        const xa = cb.x * 100 - pad, xb = (cb.x + cb.w) * 100 + pad, ya = cb.y * 100 - pad, yb = (cb.y + cb.h) * 100 + pad;
        const mx = `linear-gradient(to right, transparent ${xa - fe}%, #000 ${xa}%, #000 ${xb}%, transparent ${xb + fe}%)`;
        const my = `linear-gradient(to bottom, transparent ${ya - fe}%, #000 ${ya}%, #000 ${yb}%, transparent ${yb + fe}%)`;
        const m = `${mx}, ${my}`;
        Object.assign(c.style, {
          left: it.pr.x * 100 + '%', top: it.pr.y * 100 + '%', width: it.pr.w * 100 + '%', height: it.pr.h * 100 + '%',
          backgroundImage: `url(${patchToURL(it.patch)})`, backgroundSize: '100% 100%',
          maskImage: m, webkitMaskImage: m, maskComposite: 'intersect', webkitMaskComposite: 'source-in',
        });
      } else {
        Object.assign(c.style, {
          left: cx * 100 + '%', top: cy * 100 + '%', width: cw * 100 + '%', height: ch * 100 + '%',
          background: it.bg, boxShadow: it.old ? `0 0 3px 1px ${it.bg}` : `0 0 5px 3px ${it.bg}`,
          borderRadius: it.kind === 'speech' ? (it.old ? '50%' : '40%') : '18%',
        });
      }
      ov.appendChild(c);

      // ② 訳は吹き出しの内側（なければ原文の範囲）に組む。背景は塗らない
      // 絵の上の文字は、原文より少し広くまで使ってよい（板でにじませた範囲の中）
      let A = it.area || { x: cx, y: cy, w: cw, h: ch };
      if (it.cimg && it.crect) A = it.crect; // 消した範囲に書く
      else if (it.patch && it.pr) {
        const cb = it.cb || { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
        A = { x: it.pr.x + cb.x * it.pr.w, y: it.pr.y + cb.y * it.pr.h, w: cb.w * it.pr.w, h: cb.h * it.pr.h }; // 隠した範囲に書く
      }
      const b = document.createElement('div');
      b.className = 'ezc-b';
      // 日本の漫画のセリフはアンチック体（かな明朝＋漢字ゴシック）が定番。ナレーション・看板は原文に近いゴシックのまま
      if (it.kind === 'speech') b.classList.add('ezc-sp');
      if (S.font === 'manga') b.classList.add('ezc-fm');
      else if (S.font === 'maru') b.classList.add('ezc-fr');
      const tall = (A.h * imgRatio) > A.w * 1.25, veryTall = (A.h * imgRatio) > A.w * 2.2;
      if (S.vertical === 'auto' && tall && (it.kind !== 'narration' || veryTall)) b.classList.add('ezc-v'); // 縦に細長い枠は縦書き
      // 吹き出しの内側いっぱいだと線にかかるので、少し内側に
      const ix = hasArea ? A.w * 0.08 : 0, iy = hasArea ? A.h * 0.1 : 0;
      Object.assign(b.style, {
        left: (A.x + ix) * 100 + '%', top: (A.y + iy) * 100 + '%',
        width: (A.w - ix * 2) * 100 + '%', height: (A.h - iy * 2) * 100 + '%',
        color: it.fg,
        textShadow: outlineFor(it),
      });
      if (it.patch || it.cimg) b.dataset.free = '1';
      if (it.crect && S.artMode === 'label') { b.style.color = '#1a1a1a'; b.style.textShadow = 'none'; }
      b.textContent = it.tr;
      b.dataset.tr = it.tr;
      b.dataset.src = it.src || '';
      // 原文の文字の範囲（文字サイズの目安用）。古い保存は吹き出し全体なので、文字はその6割くらいとみなす
      b.dataset.tw = it.w * (it.old ? 0.75 : 1); b.dataset.th = it.h * (it.old ? 0.75 : 1);
      b.title = 'タップで原文を表示';
      b.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); b.classList.toggle('ezc-peek'); c.classList.toggle('ezc-peek'); });
      ov.appendChild(b);
    }
    ov.dataset.fitted = '0';
    placeOverlay(img, ov);
  }

  // ---------- 漫画の写植っぽい改行 ----------
  // 文節（「俺が」「描いた」「絵の」「中だ。」）の切れ目でだけ改行し、行の長さをそろえて真ん中に寄せる
  const SEG = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('ja', { granularity: 'word' }) : null;
  const CLOSE = /^[\s、。，．,.!！?？…‥ー〜～・」』）)】〉》"”’ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶ]+$/;
  const OPEN = /[「『（(【〈《"“‘]$/;
  const HIRA = /^[ぁ-ゟ]+$/;
  const SENT_END = /[。！？!?]$|…$|」$|』$/;

  function phraseUnits(text) {
    let raw;
    if (SEG) raw = [...SEG.segment(text)].map((x) => x.segment);
    else raw = text.match(/[^ぁ-ゟ\s]*[ぁ-ゟ]*\s*|./g) || [text]; // 漢字・カナのかたまり＋後ろのひらがな
    const out = [];
    for (const u of raw) {
      if (!u) continue;
      const prev = out[out.length - 1];
      const attach = prev != null && (CLOSE.test(prev) && out.length === 1 // 先頭の「…」は次とくっつける
        || CLOSE.test(u) || OPEN.test(prev)
        || /^[ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮーｰ]/.test(u) // 「参|った」→ 小さい字の前では切らない
        || /[0-9０-９]$/.test(prev) && /^[^\u3041-\u309f\s、。]/.test(u) // 「3」「時間」→「3時間」
        || (HIRA.test(u) && u.length <= 2 && !/[。！？!?]$/.test(prev) && !/[、,\s]$/.test(prev)));
      if (attach) out[out.length - 1] = prev + u;
      else out.push(u);
    }
    return out.map((u) => u.replace(/^\s+|\s+$/g, (m) => (m.includes('\n') ? '' : ''))).filter((u) => u);
  }

  const mcv = document.createElement('canvas').getContext('2d');
  function textW(str, font) { mcv.font = font; return mcv.measureText(str).width / 100; } // 1pxあたりの幅

  // units を n 行に分けて、いちばん長い行が最短になる分け方（文の途中で他の文と同じ行にならないように）
  function bestLines(units, widths, n, sentEnds, sepW) {
    const m = units.length;
    if (n > m) return null;
    const pre = [0];
    for (let i = 0; i < m; i++) pre.push(pre[i] + widths[i]);
    const lineW = (i, j) => pre[j] - pre[i];
    const crossOK = (i, j) => { for (let k = i; k < j - 1; k++) if (sentEnds[k]) return false; return true; };
    const strict = sentEnds.filter(Boolean).length + 1 <= n; // 文の数より行が多いなら、文の境目では必ず改行
    const INF = 1e9;
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(INF));
    const back = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(-1));
    dp[0][0] = 0;
    for (let l = 1; l <= n; l++) {
      for (let j = l; j <= m; j++) {
        for (let i = l - 1; i < j; i++) {
          if (dp[l - 1][i] >= INF) continue;
          if (strict && !crossOK(i, j)) continue;
          const v = Math.max(dp[l - 1][i], lineW(i, j));
          if (v < dp[l][j]) { dp[l][j] = v; back[l][j] = i; }
        }
      }
    }
    if (dp[n][m] >= INF) return null;
    const lines = [];
    let j = m;
    for (let l = n; l > 0; l--) { const i = back[l][j]; lines.unshift(units.slice(i, j).join('')); j = i; }
    return { lines, maxW: dp[n][m] };
  }

  // 原文の文字の大きさの目安：枠の面積を原文の字数で割る（1字が約1.3em四方とみなす）。訳がこれより大きくならないように
  function origSize(b) {
    const n = [...(b.dataset.src || '').replace(/\s/g, '')].length;
    const ov = b.parentElement;
    if (!n || !ov) return Infinity;
    const tw = +b.dataset.tw * ov.clientWidth, th = +b.dataset.th * ov.clientHeight;
    const area = tw > 0 && th > 0 ? tw * th : b.clientWidth * b.clientHeight;
    return Math.sqrt(area / n) / 1.2 * 1.1; // 原文の文字の範囲÷字数＝1字ぶん（行間込み）
  }

  function layoutCJK(b, ow) {
    const tr = (b.dataset.tr || '').replace(/\s*\n\s*/g, '').trim(); // モデルの改行は捨てて、こっちで組み直す
    const vertical = b.classList.contains('ezc-v');
    const cs = getComputedStyle(b);
    const font = `${cs.fontWeight} 100px ${cs.fontFamily}`;
    const units = phraseUnits(tr);
    if (!units.length) return;
    const widths = units.map((u) => (vertical ? [...u].length : textW(u, font)));
    const sentEnds = units.map((u) => SENT_END.test(u));
    const W = b.clientWidth, H = b.clientHeight;
    const lh = vertical ? 1.3 : 1.22;
    // 縦書きは「行の長さ」が高さ方向、「行を重ねる」のが幅方向
    const along = vertical ? H : W, across = vertical ? W : H;
    let best = null;
    for (let n = 1; n <= Math.min(8, units.length); n++) {
      const r = bestLines(units, widths, n, sentEnds);
      if (!r) continue;
      // 余白（左右 .35em×2、上下 .25em×2）込みで収まる最大の文字サイズ
      const padAlong = vertical ? 0.5 : 0.7, padAcross = vertical ? 0.7 : 0.5;
      const size = Math.min(along / (r.maxW + padAlong), across / (n * lh + padAcross));
      // 同じくらいの大きさなら、行の長さがそろっている方・行が少ない方を選ぶ
      if (!best || size > best.size * 1.04) best = { size, lines: r.lines };
    }
    if (!best) return;
    const fill = b.dataset.free ? 0.92 : 0.86; // 吹き出しの中は少し余白を残す
    const size = Math.max(6, Math.min(best.size * fill, ow * 0.075, origSize(b)) * (S.textScale || 100) / 100);
    b.textContent = '';
    best.lines.forEach((ln, i) => { if (i) b.appendChild(document.createElement('br')); b.appendChild(document.createTextNode(ln)); });
    b.style.whiteSpace = 'nowrap';
    b.style.fontSize = size.toFixed(2) + 'px';
  }

  // 吹き出しに収まる最大の文字サイズを探す
  function fitAll(ov) {
    const ow = ov.clientWidth, oh = ov.clientHeight;
    if (!ow || !oh) return;
    ov.dataset.fw = ow; ov.dataset.fh = oh;
    const cjk = /^(ja|zh)/.test(langTag());
    ov.querySelectorAll('.ezc-b').forEach((b) => {
      if (cjk) { try { layoutCJK(b, ow); return; } catch (e) { b.textContent = b.dataset.tr || ''; b.style.whiteSpace = ''; } }
      // 中央寄せのままだと上（縦書きは左）にはみ出した分が測れず、大きすぎても「収まった」と判定してしまう。
      // 測る間だけ端寄せにする
      b.style.overflow = 'hidden';
      b.style.alignItems = 'flex-start';
      b.style.justifyContent = 'flex-start';
      const W = b.clientWidth, H = b.clientHeight;
      let lo = 6, hi = Math.max(8, Math.min(Math.min(W, H) * 0.9, ow * 0.085));
      for (let i = 0; i < 14; i++) {
        const mid = (lo + hi) / 2;
        b.style.fontSize = mid + 'px';
        if (b.scrollWidth <= W + 1 && b.scrollHeight <= H + 1) lo = mid; else hi = mid;
      }
      b.style.fontSize = Math.max(6, Math.min(lo * 0.82, origSize(b)) * (S.textScale || 100) / 100).toFixed(2) + 'px'; // 吹き出しのふちまで詰めない
      b.style.alignItems = '';
      b.style.justifyContent = '';
      b.style.overflow = 'visible';
    });
    ov.dataset.fitted = '1';
  }

  // フォントの読み込みが終わったら測り直す（読み込み前の代わりのフォントで測ると小さくなる）
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => overlays.forEach((ov) => { ov.dataset.fitted = '0'; fitAll(ov); }));

  const ro = new ResizeObserver((ents) => {
    for (const e of ents) { const ov = overlays.get(e.target); if (ov) placeOverlay(e.target, ov); }
  });
  let rafPending = false;
  function replaceVisible() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      const vh = innerHeight;
      overlays.forEach((ov, img) => {
        if (!img.isConnected) { ov.remove(); overlays.delete(img); return; }
        const r = img.getBoundingClientRect();
        const near = r.bottom > -vh && r.top < vh * 2 && r.width > 0;
        if (near) placeOverlay(img, ov);
        else ov.style.display = 'none';
      });
    });
  }
  addEventListener('scroll', replaceVisible, { passive: true, capture: true });
  addEventListener('resize', replaceVisible);
  // 上の画像の読み込みなどでページの位置がずれたときにも追いかける
  setInterval(replaceVisible, 600);

  /* ---------------- 翻訳キュー ---------------- */
  const queue = [];
  const queued = new WeakSet();
  const failedAt = new WeakMap();
  let running = 0;
  const MAX_PAR = 2;

  function eligible(img) {
    if (!img.isConnected || img.closest('.ezc-ov')) return false;
    if (!img.complete || !img.naturalWidth) return false;
    if (img.naturalWidth < S.minSize || img.naturalHeight < S.minSize) return false;
    const r = img.getBoundingClientRect();
    return r.width >= 150 && r.height >= 100;
  }

  function enqueue(img, force) {
    const src = img.currentSrc || img.src;
    if (!src || queued.has(img)) return;
    // 漫画のページ（大きな画像が画面の半分以上）と判断できるまでは送らない：小説の挿絵・表紙で料金がかからないように
    if (!force && doneSrc.get(img) === src) return;
    if (!force && Date.now() - (failedAt.get(img) || 0) < 10 * 60000) return;
    if (!force && !pageActive() && waiting.has(img) && waitSrc.get(img) === src) return; // ボタン待ち：調べ直さない
    queued.add(img);
    if (force) forced.add(img); else forced.delete(img);
    queue.push(img);
    updateButton();
    pump();
  }

  // ---------- 境目の重複をなくして表示 ----------
  // 上下にくっついた画像どうしで同じ文字を持っていたら、より完全な方（原文が長い・枠が大きい）だけを表示する
  const allItems = new WeakMap(); // 画像 → 保存されている全部の項目
  function toMine(img, nImg, side, q) {
    const H = img.naturalHeight, f = img.naturalWidth / nImg.naturalWidth, nH = nImg.naturalHeight * f;
    const y = side === 'prev' ? (q.y * nH - nH) / H : (H + q.y * nH) / H;
    return { x: q.x, w: q.w, y, h: q.h * nH / H };
  }
  const score = (q, hpx) => (q.src || '').replace(/\s/g, '').length * 1000 + q.w * q.h * hpx;
  function overlapFrac(a, b) {
    const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    return ix * iy / Math.max(1e-9, Math.min(a.w * a.h, b.w * b.h));
  }
  function showItems(img, items, noPropagate) {
    allItems.set(img, items);
    let mine = items.slice();
    const nb = neighbors(img);
    for (const side of ['prev', 'next']) {
      const nImg = nb[side];
      const theirsAll = nImg && allItems.get(nImg);
      if (!theirsAll) continue;
      let theirs = (lastItems.get(nImg) || theirsAll).slice();
      let changedTheirs = false;
      mine = mine.filter((it) => {
        for (const q of theirs) {
          const qm = toMine(img, nImg, side, q);
          if (overlapFrac(it, qm) < 0.3) continue;
          // 同じ文字：完全な方を残す
          if (score(it, img.naturalHeight) >= score(qm, img.naturalHeight)) {
            theirs = theirs.filter((x) => x !== q); changedTheirs = true;
          } else return false;
        }
        return true;
      });
      if (changedTheirs && !noPropagate) { lastItems.set(nImg, theirs); render(nImg, theirs); }
    }
    lastItems.set(img, mine);
    render(img, mine);
  }

  const forced = new WeakSet();
  // 「この話を全部訳し直す」：この画面を開いている間、まだ訳し直していない画像は保存を無視して訳す
  let pageForce = false;
  const forceDone = new WeakSet();
  const lastItems = new WeakMap(); // 画像 → 表示中の訳（境目の重複チェック用）
  // ---------- 保存から探す ----------
  const scanning = new WeakSet(); // いま翻訳中のまとまりに入っている画像
  async function resolve(img) {
    const src = img.currentSrc || img.src;
    const d = await getDrawable(img);
    let ik = null;
    try { ik = imageKey(d); } catch (e) { /* 指紋が取れない画像はURLで */ }
    // 画像のURL（?以降は除く）。NAVERのように画像のURLが毎回同じサイトでは、これがいちばん確実
    let uk = null;
    if (!/^(blob|data):/.test(src)) { try { const u = new URL(src, location.href); uk = 'u:' + u.host + u.pathname; } catch (e) {} }
    const key = (ik || uk) && wkh() + '|' + (ik || uk); // 作品ごとに分けて保存
    try { d.dh = dHash(d); } catch (e) { d.dh = null; }
    try { d.rh = rHash(d); } catch (e) { d.rh = null; }
    try { d.th = thumbOf(d); } catch (e) { d.th = null; }
    const r = { img, src, d, key, ik, uk, hit: null, hitKey: null, how: '', why: [] };
    if (forced.has(img)) { r.why.push('訳し直し'); return r; }
    // 保存先の候補を順に試す。指紋が完全に一致したもの以外は「本当に同じ画像か」を確かめる
    const cands = [['指紋', key, 'exact'], ...hIndexKeys(d).map((k) => ['見た目', k, 'strict']),
      ['URL', aliasKey(uk, d.dh), 'loose'], ['別名', aliasKey(ik, d.dh), 'loose'], ['旧', ik, 'loose'], ['位置', pageKeyAt(img, d), 'loose']];
    for (const [name, k, mode] of cands) {
      if (!k) continue;
      const v = cacheGet(k);
      if (!v) continue;
      let ok = mode === 'exact';
      if (!ok && name === 'URL') {
        // URLが同じ画像（NAVERなど）：見えない透かしで画素が少し変わっても、ざっくり同じなら同じ画像
        const tc = thumbClose(thumbGet(k), d.th);
        if (tc === true || (tc === null && itemsMatch(v, d) !== false)) ok = true;
      }
      if (!ok) {
        const im = itemsMatch(v, d); // 文字の部分を細かく比べる（いちばん確か）
        const tm = thumbMatch(thumbGet(k), d.th); // 画像全体をざっくり比べる
        if (im === false || tm === false) { r.why.push(name + '✕'); continue; }
        ok = im === true || tm === true || (tm === null && mode === 'loose');
        if (!ok) { r.why.push(name + '?'); continue; }
      }
      // 0件の保存は、v2.4より前だと「返事を止められた」失敗の可能性がある。確かめた印がなければ訳し直す
      if (Array.isArray(v) && !v.length && !store.get('ezc_e:' + k, null)) { r.why.push(name + '(0件)'); continue; }
      // 前の方式（1枚ずつ）で訳した訳のうち、画像の上下の端に接しているものは、境目で切れて半分しか訳せていない。
      // 隣に画像がつながっているなら、つないで読む方式で訳し直す（その画像だけ1回）
      const nb = neighbors(img);
      const cut = Array.isArray(v) && v.some((it) => !(it.v >= 8) && ((nb.prev && it.y < 0.08) || (nb.next && it.y + it.h > 0.92)));
      if (cut) { r.why.push('境目で切れた古い訳'); break; }
      r.hit = v; r.hitKey = k; r.how = name;
      break;
    }
    if (!r.hit && !r.why.length) r.why.push('保存なし');
    return r;
  }
  const closeD = (d) => { try { if (d && !d.keep && d.src && d.src.close) d.src.close(); } catch (e) { /* 閉じられなくてもよい */ } };
  // この画面で「保存から出した枚数／新しく翻訳した枚数（理由）」をまとめて知らせる
  const tally = { hit: 0, fresh: 0, why: {} };
  let tallyTimer = 0, tallyShown = '';
  function tallyUpdate() {
    clearTimeout(tallyTimer);
    tallyTimer = setTimeout(() => {
      if (queue.length || running || scanWait.length || scanBusy) return tallyUpdate();
      const why = Object.entries(tally.why).map(([k, n]) => `${k}${n}`).join('・');
      const msg = `保存から${tally.hit}枚表示／新しく${tally.fresh}枚翻訳` + (why ? `（${why}）` : '');
      if (msg !== tallyShown && (tally.hit || tally.fresh)) { tallyShown = msg; toast(msg); }
    }, 1500);
  }
  function finishHit(r) {
    tally.hit++; tallyUpdate();
    const { img, d, key, ik, uk, hit, hitKey, src } = r;
    img.dataset.ezcHow = '保存(' + r.how + ')';
    hIndexPut(d, key);
    thumbPut(key, d);
    if (key && hitKey !== key && store.get('ezc_e:' + hitKey, null)) store.set('ezc_e:' + key, 1);
    const enriched = enrichItems(hit, d);
    if (key && (enriched || !cacheGet(key))) cachePut(key, forSave(hit));
    setAlias(uk, key, d.dh); setAlias(ik, key, d.dh);
    pageRemember(img, d, key);
    addLines(hit);
    doneSrc.set(img, src);
    setBadge(img, null);
    showItems(img, hit);
    closeD(d);
    spillCover(img, hit);
  }
  // 画像の境目をまたぐ大きな文字：保存から出したときは、その画像の画素だけでは消し板が作れず、
  // となりの画像に原文が残ってしまう。となりの画像もつないで、はみ出した部分まで消し直す（API代なし）
  async function spillCover(img, items) {
    const out = (items || []).filter((it) => it && (it.y < -0.01 || it.y + it.h > 1.01) && isFree(it));
    if (!out.length) return;
    const nb = neighbors(img);
    const needP = out.some((it) => it.y < -0.01) && nb.prev, needN = out.some((it) => it.y + it.h > 1.01) && nb.next;
    if (!needP && !needN) return;
    let dA = null, dP = null, dN = null;
    try {
      dA = await getDrawable(img);
      if (needP) { try { dP = await getDrawable(nb.prev); } catch (e) { dP = null; } }
      if (needN) { try { dN = await getDrawable(nb.next); } catch (e) { dN = null; } }
      if (!dP && !dN) return;
      const W = dA.w, parts = [];
      let vy = 0;
      if (dP) { const vh = dP.h * (W / dP.w); parts.push({ d: dP, sy: 0, vy: 0, vh }); vy = vh; }
      const offY = vy;
      parts.push({ d: dA, sy: 0, vy, vh: dA.h }); vy += dA.h;
      if (dN) { const vh = dN.h * (W / dN.w); parts.push({ d: dN, sy: 0, vy, vh }); vy += vh; }
      const st = { W, H: vy, parts };
      for (const it of out) {
        try { delete it.cimg; delete it.crect; buildCover(it, st, W, dA.h, offY); } catch (e) { /* 作れなければそのまま */ }
      }
      const cur = lastItems.get(img);
      if (cur && img.isConnected) render(img, cur);
    } catch (e) { /* 読めない画像はそのまま */ } finally { [dA, dP, dN].forEach((d) => d && closeD(d)); }
  }
  function finishNew(r, items) {
    tally.fresh++;
    const w0 = (r.why[r.why.length - 1] || '保存なし').replace(/[✕?]$/, '');
    tally.why[w0] = (tally.why[w0] || 0) + 1;
    tallyUpdate();
    const { img, d, key, ik, uk, src } = r;
    doneSrc.set(img, src);
    cachePut(key, forSave(items));
    if (key) { if (!items.length) store.set('ezc_e:' + key, 1); else del('ezc_e:' + key); } // 本当に文字がなかった印
    hIndexPut(d, key);
    thumbPut(key, d);
    img.dataset.ezcHow = '新規翻訳（' + r.why.join('・') + '）';
    setAlias(uk, key, d.dh); setAlias(ik, key, d.dh);
    pageRemember(img, d, key);
    addLines(items);
    setBadge(img, null);
    if (forced.has(img)) { forceDone.add(img); forced.delete(img); }
    showItems(img, items);
  }

  // ---------- 前後の画像をつないで、まとめて読む ----------
  // 1枚ずつだと、画像の境目にかかった吹き出しが切れて読めない。
  // 上下にくっついた「まだ訳していない画像」をつないだ1枚（ストリップ）にして、上から順に読む。
  // 区切りの下の端で切れた文字があれば、次はその文字の上から読み直すので、どの文字も必ずどこかで丸ごと読める
  const needsScan = (p) => p && !scanning.has(p) && eligible(p) && (forced.has(p) || doneSrc.get(p) !== (p.currentSrc || p.src));
  async function scanRun(first) {
    const runs = [first];
    const rs = new Map([[first, null]]);
    // 上へ2枚・下へ6枚まで、まだ訳していない画像をつなぐ（保存があればそれを使って、そこで止める）
    for (const dir of ['prev', 'next']) {
      let cur = first;
      for (let n = 0; n < (dir === 'prev' ? 2 : 6); n++) {
        const p = neighbors(cur)[dir];
        if (!needsScan(p)) break;
        scanning.add(p);
        let r;
        try { r = await resolve(p); } catch (e) { scanning.delete(p); break; }
        if (r.hit) { scanning.delete(p); finishHit(r); break; }
        rs.set(p, r);
        if (dir === 'prev') runs.unshift(p); else runs.push(p);
        cur = p;
      }
    }
    return { runs, rs };
  }

  async function translateRun(runs, rs) {
    const W = rs.get(runs[0]).d.w;
    const tryD = async (o) => { try { return await getDrawable(o); } catch (e) { return null; } };
    const parts = [], spans = new Map();
    let vy = 0;
    const band = Math.round(W * 0.5);
    const ctxPrev = neighbors(runs[0]).prev, ctxNext = neighbors(runs[runs.length - 1]).next;
    // 前後の（もう訳してある）画像も丸ごとつなぐ。ふだん読むのは境目のまわりだけだが、
    // 何枚にもまたがる大きな文字は、そこまでさかのぼって（先まで）読み直せるように
    const pd = ctxPrev && await tryD(ctxPrev);
    if (pd) { const vh = pd.h * (W / pd.w); parts.push({ d: pd, sy: 0, vy: 0, vh }); vy = vh; }
    for (const img of runs) {
      const d = rs.get(img).d, vh = d.h * (W / d.w);
      parts.push({ d, sy: 0, vy, vh });
      spans.set(img, { vy, vh });
      vy += vh;
    }
    const nd = ctxNext && await tryD(ctxNext);
    if (nd) { const vh = nd.h * (W / nd.w); parts.push({ d: nd, sy: 0, vy, vh }); vy += vh; }
    const st = { W, H: vy, parts };
    const CH = Math.round(W * 2), EDGE = W * 0.015;
    const kept = [];
    const finished = new Set();
    const onWait = () => runs.forEach((img) => { if (!finished.has(img)) setBadge(img, '回数制限のため待機中…'); });
    const iouV = (p, q) => {
      const ix = Math.max(0, Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0)), iy = Math.max(0, Math.min(p.y1, q.y1) - Math.max(p.y0, q.y0)) / W;
      const A = (p.x1 - p.x0) * (p.y1 - p.y0) / W, B = (q.x1 - q.x0) * (q.y1 - q.y0) / W;
      return ix * iy / Math.max(1e-9, Math.min(A, B));
    };
    // その文字をどの画像が受け持つか：中心がある画像。中心が前後の（もう訳してある）画像にあっても、
    // 今回の画像にかかっていれば今回の画像が受け持つ（前後の画像の古い訳が半分だけのことがあるため。表示は完全な方だけ残る）
    const owner = (r) => {
      const cy = (r.y0 + r.y1) / 2;
      for (const img of runs) { const sp = spans.get(img); if (cy >= sp.vy && cy < sp.vy + sp.vh) return img; }
      let best = null, bo = 0;
      for (const img of runs) {
        const sp = spans.get(img), ov = Math.min(r.y1, sp.vy + sp.vh) - Math.max(r.y0, sp.vy);
        if (ov > bo) { bo = ov; best = img; }
      }
      return best;
    };
    // 読み終わった（それより上の文字が確定した）画像から順に表示する
    const flush = (upTo) => {
      for (const img of runs) {
        if (finished.has(img)) continue;
        const sp = spans.get(img);
        if (sp.vy + sp.vh > upTo) break;
        const items = [];
        for (const r of kept) {
          if (owner(r) !== img) continue;
          const it = makeItem(r, st, sp, rs.get(img).d);
          if (it) items.push(it);
        }
        finished.add(img);
        finishNew(rs.get(img), items);
      }
    };
    try {
      // ① ストリップを、重なりを持たせた区切りに分けて、同時に何本か送る（速さのため）
      const P = Math.max(1, Math.min(6, +S.parallel || 3));
      const STEP = CH - Math.round(W * 0.5); // 隣の区切りと幅の半分だけ重ねる
      const runTop = spans.get(runs[0]).vy, runBot = spans.get(runs[runs.length - 1]).vy + spans.get(runs[runs.length - 1]).vh;
      const startY = Math.max(0, Math.round(runTop - band)), endY = Math.min(st.H, Math.round(runBot + band));
      const plan = [];
      for (let y = startY; ; y += STEP) {
        const h = Math.min(CH, endY - y);
        plan.push({ y, h, last: y + h >= st.H - 1 }); // last：これより下に絵がない（下の端で切れることがない）
        if (y + h >= endY - 1) break;
      }
      const runForced = runs.some((p) => forced.has(p)), runPid = pid();
      const readChunk = async (c) => {
        // 途中で止めたら、残りの区切りは一時停止。再開したら続きから送る（読み終わった区切りはそのまま使う）
        if (!pageActive() && !(runForced && !forceHold)) await waitResume(runPid);
        return mergeRaw(normalizeRaw(await callGemini([await chunkToB64(st, c)], onWait), c), W);
      };
      const defs = plan.map(() => { let res, rej; const p = new Promise((a, b) => { res = a; rej = b; }); p.catch(() => {}); return { p, res, rej }; });
      let next = 0, active = 0, stop = false;
      const launch = () => {
        while (!stop && active < P && next < plan.length) {
          const i = next++;
          active++;
          readChunk(plan[i]).then(defs[i].res, defs[i].rej).finally(() => { active--; launch(); });
        }
      };
      launch();
      // 重なった2つの読み取りの文が違う（大きな文字が区切りで分かれ、それぞれ一部だけ読めた）ときは、
      // 長い方だけ残すと残りが消えてしまうので、2つを合わせた範囲を丸ごと読み直す
      const conflicts = [];
      const norm = (t) => String(t || '').replace(/[\s\-—―~～…\.!?！？、。,]/g, '');
      const addKept = (r) => {
        const di = kept.findIndex((k) => iouV(k, r) > 0.35);
        if (di >= 0) {
          const k = kept[di], a = norm(k.src), b = norm(r.src);
          if (a && b && !a.includes(b) && !b.includes(a)) {
            conflicts.push({ x0: Math.min(k.x0, r.x0), x1: Math.max(k.x1, r.x1), y0: Math.min(k.y0, r.y0), y1: Math.max(k.y1, r.y1) });
          }
          if (b.length > a.length) kept[di] = r; // 重なり部分の二重読み
        } else kept.push(r);
      };
      const fixedConflicts = new Set();
      const fixConflicts = async () => {
        for (let t = 0; t < 3 && conflicts.length; t++) {
          for (const u of conflicts.splice(0)) {
            const sig = [u.x0, u.x1, u.y0, u.y1].map((v) => Math.round(v / 8)).join(':');
            // 合わせた範囲をほぼ丸ごと含む読み取りがもうあれば読み直さない（半分だけのものは数えない）
            const whole = kept.some((k) => k.y0 <= u.y0 + EDGE && k.y1 >= u.y1 - EDGE && covers(k, u));
            if (fixedConflicts.has(sig) || whole) continue;
            fixedConflicts.add(sig);
            await repair(u);
          }
        }
      };
      // 切れていた文字(f)を、丸ごと読めた文字(k)が含んでいるか
      const covers = (k, f) => {
        const ix = Math.max(0, Math.min(k.x1, f.x1) - Math.max(k.x0, f.x0)) / Math.max(1e-6, f.x1 - f.x0);
        const iy = Math.max(0, Math.min(k.y1, f.y1) - Math.max(k.y0, f.y0)) / Math.max(1e-6, f.y1 - f.y0);
        return ix > 0.6 && iy > 0.6;
      };
      // ② どの区切りでも切れてしまった文字だけ、その文字のまわりを広めに読み直す（まれ）。
      //    読み直しでも上や下で切れていたら、その方向へ広げてもう一度（前後の画像までさかのぼれる。最大で幅の4倍）
      const repair = async (f) => {
        let top = f.y0, bot = f.y1;
        const tried = new Set();
        for (let t = 0; t < 4; t++) {
          const extra = Math.max(W * 0.3, (bot - top) * 0.2);
          let y0 = Math.max(0, Math.round(top - extra)), y1 = Math.min(st.H, Math.round(bot + extra));
          if (y1 - y0 < CH) { const grow = CH - (y1 - y0); y0 = Math.max(0, Math.round(y0 - grow / 2)); y1 = Math.min(st.H, y0 + CH); y0 = Math.max(0, y1 - CH); }
          if (y1 - y0 > W * 4) { const mid = (top + bot) / 2; y0 = Math.max(0, Math.round(mid - W * 2)); y1 = Math.min(st.H, y0 + Math.round(W * 4)); }
          const sig = y0 + ':' + y1;
          if (tried.has(sig)) return;
          tried.add(sig);
          const raw = await readChunk({ y: y0, h: y1 - y0 });
          let ok = false, upMore = false, downMore = false;
          for (const r of raw) {
            const cT = y0 > 0 && r.y0 <= y0 + EDGE, cB = y1 < st.H - 1 && r.y1 >= y1 - EDGE;
            if (!cT && !cB) { addKept(r); if (covers(r, f)) ok = true; continue; }
            // 切れたままの文字がこの文字と重なっていたら、切れている方向へ広げる
            const ov = Math.min(r.y1, f.y1) - Math.max(r.y0, f.y0) > 0 && Math.min(r.x1, f.x1) - Math.max(r.x0, f.x0) > 0;
            if (ov) { if (cT) upMore = true; if (cB) downMore = true; }
          }
          if (ok) return;
          if (!upMore && !downMore) return;
          if (upMore) top = Math.max(0, y0 - W);
          if (downMore) bot = Math.min(st.H, y1 + W);
        }
      };
      // ③ 上の区切りから順に結果を受け取って、確定したところから表示する
      let pendingCuts = [];
      const upCuts = [];
      try {
        for (let i = 0; i < plan.length; i++) {
          const c = plan[i];
          const raw = await defs[i].p;
          const cutsHere = [];
          for (const r of raw) {
            const cutB = !c.last && r.y1 >= c.y + c.h - EDGE; // 下の端で切れている → 次の区切りで丸ごと読めるはず
            const cutT = c.y > 0 && r.y0 <= c.y + EDGE;        // 上の端で切れている → 前の区切りで読めている（読めていなければ下で直す）
            if (cutT && i === 0) { upCuts.push(r); continue; } // 最初の区切りの上で切れた：前の画像から始まる文字
            if (cutB) { cutsHere.push(r); continue; }
            if (cutT) continue;
            addKept(r);
          }
          for (const f of upCuts.splice(0)) if (!kept.some((k) => covers(k, f))) await repair(f);
          for (const f of pendingCuts) if (!kept.some((k) => covers(k, f))) { await repair(f); if (!kept.some((k) => covers(k, f))) addKept(f); } // 読み直せなくても、切れた分は捨てずに出す
          await fixConflicts();
          pendingCuts = cutsHere;
          const frontier = Math.min(i + 1 < plan.length ? plan[i + 1].y : Infinity, ...cutsHere.map((f) => f.y0)); // 切れた文字の上までは確定
          flush(frontier);
        }
        for (const f of pendingCuts) if (!kept.some((k) => covers(k, f))) { await repair(f); if (!kept.some((k) => covers(k, f))) addKept(f); }
        await fixConflicts();
      } finally { stop = true; }
      flush(Infinity);
    } finally {
      for (const p of parts) closeD(p.d);
    }
  }

  // 保存から探すのは並行でやる。翻訳（つないで読む）は1か所ずつ順番に：
  // 2か所で同時にやると、その間の境目で長い文字が分断されてしまうため
  const scanWait = [];
  let scanBusy = false;
  function requestScan(img, r) {
    if (!scanWait.some((x) => x.img === img)) scanWait.push({ img, r });
    setBadge(img, '翻訳待ち…');
    updateButton();
    runScanLoop();
  }
  async function runScanLoop() {
    if (scanBusy) return;
    scanBusy = true;
    updateButton();
    try {
      while (scanWait.length) {
        let { img, r } = scanWait.shift();
        const src = img.currentSrc || img.src;
        // 止めたら順番待ちも一時停止。再開したらそのまま送る。別の話に移ったら待つのをやめる
        if (!pageActive() && !forceRun(img)) {
          try { await waitResume(pid()); } catch (e) { waiting.add(img); setBadge(img, null); continue; }
        }
        if (!img.isConnected || (doneSrc.get(img) === src && !forced.has(img))) continue; // 前のまとまりで訳し済み
        let runs = [img];
        try {
          scanning.add(img);
          if (!r || r.src !== src) { r = await resolve(img); if (r.hit) { finishHit(r); continue; } }
          const sr = await scanRun(img);
          sr.rs.set(img, r);
          runs = sr.runs;
          for (const p of runs) { const i = scanWait.findIndex((x) => x.img === p); if (i >= 0) scanWait.splice(i, 1); }
          runs.forEach((p) => setBadge(p, '翻訳中…'));
          updateButton();
          await translateRun(runs, sr.rs);
        } catch (e) {
          if (e && e.message === '止めました') { // 止めただけ：失敗扱いにせず、次にボタンを押したら続きから
            for (const p of runs) { if (doneSrc.get(p) !== (p.currentSrc || p.src)) { waiting.add(p); setBadge(p, null); } }
            continue;
          }
          for (const p of runs) {
            if (doneSrc.get(p) === (p.currentSrc || p.src) && !forced.has(p)) continue; // 表示まで済んだ画像はそのまま
            failedAt.set(p, Date.now()); // 失敗した画像は、スクロールのたびに自動で再挑戦しない（API代の節約）。タップで再試行
            setBadge(p, '失敗：' + (e.message || e) + '（タップで再試行）', () => { setBadge(p, null); failedAt.delete(p); activate(); enqueue(p, true); });
          }
          if (/APIキー/.test(e.message)) toast(e.message);
        } finally {
          for (const p of runs) scanning.delete(p);
          scanning.delete(img);
          updateButton();
        }
      }
    } finally {
      scanBusy = false;
      updateButton();
    }
  }

  async function pump() {
    while (running < MAX_PAR && queue.length) {
      const img = queue.shift();
      queued.delete(img);
      if (scanning.has(img) || scanWait.some((x) => x.img === img)) continue; // 翻訳待ち・翻訳中
      running++;
      updateButton();
      (async () => {
        try {
          const r = await resolve(img);
          if (r.hit) finishHit(r);
          else if (pageActive() || forced.has(img)) requestScan(img, r);
          else { waiting.add(img); waitSrc.set(img, img.currentSrc || img.src); doneSrc.delete(img); } // ボタンを押すまで待つ
        } catch (e) {
          // ボタンを押す前（保存の表示だけ）の失敗は黙って待つ。押したときにもう一度試す
          if (!pageActive() && !forced.has(img) && !S.debug) { waiting.add(img); waitSrc.set(img, img.currentSrc || img.src); }
          else {
            failedAt.set(img, Date.now());
            setBadge(img, '失敗：' + (e.message || e) + '（タップで再試行）', () => { setBadge(img, null); failedAt.delete(img); activate(); enqueue(img, true); });
          }
        } finally {
          running--;
          updateButton();
          pump();
        }
      })();
    }
  }

  /* ---------------- 画像の監視 ---------------- */
  const io = new IntersectionObserver((ents) => {
    if (!isOn()) return;
    for (const e of ents) {
      if (!e.isIntersecting || !eligible(e.target)) continue;
      // 翻訳中でないとき（保存した訳を出すだけ）は、画面の近くの画像だけ読む。先の画像まで読み込むとサイトの表示が遅くなるため
      if (!pageActive() && e.boundingClientRect.top > innerHeight * 1.5) continue;
      enqueue(e.target, pageForce && !forceDone.has(e.target));
    }
  }, { rootMargin: '0px 0px 2000px 0px' });

  const watched = new WeakSet();
  function watch(img) {
    if (watched.has(img)) return;
    watched.add(img);
    io.observe(img);
    img.addEventListener('load', () => {
      const ov = overlays.get(img);
      const src = img.currentSrc || img.src;
      if (doneSrc.has(img) && doneSrc.get(img) !== src) {
        // 同じ<img>に別の画像が入った（読み込み直し・使い回し）：前の訳を消して、境目の重複チェックからも外す
        if (ov) ov.querySelectorAll('.ezc-b, .ezc-c, .ezc-dbgl').forEach((n) => n.remove());
        allItems.delete(img); lastItems.delete(img); failedAt.delete(img);
      }
      if (isOn() && eligible(img)) { io.unobserve(img); io.observe(img); }
    });
  }
  document.querySelectorAll('img').forEach(watch);
  new MutationObserver((muts) => {
    for (const m of muts) {
      m.addedNodes.forEach((n) => {
        if (n.nodeType !== 1) return;
        if (n.tagName === 'IMG') watch(n);
        else if (n.querySelectorAll) n.querySelectorAll('img').forEach(watch);
      });
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  // 確認モード：画面に見えている漫画が <img> か canvas かを知らせる（canvas だと読めない）
  function diagnose() {
    const vh = innerHeight;
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.bottom > 0 && r.top < vh && r.width > 150 && r.height > 100; };
    const imgs = [...document.images].filter(vis);
    const ok = imgs.filter((i) => eligible(i)).length;
    const cvs = [...document.querySelectorAll('canvas')].filter(vis).length;
    const bgs = [...document.querySelectorAll('div,section,figure')].filter((e) => vis(e) && /url\(/.test(getComputedStyle(e).backgroundImage)).length;
    toast(`確認：画像${imgs.length}枚（対象${ok}）／canvas ${cvs}／背景画像 ${bgs}`);
  }

  function translateVisibleNow() {
    const vh = innerHeight, reach = pageActive() ? 2 : 1.5;
    document.querySelectorAll('img').forEach((img) => {
      const r = img.getBoundingClientRect();
      if (r.bottom > 0 && r.top < vh * reach && eligible(img)) enqueue(img);
    });
  }
  // 翻訳中でないときは、スクロールで近づいた画像の保存した訳を、その都度出す
  let nearTimer = 0;
  addEventListener('scroll', () => {
    if (!isOn() || pageActive()) return;
    clearTimeout(nearTimer);
    nearTimer = setTimeout(translateVisibleNow, 250);
  }, { passive: true });

  /* ---------------- ボタン・設定画面 ---------------- */
  const isOn = () => !!GM_getValue(wtKey(), false); // WTモードのサイト
  // 翻訳（API）は、そのページでWTボタンを押してから。保存してある訳は押さなくても表示する
  let activePage = '';
  // 話の見分け：URLのパス＋話を表す項目だけ（NAVERは ?titleId=…&no=… で話が変わる。読む位置などの項目は無視）
  const PID_Q = /^(no|titleid|ep|episode|episodeid|episode_id|chapter|chapterid|seq|vol|volume|id|bookid|book_id|productid|product_id)$/i;
  const pid = () => { const q = [...new URLSearchParams(location.search)].filter(([k]) => PID_Q.test(k)).map(([k, v]) => k + '=' + v).join('&'); return location.host + location.pathname + (q ? '?' + q : ''); };
  const pageActive = () => activePage === pid();
  const waiting = new Set(); // 保存がなくて、ボタン待ちの画像
  const waitSrc = new WeakMap(); // ボタン待ちになったときの画像のURL（同じなら、スクロールのたびに調べ直さない）
  // 一時停止：再開（同じページでもう一度押す）まで待つ。別の話に移ったら待つのをやめる
  async function waitResume(myPid) {
    while (!pageActive()) {
      if (pid() !== myPid) throw new Error('止めました');
      await sleep(400);
    }
  }
  let origPage = ''; // 原文に戻したページ
  let syncPid = '';
  const showOrig = (v) => { origPage = v ? pid() : ''; document.documentElement.classList.toggle('ezc-off', !!v); };
  // 訳し直し・再試行など、手で頼んだ翻訳も「翻訳中」として扱う（ボタンが回り、押せば一時停止できる）
  function activate() { showOrig(false); activePage = pid(); }
  let redoing = false, forceHold = false; // 訳し直し中（ページ全体の翻訳はオンにしない）／止めたら訳し直しも一時停止
  const forceRun = (img) => forced.has(img) && !forceHold;
  function togglePage() {
    // 翻訳中に押したら：止めて原文に戻す（小説の「原」と同じ）
    if (pageActive() || (redoing && !forceHold)) { activePage = ''; pageForce = false; redoing = false; forceHold = true; showOrig(true); toast('原文に戻した'); updateButton(); return; }
    forceHold = false;
    if (!keyOf()) { openPanel(); toast('先にGeminiのAPIキーを入れてね'); return; }
    showOrig(false);
    activePage = pid();
    toast('このページを翻訳する');
    const list = [...waiting].filter((img) => img.isConnected); waiting.clear();
    list.forEach((img) => enqueue(img));
    translateVisibleNow();
    updateButton();
  }
  function setOn(v) {
    origPage = '';
    if (!v) { activePage = ''; waiting.clear(); }
    document.documentElement.classList.toggle('ezc-off', !v);
    if (v) translateVisibleNow(); // 保存してある訳だけ表示（翻訳はボタンを押してから）
    updateButton();
  }

  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
<style>
  :host{all:initial}
  *{box-sizing:border-box;font-family:system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif}
  .fab{position:fixed;width:54px;height:54px;border-radius:50%;border:2px solid #2b2d42;background:#fff;color:#2b2d42;
    font-weight:800;font-size:17px;display:flex;align-items:center;justify-content:center;box-shadow:0 3px 10px rgba(0,0,0,.28);
    touch-action:none;user-select:none;-webkit-user-select:none;opacity:.9}
  .fab.on{background:#2b2d42;color:#fff}
  .fab.busy::before{content:"";position:absolute;inset:-5px;border-radius:50%;border:3px solid rgba(84,101,232,.18);border-top-color:#5465e8;animation:ezc-spin .8s linear infinite}
  @keyframes ezc-spin{to{transform:rotate(360deg)}}
  .fab .n{position:absolute;top:-4px;right:-4px;min-width:18px;height:18px;border-radius:9px;background:#ef476f;color:#fff;font-size:11px;
    line-height:18px;text-align:center;padding:0 4px}
  .fab .n[hidden]{display:none}
  .sheet{position:fixed;left:0;right:0;bottom:0;max-height:88vh;overflow:auto;background:#fff;color:#1c1c24;border-radius:16px 16px 0 0;
    padding:18px 16px calc(18px + env(safe-area-inset-bottom,0px));box-shadow:0 -6px 24px rgba(0,0,0,.25);font-size:14px}
  .sheet[hidden]{display:none}
  h2{margin:0 0 12px;font-size:16px}
  h3{margin:20px 0 4px;font-size:14px;border-top:1px solid #c9cbd6;padding-top:14px}
  label{display:block;margin:12px 0 4px;font-weight:600;font-size:13px}
  input[type=text],input[type=password],input[type=number],select,textarea{width:100%;padding:9px 10px;border:1px solid #c9cbd6;border-radius:8px;font-size:14px;background:#fff;color:inherit}
  textarea{min-height:72px;resize:vertical}
  .row{display:flex;gap:8px;align-items:center;margin-top:12px}
  .row label{margin:0;font-weight:500}
  .hint{color:#6b6e7f;font-size:12px;margin-top:3px}
  .btns{display:flex;gap:8px;margin-top:16px;flex-wrap:wrap}
  button{padding:10px 14px;border-radius:8px;border:1px solid #2b2d42;background:#fff;color:#2b2d42;font-weight:700;font-size:14px}
  button.pri{background:#2b2d42;color:#fff}
  .toast{position:fixed;left:50%;top:calc(env(safe-area-inset-top,0px) + 12px);transform:translateX(-50%);background:rgba(24,28,40,.78);color:#fff;
    padding:7px 13px;border-radius:999px;font-size:12px;font-weight:500;max-width:80vw;width:max-content;box-shadow:0 4px 14px rgba(0,0,0,.18);
    backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);pointer-events:none}
  .toast[hidden]{display:none}
  @media (prefers-color-scheme: dark){
    .sheet{background:#1e1f26;color:#ececf1}
    input[type=text],input[type=password],input[type=number],select,textarea{background:#2a2b33;border-color:#444756}
    button{background:#2a2b33;color:#ececf1;border-color:#6b6e7f}
    button.pri{background:#ececf1;color:#1e1f26}
    .hint{color:#9a9db0}
  }
</style>
<div class="fab" id="fab" role="button" aria-label="吹き出し翻訳（WT）">WT<span class="n" id="n" hidden></span></div>
<div class="sheet" id="sheet" hidden>
  <h2>まんが吹き出し翻訳</h2>
  <label for="k">Gemini APIキー（空欄なら小説翻訳の設定のキーを使う）</label>
  <input type="password" id="k" autocomplete="off">
  <label for="m">モデル（混雑時は左から順に切り替え）</label>
  <input type="text" id="m">
  <label for="t">訳す言語</label>
  <input type="text" id="t">
  <label for="v">縦書き</label>
  <select id="v"><option value="auto">縦長の吹き出しは縦書き</option><option value="off">常に横書き</option></select>
  <label for="ts">文字の大きさ：<span id="tsv"></span>%</label>
  <input type="range" id="ts" min="70" max="130" step="5" style="width:100%">
  <label for="am2">絵の上の文字の隠し方</label>
  <select id="am2"><option value="erase">文字の形だけ消す（絵が残る）</option><option value="label">白い札で隠す（読みやすい）</option></select>
  <label for="fnt">セリフの文字</label>
  <select id="fnt"><option value="manga">漫画風（かなは明朝・漢字はゴシック）</option><option value="gothic">ゴシック（原文に近い）</option><option value="maru">丸ゴシック（やわらかい）</option></select>
  <div class="row"><input type="checkbox" id="sfx"><label for="sfx">効果音も訳す</label></div>
  <label for="g">全作品共通の固定訳（1行に1つ）</label>
  <textarea id="g" placeholder="김독자 = キム・ドクチャ&#10;유중혁 = ユ・ジュンヒョク"></textarea>
  <label for="par">同時に送る数（多いほど速い。無料枠だと回数制限に当たりやすい）</label>
  <input type="number" id="par" min="1" max="6">
  <label for="min">無視する小さい画像（px未満）</label>
  <input type="number" id="min" min="50" step="10">
  <div class="row"><input type="checkbox" id="dbg"><label for="dbg">確認モード（読んだ画像をピンクの点線、見つけた文字を青枠で表示）</label></div>
  <h3 id="wn">この作品</h3>
  <label for="memo">翻訳メモ（人物の訳名・性別・一人称・口調、用語。作品ごと）</label>
  <textarea id="memo" style="min-height:120px" placeholder="김독자=キム・ドクチャ｜男｜俺｜ぶっきらぼう"></textarea>
  <div class="row"><input type="checkbox" id="am"><label for="am">訳した内容からメモを自動で更新</label></div>
  <div class="hint" id="memost"></div>
  <label for="story">これまでのあらすじ（自動。直してもOK）</label>
  <textarea id="story" style="min-height:90px"></textarea>
  <div class="btns"><button id="memoNow">今すぐメモを更新</button></div>
  <div class="btns">
    <button id="wex">この作品を書き出す</button>
    <button id="wclr">この作品の記録を消す</button>
  </div>
  <h3>訳の記録・バックアップ（全作品）</h3>
  <label for="gt">クラウドに自動バックアップ（GitHubのトークン。空欄なら小説翻訳の設定のトークンを使う）</label>
  <input type="password" id="gt" autocomplete="off" placeholder="github_pat_… / ghp_…">
  <div class="row"><input type="checkbox" id="ab"><label for="ab">訳が増えたら自動でクラウドに保存</label></div>
  <div class="btns">
    <button id="cs">クラウドに保存</button>
    <button id="cl">クラウドから戻す</button>
    <button id="ex">ファイルに書き出す</button>
    <button id="im">ファイルを読み込む</button>
    <input type="file" id="imf" accept=".json,application/json" hidden>
  </div>
  <div class="hint">ボタンのタップ＝このサイトで翻訳ON/OFF、長押し＝この画面、ドラッグ＝移動。訳をタップすると原文が見える。</div>
  <div class="btns">
    <button class="pri" id="save">保存</button>
    <button id="redo">この画面を訳し直す</button>
    <button id="redoAll">この話を全部訳し直す</button>
    <button id="clr">保存した訳を全部消す</button>
    <button id="close">閉じる</button>
  </div>
</div>
<div class="toast" id="toast" hidden></div>`;
  document.documentElement.appendChild(host);
  host.style.display = 'none'; // 漫画の画像が見つかるまでは出さない
  wtApi = {
    // 漫画のページ：大きな画像が画面の半分以上をうめている。一度そうなったら同じページの間はWTのまま（スクロールでちらつかない）
    hasImages: () => {
      const id = location.host + location.pathname;
      if (wtSeenPage === id) return true;
      const vh = innerHeight, vw = innerWidth;
      let area = 0;
      for (const img of document.images) {
        if (!eligible(img)) continue;
        const r = img.getBoundingClientRect();
        const h = Math.max(0, Math.min(vh, r.bottom) - Math.max(0, r.top)), w = Math.max(0, Math.min(vw, r.right) - Math.max(0, r.left));
        area += h * w;
      }
      if (area >= vw * vh * 0.5) { wtSeenPage = id; return true; }
      return false;
    },
    show: (v) => { host.style.display = v ? '' : 'none'; },
    setOn: (v) => setOn(v),
    // 別の話に移ったら、原文表示を解除（保存してある訳はまた最初から出す）
    sync: () => {
      if (syncPid !== pid()) { syncPid = pid(); pageForce = false; } // 別の話に移ったら「全部訳し直す」は終わり
      if (origPage && origPage !== pid()) { showOrig(false); if (isOn()) translateVisibleNow(); }
    },
    // 設定画面（小説と同じ画面のWTタブ）との受け渡し：元の設定欄に値を入れて、元の処理をそのまま使う
    load: () => {
      fillPanel();
      const o = {};
      ['k', 'm', 't', 'v', 'ts', 'am2', 'fnt', 'g', 'par', 'min', 'memo', 'story', 'gt'].forEach((k) => { o[k] = $(k).value; });
      ['sfx', 'dbg', 'am', 'ab'].forEach((k) => { o[k] = $(k).checked; });
      o.wn = $('wn').textContent; o.memost = $('memost').textContent;
      return o;
    },
    put: (o) => {
      ['k', 'm', 't', 'v', 'ts', 'am2', 'fnt', 'g', 'par', 'min', 'memo', 'story', 'gt'].forEach((k) => { if (o[k] != null) $(k).value = o[k]; });
      ['sfx', 'dbg', 'am', 'ab'].forEach((k) => { if (o[k] != null) $(k).checked = !!o[k]; });
    },
    save: (o) => { wtApi.put(o); $('save').onclick(); },
    act: (name, o) => { wtApi.put(o); const b = $(name); if (b && b.onclick) b.onclick(); },
    preview: (v) => { $('ts').value = v; $('ts').oninput(); },
    importText: (t) => importData(t),
    // 小説のボタンの「訳」の位置に重ねる
    // ⚙と同じ基準（画面の左上から）で置く。右下基準だと、スマホのアドレスバーの出し入れで画面の高さが変わったときにずれるため
    placeAt: (r) => { fab.style.right = 'auto'; fab.style.bottom = 'auto'; fab.style.left = Math.round(r.left) + 'px'; fab.style.top = Math.round(r.top) + 'px'; },
  };

  const $ = (id) => root.getElementById(id);
  const fab = $('fab');

  let toastTimer;
  // いつもの動き（翻訳開始・原文に戻す・保存から表示など）はボタンの見た目で分かるので出さない。確認モードのときだけ出す
  const QUIET = /^(このページを翻訳する|原文に戻した|保存した$|翻訳メモを更新(中…|した)|保存から\d+枚表示)/;
  function toast(msg) {
    if (QUIET.test(String(msg)) && !S.debug) return;
    if (ui.isOpen()) return ui.toast(String(msg), 3000); // 設定画面を開いている間はWTの表示が隠れるので、設定画面側に出す
    const t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 2600);
  }

  function updateButton() {
    fab.classList.toggle('on', pageActive());
    const n = queue.length + running + scanWait.length + (scanBusy ? 1 : 0);
    if (!n) redoing = false;
    fab.classList.toggle('busy', n > 0 && (pageActive() || (redoing && !forceHold))); // 翻訳中はボタンのまわりがくるくる回る
    $('n').hidden = n === 0 || !S.debug; // 残りの枚数は確認モードのときだけ
    $('n').textContent = n;
  }
  function applyPos() {
    fab.style.right = S.pos.right + 'px';
    fab.style.bottom = S.pos.bottom + 'px';
  }
  applyPos();

  function openPanel() { ui.openSettings('wt'); } // 設定は小説と同じ画面（WTタブ）に出す
  function fillPanel() {
    $('k').value = S.apiKey; $('m').value = S.models; $('t').value = S.target;
    $('ts').value = S.textScale || 100; $('tsv').textContent = $('ts').value;
    $('fnt').value = S.font; $('am2').value = S.artMode || 'erase'; $('v').value = S.vertical; $('sfx').checked = S.sfx; $('g').value = S.glossary; $('min').value = S.minSize; $('par').value = S.parallel || 3; $('dbg').checked = S.debug;
    $('gt').value = S.gistToken; $('ab').checked = S.autoBackup;
    const w = getWork();
    const eps = Object.keys(w.eps || {}).length;
    $('wn').textContent = `この作品：${w.name}${eps ? `（${eps}話ぶん記録）` : ''}`;
    $('memo').value = w.memo || ''; $('am').checked = S.autoMemo; $('story').value = w.story || '';
    const pend = pendingMemoLines();
    $('memost').textContent = (w.memoAt ? `最終更新：${new Date(w.memoAt).toLocaleString()}` : 'まだ一度も更新されていない')
      + `／未反映のセリフ：${pend}行` + (w.memoErr ? `／前回の失敗：${w.memoErr}` : '');
  }
  $('save').onclick = () => {
    S.apiKey = $('k').value.trim();
    S.models = $('m').value.trim() || DEFAULTS.models;
    S.target = $('t').value.trim() || '日本語';
    S.textScale = +$('ts').value || 100;
    overlays.forEach((ov) => { ov.dataset.fitted = '0'; fitAll(ov); });
    const artChanged = (S.artMode || 'erase') !== $('am2').value;
    S.artMode = $('am2').value;
    if (artChanged) overlays.forEach((ov, img) => { doneSrc.delete(img); enqueue(img); });
    const fontChanged = S.font !== $('fnt').value;
    S.font = $('fnt').value;
    if (fontChanged) overlays.forEach((ov, img) => { doneSrc.delete(img); enqueue(img); });
    S.vertical = $('v').value; S.sfx = $('sfx').checked; S.glossary = $('g').value;
    S.minSize = Math.max(50, parseInt($('min').value, 10) || DEFAULTS.minSize);
    S.parallel = Math.min(6, Math.max(1, parseInt($('par').value, 10) || 3));
    const dbgChanged = S.debug !== $('dbg').checked;
    S.debug = $('dbg').checked;
    // 表示だけ変えるときは保存済みの訳から描き直す（API代なし）
    if (dbgChanged) overlays.forEach((ov, img) => { doneSrc.delete(img); enqueue(img); });
    if (S.debug) setTimeout(diagnose, 600);
    S.gistToken = $('gt').value.trim(); S.autoBackup = $('ab').checked; S.autoMemo = $('am').checked;
    saveS();
    const w = getWork();
    if ((w.memo || '') !== $('memo').value.trim() || (w.story || '') !== $('story').value.trim()) { w.memo = $('memo').value.trim(); w.story = $('story').value.trim(); putWork(w); }
    $('sheet').hidden = true;
    toast('保存した');
    if (isOn()) translateVisibleNow();
  };
  $('close').onclick = () => ($('sheet').hidden = true);
  // 動かしている間もその場で大きさを確認できる
  $('ts').oninput = () => { $('tsv').textContent = $('ts').value; S.textScale = +$('ts').value; overlays.forEach((ov) => { ov.dataset.fitted = '0'; fitAll(ov); }); };
  $('clr').onclick = () => {
    if (!confirm('全作品の保存した訳を全部消す？（クラウドのバックアップは残る）')) return;
    cacheClear(); toast('保存した訳を全部消した');
  };
  const saveGist = () => { S.gistToken = $('gt').value.trim(); S.autoBackup = $('ab').checked; saveS(); };
  $('cs').onclick = () => { saveGist(); backupNow(true); };
  $('cl').onclick = () => { saveGist(); restoreFromCloud(); };
  $('ex').onclick = () => exportData();
  $('wex').onclick = () => exportData(wkh());
  $('memoNow').onclick = () => {
    const w = getWork(); // 手で書き換えた内容を先に保存してから
    if ((w.memo || '') !== $('memo').value.trim() || (w.story || '') !== $('story').value.trim()) { w.memo = $('memo').value.trim(); w.story = $('story').value.trim(); putWork(w); }
    updateMemo(true);
  };
  $('wclr').onclick = () => {
    if (!confirm(`「${getWork().name}」の訳・話の記録・メモを消す？`)) return;
    toast(`この作品の記録を消した（${workClear(wkh())}件）`);
  };
  $('im').onclick = () => $('imf').click();
  $('imf').onchange = async () => {
    const f = $('imf').files[0];
    if (f) importData(await f.text());
    $('imf').value = '';
  };
  $('redoAll').onclick = () => {
    const imgs = [...document.images].filter((img) => eligible(img));
    if (!confirm(`この話の画像を全部訳し直す？（今読み込まれている${imgs.length}枚＋この後読み込まれる分。API代がかかる）`)) return;
    $('sheet').hidden = true;
    showOrig(false); forceHold = false; redoing = true; pageForce = true;
    imgs.forEach((img) => { if (!forceDone.has(img)) enqueue(img, true); });
  };
  $('redo').onclick = () => {
    $('sheet').hidden = true;
    showOrig(false); forceHold = false; redoing = true;
    const vh = innerHeight;
    document.querySelectorAll('img').forEach((img) => {
      const r = img.getBoundingClientRect();
      if (r.bottom > 0 && r.top < vh && eligible(img)) enqueue(img, true);
    });
  };

  // タップ / 長押し / ドラッグ
  let pd = null, lpTimer = null;
  fab.addEventListener('pointerdown', (e) => {
    fab.setPointerCapture(e.pointerId);
    pd = { x: e.clientX, y: e.clientY, r: S.pos.right, b: S.pos.bottom, moved: false, long: false };
    ui.dockDrag.start();
    lpTimer = setTimeout(() => { if (pd && !pd.moved) { pd.long = true; openPanel(); } }, 550);
  });
  fab.addEventListener('pointermove', (e) => {
    if (!pd) return;
    const dx = e.clientX - pd.x, dy = e.clientY - pd.y;
    if (!pd.moved && Math.hypot(dx, dy) > 10) { pd.moved = true; clearTimeout(lpTimer); }
    if (pd.moved) ui.dockDrag.move(dx, dy); // ⚙と一緒に動く（位置は小説のボタンと共通）
  });
  fab.addEventListener('pointerup', () => {
    clearTimeout(lpTimer);
    if (!pd) return;
    if (pd.moved) ui.dockDrag.end();
    else if (!pd.long) togglePage();
    pd = null;
  });
  fab.addEventListener('pointercancel', () => { clearTimeout(lpTimer); pd = null; });

  document.documentElement.classList.toggle('ezc-off', !isOn());
  updateButton();
  if (isOn()) translateVisibleNow();
  if (S.debug) setTimeout(diagnose, 3000);
  }
  if (GM_getValue(wtKey(), false)) startWT(false);
})();

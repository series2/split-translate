// ページ側（原文）のスクリプト。isolated world に常駐し、
//  - 本文ブロックの抽出（要素を index で保持）
//  - ページの複製（右側に表示するミラー用 HTML）の作成
//  - ホバー検知 → サイドパネルへ通知 / パネルからの指示でハイライト
//  - スクロール位置（先頭に見えているブロック）の相互同期
// を担当する。多重注入されても 1 回だけ初期化する。（compose.js を先に注入しておくこと）
(() => {
  if (window.__splitTranslate) return;

  // section は div と同じ扱い: 中に他のブロックを持たなければ葉として拾う（div/section 以外の
  // 汎用コンテナに文章が直書きされることは稀なので、他は STRUCT_SEL 止まりで十分）
  const BLOCK_SEL = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,figcaption,dt,dd,td,th,summary,caption,div,section';
  const GENERIC_TAGS = new Set(['div', 'section']); // 短すぎる文字列を誤って拾わないよう、長さの下限を上げる対象
  // 中にこれらがあるブロックは「構造を持つ入れ物」なので、訳文で中身を作り直せない → 末端側で拾う
  const STRUCT_SEL = 'ul,ol,table,thead,tbody,tfoot,tr,section,article,header,footer,nav,aside,main,form,fieldset,figure,details,dl,pre,address,menu,hgroup';
  const EXCLUDE_SEL =
    'nav,footer,aside,script,style,noscript,form,textarea,[role=navigation],[role=banner],[role=contentinfo],[aria-hidden=true]';
  const MAX_BLOCKS = 600;
  const MAX_CHARS = 250000;

  let docId = null;
  let elems = [];
  let indexOf = new Map();
  let hlEl = null;
  let lastHover = null;
  let userDriven = false; // ユーザー自身がページをスクロールしているときだけパネルへ送る
  let rafPending = false;
  let mainScroller = null; // 本文をスクロールさせている要素（null = ウィンドウ）
  let syncable = []; // スクロール位置合わせに使えるブロックか（固定/sticky や別スクロール領域は除外）

  const send = (msg) => {
    try {
      chrome.runtime.sendMessage({ ...msg, docId }).catch(() => {});
    } catch {
      /* 拡張機能の再読み込み直後などは無視 */
    }
  };

  // -------------------------------------------------------------------------
  // 抽出
  // -------------------------------------------------------------------------
  function extract(id) {
    setHighlight(null);
    docId = id;
    elems = [];
    indexOf = new Map();
    lastHover = null;

    // 本文コンテナは常に body 全体にする。かつては最も文字数の多い article/main に絞っていたが、
    // その場合「本文（記事）」と「クイズ／タスク一覧」のように文字数の偏った兄弟セクションがあると、
    // 少ない方が丸ごと対象外になってしまう（EXCLUDE_SEL で nav/footer/aside 等は別途除外している）。
    const root = document.body;

    const blocks = [];
    let chars = 0;
    for (const el of root.querySelectorAll(BLOCK_SEL)) {
      if (blocks.length >= MAX_BLOCKS || chars >= MAX_CHARS) break;
      if (el.closest(EXCLUDE_SEL)) continue;
      const header = el.closest('header');
      if (header && !header.closest('article, main')) continue;
      if (el.querySelector(`${BLOCK_SEL},${STRUCT_SEL}`)) continue; // 入れ子は末端側で拾う
      if (el.getClientRects().length === 0) continue;

      const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
      const tag = el.tagName.toLowerCase();
      if (!/\p{L}/u.test(text)) continue;
      if (GENERIC_TAGS.has(tag) ? text.length < 15 : text.length < 2) continue;

      // 訳文を元の構造（リンク・画像など）に差し込むための情報（compose.js）。
      //   m: plain | parts | marks / w: 囲み要素の文言（複製側で構造が一致するかの確認に使う）
      const plan = PlamoCompose.plan(el.childNodes);
      const block = { tag, text, m: plan.mode, w: plan.wraps };
      if (plan.mode === 'parts') {
        block.parts = plan.parts;
        block.text = plan.parts.join(' ');
      } else if (plan.mode === 'marks') {
        block.marked = plan.marked;
        block.markCount = plan.markCount;
      }

      indexOf.set(el, blocks.length);
      elems.push(el);
      blocks.push(block);
      chars += text.length;
    }

    computeScrollInfo();
    return { id, title: document.title, url: location.href, lang: document.documentElement.lang || '', blocks };
  }

  window.__splitTranslate = { extract };

  // -------------------------------------------------------------------------
  // スクロール位置合わせに使えるブロックの判定
  //   固定ヘッダー・sticky なサイドバーなどは、スクロールしても常に画面内にあるため
  //   「先頭に見えているブロック」として拾うと、相手側が常に先頭へ飛んでしまう。
  // -------------------------------------------------------------------------
  function computeScrollInfo() {
    ({ mainScroller, syncable } = ScrollSync.detect(document, window, elems));
  }

  const scrollTop0 = () => (mainScroller ? mainScroller.getBoundingClientRect().top : 0);

  function nextSyncable(i) {
    for (let k = i; k < elems.length; k++) if (syncable[k]) return k;
    for (let k = i - 1; k >= 0; k--) if (syncable[k]) return k;
    return -1;
  }

  // -------------------------------------------------------------------------
  // ページの複製（右側のミラー用）
  //   スクリプトは除去し、CSS・画像・リンクはそのまま残す。ブロック要素には data-st-i を付ける。
  // -------------------------------------------------------------------------
  function ruleText(sheet) {
    try {
      return Array.from(sheet.cssRules, (r) => r.cssText).join('\n');
    } catch {
      return ''; // クロスオリジンのシートは読めない（<link> のまま残るので問題ない）
    }
  }

  function snapshot() {
    elems.forEach((el, i) => el.setAttribute('data-st-i', i));
    let clone;
    try {
      clone = document.documentElement.cloneNode(true);
    } finally {
      elems.forEach((el) => el.removeAttribute('data-st-i'));
    }

    // CSSOM にしか存在しないスタイル（CSS-in-JS など）をテキストとして書き出す
    const liveStyles = document.querySelectorAll('style');
    const cloneStyles = clone.querySelectorAll('style');
    liveStyles.forEach((s, k) => {
      const c = cloneStyles[k];
      if (c && !c.textContent.trim() && s.sheet) c.textContent = ruleText(s.sheet);
    });
    const adopted = Array.from(document.adoptedStyleSheets || [], ruleText).join('\n');

    clone
      .querySelectorAll(
        'script,noscript,template,iframe,frame,frameset,object,embed,base,meta[http-equiv],' +
          'link[rel~=preload],link[rel~=prefetch],link[rel~=modulepreload],link[rel~=dns-prefetch],link[rel~=preconnect]'
      )
      .forEach((n) => n.remove());

    let head = clone.querySelector('head');
    if (!head) {
      head = document.createElement('head');
      clone.insertBefore(head, clone.firstChild);
    }
    const base = document.createElement('base');
    base.href = document.baseURI; // 相対 URL の CSS・画像・リンクを元のサイトから解決する
    base.target = '_blank'; // リンクは新しいタブで開く
    const referrer = document.createElement('meta');
    referrer.name = 'referrer';
    referrer.content = 'no-referrer';
    const charset = document.createElement('meta');
    charset.setAttribute('charset', 'utf-8');
    head.prepend(charset, base, referrer);
    if (adopted) {
      const st = document.createElement('style');
      st.textContent = adopted;
      head.append(st);
    }
    return '<!doctype html>\n' + clone.outerHTML;
  }

  // -------------------------------------------------------------------------
  // ハイライト
  // -------------------------------------------------------------------------
  function setHighlight(i) {
    if (hlEl) hlEl.removeAttribute('data-st-hl');
    hlEl = i == null ? null : elems[i] || null;
    if (hlEl) hlEl.setAttribute('data-st-hl', '');
  }

  function blockAt(target) {
    for (let n = target; n && n !== document; n = n.parentElement) {
      if (indexOf.has(n)) return indexOf.get(n);
    }
    return null;
  }

  document.addEventListener(
    'mouseover',
    (e) => {
      if (docId == null) return;
      const idx = blockAt(e.target);
      if (idx === lastHover) return;
      lastHover = idx;
      setHighlight(idx);
      send({ type: 'hover', block: idx });
    },
    true
  );

  document.addEventListener(
    'mouseout',
    (e) => {
      if (e.relatedTarget || lastHover == null) return; // ウィンドウ外へ出たとき
      lastHover = null;
      setHighlight(null);
      send({ type: 'hover', block: null });
    },
    true
  );

  // -------------------------------------------------------------------------
  // スクロール同期
  // -------------------------------------------------------------------------
  for (const ev of ['wheel', 'touchstart', 'keydown', 'mousedown']) {
    window.addEventListener(ev, () => (userDriven = true), { capture: true, passive: true });
  }

  const isMainScrollEvent = (target) =>
    mainScroller ? target === mainScroller : target === document || target === document.documentElement;

  function atEnd() {
    if (mainScroller) return mainScroller.scrollTop > 0 && mainScroller.scrollTop + mainScroller.clientHeight >= mainScroller.scrollHeight - 2;
    const de = document.documentElement;
    return window.scrollY > 0 && Math.ceil(window.scrollY + window.innerHeight) >= de.scrollHeight - 2;
  }

  window.addEventListener(
    'scroll',
    (e) => {
      if (!userDriven || docId == null || rafPending || !isMainScrollEvent(e.target)) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        if (atEnd()) {
          send({ type: 'scroll', end: true });
          return;
        }
        const top = scrollTop0();
        for (let i = 0; i < elems.length; i++) {
          if (!syncable[i]) continue;
          const r = elems[i].getBoundingClientRect();
          if (r.height === 0 || r.bottom <= top + 1) continue;
          send({ type: 'scroll', block: i, frac: Math.min(1, Math.max(0, (top - r.top) / r.height)) });
          return;
        }
      });
    },
    { capture: true, passive: true }
  );

  // -------------------------------------------------------------------------
  // サイドパネルからの指示
  // -------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.docId !== docId) return;
    if (msg.type === 'snapshot') {
      try {
        sendResponse({ html: snapshot() });
      } catch (err) {
        sendResponse({ error: String(err) });
      }
    } else if (msg.type === 'highlight') {
      userDriven = false;
      lastHover = null;
      setHighlight(msg.block);
    } else if (msg.type === 'scrollTo') {
      userDriven = false;
      const sc = mainScroller || window;
      if (msg.end) {
        if (mainScroller) mainScroller.scrollTo({ top: mainScroller.scrollHeight, behavior: 'instant' });
        else window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
        return;
      }
      const k = nextSyncable(msg.block);
      if (k === -1) return;
      const r = elems[k].getBoundingClientRect();
      sc.scrollBy({ top: r.top + msg.frac * r.height - scrollTop0(), behavior: 'instant' });
    }
  });
})();

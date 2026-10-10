'use strict';

// 訳文を、元のブロック要素の構造（リンク・太字・画像など）に差し込む。
//
// PLaMo に「タグを保ったまま訳す」ことはさせられない（<a1>…</a1> や [1] などは保持率 2〜3/12）。
// 一方で日本語の「」は自然な記号なのでよく保たれる（9/12）。そこで、ブロックの種類ごとに次のように扱う。
//
//   plain … 文字だけ、または要素 1 つが全体を包む（<li><a><span>…</span></a></li>）
//           → 訳文をそのまま（包んでいる要素の中へ）入れる
//   parts … 文字を持つ要素だけが並ぶ（<li><a>題名</a> <span>3 件</span></li>）
//           → 要素ごとに別々に訳し、元の要素に戻す（位置合わせ不要）
//   marks … 文字と囲み要素が混在する（段落の途中にリンクなど）
//           → 囲み要素の文言を「」で囲んだ原文を訳し、「」の位置を要素の範囲として使う（「」は取り除く）
//           → 「」が崩れたときは括弧なしの訳を使い、原文がそのまま残る語だけ包む。
//             位置が決められない <a> は消さずに末尾へ ↗ で残す
//
// 画像などの単体要素は、元の位置の割合で訳文中に差し込む。
// DOM の Node を受け取るだけなので、ブラウザ・jsdom のどちらでも動く。
(function (root) {
  const ATOMIC = new Set([
    'img', 'picture', 'svg', 'canvas', 'video', 'audio', 'input', 'select', 'textarea', 'button',
    'br', 'wbr', 'hr', 'math',
  ]);
  // 複製では取り除かれる（または意味を持たない）要素。抽出側・複製側で同じ数え方になるよう、常に無視する
  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'frame', 'object', 'embed', 'link', 'meta', 'base']);
  const SEP = '\u0001'; // parts の訳を区切る文字
  const BOUNDARY = /[\s、。，．,.!?！？）)」』]/;
  const HAS_LETTER = /\p{L}/u;
  // 「」で位置を追う対象。太字・強調などは括弧が崩れやすくリンクの成功率を下げるので、原文のまま残る語だけ探す
  const MARKABLE = new Set(['a', 'code', 'kbd', 'samp', 'time']);
  const isMarkable = (w) => MARKABLE.has(w.tag);

  const norm = (s) => s.replace(/\s+/g, ' ').trim();

  /** 1 つの子ノードを text / wrap（文字を持つ要素）/ atom（画像など）/ skip に分類する。 */
  function classify(n) {
    if (n.nodeType === 3) return { k: 'text', text: norm(n.data) };
    if (n.nodeType !== 1) return { k: 'skip' };
    const tag = n.tagName.toLowerCase();
    if (SKIP.has(tag)) return { k: 'skip' };
    const text = norm(n.textContent || '');
    if (ATOMIC.has(tag) || !text) return { k: 'atom', tag };
    return { k: 'wrap', tag, text };
  }

  /** 子ノード列を分類し、各要素の「元の文章上の位置」（atom の相対位置の計算に使う）も付ける。 */
  function analyze(nodes) {
    const segs = [];
    let len = 0;
    for (const n of nodes) {
      const c = classify(n);
      if (c.k === 'skip' || (c.k === 'text' && !c.text)) continue;
      segs.push({ ...c, node: n, before: len });
      if (c.k === 'text' || c.k === 'wrap') len += c.text.length + 1;
    }
    return { segs, total: Math.max(len - 1, 1) };
  }

  /**
   * ブロックの扱い方を決める。抽出時（ページ側）と描画時（複製側）で同じ結果になる。
   * 戻り値: { mode: 'plain'|'parts'|'marks', wraps: 囲み要素の文言[], marked?: 「」付き原文, parts?: 要素ごとの原文[] }
   */
  function plan(nodes) {
    const { segs } = analyze(nodes);
    const wraps = segs.filter((s) => s.k === 'wrap');
    const texts = wraps.map((w) => w.text);
    const hasLetterText = segs.some((s) => s.k === 'text' && HAS_LETTER.test(s.text));
    if (!wraps.length || (wraps.length === 1 && !hasLetterText)) return { mode: 'plain', wraps: texts };
    if (!hasLetterText) return { mode: 'parts', wraps: texts, parts: texts };
    const markCount = wraps.filter(isMarkable).length;
    if (!markCount) return { mode: 'plain', wraps: texts };
    return { mode: 'marks', wraps: texts, markCount, marked: markedSource(nodes) };
  }

  /** 囲み要素の文言を「」で囲んだ原文。 */
  function markedSource(nodes) {
    let s = '';
    for (const n of nodes) {
      const c = classify(n);
      if (c.k === 'text') s += n.data.replace(/\s+/g, ' ');
      else if (c.k === 'wrap' && isMarkable(c)) s += ` 「${c.text.replace(/[「」『』]/g, '"')}」 `;
      else if (c.k === 'wrap') s += n.textContent.replace(/\s+/g, ' ');
      else if (c.k === 'atom' && c.tag === 'br') s += ' ';
    }
    return s.replace(/\s+/g, ' ').trim();
  }

  /**
   * 「」付きの訳から、括弧を取り除いた文章と、k 番目の囲み要素が占める範囲を返す。
   * 括弧の組の数が囲み要素の数と違う、または括弧の中に原文にない英単語がある（幻覚）なら null。
   * source: 原文の文章（幻覚の検出に使う）
   */
  function applyMarks(raw, count, source) {
    const src = (source || '').toLowerCase();
    const re = /[「『]([^「」『』]*)[」』]/g;
    const groups = [...raw.matchAll(re)];
    if (groups.length !== count) return null;
    let text = '';
    let last = 0;
    const hints = new Map();
    for (let k = 0; k < groups.length; k++) {
      const g = groups[k];
      const inner = g[1].trim();
      if (!inner) return null;
      if (src && (inner.match(/[A-Za-z]{3,}/g) || []).some((w) => !src.includes(w.toLowerCase()))) return null;
      text += raw.slice(last, g.index);
      hints.set(k, { start: text.length, end: text.length + inner.length });
      text += inner;
      last = g.index + g[0].length;
    }
    text += raw.slice(last);
    return { text, hints };
  }

  // -------------------------------------------------------------------------
  // 訳文中での位置の探索
  // -------------------------------------------------------------------------
  const overlaps = (s, e, taken) => taken.some((t) => s < t.end && e > t.start);

  /** 訳文 hay の中で needle（原文のまま残っている語）が占める範囲を探す。 */
  function locate(hay, needle, taken) {
    if (!needle) return null;
    for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) {
      if (!overlaps(i, i + needle.length, taken)) return { start: i, end: i + needle.length };
    }
    return null;
  }

  /** 画像などを差し込む位置を、囲み要素の中や単語の途中を避けて句読点・空白の直後に寄せる。 */
  function snap(pos, s, taken) {
    pos = Math.min(Math.max(pos, 0), s.length);
    for (const t of taken) {
      if (pos > t.start && pos < t.end) return pos - t.start < t.end - pos ? t.start : t.end;
    }
    if (pos === 0 || pos === s.length) return pos;
    const free = (p) => p > 0 && p < s.length && !taken.some((t) => p > t.start && p < t.end);
    // まず近くの文末（。！？.!?）の直後、なければ句読点・空白の直後に寄せる
    for (const [pattern, reach] of [[/[。！？.!?]/, 24], [BOUNDARY, 8]]) {
      for (let d = 0; d <= reach; d++) {
        for (const p of [pos + d, pos - d]) if (free(p) && pattern.test(s[p - 1])) return p;
      }
    }
    return pos;
  }

  // -------------------------------------------------------------------------
  // 構造の復元
  // -------------------------------------------------------------------------
  /** parts: 元の並び順のまま、囲み要素ごとに別々の訳を入れる（要素間の記号や画像はそのまま）。 */
  function composeParts(nodes, parts, doc) {
    const out = [];
    let k = 0;
    for (const n of nodes) {
      const c = classify(n);
      if (c.k === 'skip') continue;
      if (c.k === 'wrap') {
        const el = n.cloneNode(false);
        el.append(...compose(n.childNodes, parts[k++], doc));
        out.push(el);
      } else {
        out.push(n.cloneNode(true));
      }
    }
    return out;
  }

  /** 文章 translated に、囲み要素（hints の範囲、または原文のまま残る語）と画像などを差し込む。 */
  function composeText(nodes, translated, hints, doc) {
    const { segs, total } = analyze(nodes);
    const wraps = segs.filter((s) => s.k === 'wrap');
    const atoms = segs.filter((s) => s.k === 'atom');
    const hasLetterText = segs.some((s) => s.k === 'text' && HAS_LETTER.test(s.text));
    const taken = [];
    const unresolved = [];

    if (wraps.length === 1 && !hasLetterText) {
      // 全体が 1 つの囲み要素（例: <li><a><span>…</span></a></li>）→ 訳文全体をその中へ
      taken.push({ start: 0, end: translated.length, seg: wraps[0] });
    } else {
      let mk = 0;
      wraps.forEach((w) => {
        let r = isMarkable(w) && hints ? hints.get(mk++) : null;
        if (r && (r.end > translated.length || overlaps(r.start, r.end, taken))) r = null;
        if (!r) r = locate(translated, w.text, taken); // 訳されずに残る語（Python, npm など）は原文のまま探す
        if (r) taken.push({ ...r, seg: w });
        else unresolved.push(w);
      });
    }
    taken.sort((a, b) => a.start - b.start);

    const events = [
      ...taken.map((t) => ({ pos: t.start, order: 1, range: t })),
      ...atoms.map((a) => ({ pos: snap(Math.round((a.before / total) * translated.length), translated, taken), order: 0, atom: a })),
    ].sort((a, b) => a.pos - b.pos || a.order - b.order);

    const out = [];
    let cur = 0;
    const text = (s) => doc.createTextNode(s);
    for (const ev of events) {
      if (ev.range) {
        const { start, end, seg } = ev.range;
        if (start > cur) out.push(text(translated.slice(cur, start)));
        const el = seg.node.cloneNode(false);
        el.append(...compose(seg.node.childNodes, translated.slice(start, end), doc));
        out.push(el);
        cur = end;
      } else {
        if (ev.pos > cur) {
          out.push(text(translated.slice(cur, ev.pos)));
          cur = ev.pos;
        }
        out.push(ev.atom.node.cloneNode(true));
      }
    }
    if (cur < translated.length) out.push(text(translated.slice(cur)));

    // 位置が決められなかったリンクは消さずに末尾へ（ホバーすると元の文言が出る）
    for (const w of unresolved) {
      if (w.tag !== 'a') continue;
      const m = w.node.cloneNode(false);
      m.textContent = '↗';
      m.title = w.text;
      out.push(text(' '), m);
    }
    return out;
  }

  /**
   * nodes（元のブロックの子ノード）と訳（raw）から、差し込む Node の配列を作る。
   * 元のノードは移動せず、cloneNode したものだけを返す。
   */
  function compose(nodes, raw, doc) {
    const p = plan(nodes);
    if (p.mode === 'parts') {
      const parts = raw.split(SEP);
      if (parts.length === p.wraps.length) return composeParts(nodes, parts, doc);
      raw = parts.join(' ');
    }
    let text = raw;
    let hints = null;
    if (p.mode === 'marks') {
      const a = applyMarks(raw, p.markCount, sourceOf(nodes));
      if (a) {
        text = a.text;
        hints = a.hints;
      }
    }
    return composeText(nodes, text, hints, doc);
  }

  const sourceOf = (nodes) => norm(Array.from(nodes, (n) => (classify(n).k === 'skip' ? '' : n.textContent || n.data || '')).join(' '));

  /** 構造を復元できないとき用: 訳から印や区切りを除いた、文字だけの文章。 */
  function plainText(raw, mode, count, source) {
    if (mode === 'parts') return raw.split(SEP).join(' ');
    if (mode === 'marks') return (applyMarks(raw, count, source) || { text: raw }).text;
    return raw;
  }

  const api = { plan, compose, applyMarks, plainText, analyze, SEP };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PlamoCompose = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

'use strict';

// 本文のスクロール領域を自動検出する。ページ側（content.js）とパネル側の複製（viewer.js）の
// 両方から、同じロジックで使う（compose.js と同じやり方で両方に読み込ませる）。
//
// 各ブロック要素の祖先を辿り、
//   - スクロール可能な祖先（overflow-y: auto/scroll かつ scrollHeight > clientHeight、body は除く）が
//     見つかったらそこで打ち切る。それより外側の fixed/sticky は、このブロックの可視位置に影響しない。
//     （画面全体を覆う fixed なアプリシェルなどがあると、打ち切らない場合は記事本体ごと
//       「常に画面内にある」と誤判定してしまう）
//   - 打ち切るまでの間に fixed/sticky な祖先があれば、そのブロックは常に画面内にあるとみなし除外する
// 固定でないブロックが最も多く属するスクロール領域を、本文のスクロールとみなす。
(function (root) {
  /**
   * @param {Document} doc
   * @param {Window} win
   * @param {(Element|undefined)[]} elements ブロック要素（index = ブロック番号。抜けは undefined でよい）
   * @returns {{ mainScroller: Element|null, syncable: boolean[] }}
   */
  function detect(doc, win, elements) {
    const info = elements.map((el) => {
      if (!el) return { fixed: false, scroller: null };
      let fixed = false;
      let scroller = null;
      for (let p = el; p && p !== doc.documentElement; p = p.parentElement) {
        const cs = win.getComputedStyle(p);
        if (p !== doc.body && (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && p.scrollHeight > p.clientHeight + 1) {
          scroller = p;
          break;
        }
        if (cs.position === 'fixed' || cs.position === 'sticky') fixed = true;
      }
      return { fixed, scroller };
    });
    // 固定でないブロックが最も多く属するスクロール領域を「本文のスクロール」とみなす
    const counts = new Map();
    for (const { fixed, scroller } of info) if (!fixed) counts.set(scroller, (counts.get(scroller) || 0) + 1);
    let top = -1;
    let mainScroller = null;
    for (const [scroller, n] of counts) {
      if (n > top) {
        top = n;
        mainScroller = scroller;
      }
    }
    const syncable = info.map(({ fixed, scroller }) => !fixed && scroller === mainScroller);
    return { mainScroller, syncable };
  }

  const api = { detect };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ScrollSync = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

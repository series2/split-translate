// アイコンクリック → サイドパネルを開き、アクティブタブの本文ブロックを抽出して storage.session に保存する。
// サイドパネル（viewer.html）が `doc:<tabId>` を読んで翻訳・表示する。

const docKey = (tabId) => `doc:${tabId}`;
const cacheKey = (tabId) => `tr:${tabId}`;

// 既定ではどのタブにもパネルを出さない。アイコンをクリックしたタブだけ有効にする。
chrome.runtime.onInstalled.addListener(() => chrome.sidePanel.setOptions({ enabled: false }));

async function flashBadge(tabId, text) {
  await chrome.action.setBadgeText({ tabId, text });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: '#d93025' });
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }), 2500);
}

async function extractAndStore(tab) {
  const tabId = tab.id;
  try {
    const { extractionMaxBlocks = 5000 } = await chrome.storage.local.get('extractionMaxBlocks');
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['compose.js', 'scrollsync.js', 'content.js'] });
    const id = crypto.randomUUID();
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (docId, options) => window.__splitTranslate.extract(docId, options),
      args: [id, { maxBlocks: extractionMaxBlocks }],
    });
    const doc = injection?.result;
    if (!doc || doc.blocks.length === 0) {
      await chrome.storage.session.remove(docKey(tabId));
      flashBadge(tabId, '0');
      return;
    }
    await chrome.storage.session.set({ [docKey(tabId)]: doc });
  } catch (err) {
    console.error('[Split Translate]', err);
    flashBadge(tabId, '!');
  }
}

chrome.action.onClicked.addListener((tab) => {
  if (!tab.id || !/^https?:/.test(tab.url || '')) {
    if (tab.id) flashBadge(tab.id, '!');
    return;
  }
  // サイドパネルはこのタブ専用にする（他のタブへ移動してもパネルが付いて回らない）。
  // sidePanel.open() はユーザー操作の直後に同期的に呼ぶ必要があるので、await を挟まず setOptions → open の順で呼ぶ。
  chrome.sidePanel
    .setOptions({ tabId: tab.id, path: `viewer.html?tab=${tab.id}`, enabled: true })
    .catch((err) => console.error(err));
  chrome.sidePanel.open({ tabId: tab.id }).catch((err) => console.error(err));
  extractAndStore(tab);
});

// メインフレームが遷移・リロードされたら、古い抽出結果は無効。
// tabs.onUpdated の status:'loading' は iframe（広告など）の読み込みでも発火するので使わない。
function invalidateDoc(details) {
  if (details.frameId === 0) chrome.storage.session.remove([docKey(details.tabId), cacheKey(details.tabId)]);
}
chrome.webNavigation.onCommitted.addListener(invalidateDoc);
// SPA（history.pushState 等によるクライアント側遷移）で別ページへ移っても、フルリロードを伴わないため
// onCommitted は発火せず、古い抽出結果がパネルに残り続けることがある。onHistoryStateUpdated で検知する
// 案を試したが、サイトによってはスクロールするだけで pathname が変わる実装があり、誤検知で翻訳結果が
// 消え続けてしまうため撤回。SPA内の別ページへ移動した後に内容が古いままの場合は、アイコンを再クリックして
// 手動で再抽出すること。
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove([docKey(tabId), cacheKey(tabId)]);
  chrome.sidePanel.setOptions({ tabId, enabled: false }).catch(() => {});
});

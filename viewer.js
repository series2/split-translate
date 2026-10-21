'use strict';

// サイドパネル（翻訳側）。原文はアクティブタブのページそのもの。
// 右側（このパネル）は、ページの複製（CSS・画像・リンクつき）の本文ブロックを訳文に差し替えたもの。
//   - 複製は content.js が作り、iframe(sandbox, スクリプト無効) に読み込む
//   - 翻訳は Chrome内蔵翻訳 / Ollama / 各種APIから選べる。複数の設定を保存して切り替えられる
//   - 訳文の構造復元は compose.js
//   - content.js とメッセージで「ホバー中のブロック」「スクロール位置」を同期する

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------
// value は翻訳先として渡す出力言語名。
const LANGS = [
  ['Japanese', '日本語'],
  ['English', 'English'],
  ['Chinese', '中国語（実験的）'],
  ['Korean', '韓国語（実験的）'],
  ['French', 'フランス語（実験的）'],
  ['German', 'ドイツ語（実験的）'],
  ['Spanish', 'スペイン語（実験的）'],
  ['Italian', 'イタリア語（実験的）'],
  ['Russian', 'ロシア語（実験的）'],
  ['Arabic', 'アラビア語（実験的）'],
  ['Thai', 'タイ語（実験的）'],
  ['Vietnamese', 'ベトナム語（実験的）'],
  ['Indonesian', 'インドネシア語（実験的）'],
];
// プロバイダーごとの既定値。モデル設定を新規作成/プロバイダー切替したときに使う。
// needsKey/needsModel/needsTemplate/needsRegion: 編集欄の各項目をそのプロバイダーで見せるか。
const PROVIDER_DEFAULTS = {
  chrome: {
    label: 'ブラウザー内蔵翻訳',
    url: '',
    model: '',
    needsKey: false,
    needsModel: false,
    needsTemplate: false,
    needsRegion: false,
  },
  ollama: {
    label: 'Ollama',
    url: 'http://localhost:11434',
    model: 'mitmul/plamo-2-translate',
    needsKey: false,
    needsModel: true,
    needsTemplate: true,
    needsRegion: false,
  },
  openai: {
    label: 'OpenAI',
    url: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    needsKey: true,
    needsModel: true,
    needsTemplate: true,
    needsRegion: false,
  },
  anthropic: {
    label: 'Anthropic',
    url: 'https://api.anthropic.com',
    model: 'claude-haiku-4-5-20251001',
    needsKey: true,
    needsModel: true,
    needsTemplate: true,
    needsRegion: false,
  },
  google: {
    label: 'Google Cloud Translation',
    url: 'https://translation.googleapis.com',
    model: '',
    needsKey: true,
    needsModel: false,
    needsTemplate: false,
    needsRegion: false,
  },
  azure: {
    label: 'Azure AI Translator',
    url: 'https://api.cognitive.microsofttranslator.com',
    model: '',
    needsKey: true,
    needsModel: false,
    needsTemplate: false,
    needsRegion: true,
  },
};
const CHAT_PROVIDER_DEFAULTS = {
  chrome: { label: 'Chrome内蔵 Local LLM', url: '', model: '', needsKey: false },
  ollama: { label: 'Ollamaチャット', url: 'http://localhost:11434', model: 'gemma3:4b', needsKey: false },
  openai: { label: 'OpenAIチャット', url: 'https://api.openai.com/v1', model: 'gpt-4o-mini', needsKey: true },
  anthropic: { label: 'Anthropicチャット', url: 'https://api.anthropic.com', model: 'claude-haiku-4-5-20251001', needsKey: true },
};
const CONCURRENCY = 2;
const MAX_CACHE_ENTRIES = 4000;
const DEFAULT_CHAT_CONTEXT_CHARS = 4000;
const CHAT_TIMEOUT_MS = 90000;
const MIN_CHAT_HEIGHT = 120;
const CHAT_CLOSE_THRESHOLD = 80;
const LOCAL_LLM_OPTIONS = {
  // Chrome Prompt API が現在サポートするテキスト言語。システム指示と通常の質問は日本語、
  // ページ本文には英語などが混ざるため、availability() と create() の両方へ同じ宣言を渡す。
  expectedInputs: [{ type: 'text', languages: ['ja', 'en', 'es', 'de', 'fr'] }],
  expectedOutputs: [{ type: 'text', languages: ['ja'] }],
};

// 複製の中に差し込むスタイル（ホバー・状態表示・再翻訳ボタン）
const FRAME_CSS = `
[data-st-hl]{background-color:rgba(250,204,21,.4)!important;outline:2px solid rgba(234,179,8,.9)!important;outline-offset:2px!important;border-radius:3px}
[data-st-state=pending],[data-st-state=busy]{opacity:.55!important}
[data-st-state=error]{outline:2px dashed #d93025!important;outline-offset:2px!important;cursor:pointer!important}
#st-retry{all:initial;position:fixed;z-index:2147483647;display:none;box-sizing:border-box;width:28px;height:28px;font:15px/26px sans-serif;text-align:center;color:#555;background:#fff;border:1px solid #bbb;border-radius:6px;cursor:pointer;opacity:.72;box-shadow:0 1px 3px rgba(0,0,0,.25)}
#st-retry:hover{color:#2563eb;border-color:#2563eb;opacity:1}
`;

// ---------------------------------------------------------------------------
// 状態・DOM
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const frame = $('#frame');
const emptyEl = $('#empty');
const titleEl = $('#page-title');
const toolbar = $('#toolbar');
const btnToolbarToggle = $('#toolbar-toggle');
const btnChatToggle = $('#chat-toggle');
const chatPane = $('#chat-pane');
const chatDomainEl = $('#chat-domain');
const chatMessagesEl = $('#chat-messages');
const chatStatusEl = $('#chat-status');
const chatForm = $('#chat-form');
const chatInput = $('#chat-input');
const btnChatSend = $('#chat-send');
const btnChatStop = $('#chat-stop');
const btnChatReset = $('#chat-reset');
const btnChatClose = $('#chat-close');
const btnChatSettings = $('#chat-settings');
const btnChatInfoToggle = $('#chat-info-toggle');
const chatInfo = $('#chat-info');
const chatResizer = $('#chat-resizer');
const selChatProfile = $('#chat-profile');
const selSl = $('#sl');
const selTl = $('#tl');
const chkSync = $('#sync');
const inExtractionMaxBlocks = $('#extraction-max-blocks');
const statusEl = $('#status');
const noticeEl = $('#notice');
const extractionWarningEl = $('#extraction-warning');
const progressEl = $('#progress');
const btnPause = $('#pause');
const selProfile = $('#profile');
const inName = $('#cfg-name');
const selProvider = $('#cfg-provider');
const inUrl = $('#cfg-url');
const inKey = $('#cfg-key');
const inRegion = $('#cfg-region');
const inModel = $('#cfg-model');
const modelList = $('#cfg-model-list');
const btnRefreshModels = $('#cfg-refresh-models');
const inTemplate = $('#cfg-template');
const rowKey = $('#cfg-key-row');
const rowUrl = $('#cfg-url-row');
const rowRegion = $('#cfg-region-row');
const rowModel = $('#cfg-model-row');
const rowTemplate = $('#cfg-template-row');
const cfgHint = $('#cfg-hint');
const btnUpdate = $('#cfg-update');
const btnAdd = $('#cfg-add');
const btnDelete = $('#cfg-delete');
const translateSettings = $('#translate-settings');
const chatSettings = $('#chat-model-settings');
const selChatCfgProfile = $('#chat-cfg-profile');
const inChatCfgName = $('#chat-cfg-name');
const selChatCfgProvider = $('#chat-cfg-provider');
const inChatCfgUrl = $('#chat-cfg-url');
const inChatCfgKey = $('#chat-cfg-key');
const inChatCfgModel = $('#chat-cfg-model');
const inChatCfgContextLimit = $('#chat-cfg-context-limit');
const chatCfgModelList = $('#chat-cfg-model-list');
const btnChatCfgRefresh = $('#chat-cfg-refresh-models');
const rowChatCfgUrl = $('#chat-cfg-url-row');
const rowChatCfgKey = $('#chat-cfg-key-row');
const rowChatCfgModel = $('#chat-cfg-model-row');
const chatCfgHint = $('#chat-cfg-hint');
const btnChatCfgUpdate = $('#chat-cfg-update');
const btnChatCfgAdd = $('#chat-cfg-add');
const btnChatCfgDelete = $('#chat-cfg-delete');

inTemplate.placeholder = STTranslate.DEFAULT_TEMPLATE;

const { translate, chat: apiChat, checkBackend: apiCheckBackend } = STTranslate;
const C = PlamoCompose;

let tabId = null; // このパネルが紐づくタブ（?tab= で渡される）
let doc = null;
let run = 0; // 再翻訳・別ページへの切替時に古いワーカーを止めるための世代番号
let anchor = 0; // いま見ているブロック。ここに近い順に翻訳する
let curStore = []; // 現在の訳（index = ブロック番号。parts は C.SEP 区切り / marks は「」付き）
let stateArr = []; // 'pending' | 'done' | 'error' | 'busy'
let translating = false; // translateAll() のワーカーが実際に動いている間だけ true
let paused = false; // true の間は、ホバー/スクロールなどによる自動再開（resumeIfIdle）を行わない
let activeLanguagePair = ''; // Chrome/Edge 内蔵翻訳が実際に使っている言語ペア（例: en → ja）
let profiles = []; // 保存されたモデル設定 [{ id, name, provider, url, apiKey, model }]
let activeProfileId = null;
let chatProfiles = []; // 翻訳設定とは独立したLLMチャット用設定
const stores = new Map(); // `${docId}|${profileId}|${lang}` -> string[]
const textCache = new Map(); // `${profileId}|${lang}|${原文}` -> 訳（再抽出・パネルの開き直しをまたいで使い回す）
const BUILTIN_CHAT_ID = '__chrome_builtin_llm__';
const llmStates = new Map(); // domain + chat profile -> { history, session, creating, loaded }
let activeChatDomain = '';
let activeChatProfileId = BUILTIN_CHAT_ID;
let chatBusy = false;
let currentChatAbort = null;

// 複製（iframe）側
let frameToken = 0;
let ready = false; // DOM が使える（ブロックを差し替えられる）
let frameLoaded = false; // CSS・画像まで読み込み済み（固定要素の判定が正しくなる）
let fdoc = null;
let fwin = null;
let els = []; // 複製内のブロック要素（index = ブロック番号）
let origNodes = []; // 各ブロックの元の子ノード（差し替え前に退避）
let retryBtn = null;
let retryIdx = null; // ボタン表示後にホバー先が変化しても、クリック対象を明示的に保持する
let fMainScroller = null; // 複製内で実際にスクロールしている要素（null = フレーム自体がスクロールする）
let fSyncable = []; // スクロール位置合わせに使えるブロックか（ScrollSync.detect の結果。index = ブロック番号）
let scrollerReady = false; // fMainScroller を検出済みか

function activeProfile() {
  return profiles.find((p) => p.id === activeProfileId) || profiles[0] || null;
}

const cfg = () => {
  const p = activeProfile();
  if (!p) return { provider: 'ollama', url: PROVIDER_DEFAULTS.ollama.url, apiKey: '', model: PROVIDER_DEFAULTS.ollama.model, template: '', region: '' };
  return {
    provider: p.provider,
    url: (p.url || '').replace(/\/+$/, ''),
    apiKey: p.apiKey,
    model: p.model,
    template: p.template,
    region: p.region,
    // auto ではページの lang 属性を信用しすぎず、Language Detector で本文から判定する。
    sourceLanguage: selSl.value === 'auto' ? '' : selSl.value,
    fallbackSourceLanguage: doc?.lang || '',
    sourceSample: doc ? doc.blocks.slice(0, 20).map(sourceOf).join('\n').slice(0, 4000) : '',
    onLanguagePair: (source, target) => {
      activeLanguagePair = `${source} → ${target}`;
    },
    onDownloadProgress: (loaded) => {
      const percent = Math.round(loaded * 100);
      statusEl.textContent = `内蔵翻訳モデルを取得中… ${percent}%`;
      progressEl.classList.add('active');
      progressEl.firstElementChild.style.width = `${percent}%`;
    },
  };
};

// ---------------------------------------------------------------------------
// 翻訳バックエンド（通信・翻訳ロジックは translate.js）
// ---------------------------------------------------------------------------
function explain(err) {
  const { provider, url, model } = cfg();
  if (provider === 'chrome') {
    switch (err.code) {
      case 'unsupported':
        return 'ブラウザー内蔵翻訳を利用できません。Chrome 138 以降または対応版Edgeに更新するか、別のモデル設定を選んでください。';
      case 'activation':
        return '初回の翻訳モデル取得にはユーザー操作が必要です。上の「再翻訳」をクリックしてください。';
      case 'language':
        return String(err.message || 'この言語ペアはブラウザー内蔵翻訳で利用できません。');
      case 'download':
        return `内蔵翻訳モデルを取得できませんでした。ネットワークを確認して再翻訳してください。\n${err.message || ''}`.trim();
      default:
        return String(err?.message || err);
    }
  }
  if (provider === 'ollama') {
    switch (err.code) {
      case 'network':
        return (
          `Ollama（${url}）に接続できません。\n` +
          '・起動しているか確認してください: launchctl print gui/$(id -u)/local.ollama\n' +
          '・Docker 版の場合は 11434 番ポートを公開してください'
        );
      case 'forbidden':
        return (
          'Ollama が拡張機能からのアクセスを拒否しました（403）。\n' +
          'Ollama の環境変数 OLLAMA_ORIGINS に chrome-extension://* を含めて再起動してください。\n' +
          '（Docker の場合は -e OLLAMA_ORIGINS="chrome-extension://*"）'
        );
      case 'model':
        return `モデル ${model} が見つかりません。次を実行して取得してください:\nollama pull ${model}`;
      case 'runaway':
        return '訳の生成が止まらなくなったため、この文の翻訳に失敗しました。↻ で再試行してください。';
      default:
        return String(err?.message || err);
    }
  }
  const providerNames = {
    openai: 'OpenAI互換API',
    anthropic: 'Anthropic API',
    google: 'Google Cloud Translation API',
    azure: 'Azure AI Translator',
  };
  const providerName = providerNames[provider] || provider;
  switch (err.code) {
    case 'network':
      return (
        `${providerName}（${url}）に接続できません。\n` +
        '・URL が正しいか確認してください\n' +
        '・この接続先への拡張機能からのアクセスが許可されているか確認してください（モデル設定のURL欄を保存し直すと許可を求められます）'
      );
    case 'forbidden':
      return provider === 'azure'
        ? `${providerName}がAPIキーを拒否しました。キーとリージョン（例: japaneast、不明なら global）が正しいか確認してください。`
        : `${providerName}がAPIキーを拒否しました。キーが正しいか、利用枠が残っているか確認してください。`;
    case 'model':
      return `モデル ${model} が見つかりません。モデル名が正しいか確認してください。`;
    default:
      return String(err?.message || err);
  }
}

const checkBackend = () => apiCheckBackend(cfg());
const translateText = (text, lang, temperature = 0) => translate(text, lang, { ...cfg(), temperature });

/** 原文（キャッシュのキー）。parts は要素ごとの原文を区切り文字でつなぐ。 */
function sourceOf(b) {
  if (b.m === 'parts') return b.parts.join(C.SEP);
  if (b.m === 'marks') return b.marked;
  return b.text;
}

/** 1 ブロックを訳す。構造の復元に必要な形（parts / 「」付き）で返す。 */
async function translateBlockAt(i, lang, temperature = 0) {
  const b = doc.blocks[i];
  if (b.m === 'parts') {
    const outs = [];
    for (const part of b.parts) outs.push(await translateText(part, lang, temperature));
    return outs.join(C.SEP);
  }
  if (b.m === 'marks' && lang === 'Japanese') {
    // リンクなどを「」で囲んだ原文を訳す。「」が崩れたら温度を変えて 1 回だけやり直す
    for (const t of [temperature, temperature === 0 ? 0.4 : 0]) {
      const raw = await translateText(b.marked, lang, t);
      if (C.applyMarks(raw, b.markCount, b.text)) return raw;
    }
  }
  return translateText(b.text, lang, temperature);
}

// ---------------------------------------------------------------------------
// 翻訳キャッシュ
// ---------------------------------------------------------------------------
const tkey = (profileId, lang, text) => `${profileId}|${lang}|${text}`;

let persistTimer = null;
function persistCache() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    if (!doc) return;
    const entries = [...textCache].slice(-MAX_CACHE_ENTRIES);
    chrome.storage.session.set({ [`tr:${tabId}`]: entries }).catch(() => {});
  }, 600);
}

async function restoreCache() {
  const key = `tr:${tabId}`;
  const entries = (await chrome.storage.session.get(key))[key] || [];
  for (const [k, val] of entries) if (!textCache.has(k)) textCache.set(k, val);
}

/** 訳を記録する。profileId / lang は翻訳を始めた時点のもの（実行中に設定が変わっても混ざらない）。 */
function remember(store, i, text, profileId, lang) {
  store[i] = text;
  textCache.set(tkey(profileId, lang, sourceOf(doc.blocks[i])), text);
  persistCache();
}

function currentStore(force) {
  const profileId = activeProfileId;
  const lang = selTl.value;
  const key = `${doc.id}|${profileId}|${lang}`;
  if (force) {
    stores.delete(key);
    for (const b of doc.blocks) textCache.delete(tkey(profileId, lang, sourceOf(b)));
  }
  if (!stores.has(key)) stores.set(key, doc.blocks.map((b) => textCache.get(tkey(profileId, lang, sourceOf(b)))));
  return stores.get(key);
}

// ---------------------------------------------------------------------------
// Local LLM チャット（Chrome Prompt API / Gemini Nano）
// ---------------------------------------------------------------------------
const MAX_CHAT_MESSAGES = 16;

function domainOf(url) {
  try {
    return new URL(url).hostname || 'local';
  } catch {
    return 'unknown';
  }
}

const llmStateId = (domain, profileId = activeChatProfileId) => `${domain}|${profileId}`;
const llmHistoryKey = (domain, profileId = activeChatProfileId) => `llm-chat:${llmStateId(domain, profileId)}`;

async function llmState(domain, profileId = activeChatProfileId) {
  const id = llmStateId(domain, profileId);
  if (!llmStates.has(id)) llmStates.set(id, { history: [], session: null, creating: null, loaded: false });
  const state = llmStates.get(id);
  if (!state.loaded) {
    const key = llmHistoryKey(domain, profileId);
    const stored = await chrome.storage.session.get(key);
    const history = stored[key];
    if (Array.isArray(history)) state.history = history.slice(-MAX_CHAT_MESSAGES);
    state.loaded = true;
  }
  return state;
}

function appendChatMessage(role, text) {
  const el = document.createElement('div');
  el.className = `chat-message ${role}`;
  if (role === 'assistant') renderMarkdown(el, text);
  else el.textContent = text;
  chatMessagesEl.append(el);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  return el;
}

// LLMの出力を表示するための小さなMarkdownレンダラー。
// innerHTMLは使わず、リンク先も安全なプロトコルだけを許可する。
function appendInlineMarkdown(parent, source) {
  const pattern = /(`+)([^\n]*?)\1|\[([^\]]+)\]\(([^\s)]+)(?:\s+["'][^"']*["'])?\)|(\*\*|__)(.+?)\5|(?<!\*)\*([^*\n]+)\*(?!\*)|(?<!_)_([^_\n]+)_(?!_)/g;
  let offset = 0;
  let match;

  const appendText = (text) => {
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      if (index) parent.append(document.createElement('br'));
      if (line) parent.append(document.createTextNode(line));
    });
  };

  while ((match = pattern.exec(source))) {
    appendText(source.slice(offset, match.index));
    if (match[1]) {
      const code = document.createElement('code');
      code.textContent = match[2];
      parent.append(code);
    } else if (match[3]) {
      let url;
      try {
        url = new URL(match[4]);
      } catch {
        url = null;
      }
      if (url && ['http:', 'https:', 'mailto:'].includes(url.protocol)) {
        const link = document.createElement('a');
        link.href = url.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        appendInlineMarkdown(link, match[3]);
        parent.append(link);
      } else {
        appendText(match[0]);
      }
    } else {
      const emphasis = document.createElement(match[5] ? 'strong' : 'em');
      appendInlineMarkdown(emphasis, match[5] ? match[6] : (match[7] || match[8]));
      parent.append(emphasis);
    }
    offset = pattern.lastIndex;
  }
  appendText(source.slice(offset));
}

function markdownCells(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

function renderMarkdown(container, markdown) {
  container.replaceChildren();
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');

  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = line.match(/^\s*```\s*([^\s`]*)\s*$/);
    if (fence) {
      const codeLines = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) codeLines.push(lines[i++]);
      if (i < lines.length) i++;
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      if (fence[1]) code.dataset.language = fence[1];
      code.textContent = codeLines.join('\n');
      pre.append(code);
      container.append(pre);
      continue;
    }

    const heading = line.match(/^\s*(#{1,6})\s+(.+)$/);
    if (heading) {
      const el = document.createElement(`h${heading[1].length}`);
      appendInlineMarkdown(el, heading[2]);
      container.append(el);
      i++;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
      const el = document.createElement('blockquote');
      appendInlineMarkdown(el, quote.join('\n'));
      container.append(el);
      continue;
    }

    const listMatch = line.match(/^\s*(?:([-+*])|(\d+)[.)])\s+(.+)$/);
    if (listMatch) {
      const ordered = Boolean(listMatch[2]);
      const list = document.createElement(ordered ? 'ol' : 'ul');
      if (ordered && Number(listMatch[2]) !== 1) list.start = Number(listMatch[2]);
      while (i < lines.length) {
        const item = lines[i].match(/^\s*(?:([-+*])|(\d+)[.)])\s+(.+)$/);
        if (!item || Boolean(item[2]) !== ordered) break;
        const li = document.createElement('li');
        appendInlineMarkdown(li, item[3]);
        list.append(li);
        i++;
      }
      container.append(list);
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1])) {
      const table = document.createElement('table');
      const thead = table.createTHead();
      const headerRow = thead.insertRow();
      for (const cell of markdownCells(line)) {
        const th = document.createElement('th');
        appendInlineMarkdown(th, cell);
        headerRow.append(th);
      }
      const tbody = table.createTBody();
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        const row = tbody.insertRow();
        for (const cell of markdownCells(lines[i++])) {
          const td = row.insertCell();
          appendInlineMarkdown(td, cell);
        }
      }
      container.append(table);
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      container.append(document.createElement('hr'));
      i++;
      continue;
    }

    const paragraph = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^\s*(?:```|#{1,6}\s|>|[-+*]\s+|\d+[.)]\s+)/.test(lines[i])) {
      if (lines[i].includes('|') && i + 1 < lines.length && /-{3,}/.test(lines[i + 1])) break;
      paragraph.push(lines[i++]);
    }
    const p = document.createElement('p');
    appendInlineMarkdown(p, paragraph.join('\n'));
    container.append(p);
  }
}

function renderChatHistory(history) {
  chatMessagesEl.replaceChildren();
  for (const item of history) appendChatMessage(item.role, item.content);
}

async function switchChatDomain(d) {
  const nextDomain = d ? domainOf(d.url) : '';
  if (chatBusy && nextDomain !== activeChatDomain) currentChatAbort?.abort('switch');
  activeChatDomain = nextDomain;
  chatDomainEl.textContent = activeChatDomain;
  chatStatusEl.textContent = '';
  chatStatusEl.classList.remove('error');
  const keepId = activeChatDomain ? llmStateId(activeChatDomain, activeChatProfileId) : '';
  for (const [id, state] of llmStates) {
    if (id === keepId || !state.session) continue;
    state.session.destroy?.();
    state.session = null;
  }
  if (!activeChatDomain) return renderChatHistory([]);
  const expectedDomain = activeChatDomain;
  const expectedProfile = activeChatProfileId;
  const state = await llmState(expectedDomain, expectedProfile);
  if (activeChatDomain === expectedDomain && activeChatProfileId === expectedProfile) renderChatHistory(state.history);
}

function chatProfile() {
  return chatProfiles.find((p) => p.id === activeChatProfileId) || chatProfiles[0] || null;
}

function populateChatProfileSelect() {
  const previous = activeChatProfileId;
  selChatProfile.replaceChildren(...chatProfiles.map((p) => new Option(p.name || '(無題)', p.id)));
  if (!chatProfiles.some((p) => p.id === activeChatProfileId)) activeChatProfileId = chatProfiles[0]?.id || BUILTIN_CHAT_ID;
  selChatProfile.value = activeChatProfileId;
  if (activeChatProfileId !== previous) {
    chrome.storage.local.set({ activeChatProfileId });
    if (doc) switchChatDomain(doc);
  }
}

const CHAT_STOP_WORDS = new Set([
  'これ', 'それ', 'あれ', 'ここ', 'そこ', 'どこ', 'この', 'その', 'について', 'ください', '教えて', '説明', '意味',
  'what', 'where', 'when', 'which', 'please', 'tell', 'explain', 'this', 'that', 'about', 'with', 'from',
]);

function chatQuestionTerms(question) {
  let words = [];
  try {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
    words = [...segmenter.segment(question)].filter((part) => part.isWordLike).map((part) => part.segment);
  } catch {
    words = question.match(/[\p{L}\p{N}]{2,}/gu) || [];
  }
  return [...new Set(words.map((word) => word.toLocaleLowerCase()).filter((word) => word.length >= 2 && !CHAT_STOP_WORDS.has(word)))].slice(0, 12);
}

function questionNeedsPageContext(question, selected) {
  if (selected) return true;
  return !/^\s*(こんにちは|こんばんは|おはよう|ありがとう|hi|hello|thanks|thank you)[!！。.、,\s]*$/i.test(question);
}

function chatContext(question, maxChars) {
  if (!doc || maxChars <= 0) return '';
  const selected = String(fwin?.getSelection?.() || '').trim();
  if (!questionNeedsPageContext(question, selected)) return '';

  const terms = chatQuestionTerms(question);
  const scores = [];
  for (let i = 0; i < doc.blocks.length; i++) {
    const source = sourceOf(doc.blocks[i]).split(C.SEP).join(' ').trim();
    const translated = curStore[i]?.split(C.SEP).join(' ').trim() || '';
    const haystack = `${source}\n${translated}`.toLocaleLowerCase();
    let score = 0;
    for (const term of terms) if (haystack.includes(term)) score += Math.min(4, term.length);
    if (score) scores.push({ i, score });
  }
  scores.sort((a, b) => b.score - a.score || Math.abs(a.i - anchor) - Math.abs(b.i - anchor));

  const indexes = new Set();
  if (scores.length) {
    for (const { i } of scores.slice(0, 6)) indexes.add(i);
    for (let i = Math.max(0, anchor - 1); i <= Math.min(doc.blocks.length - 1, anchor + 1); i++) indexes.add(i);
  } else {
    for (let i = Math.max(0, anchor - 2); i <= Math.min(doc.blocks.length - 1, anchor + 2); i++) indexes.add(i);
  }

  const parts = [];
  if (selected) parts.push(`[選択中の文章]\n${selected}`);
  for (const i of [...indexes].sort((a, b) => a - b)) {
    const source = sourceOf(doc.blocks[i]).split(C.SEP).join(' ').trim();
    if (!source) continue;
    const translated = curStore[i]?.split(C.SEP).join(' ').trim();
    parts.push(`[ブロック ${i + 1} / 原文]\n${source}${translated ? `\n[訳文]\n${translated}` : ''}`);
  }
  return parts.join('\n\n').slice(0, maxChars);
}

function llmErrorMessage(err, provider) {
  if (provider === 'chrome' && !globalThis.LanguageModel) return 'Local LLM は対応版Chromeの拡張機能でのみ利用できます。';
  if (err?.name === 'NotAllowedError') return '初回のモデル取得にはユーザー操作が必要です。もう一度「送信」を押してください。';
  if (err?.name === 'QuotaExceededError') return '会話が長くなりました。会話をリセットしてください。';
  return String(err?.message || err || 'Local LLM でエラーが発生しました。');
}

function chatSystemPrompt(domain) {
  return (
    `あなたは ${domain} の文章を読む人の補助者です。日本語で簡潔に回答してください。` +
    '与えられたページ文脈と会話だけを根拠にし、外部検索をしたように装わないでください。' +
    '文脈から判断できない場合は、その旨を明示してください。'
  );
}

async function createLlmSession(state, domain, profileId, signal) {
  if (!globalThis.LanguageModel) throw new Error('LanguageModel API が利用できません');
  if (state.session) return state.session;
  if (!state.creating) {
    state.creating = (async () => {
      try {
        const availability = await LanguageModel.availability(LOCAL_LLM_OPTIONS);
        if (availability === 'unavailable') throw new Error('この端末でLocal LLMを利用できません（メモリ・CPU/GPU・空き容量を確認してください）');
        if (activeChatDomain === domain && activeChatProfileId === profileId) {
          chatStatusEl.textContent =
            availability === 'downloadable'
              ? 'Local LLM モデルのダウンロードを開始しています…（容量・対処方法はⓘ）'
              : availability === 'downloading'
              ? 'Local LLM モデルをダウンロード中…（容量・対処方法はⓘ）'
              : 'Local LLM モデルを読み込み中…';
        }
        const initialPrompts = [
          {
            role: 'system',
            content: chatSystemPrompt(domain),
          },
          ...state.history.slice(-10).map((item) => ({ role: item.role, content: item.content })),
        ];
        state.session = await LanguageModel.create({
          ...LOCAL_LLM_OPTIONS,
          signal,
          initialPrompts,
          monitor(monitor) {
            monitor.addEventListener('downloadprogress', (event) => {
              const loaded = event.total ? event.loaded / event.total : event.loaded;
              if (activeChatDomain === domain && activeChatProfileId === profileId) {
                chatStatusEl.textContent = Number.isFinite(loaded)
                  ? `Local LLM モデルをダウンロード中… ${Math.round(loaded * 100)}%`
                  : 'Local LLM モデルをダウンロード中…';
              }
            });
          },
        });
        return state.session;
      } finally {
        state.creating = null;
      }
    })();
  }
  return state.creating;
}

async function askLlm(question) {
  if (!doc || !activeChatDomain || chatBusy) return;
  const askedDomain = activeChatDomain;
  const askedProfileId = activeChatProfileId;
  const profile = chatProfile();
  if (!profile) return;
  const askedDoc = doc;
  const configuredLimit = Number(profile.maxContextChars ?? DEFAULT_CHAT_CONTEXT_CHARS);
  const contextLimit = Math.max(0, Math.min(50000, Number.isFinite(configuredLimit) ? configuredLimit : DEFAULT_CHAT_CONTEXT_CHARS));
  const context = chatContext(question, contextLimit);
  const controller = new AbortController();
  let stopReason = '';
  let timeout = null;
  const startResponseTimeout = () => {
    clearTimeout(timeout);
    timeout = setTimeout(() => {
      stopReason = 'timeout';
      controller.abort();
    }, CHAT_TIMEOUT_MS);
  };
  currentChatAbort = {
    abort(reason = 'manual') {
      stopReason = reason;
      controller.abort();
    },
  };
  chatBusy = true;
  chatInput.disabled = true;
  btnChatSend.disabled = true;
  btnChatStop.hidden = false;
  chatStatusEl.classList.remove('error');
  chatStatusEl.textContent = '準備中…';
  appendChatMessage('user', question);
  const answerEl = appendChatMessage('assistant', '');
  try {
    const state = await llmState(askedDomain, askedProfileId);
    const prompt = context
      ? `[現在のページ]\n${askedDoc.title || ''}\n${askedDoc.url}\n\n[質問に関連する原文と訳文]\n${context}\n\n[質問]\n${question}`
      : question;
    let answer = '';
    if (profile.provider === 'chrome') {
      const session = await createLlmSession(state, askedDomain, askedProfileId, controller.signal);
      if (activeChatDomain === askedDomain && activeChatProfileId === askedProfileId) {
        chatStatusEl.textContent = context ? `回答を生成中…（ページ文脈 ${context.length.toLocaleString()}文字）` : '回答を生成中…（ページ文脈なし）';
      }
      startResponseTimeout();
      const stream = session.promptStreaming(prompt, { signal: controller.signal });
      let renderFrame = 0;
      const renderPartial = () => {
        if (renderFrame) return;
        renderFrame = requestAnimationFrame(() => {
          renderFrame = 0;
          renderMarkdown(answerEl, answer);
          chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
        });
      };
      try {
        for await (const chunk of stream) {
          // 現行Chromeは文字列を返す。将来のtyped chunkもテキストだけ受け取れるようにする。
          const text = typeof chunk === 'string' ? chunk : chunk?.type === 'text' ? chunk.value : '';
          if (!text) continue;
          answer += text;
          startResponseTimeout(); // ストリーミング中は「全体時間」ではなく無応答時間を監視する。
          renderPartial();
        }
      } finally {
        if (renderFrame) cancelAnimationFrame(renderFrame);
      }
    } else {
      if (activeChatDomain === askedDomain && activeChatProfileId === askedProfileId) {
        chatStatusEl.textContent = context ? `回答中…（ページ文脈 ${context.length.toLocaleString()}文字）` : '回答中…（ページ文脈なし）';
      }
      startResponseTimeout();
      answer = await apiChat(
        [
          { role: 'system', content: chatSystemPrompt(askedDomain) },
          ...state.history.slice(-10),
          { role: 'user', content: prompt },
        ],
        {
          provider: profile.provider,
          url: (profile.url || '').replace(/\/+$/, ''),
          apiKey: profile.apiKey || '',
          model: profile.model || '',
          signal: controller.signal,
        }
      );
    }
    if (!answer.trim()) answer = '回答を生成できませんでした。';
    renderMarkdown(answerEl, answer);
    state.history.push({ role: 'user', content: question }, { role: 'assistant', content: answer });
    state.history = state.history.slice(-MAX_CHAT_MESSAGES);
    await chrome.storage.session.set({ [llmHistoryKey(askedDomain, askedProfileId)]: state.history });
    if (activeChatDomain === askedDomain && activeChatProfileId === askedProfileId) {
      chatStatusEl.textContent = profile.provider === 'chrome' ? 'ローカルで回答しました' : `${profile.name} で回答しました`;
    }
  } catch (err) {
    answerEl.remove();
    const state = await llmState(askedDomain, askedProfileId);
    if (profile.provider === 'chrome' && (stopReason || err?.name === 'AbortError')) {
      state.session?.destroy?.();
      state.session = null;
    }
    if (activeChatDomain === askedDomain && activeChatProfileId === askedProfileId) {
      chatStatusEl.textContent = stopReason === 'timeout' ? '90秒応答がなかったため停止しました' : stopReason ? '回答を停止しました' : llmErrorMessage(err, profile.provider);
      chatStatusEl.classList.toggle('error', !stopReason);
    }
    console.warn('LLM chat failed', err);
  } finally {
    clearTimeout(timeout);
    currentChatAbort = null;
    chatBusy = false;
    chatInput.disabled = false;
    btnChatSend.disabled = false;
    btnChatStop.hidden = true;
    if (activeChatDomain === askedDomain && activeChatProfileId === askedProfileId) chatInput.focus();
  }
}

async function resetLlmChat() {
  if (!activeChatDomain || chatBusy) return;
  const state = await llmState(activeChatDomain, activeChatProfileId);
  if (state.history.length && !confirm(`「${activeChatDomain}」の会話履歴を消去しますか？`)) return;
  state.session?.destroy?.();
  state.session = null;
  state.creating = null;
  state.history = [];
  await chrome.storage.session.remove(llmHistoryKey(activeChatDomain, activeChatProfileId));
  renderChatHistory([]);
  chatStatusEl.textContent = '会話をリセットしました';
}

// ---------------------------------------------------------------------------
// 表示（ツールバー）
// ---------------------------------------------------------------------------
function setNotice(message) {
  noticeEl.hidden = !message;
  noticeEl.textContent = message || '';
  // ヘッダーを閉じていても致命的なエラーや権限案内は見逃さない。
  // 自動で開いた状態は保存せず、次回起動時はユーザーの設定を尊重する。
  if (message && toolbar.hidden) setToolbarOpen(true, false);
}

function showEmpty(message) {
  doc = null;
  switchChatDomain(null);
  run++;
  frameToken++;
  ready = false;
  frame.hidden = true;
  frame.removeAttribute('srcdoc');
  emptyEl.hidden = false;
  emptyEl.textContent = message;
  titleEl.textContent = '';
  titleEl.removeAttribute('href');
  statusEl.textContent = '';
  setNotice('');
  extractionWarningEl.hidden = true;
  extractionWarningEl.textContent = '';
  progressEl.classList.remove('active');
}

function setStatus(done, total, failed) {
  const pair = activeLanguagePair ? `（${activeLanguagePair}）` : '';
  progressEl.firstElementChild.style.width = `${total ? (done / total) * 100 : 0}%`;
  progressEl.classList.toggle('active', done < total);
  if (done < total) statusEl.textContent = `翻訳中 ${done}/${total} ${pair}`.trim();
  else statusEl.textContent = failed ? `完了（失敗 ${failed}）${pair}` : `完了 ${total} ブロック ${pair}`.trim();
}

// ---------------------------------------------------------------------------
// 複製（iframe）の読み込みと描画
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadFrame() {
  const token = ++frameToken;
  ready = false;
  frameLoaded = false;
  fMainScroller = null;
  fSyncable = [];
  scrollerReady = false;
  frame.hidden = true;
  emptyEl.hidden = false;
  emptyEl.textContent = 'ページの複製を読み込み中…';

  let html;
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'snapshot', docId: doc.id });
    html = res?.html;
    if (!html) throw new Error(res?.error || 'empty');
  } catch (err) {
    if (token !== frameToken) return;
    emptyEl.textContent = 'ページの複製を取得できませんでした。\nページを再読み込みしてから、もう一度アイコンをクリックしてください。';
    console.warn('snapshot failed', err);
    return;
  }
  if (token !== frameToken) return;
  frame.srcdoc = html;

  // DOM が使えるようになったら（画像や CSS の完了を待たずに）準備する
  for (let k = 0; k < 200 && token === frameToken; k++) {
    await sleep(100);
    let d;
    try {
      d = frame.contentDocument;
    } catch {
      continue;
    }
    if (d && d.readyState !== 'loading' && d.querySelector('[data-st-i]')) {
      onFrameReady(token);
      return;
    }
  }
  if (token === frameToken) {
    emptyEl.textContent = 'ページの複製の読み込みがタイムアウトしました。\n再翻訳ボタンを押して、もう一度お試しください。';
  }
}

frame.addEventListener('load', () => {
  try {
    if (frame.contentDocument?.querySelector('[data-st-i]')) {
      frameLoaded = true;
      ensureMainScroller();
    }
  } catch {
    /* 別の文書 */
  }
});

/**
 * 複製（iframe）内で実際にスクロールしている要素を検出する（ScrollSync.detect、content.js と共通）。
 * ページ本体（body/html）が overflow:hidden で、内部の専用コンテナがスクロールするタイプのサイトでは、
 * fwin 自体はスクロールしないため、この要素を見つけて使わないと追従しない。
 * CSS が効いていないと誤判定するので、frameLoaded（iframe の load イベント）後にのみ実行する。
 */
function ensureMainScroller() {
  if (scrollerReady || !frameLoaded || !els.length) return;
  scrollerReady = true;
  ({ mainScroller: fMainScroller, syncable: fSyncable } = ScrollSync.detect(fdoc, fwin, els));
}

const fScrollTop0 = () => (fMainScroller ? fMainScroller.getBoundingClientRect().top : 0);

function onFrameReady(token) {
  if (token !== frameToken || ready) return;
  fdoc = frame.contentDocument;
  fwin = frame.contentWindow;
  els = [];
  origNodes = [];
  fdoc.querySelectorAll('[data-st-i]').forEach((el) => {
    els[Number(el.getAttribute('data-st-i'))] = el;
  });
  els.forEach((el, i) => {
    if (el) origNodes[i] = [...el.childNodes];
  });

  const style = fdoc.createElement('style');
  style.textContent = FRAME_CSS;
  fdoc.head.append(style);
  retryBtn = fdoc.createElement('button');
  retryBtn.id = 'st-retry';
  retryBtn.type = 'button';
  retryBtn.title = 'この文を再翻訳';
  retryBtn.textContent = '↻';
  fdoc.body.append(retryBtn);

  attachFrameListeners();
  ready = true;
  emptyEl.hidden = true;
  frame.hidden = false;
  paintAll();
}

/** 訳を差し込んだ Node 列。複製とページで構造が食い違っていたら、構造は復元せず文字だけにする。 */
function renderNodes(i) {
  const raw = curStore[i];
  const b = doc.blocks[i];
  const plain = () => [fdoc.createTextNode(C.plainText(raw, b.m, b.markCount, b.text))];
  try {
    if (JSON.stringify(C.plan(origNodes[i]).wraps) !== JSON.stringify(b.w)) return plain();
    return C.compose(origNodes[i], raw, fdoc);
  } catch (err) {
    console.warn('compose failed', i, err);
    return plain();
  }
}

function paint(i) {
  const el = els[i];
  if (!ready || !el) return;
  const st = stateArr[i];
  if (st === 'done') {
    el.removeAttribute('data-st-state');
    el.replaceChildren(...renderNodes(i));
  } else if (st === 'busy') {
    el.setAttribute('data-st-state', 'busy'); // 元の訳を残したまま薄く表示
  } else {
    el.replaceChildren(...origNodes[i]); // 訳が来るまでは元の文章（薄く）
    el.setAttribute('data-st-state', st);
  }
}

function paintAll() {
  if (!ready || !doc) return;
  fdoc.documentElement.dir = selTl.value === 'Arabic' ? 'rtl' : fdoc.documentElement.dir;
  for (let i = 0; i < doc.blocks.length; i++) paint(i);
}

function setState(i, st) {
  stateArr[i] = st;
  paint(i);
  if (hoverIdx === i) positionRetry(i);
}

// ---------------------------------------------------------------------------
// 翻訳ジョブ
// ---------------------------------------------------------------------------
async function translateAll(force = false) {
  if (!doc) return;
  activeLanguagePair = '';
  paused = false;
  btnPause.textContent = '一時停止';
  const my = ++run;
  const lang = selTl.value;
  const profileId = activeProfileId;
  const store = currentStore(force);
  curStore = store;
  const total = doc.blocks.length;
  setNotice('');

  let done = 0;
  let failed = 0;
  const skip = new Set(); // 処理中・失敗済みのブロック
  stateArr = store.map((t) => (t != null ? 'done' : 'pending'));
  done = stateArr.filter((s) => s === 'done').length;
  paintAll();
  setStatus(done, total, failed);
  if (done === total) return;

  translating = true;
  try {
    try {
      await checkBackend();
    } catch (err) {
      if (my !== run) return;
      setNotice(explain(err));
      statusEl.textContent = '翻訳できません';
      return;
    }
    if (my !== run) return;

    // いま見ている位置から先（→戻って手前）へ、未翻訳のブロックを 1 つ選ぶ
    const pick = () => {
      for (let k = 0; k < total; k++) {
        const i = (anchor + k) % total;
        if (store[i] == null && !skip.has(i)) return i;
      }
      return -1;
    };

    async function worker() {
      for (let i = pick(); my === run && i !== -1; i = pick()) {
        skip.add(i);
        try {
          const text = await translateBlockAt(i, lang);
          if (my !== run) return; // 別のページ・言語に切り替わった
          remember(store, i, text, profileId, lang);
          setState(i, 'done');
        } catch (err) {
          if (my !== run) return;
          console.warn('translate failed', i, err);
          if (err.fatal) {
            run++; // 他のワーカーも止める
            setNotice(explain(err));
            setState(i, 'error');
            statusEl.textContent = '翻訳を中断しました';
            progressEl.classList.remove('active');
            return;
          }
          failed++;
          setState(i, 'error');
        }
        done++;
        setStatus(done, total, failed);
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  } finally {
    // このジョブがまだ「現行世代」であるときだけ下ろす（新しいジョブに引き継がれていたら触らない）
    if (my === run) translating = false;
  }
}

/**
 * スクロールで見ている場所（anchor）が変わったときに呼ぶ。
 * ちょうど良いタイミングで再開できるよう、ジョブが止まっていて（完了・致命的エラーによる中断など）
 * まだ未訳のブロックが残っていれば、キャッシュを消さずに翻訳を再開する。
 * これがないと、致命的エラーで中断した後や全ブロックを訳し終えた後は、
 * スクロールしても「見ている場所を優先する」仕組みが機能しなくなる（誰も pick() を呼ばなくなるため）。
 */
function resumeIfIdle() {
  if (!doc || translating || paused) return;
  if (stateArr.some((s) => s === 'pending')) translateAll();
}

/** 一時停止/再開。一時停止中は、新しいブロックの翻訳を発行しない（実行中の 1〜数件は最後まで走る）。 */
function togglePause() {
  if (!doc) return;
  paused = !paused;
  if (paused) {
    run++; // ワーカーの pick() ループを止める（この生成の finally は my!==run になるので translating はここで自分で下ろす）
    translating = false;
    btnPause.textContent = '再開';
    statusEl.textContent = '一時停止中';
    progressEl.classList.remove('active');
  } else {
    resumeIfIdle();
  }
}
btnPause.addEventListener('click', togglePause);

const retrying = new Set();

/** 1 ブロックだけ訳し直す。訳済みのブロックは毎回違う候補が出るよう temperature を上げる。 */
async function retryBlock(i) {
  if (retrying.has(i) || !doc) return;
  const my = run;
  const store = currentStore(false);
  const lang = selTl.value;
  const profileId = activeProfileId;
  const hadText = store[i] != null;
  retrying.add(i);
  setState(i, hadText ? 'busy' : 'pending');
  try {
    const text = await translateBlockAt(i, lang, hadText ? 0.6 : 0);
    if (my === run) {
      remember(store, i, text, profileId, lang);
      setState(i, 'done');
    }
  } catch (err) {
    if (my === run) {
      setState(i, hadText ? 'done' : 'error'); // 失敗しても元の訳は残す
      setNotice(explain(err));
    }
  } finally {
    retrying.delete(i);
  }
}

// ---------------------------------------------------------------------------
// ページ（原文）との連携
// ---------------------------------------------------------------------------
function sendToPage(msg) {
  if (tabId == null || !doc) return;
  chrome.tabs.sendMessage(tabId, { ...msg, docId: doc.id }).catch(() => {});
}

let hoverIdx = null;
function setHover(i) {
  if (hoverIdx != null) els[hoverIdx]?.removeAttribute('data-st-hl');
  hoverIdx = i;
  if (i == null || !els[i]) return;
  els[i].setAttribute('data-st-hl', '');
}

function positionRetry(i) {
  if (!retryBtn) return;
  if (i == null || stateArr[i] !== 'done' || !els[i]) {
    retryBtn.style.display = 'none';
    retryIdx = null;
    return;
  }
  const r = els[i].getBoundingClientRect();
  retryIdx = i;
  // 28pxのクリック領域の下端を対象ブロック上端へ接続し、前ブロックへ
  // mouseover が抜ける隙間を作らない。見た目は訳文の外側に置く。
  retryBtn.style.top = `${Math.max(2, Math.min(r.top - 28, fwin.innerHeight - 28))}px`;
  retryBtn.style.left = `${Math.max(2, Math.min(r.right - 28, fwin.innerWidth - 30))}px`;
  retryBtn.style.display = 'block';
}

let driver = false; // ユーザーがこのパネルを操作しているときだけ、スクロールをページへ送る
let rafPending = false;

function attachFrameListeners() {
  // iframe内の操作も、親パネルの一時UIに対する「外側クリック」とEscapeとして扱う。
  fdoc.addEventListener('pointerdown', () => setChatInfoOpen(false), { passive: true });
  fdoc.addEventListener('keydown', handleEscape, true);

  // ホバー → ページのブロックをハイライト
  fdoc.addEventListener('mouseover', (e) => {
    if (e.target === retryBtn) return;
    const el = e.target.closest?.('[data-st-i]');
    const i = el ? Number(el.getAttribute('data-st-i')) : null;
    if (i === hoverIdx) return;
    setHover(i);
    positionRetry(i);
    sendToPage({ type: 'highlight', block: i });
    if (i != null) {
      anchor = i;
      resumeIfIdle();
    }
  });
  fdoc.documentElement.addEventListener('mouseleave', () => {
    if (hoverIdx == null) return;
    setHover(null);
    positionRetry(null);
    sendToPage({ type: 'highlight', block: null });
  });
  fdoc.addEventListener(
    'click',
    (e) => {
      if (e.target === retryBtn) {
        if (retryIdx != null) retryBlock(retryIdx);
        return;
      }
      const el = e.target.closest?.('[data-st-i]');
      if (el && stateArr[Number(el.getAttribute('data-st-i'))] === 'error') {
        e.preventDefault();
        retryBlock(Number(el.getAttribute('data-st-i')));
      }
    },
    true
  );

  // スクロール → 翻訳の優先位置を更新し、ページを同じブロックへ（ユーザー操作時のみ）
  for (const ev of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
    fdoc.addEventListener(ev, () => (driver = true), { passive: true });
  }
  fdoc.addEventListener(
    'scroll',
    () => {
      if (rafPending || !doc) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        ensureMainScroller();
        positionRetry(hoverIdx);
        const atEnd = fMainScroller
          ? fMainScroller.scrollTop > 0 && fMainScroller.scrollTop + fMainScroller.clientHeight >= fMainScroller.scrollHeight - 2
          : fwin.scrollY > 0 && Math.ceil(fwin.scrollY + fwin.innerHeight) >= fdoc.documentElement.scrollHeight - 2;
        const top = fScrollTop0();
        let msg = null;
        for (let i = 0; i < els.length; i++) {
          if (!els[i]) continue;
          const r = els[i].getBoundingClientRect();
          if (r.height === 0 || r.bottom <= top + 1) continue;
          if (frameLoaded && !fSyncable[i]) continue;
          anchor = i;
          msg = { type: 'scrollTo', block: i, frac: Math.min(1, Math.max(0, (top - r.top) / r.height)) };
          break;
        }
        if (chkSync.checked && driver && frameLoaded) sendToPage(atEnd ? { type: 'scrollTo', end: true } : msg);
      });
    },
    { capture: true, passive: true }
  );
}

// ページ側からの通知
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!doc || sender.tab?.id !== tabId || msg.docId !== doc.id) return;
  driver = false; // ページ主導の間は、パネルのスクロールを送り返さない
  if (msg.type === 'hover') {
    if (ready) {
      setHover(msg.block);
      positionRetry(null);
    }
    if (msg.block != null) {
      anchor = msg.block;
      resumeIfIdle();
    }
  } else if (msg.type === 'scroll') {
    anchor = msg.end ? doc.blocks.length - 1 : msg.block;
    if (!chkSync.checked || !ready) return;
    ensureMainScroller();
    if (msg.end) {
      if (fMainScroller) fMainScroller.scrollTo({ top: fMainScroller.scrollHeight, behavior: 'instant' });
      else fwin.scrollTo({ top: fdoc.documentElement.scrollHeight, behavior: 'instant' });
    } else if (els[msg.block]) {
      const r = els[msg.block].getBoundingClientRect();
      const sc = fMainScroller || fwin;
      sc.scrollBy({ top: r.top + msg.frac * r.height - fScrollTop0(), behavior: 'instant' });
    }
  }
});

// ---------------------------------------------------------------------------
// ページ（doc）の切替
// ---------------------------------------------------------------------------
const NO_DOC_MESSAGE =
  'このタブはまだ翻訳されていません。\nツールバーの拡張機能アイコン（または Alt+Shift+T）をクリックしてください。';

async function applyDoc(d) {
  hoverIdx = null;
  driver = false;
  if (!d) {
    showEmpty(NO_DOC_MESSAGE);
    return;
  }
  doc = d;
  const extraction = d.extraction || {};
  if (extraction.truncatedBy === 'blocks') {
    extractionWarningEl.textContent =
      `本文が抽出上限の${Number(extraction.maxBlocks).toLocaleString()}ブロックに達したため、後半は未抽出です。` +
      '上限を増やし、元ページで拡張機能アイコンをもう一度クリックしてください。';
    extractionWarningEl.hidden = false;
  } else if (extraction.truncatedBy === 'characters') {
    extractionWarningEl.textContent =
      `本文が安全上限の${Number(extraction.maxChars).toLocaleString()}文字に達したため、後半は未抽出です。`;
    extractionWarningEl.hidden = false;
  } else {
    extractionWarningEl.hidden = true;
    extractionWarningEl.textContent = '';
  }
  if (!extractionWarningEl.hidden && toolbar.hidden) setToolbarOpen(true, false);
  switchChatDomain(d);
  curStore = [];
  stateArr = d.blocks.map(() => 'pending');
  titleEl.textContent = d.title || d.url;
  titleEl.href = d.url;
  titleEl.title = d.url;
  await restoreCache();
  if (doc !== d) return;
  loadFrame();
  translateAll();
}

async function loadDoc() {
  const key = `doc:${tabId}`;
  applyDoc((await chrome.storage.session.get(key))[key]);
}

// アイコンの再クリックでページが再抽出されたとき（doc が置き換わる／遷移で消える）
chrome.storage.session.onChanged.addListener((changes) => {
  const change = changes[`doc:${tabId}`];
  if (change) applyDoc(change.newValue);
});

// ---------------------------------------------------------------------------
// モデル設定（複数保存して切り替え）
// ---------------------------------------------------------------------------
function defaultsFor(provider) {
  return PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.ollama;
}

/** 既存と同じ名前なら "Ollama 2" のように連番を付け、新規追加しても一覧で見分けられるようにする。 */
function uniqueProfileName(base) {
  const existing = new Set(profiles.map((p) => p.name));
  if (!existing.has(base)) return base;
  let n = 2;
  while (existing.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

function makeProfile(provider) {
  const d = defaultsFor(provider);
  return {
    id: crypto.randomUUID(),
    name: uniqueProfileName(d.label),
    provider,
    url: d.url,
    apiKey: '',
    model: d.model,
    template: STTranslate.DEFAULT_TEMPLATE,
    region: '',
  };
}

function saveProfiles() {
  return chrome.storage.local.set({ profiles, activeProfileId });
}

function populateProfileSelect() {
  selProfile.replaceChildren(...profiles.map((p) => new Option(p.name || '(無題)', p.id)));
  selProfile.value = activeProfileId;
}

/** PLaMo-2-Translate は専用の固定プロンプトを使うため、翻訳指示（テンプレート）を無視する。 */
function isPlamoModel(provider, model) {
  return provider === 'ollama' && /plamo/i.test(model || '');
}

function updateProviderVisibility(provider) {
  const d = defaultsFor(provider);
  rowUrl.hidden = provider === 'chrome';
  rowKey.hidden = !d.needsKey;
  rowRegion.hidden = !d.needsRegion;
  rowModel.hidden = !d.needsModel;
  rowTemplate.hidden = !d.needsTemplate;
  btnRefreshModels.hidden = provider !== 'ollama';
  const plamo = isPlamoModel(provider, inModel.value);
  inTemplate.disabled = plamo || !d.needsTemplate;
  cfgHint.textContent =
    provider === 'chrome'
      ? 'Chrome 138 以降または対応版Edgeの内蔵 Translator API を使います。初回だけ言語モデルを取得し、翻訳は端末内で実行されます。APIキーとOllamaは不要です。'
      : provider === 'ollama'
      ? plamo
        ? 'モデル名に "plamo" を含むため、PLaMo-2-Translate 専用の高品質な翻訳ロジックを使います。翻訳指示（テンプレート）はこのモデルでは使われないため編集できません。'
        : '下の翻訳指示を Ollama 標準のチャットテンプレートに渡して翻訳します。'
      : provider === 'openai'
      ? 'OpenAI 本体のほか、Groq・OpenRouter・DeepSeek・LM Studio など /chat/completions 互換のエンドポイントを指定できます。URL は /v1 まで含めてください。'
      : provider === 'anthropic'
      ? 'Anthropic の Messages API（Claude）を使います。'
      : provider === 'google'
      ? '翻訳専用の API です（モデル・指示文の指定はありません）。Google Cloud のAPIキーが必要です。月50万文字まで無料です。'
      : 'Azure の翻訳専用 API です（モデル・指示文の指定はありません）。サブスクリプションキーに加えて、多くのリソースでリージョン（例: japaneast、不明なら global）の指定が必要です。月200万文字まで無料です。';
}

/** Ollama にインストール済みのモデル一覧を取得し、モデル欄の候補（datalist）に反映する。 */
async function refreshOllamaModels() {
  const url = (inUrl.value.trim() || PROVIDER_DEFAULTS.ollama.url).replace(/\/+$/, '');
  btnRefreshModels.disabled = true;
  try {
    const res = await fetch(`${url}/api/tags`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { models = [] } = await res.json();
    modelList.replaceChildren(...models.map((m) => new Option(m.name || m.model)));
    setNotice(models.length ? '' : `${url} にインストール済みのモデルが見つかりませんでした。`);
  } catch (err) {
    setNotice(`Ollama（${url}）のモデル一覧を取得できませんでした: ${err.message || err}`);
  } finally {
    btnRefreshModels.disabled = false;
  }
}
btnRefreshModels.addEventListener('click', refreshOllamaModels);

function fillEditor(p) {
  inName.value = p.name;
  selProvider.value = p.provider;
  inUrl.value = p.url;
  inKey.value = p.apiKey || '';
  inRegion.value = p.region || '';
  inModel.value = p.model;
  inTemplate.value = p.template || '';
  updateProviderVisibility(p.provider);
}

/** 編集欄の現在値を、選択中のプロファイルへ書き戻す。「更新」を押すまでは反映されない。 */
function commitEditor() {
  const p = activeProfile();
  if (!p) return;
  p.provider = selProvider.value;
  const d = defaultsFor(p.provider);
  p.name = inName.value.trim() || d.label;
  p.url = inUrl.value.trim().replace(/\/+$/, '') || d.url;
  p.apiKey = inKey.value;
  p.region = inRegion.value.trim();
  p.model = inModel.value.trim() || d.model;
  p.template = inTemplate.value;
  populateProfileSelect(); // 名前の変更を一覧に反映
  saveProfiles();
}

// -------------------------------------------------------------------------
// ホスト権限（Ollama 以外の既定ホスト・カスタム URL は実行時に許可を求める）
//   manifest.json の host_permissions で localhost / api.openai.com / api.anthropic.com は
//   あらかじめ許可済み。それ以外（自前サーバー・別のクラウドプロキシ等）だけ、ユーザー操作の
//   タイミングで chrome.permissions.request を呼ぶ（この API はユーザー操作中でないと使えない）。
// -------------------------------------------------------------------------
function originOf(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/*`;
  } catch {
    return null;
  }
}

function providerNeedsHost(provider) {
  return provider !== 'chrome';
}

async function hasHostPermission(url) {
  const origin = originOf(url);
  if (!origin) return false;
  try {
    return await chrome.permissions.contains({ origins: [origin] });
  } catch {
    return false;
  }
}

async function ensureHostPermission(url, provider = selProvider.value) {
  if (!providerNeedsHost(provider)) return true;
  const origin = originOf(url);
  if (!origin) return false;
  if (await hasHostPermission(url)) return true;
  try {
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (!granted) setNotice(`${origin} へのアクセスが許可されなかったため、接続できません。`);
    return granted;
  } catch (err) {
    console.warn('permission request failed', err);
    return false;
  }
}

selProfile.addEventListener('change', async () => {
  activeProfileId = selProfile.value;
  fillEditor(activeProfile()); // 編集欄の下書きは捨てて、選び直したプロファイルの内容を表示する
  await saveProfiles();
  await ensureHostPermission(activeProfile().url);
  translateAll(); // 強制はしない。そのプロファイルで訳し済みのキャッシュがあればそのまま使う
});

// プロバイダーを切り替えたときは、編集欄の URL/モデルがまだ既定値のままなら新しいプロバイダーの
// 既定値に合わせる（下書きの更新のみ。保存や再翻訳は「更新」ボタンを押すまで行わない）。
selProvider.addEventListener('change', () => {
  const provider = selProvider.value;
  const d = defaultsFor(provider);
  const wasDefaultUrl = Object.values(PROVIDER_DEFAULTS).some((pd) => pd.url === inUrl.value.trim());
  const wasDefaultModel = Object.values(PROVIDER_DEFAULTS).some((pd) => pd.model === inModel.value.trim());
  if (wasDefaultUrl) inUrl.value = d.url;
  if (wasDefaultModel) inModel.value = d.model;
  updateProviderVisibility(provider);
});

// モデル名を打ち替えたときも、plamo かどうかに応じて翻訳指示欄の有効/無効をその場で切り替える
inModel.addEventListener('input', () => updateProviderVisibility(selProvider.value));

/**
 * 「更新」ボタン。編集欄の内容を選択中のプロファイルへ反映し、保存する。
 * 強制的な全件再翻訳はしない（設定を少し変えただけで訳文が全部消えるのは煩わしいため）。
 * モデルや指示文を変えてやり直したいときは、既存の「再翻訳」ボタンを使う。
 */
async function updateActiveProfile() {
  commitEditor();
  await ensureHostPermission(activeProfile().url);
  translateAll();
}

btnUpdate.addEventListener('click', async () => {
  await updateActiveProfile();
  const original = btnUpdate.textContent;
  btnUpdate.textContent = '更新しました ✓';
  btnUpdate.disabled = true;
  setTimeout(() => {
    btnUpdate.textContent = original;
    btnUpdate.disabled = false;
  }, 1200);
});

/** 編集欄に今表示されている内容をそのまま新しいプロファイルにする（複製・下書きの保存）。 */
function profileFromEditor() {
  const provider = selProvider.value;
  const d = defaultsFor(provider);
  return {
    id: crypto.randomUUID(),
    name: uniqueProfileName(inName.value.trim() || d.label),
    provider,
    url: inUrl.value.trim().replace(/\/+$/, '') || d.url,
    apiKey: inKey.value,
    region: inRegion.value.trim(),
    model: inModel.value.trim() || d.model,
    template: inTemplate.value,
  };
}

btnAdd.addEventListener('click', async () => {
  const p = profileFromEditor();
  profiles.push(p);
  activeProfileId = p.id;
  populateProfileSelect();
  fillEditor(p);
  await saveProfiles();
  await ensureHostPermission(p.url);
  inName.focus();
  inName.select();
  translateAll();
});

btnDelete.addEventListener('click', async () => {
  if (profiles.length <= 1) {
    setNotice('最後の1つのモデル設定は削除できません。');
    return;
  }
  const profile = activeProfile();
  if (!confirm(`翻訳モデル設定「${profile?.name || '(無題)'}」を削除しますか？`)) return;
  profiles = profiles.filter((p) => p.id !== activeProfileId);
  activeProfileId = profiles[0].id;
  populateProfileSelect();
  fillEditor(activeProfile());
  await saveProfiles();
  translateAll();
});

// ---------------------------------------------------------------------------
// LLMチャット用モデル設定（翻訳モデル設定とは別管理）
// ---------------------------------------------------------------------------
function chatDefaultsFor(provider) {
  return CHAT_PROVIDER_DEFAULTS[provider] || CHAT_PROVIDER_DEFAULTS.ollama;
}

function uniqueChatProfileName(base) {
  const existing = new Set(chatProfiles.map((p) => p.name));
  if (!existing.has(base)) return base;
  let n = 2;
  while (existing.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

function makeChatProfile(provider = 'ollama', id = crypto.randomUUID()) {
  const d = chatDefaultsFor(provider);
  return {
    id,
    name: uniqueChatProfileName(d.label),
    provider,
    url: d.url,
    apiKey: '',
    model: d.model,
    maxContextChars: DEFAULT_CHAT_CONTEXT_CHARS,
  };
}

function saveChatProfiles() {
  return chrome.storage.local.set({ chatProfiles, activeChatProfileId });
}

function updateChatProviderVisibility() {
  const provider = selChatCfgProvider.value;
  const d = chatDefaultsFor(provider);
  selChatCfgProvider.disabled = false;
  rowChatCfgUrl.hidden = provider === 'chrome';
  rowChatCfgKey.hidden = !d.needsKey;
  rowChatCfgModel.hidden = provider === 'chrome';
  btnChatCfgRefresh.hidden = provider !== 'ollama';
  btnChatCfgDelete.disabled = chatProfiles.length <= 1;
  chatCfgHint.textContent =
    provider === 'chrome'
      ? 'Chromeが管理する内蔵モデルを端末内で使います。モデル名は変更できません。'
      : provider === 'ollama'
      ? 'OllamaのチャットAPIを使います。翻訳用モデルとは別のモデルを指定できます。'
      : provider === 'openai'
      ? 'OpenAI本体または /chat/completions 互換APIを使います。URLは /v1 まで含めてください。'
      : 'Anthropic Messages APIを使います。';
}

function fillChatEditor(profile) {
  if (!profile) return;
  selChatCfgProfile.value = profile.id;
  inChatCfgName.value = profile.name || '';
  selChatCfgProvider.value = profile.provider;
  inChatCfgUrl.value = profile.url || '';
  inChatCfgKey.value = profile.apiKey || '';
  inChatCfgModel.value = profile.model || '';
  inChatCfgContextLimit.value = profile.maxContextChars ?? DEFAULT_CHAT_CONTEXT_CHARS;
  updateChatProviderVisibility();
}

function populateChatConfigSelect() {
  selChatCfgProfile.replaceChildren(...chatProfiles.map((p) => new Option(p.name || '(無題)', p.id)));
  selChatCfgProfile.value = activeChatProfileId;
}

function refreshChatProfileControls() {
  populateChatProfileSelect();
  populateChatConfigSelect();
  fillChatEditor(chatProfile());
}

selChatCfgProfile.addEventListener('change', () => {
  activeChatProfileId = selChatCfgProfile.value;
  refreshChatProfileControls();
  saveChatProfiles();
  switchChatDomain(doc);
});

selChatCfgProvider.addEventListener('change', () => {
  const provider = selChatCfgProvider.value;
  const d = chatDefaultsFor(provider);
  const knownUrls = Object.values(CHAT_PROVIDER_DEFAULTS).map((item) => item.url);
  const knownModels = Object.values(CHAT_PROVIDER_DEFAULTS).map((item) => item.model);
  if (knownUrls.includes(inChatCfgUrl.value.trim())) inChatCfgUrl.value = d.url;
  if (knownModels.includes(inChatCfgModel.value.trim())) inChatCfgModel.value = d.model;
  updateChatProviderVisibility();
});

btnChatCfgRefresh.addEventListener('click', async () => {
  const url = (inChatCfgUrl.value.trim() || CHAT_PROVIDER_DEFAULTS.ollama.url).replace(/\/+$/, '');
  btnChatCfgRefresh.disabled = true;
  try {
    const res = await fetch(`${url}/api/tags`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { models = [] } = await res.json();
    chatCfgModelList.replaceChildren(...models.map((m) => new Option(m.name || m.model)));
    chatStatusEl.textContent = models.length ? `${models.length}件のOllamaモデルを取得しました` : 'Ollamaモデルが見つかりませんでした';
  } catch (err) {
    chatStatusEl.textContent = `Ollamaモデル一覧を取得できませんでした: ${err.message || err}`;
    chatStatusEl.classList.add('error');
  } finally {
    btnChatCfgRefresh.disabled = false;
  }
});

btnChatCfgUpdate.addEventListener('click', async () => {
  if (chatBusy) return;
  const profile = chatProfile();
  if (!profile) return;
  const provider = selChatCfgProvider.value;
  const defaults = chatDefaultsFor(provider);
  const url = inChatCfgUrl.value.trim().replace(/\/+$/, '') || defaults.url;
  if (!(await ensureHostPermission(url, provider))) return;
  Object.assign(profile, {
    name: inChatCfgName.value.trim() || defaults.label,
    provider,
    url,
    apiKey: inChatCfgKey.value,
    model: inChatCfgModel.value.trim() || defaults.model,
    maxContextChars: Math.max(0, Math.min(50000, Number(inChatCfgContextLimit.value) || 0)),
  });
  refreshChatProfileControls();
  await saveChatProfiles();
  btnChatCfgUpdate.textContent = '更新しました ✓';
  setTimeout(() => (btnChatCfgUpdate.textContent = '更新'), 1200);
});

btnChatCfgAdd.addEventListener('click', async () => {
  if (chatBusy) return;
  const profile = makeChatProfile('ollama');
  chatProfiles.push(profile);
  activeChatProfileId = profile.id;
  refreshChatProfileControls();
  await saveChatProfiles();
  await ensureHostPermission(profile.url, profile.provider);
  inChatCfgName.focus();
  inChatCfgName.select();
  switchChatDomain(doc);
});

btnChatCfgDelete.addEventListener('click', async () => {
  if (chatBusy) return;
  if (chatProfiles.length <= 1) return;
  const profile = chatProfile();
  if (!confirm(`LLMチャットモデル設定「${profile?.name || '(無題)'}」を削除しますか？`)) return;
  const removedId = activeChatProfileId;
  chatProfiles = chatProfiles.filter((p) => p.id !== removedId);
  activeChatProfileId = chatProfiles[0].id;
  refreshChatProfileControls();
  await saveChatProfiles();
  switchChatDomain(doc);
});

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------
const normalizedExtractionMaxBlocks = () => Math.max(100, Math.min(10000, Math.round(Number(inExtractionMaxBlocks.value) || 5000)));
const savePrefs = () =>
  chrome.storage.local.set({
    source: selSl.value,
    target: selTl.value,
    sync: chkSync.checked,
    extractionMaxBlocks: normalizedExtractionMaxBlocks(),
  });

function setToolbarOpen(open, save = true) {
  toolbar.hidden = !open;
  if (!open) {
    translateSettings.open = false;
    chatSettings.open = false;
  }
  btnToolbarToggle.setAttribute('aria-expanded', String(open));
  btnToolbarToggle.textContent = open ? '閉じる' : '設定';
  btnToolbarToggle.title = open ? 'ヘッダーを隠す' : '翻訳設定を表示';
  clampFloatingControl(btnToolbarToggle);
  if (isChatOpen() && chatPane.style.flexBasis) setChatHeight(chatPane.getBoundingClientRect().height, false);
  if (save) chrome.storage.local.set({ toolbarOpen: open });
}

const isChatOpen = () => !chatPane.hidden && !chatPane.classList.contains('collapsed');

function setChatInfoOpen(open, returnFocus = false) {
  chatInfo.hidden = !open;
  btnChatInfoToggle.setAttribute('aria-expanded', String(open));
  if (!open && returnFocus && isChatOpen()) btnChatInfoToggle.focus();
}

function updateChatResizerAria(open, height = 0) {
  const toolbarHeight = toolbar.hidden ? 0 : toolbar.getBoundingClientRect().height;
  const max = Math.max(MIN_CHAT_HEIGHT, innerHeight - toolbarHeight - 80);
  chatResizer.setAttribute('aria-valuemin', String(open ? MIN_CHAT_HEIGHT : 0));
  chatResizer.setAttribute('aria-valuemax', String(max));
  chatResizer.setAttribute('aria-valuenow', String(open ? Math.round(height || chatPane.getBoundingClientRect().height) : 0));
  chatResizer.setAttribute('aria-valuetext', open ? `チャットの高さ ${Math.round(height || chatPane.getBoundingClientRect().height)}ピクセル` : 'チャットは閉じています');
}

function setChatOpen(open, save = true) {
  chatPane.hidden = false;
  chatPane.classList.toggle('collapsed', !open);
  if (!open) setChatInfoOpen(false);
  btnChatToggle.hidden = open; // 開いている間は入力欄に重ねず、ヘッダーの × で閉じる
  btnChatToggle.setAttribute('aria-expanded', String(open));
  btnChatToggle.textContent = 'AI';
  btnChatToggle.title = 'LLMチャットを開く';
  chatResizer.setAttribute('aria-label', open ? 'チャットの高さを変更' : '上へドラッグしてチャットを開く');
  chatResizer.title = open ? 'ドラッグまたは矢印キーで高さを変更' : '上へドラッグまたは上矢印キーでチャットを開く';
  clampFloatingControl(btnChatToggle);
  if (open) {
    if (!doc) {
      chatStatusEl.textContent = '先に翻訳するページを開いてください。';
      chatStatusEl.classList.add('error');
    } else {
      chatInput.focus();
    }
  }
  updateChatResizerAria(open);
  if (save) chrome.storage.local.set({ chatOpen: open });
}

function setChatHeight(height, save = true) {
  const toolbarHeight = toolbar.hidden ? 0 : toolbar.getBoundingClientRect().height;
  const max = Math.max(MIN_CHAT_HEIGHT, innerHeight - toolbarHeight - 80);
  const value = Math.max(MIN_CHAT_HEIGHT, Math.min(Number(height) || 0, max));
  chatPane.style.flexBasis = `${value}px`;
  updateChatResizerAria(true, value);
  if (save) chrome.storage.local.set({ chatHeight: value });
}

function closeChatFromResize() {
  // 極小の高さを記憶しない。次に開いたときはCSSの既定サイズを使う。
  chatPane.style.flexBasis = '';
  chatPane.classList.remove('close-ready');
  chrome.storage.local.remove('chatHeight');
  setChatOpen(false);
}

function makeChatResizable(initialHeight) {
  if (Number.isFinite(initialHeight)) setChatHeight(initialHeight, false);
  let drag = null;
  chatResizer.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const collapsed = !isChatOpen();
    const height = chatPane.getBoundingClientRect().height;
    drag = {
      pointerId: event.pointerId,
      y: event.clientY,
      height,
      requestedHeight: collapsed ? 0 : height,
      collapsed,
      previousFlexBasis: chatPane.style.flexBasis,
    };
    chatResizer.setPointerCapture(event.pointerId);
    document.body.style.cursor = 'ns-resize';
    event.preventDefault();
  });
  chatResizer.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.requestedHeight = (drag.collapsed ? 0 : drag.height) + drag.y - event.clientY;
    if (drag.collapsed) {
      const opening = drag.requestedHeight >= CHAT_CLOSE_THRESHOLD;
      chatPane.classList.toggle('collapsed', !opening);
      if (opening) setChatHeight(drag.requestedHeight, false);
    } else {
      chatPane.classList.toggle('close-ready', drag.requestedHeight <= CHAT_CLOSE_THRESHOLD);
      setChatHeight(drag.requestedHeight, false);
    }
  });
  const finish = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const completedDrag = drag;
    drag = null;
    document.body.style.cursor = '';
    chatPane.classList.remove('close-ready');
    if (completedDrag.collapsed) {
      if (completedDrag.requestedHeight >= CHAT_CLOSE_THRESHOLD) {
        setChatOpen(true);
        setChatHeight(Math.max(MIN_CHAT_HEIGHT, completedDrag.requestedHeight));
      } else {
        chatPane.classList.add('collapsed');
        chatPane.style.flexBasis = completedDrag.previousFlexBasis;
      }
    } else if (completedDrag.requestedHeight <= CHAT_CLOSE_THRESHOLD) {
      closeChatFromResize();
    } else {
      setChatHeight(chatPane.getBoundingClientRect().height);
    }
  };
  chatResizer.addEventListener('pointerup', finish);
  chatResizer.addEventListener('pointercancel', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const cancelledDrag = drag;
    drag = null;
    document.body.style.cursor = '';
    chatPane.classList.remove('close-ready');
    if (cancelledDrag.collapsed) {
      chatPane.classList.add('collapsed');
      chatPane.style.flexBasis = cancelledDrag.previousFlexBasis;
    }
  });
  chatResizer.addEventListener('keydown', (event) => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (!isChatOpen() && ['ArrowUp', 'Home', 'End'].includes(event.key)) {
      setChatOpen(true);
      if (event.key === 'Home') setChatHeight(MIN_CHAT_HEIGHT);
      if (event.key === 'End') setChatHeight(innerHeight);
      return;
    }
    if (!isChatOpen()) return;
    if (event.key === 'ArrowDown' && chatPane.getBoundingClientRect().height <= MIN_CHAT_HEIGHT) {
      closeChatFromResize();
      return;
    }
    if (event.key === 'Home') {
      setChatHeight(MIN_CHAT_HEIGHT);
      return;
    }
    if (event.key === 'End') {
      setChatHeight(innerHeight);
      return;
    }
    const delta = event.key === 'ArrowUp' ? 20 : -20;
    setChatHeight(chatPane.getBoundingClientRect().height + delta);
  });
  chatResizer.addEventListener('dblclick', () => {
    chatPane.style.flexBasis = '';
    chrome.storage.local.remove('chatHeight');
  });
}

function clampFloatingControl(button) {
  if (!button.style.left || !button.style.top) return;
  const rect = button.getBoundingClientRect();
  const left = Math.max(2, Math.min(parseFloat(button.style.left), innerWidth - rect.width - 2));
  const top = Math.max(2, Math.min(parseFloat(button.style.top), innerHeight - rect.height - 2));
  button.style.left = `${left}px`;
  button.style.top = `${top}px`;
}

function placeFloatingControl(button, position) {
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return;
  const rect = button.getBoundingClientRect();
  button.style.right = 'auto';
  button.style.bottom = 'auto';
  button.style.left = `${Math.max(2, position.x * Math.max(1, innerWidth - rect.width))}px`;
  button.style.top = `${Math.max(2, position.y * Math.max(1, innerHeight - rect.height))}px`;
  clampFloatingControl(button);
}

function makeFloatingControlDraggable(button, storageKey, onActivate, initialPosition) {
  placeFloatingControl(button, initialPosition);
  let drag = null;
  button.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const rect = button.getBoundingClientRect();
    drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false };
    button.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  button.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.hypot(dx, dy) > 4) drag.moved = true;
    if (!drag.moved) return;
    button.style.right = 'auto';
    button.style.bottom = 'auto';
    button.style.left = `${drag.left + dx}px`;
    button.style.top = `${drag.top + dy}px`;
    clampFloatingControl(button);
  });
  const finish = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const moved = drag.moved;
    drag = null;
    if (moved) {
      const rect = button.getBoundingClientRect();
      const position = {
        x: rect.left / Math.max(1, innerWidth - rect.width),
        y: rect.top / Math.max(1, innerHeight - rect.height),
      };
      chrome.storage.local.set({ [storageKey]: position });
    } else {
      onActivate();
    }
  };
  button.addEventListener('pointerup', finish);
  button.addEventListener('pointercancel', () => (drag = null));
  // キーボード操作での click は pointerup がないためここで処理する。
  button.addEventListener('click', (event) => {
    event.preventDefault();
    if (event.detail === 0) onActivate();
  });
}

chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const question = chatInput.value.trim();
  if (!question) return;
  chatInput.value = '';
  askLlm(question);
});
chatInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
    event.preventDefault();
    chatForm.requestSubmit();
  }
});
btnChatReset.addEventListener('click', resetLlmChat);
btnChatClose.addEventListener('click', () => {
  currentChatAbort?.abort('close');
  setChatOpen(false);
});
btnChatStop.addEventListener('click', () => currentChatAbort?.abort('manual'));
btnChatInfoToggle.addEventListener('click', () => {
  setChatInfoOpen(chatInfo.hidden);
});
chatInfo.addEventListener('click', async (event) => {
  const button = event.target.closest?.('[data-chrome-page]');
  if (!button) return;
  const url = button.dataset.chromePage;
  try {
    await chrome.tabs.create({ url });
  } catch (err) {
    await navigator.clipboard.writeText(url).catch(() => {});
    chatStatusEl.textContent = `${url} を開けなかったため、アドレスをコピーしました。`;
    chatStatusEl.classList.add('error');
    console.warn('failed to open Chrome diagnostics page', err);
  }
});
btnChatSettings.addEventListener('click', () => {
  const profile = chatProfile();
  setChatInfoOpen(false);
  setToolbarOpen(true);
  translateSettings.open = false;
  chatSettings.open = true;
  fillChatEditor(profile);
  (profile?.provider === 'chrome' ? selChatCfgProvider : inChatCfgModel).focus();
});

for (const details of [translateSettings, chatSettings]) {
  details.addEventListener('toggle', () => {
    if (!details.open) return;
    for (const other of [translateSettings, chatSettings]) if (other !== details) other.open = false;
  });
}

// 情報パネルはポップオーバー同様、外側の操作でも閉じる。
document.addEventListener('pointerdown', (event) => {
  if (chatInfo.hidden || chatInfo.contains(event.target) || btnChatInfoToggle.contains(event.target)) return;
  setChatInfoOpen(false);
});

// 一時的なUIを最前面から一段ずつ閉じる。入力中のIME確定操作は奪わない。
function handleEscape(event) {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;

  let handled = false;
  if (!chatInfo.hidden) {
    setChatInfoOpen(false, true);
    handled = true;
  } else {
    const openSettings = [translateSettings, chatSettings].filter((details) => details.open);
    if (openSettings.length) {
      const focused = openSettings.find((details) => details.contains(document.activeElement));
      const details = focused || openSettings.at(-1);
      details.open = false;
      details.querySelector('summary')?.focus();
      handled = true;
    } else if (!toolbar.hidden) {
      setToolbarOpen(false);
      btnToolbarToggle.focus();
      handled = true;
    } else if (isChatOpen()) {
      currentChatAbort?.abort('close');
      setChatOpen(false);
      btnChatToggle.focus();
      handled = true;
    }
  }

  if (handled) {
    event.preventDefault();
    event.stopPropagation();
  }
}

document.addEventListener('keydown', handleEscape);
selChatProfile.addEventListener('change', async () => {
  if (chatBusy) {
    selChatProfile.value = activeChatProfileId;
    return;
  }
  const next = selChatProfile.value;
  const profile = chatProfiles.find((p) => p.id === next);
  if (profile && providerNeedsHost(profile.provider) && !(await ensureHostPermission(profile.url, profile.provider))) {
    selChatProfile.value = activeChatProfileId;
    chatStatusEl.textContent = 'この接続先へのアクセス許可が必要です。';
    chatStatusEl.classList.add('error');
    return;
  }
  activeChatProfileId = next;
  refreshChatProfileControls();
  await saveChatProfiles();
  switchChatDomain(doc);
});

selSl.addEventListener('change', () => (savePrefs(), translateAll(true)));
selTl.addEventListener('change', () => (savePrefs(), translateAll()));
chkSync.addEventListener('change', savePrefs);
inExtractionMaxBlocks.addEventListener('change', () => {
  inExtractionMaxBlocks.value = normalizedExtractionMaxBlocks();
  savePrefs();
  statusEl.textContent = '抽出上限は次回のページ抽出から反映されます';
});
$('#retry').addEventListener('click', () => translateAll(true));

addEventListener('pagehide', () => {
  currentChatAbort?.abort('unload');
  for (const state of llmStates.values()) state.session?.destroy?.();
});

(async function init() {
  selSl.append(new Option('自動検出', 'auto'));
  for (const [value, label] of LANGS) selSl.append(new Option(label, value));
  for (const [value, label] of LANGS) selTl.append(new Option(label, value));
  const stored = await chrome.storage.local.get({
    source: 'auto',
    target: 'Japanese',
    sync: true,
    extractionMaxBlocks: 5000,
    toolbarOpen: false,
    chatOpen: false,
    toolbarButtonPosition: null,
    chatButtonPosition: null,
    chatHeight: null,
    profiles: null,
    chatProfiles: null,
    activeProfileId: null,
    activeChatProfileId: BUILTIN_CHAT_ID,
  });
  selSl.value = stored.source;
  if (!selSl.value) selSl.value = 'auto';
  selTl.value = stored.target;
  chkSync.checked = stored.sync;
  inExtractionMaxBlocks.value = Math.max(100, Math.min(10000, Math.round(Number(stored.extractionMaxBlocks) || 5000)));
  makeChatResizable(stored.chatHeight);
  makeFloatingControlDraggable(
    btnToolbarToggle,
    'toolbarButtonPosition',
    () => setToolbarOpen(toolbar.hidden),
    stored.toolbarButtonPosition
  );
  makeFloatingControlDraggable(
    btnChatToggle,
    'chatButtonPosition',
    () => setChatOpen(!isChatOpen()),
    stored.chatButtonPosition
  );
  setToolbarOpen(stored.toolbarOpen, false);
  setChatOpen(stored.chatOpen, false);
  addEventListener('resize', () => {
    clampFloatingControl(btnToolbarToggle);
    clampFloatingControl(btnChatToggle);
    if (isChatOpen() && chatPane.style.flexBasis) setChatHeight(chatPane.getBoundingClientRect().height, false);
    else updateChatResizerAria(isChatOpen());
  });

  if (Array.isArray(stored.profiles) && stored.profiles.length) {
    profiles = stored.profiles;
    activeProfileId = profiles.some((p) => p.id === stored.activeProfileId) ? stored.activeProfileId : profiles[0].id;
  } else {
    const initial = makeProfile('chrome');
    profiles = [initial];
    activeProfileId = initial.id;
    await saveProfiles();
  }
  populateProfileSelect();
  if (Array.isArray(stored.chatProfiles) && stored.chatProfiles.length) {
    chatProfiles = stored.chatProfiles;
  } else {
    chatProfiles = [makeChatProfile('chrome', BUILTIN_CHAT_ID)];
  }
  activeChatProfileId = chatProfiles.some((p) => p.id === stored.activeChatProfileId)
    ? stored.activeChatProfileId
    : BUILTIN_CHAT_ID;
  refreshChatProfileControls();
  await saveChatProfiles();
  switchChatDomain(doc);
  fillEditor(activeProfile());
  if (providerNeedsHost(activeProfile().provider) && !(await hasHostPermission(activeProfile().url))) {
    setNotice(
      `「${activeProfile().name}」の接続先へのアクセスが許可されていません。モデル設定のURL欄を一度保存し直すと許可を求められます。`
    );
  }

  showEmpty('読み込み中…');
  const id = Number(new URLSearchParams(location.search).get('tab'));
  if (!Number.isInteger(id)) return showEmpty(NO_DOC_MESSAGE);
  tabId = id;
  loadDoc();
})();

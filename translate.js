'use strict';

// 翻訳バックエンド。3 種類のプロバイダーに対応する。DOM 非依存（Node からもテストできる）。
//   - Ollama + PLaMo-2-Translate: 専用の高品質ロジック（文分割・暴走検出・再試行）
//   - Ollama + それ以外のモデル : Ollama 同梱のチャットテンプレートに素直な翻訳指示を渡す
//   - OpenAI 互換 API          : OpenAI 本体・Groq・OpenRouter・DeepSeek・LM Studio 等
//   - Anthropic API            : Claude
(function (root) {
  const KANA = /[぀-ヿ]/;
  const ASCII_LATIN = /^[\u0000-ɏ -⁯€]*$/; // 英語らしい文字だけ
  const CJK_LIKE = /[぀-ヿ㐀-鿿가-힯]/;
  const NO_SPACE_LANGS = new Set(['Japanese', 'Chinese', 'Korean', 'Thai']);
  const MAX_CHUNK = 1500;

  class TranslateError extends Error {
    /** code: network | forbidden | model | http | runaway */
    constructor(code, message, fatal = false) {
      super(message);
      this.code = code;
      this.fatal = fatal; // true: 続行しても全ブロック失敗する（接続不可・権限・モデル未取得）
    }
  }

  // ===========================================================================
  // Ollama + PLaMo-2-Translate 専用
  //
  // Ollama 同梱のチャットテンプレートは公式の書式（input lang=…）と違うため、文の断片を渡すと
  // 訳した後も止まらず学習データ由来の文書（"Domain: generated.ja.cosmopedia.org 第10章…"）を
  // 続けたり、"token repeat limit reached" で中断されたりする。
  // そこで公式の書式を raw で自前に組み立て、暴走を検出したら再試行する。
  // ===========================================================================
  const OP = '<|plamo:op|>';
  const HEAD = `${OP}dataset\ntranslation\n`;

  async function ollamaGenerate(body, { url }) {
    let res;
    try {
      res = await fetch(`${url}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      throw new TranslateError('network', 'Ollama に接続できません', true);
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 403) throw new TranslateError('forbidden', 'Ollama が拡張機能からのアクセスを拒否しました（403）', true);
    if (!res.ok) {
      const msg = String(data.error || `HTTP ${res.status}`);
      if (/repeat limit/i.test(msg)) throw new TranslateError('runaway', msg); // 暴走を Ollama が中断した
      if (res.status === 404) throw new TranslateError('model', msg, true);
      throw new TranslateError('http', `Ollama がエラーを返しました: ${msg}`);
    }
    return data;
  }

  async function checkOllama({ url, model }) {
    let res;
    try {
      res = await fetch(`${url}/api/tags`);
    } catch {
      throw new TranslateError('network', 'Ollama に接続できません', true);
    }
    if (res.status === 403) throw new TranslateError('forbidden', 'Ollama が拡張機能からのアクセスを拒否しました（403）', true);
    if (!res.ok) throw new TranslateError('http', `Ollama がエラーを返しました（HTTP ${res.status}）`, true);
    const { models = [] } = await res.json();
    const want = model.includes(':') ? model : `${model}:latest`;
    if (!models.some((m) => m.name === want || m.model === want)) {
      throw new TranslateError('model', `モデル ${model} が見つかりません`, true);
    }
  }

  /**
   * 'pair'    : 英⇄日。公式の書式そのまま（input lang=English|Japanese / output は言語指定なし → 自動で反対側）
   * 'generic' : それ以外（input は言語指定なし / output lang=<出力言語>）
   */
  function buildPlamoPrompt(text, target, mode) {
    if (mode === 'pair') return `${HEAD}${OP}input lang=English|Japanese\n${text}\n${OP}output\n`;
    return `${HEAD}${OP}input\n${text}\n${OP}output lang=${target}\n`;
  }

  function looksRunaway(input, out, reason) {
    if (!out || reason === 'length') return true;
    if (/Domain:\s*\S+\.\w+/i.test(out)) return true; // 学習データ由来のメタ情報が混ざった
    const ratio = CJK_LIKE.test(input) ? 10 : 4; // 日→英は文字数が数倍になる
    return out.length > input.length * ratio + 80;
  }

  /** pair モードは方向を自動判定するので、断片だと訳されず同じ言語で言い換えることがある。 */
  function wrongLanguage(input, out, target) {
    if (target === 'Japanese') return /[A-Za-z]{3,}/.test(input) && !/[぀-ヿ㐀-鿿]/.test(out);
    if (target === 'English') return KANA.test(input) && !/[A-Za-z]{2,}/.test(out);
    return false;
  }

  function pickMode(text, target) {
    const kana = KANA.test(text);
    if (target === 'Japanese' && !kana && ASCII_LATIN.test(text.replace(/[「」]/g, ''))) return 'pair';
    if (target === 'English' && kana) return 'pair';
    return 'generic';
  }

  async function plamoAttempt(text, target, mode, opts, temperature) {
    const prompt = buildPlamoPrompt(text, target, mode);
    const numPredict = Math.min(2048, Math.max(128, text.length * 3 + 64));
    const data = await ollamaGenerate(
      {
        model: opts.model,
        prompt,
        raw: true, // Ollama のテンプレートを通さず、書式を自分で組み立てる
        stream: false,
        keep_alive: '30m',
        options: {
          temperature,
          // 再試行・再翻訳（temperature > 0）のときは毎回違う候補が出るようシードも振る
          ...(temperature > 0 && { top_p: 0.95, seed: Math.floor(Math.random() * 2 ** 31) }),
          num_predict: numPredict,
          stop: ['\n', OP], // 入力は 1 行なので、出力も 1 行で終わる
        },
      },
      opts
    );
    const out = String(data.response ?? '').split(OP)[0].trim();
    if (looksRunaway(text, out, data.done_reason)) throw new TranslateError('runaway', '訳の生成が暴走しました');
    if (mode === 'pair' && wrongLanguage(text, out, target)) throw new TranslateError('wronglang', '目的の言語で出力されませんでした');
    return out;
  }

  /**
   * 最大 2 回試す。
   *  - 暴走            → 温度を変えて再試行
   *  - 言語の取り違え  → generic 形式（出力言語を明示）で再試行
   * それ以外のエラーは即座に投げる。
   */
  async function plamoTryTwice(text, target, mode, opts) {
    const retryable = (err) => err.code === 'runaway' || err.code === 'wronglang';
    const t0 = opts.temperature ?? 0;
    try {
      return await plamoAttempt(text, target, mode, opts, t0);
    } catch (err) {
      if (!retryable(err)) throw err;
      return err.code === 'wronglang'
        ? plamoAttempt(text, target, 'generic', opts, 0)
        : plamoAttempt(text, target, mode, opts, t0 === 0 ? 0.3 : 0);
    }
  }

  function splitSentences(text) {
    return text.split(/(?<=[.!?])\s+|(?<=[。！？])\s*/).filter(Boolean);
  }

  function pack(sentences, max) {
    const chunks = [];
    let cur = '';
    for (let s of sentences) {
      while (s.length > max) {
        if (cur) chunks.push(cur), (cur = '');
        chunks.push(s.slice(0, max));
        s = s.slice(max);
      }
      if (cur.length + s.length + 1 > max) chunks.push(cur), (cur = '');
      cur += (cur ? ' ' : '') + s;
    }
    if (cur) chunks.push(cur);
    return chunks;
  }

  function tidy(out, target) {
    // PLaMo は文と文の間に空白を入れないことがあるので、スペース区切りの言語では補う
    return NO_SPACE_LANGS.has(target) ? out : out.replace(/(?<=[a-z][.!?])(?=[A-Z])/g, ' ');
  }

  /** 暴走したら温度を変えて再試行 → それでもだめなら 1 文ずつ訳す。 */
  async function translatePlamo(text, target, opts) {
    const mode = pickMode(text, target);
    const join = NO_SPACE_LANGS.has(target) ? '' : ' ';
    const outs = [];
    for (const chunk of pack(splitSentences(text), MAX_CHUNK)) {
      try {
        outs.push(await plamoTryTwice(chunk, target, mode, opts));
      } catch (err) {
        if (err.code === 'wronglang') {
          outs.push(chunk); // 固有名詞やコードなど、訳しようがないもの
          continue;
        }
        const sentences = splitSentences(chunk);
        if (err.code !== 'runaway' || sentences.length < 2) throw err;
        const parts = [];
        for (const s of sentences) parts.push(await plamoTryTwice(s, target, mode, { ...opts, temperature: 0 }));
        outs.push(parts.join(join));
      }
    }
    return tidy(outs.join(join).trim() || text, target);
  }

  // ===========================================================================
  // 翻訳指示文（テンプレート）。プロファイルごとに編集できる。
  //   {target} は翻訳先の言語名に置き換える。空/未設定なら既定の指示文を使う。
  //   PLaMo-2-Translate 専用ロジック（translatePlamo）では使わない。
  // ===========================================================================
  const DEFAULT_TEMPLATE =
    'Translate the following text into {target}. Output ONLY the translation itself, ' +
    'with no explanations, notes, or surrounding quotation marks. Keep the original line breaks.';

  function buildInstruction(target, template) {
    return (template && template.trim() ? template : DEFAULT_TEMPLATE).replace(/\{target\}/g, target);
  }

  // ===========================================================================
  // Ollama + それ以外のモデル: Ollama 同梱のチャットテンプレートに素直な翻訳指示を渡す
  // ===========================================================================
  function instructPrompt(text, target, template) {
    return `${buildInstruction(target, template)}\n\n${text}`;
  }

  function stripWrap(s) {
    return s
      .trim()
      .replace(/^[「『"'](.*)["'」』]$/s, '$1')
      .trim();
  }

  async function translateOllamaGeneric(text, target, opts) {
    const data = await ollamaGenerate(
      {
        model: opts.model,
        prompt: instructPrompt(text, target, opts.template),
        stream: false,
        keep_alive: '30m',
        options: { temperature: opts.temperature ?? 0 },
      },
      opts
    );
    return stripWrap(String(data.response ?? '')) || text;
  }

  // ===========================================================================
  // OpenAI 互換 API（OpenAI 本体・Groq・OpenRouter・DeepSeek・LM Studio 等）
  //   url は /v1 までを含む base URL（例: https://api.openai.com/v1）。
  // ===========================================================================
  async function translateOpenAI(text, target, opts) {
    let res;
    try {
      res = await fetch(`${opts.url}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey || ''}` },
        body: JSON.stringify({
          model: opts.model,
          temperature: opts.temperature ?? 0,
          messages: [
            { role: 'system', content: buildInstruction(target, opts.template) },
            { role: 'user', content: text },
          ],
        }),
      });
    } catch {
      throw new TranslateError('network', 'APIに接続できません（URL・ネットワーク・拡張機能へのアクセス許可を確認してください）', true);
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) throw new TranslateError('forbidden', 'APIキーが拒否されました', true);
    if (!res.ok) {
      const msg = String(data.error?.message || data.error || `HTTP ${res.status}`);
      if (res.status === 404) throw new TranslateError('model', msg, true);
      throw new TranslateError('http', `APIがエラーを返しました: ${msg}`);
    }
    return stripWrap(data.choices?.[0]?.message?.content ?? '') || text;
  }

  // ===========================================================================
  // Anthropic API（Claude）
  // ===========================================================================
  async function translateAnthropic(text, target, opts) {
    let res;
    try {
      res = await fetch(`${opts.url}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': opts.apiKey || '',
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: opts.model,
          max_tokens: Math.min(4096, Math.max(256, text.length * 3 + 128)),
          temperature: opts.temperature ?? 0,
          system: buildInstruction(target, opts.template),
          messages: [{ role: 'user', content: text }],
        }),
      });
    } catch {
      throw new TranslateError('network', 'APIに接続できません（URL・ネットワーク・拡張機能へのアクセス許可を確認してください）', true);
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) throw new TranslateError('forbidden', 'APIキーが拒否されました', true);
    if (!res.ok) {
      const msg = String(data.error?.message || data.error || `HTTP ${res.status}`);
      if (res.status === 404) throw new TranslateError('model', msg, true);
      throw new TranslateError('http', `APIがエラーを返しました: ${msg}`);
    }
    const out = (data.content || []).map((c) => c.text || '').join('');
    return stripWrap(out) || text;
  }

  // ===========================================================================
  // 公開 API（プロバイダーで分岐）
  // ===========================================================================
  /**
   * 1 ブロックを翻訳する。
   * opts: { provider: 'ollama'|'openai'|'anthropic', url, apiKey, model, temperature = 0 }
   * Ollama かつモデル名に "plamo" を含む場合だけ、専用の高品質ロジック（文分割・暴走検出・再試行）を使う。
   */
  async function translate(text, target, opts) {
    if (target === 'Japanese' && KANA.test(text)) return text; // すでに日本語
    if (opts.provider === 'openai') return translateOpenAI(text, target, opts);
    if (opts.provider === 'anthropic') return translateAnthropic(text, target, opts);
    if (!/plamo/i.test(opts.model || '')) return translateOllamaGeneric(text, target, opts);
    return translatePlamo(text, target, opts);
  }

  /** 接続確認。OpenAI 互換・Anthropic は事前チェックをせず、実際の翻訳リクエストのエラーで判断する。 */
  async function checkBackend(opts) {
    if (opts.provider === 'openai' || opts.provider === 'anthropic') return;
    return checkOllama(opts);
  }

  const api = { translate, checkBackend, TranslateError, splitSentences, looksRunaway, DEFAULT_TEMPLATE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.STTranslate = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

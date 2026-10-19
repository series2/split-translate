# Split Translate
<img width="1903" height="834" alt="AppViewer" src="https://github.com/user-attachments/assets/c534af1d-a6db-4f9c-b483-4982b00619c8" />

Webページを左右に並べて表示する Chrome 拡張機能です。左（元のタブ）が原文、右（サイドパネル）がページをそのまま複製して文章だけを訳文に差し替えたもので、レイアウト・画像・リンクは元のページと同じまま読めます。

- マウスホバーで、原文⇔訳文の対応するブロックが連動してハイライトされます
- どちらをスクロールしても、もう片方が同じ位置まで追従します
- 翻訳は **ブラウザー内蔵翻訳（Chrome / Edge、無料・ローカル）** / **Ollama（ローカル）** / **OpenAI互換API** / **Anthropic（Claude）** / **Google Cloud Translation** / **Azure AI Translator** から選べます。複数の接続設定を保存しておき、ツールバーから切り替えられます
- Chrome内蔵のLocal LLM（Prompt API / Gemini Nano）、Ollama、OpenAI互換API、Anthropicに、現在読んでいる原文・訳文について質問できます。チャットはドメイン・接続設定ごとに分離されます

## できないこと / 制限事項

- `<pre><code>` のようなコードブロックは翻訳しません（構造を壊さないため、意図的に対象外にしています）
- 1ページあたり最大 600 ブロック・25万文字までしか抽出しません（`content.js` の `MAX_BLOCKS` / `MAX_CHARS`）
- SPA（`history.pushState` 等でページ遷移するサイト）では、別ページへ移動しても自動では再抽出しません。内容が古い・足りないと感じたら、拡張機能アイコンをもう一度クリックして再抽出してください
- 翻訳パネルはスクリプトを無効化した複製なので、元ページ側の動的な機能（フォーム送信やJS駆動のUIなど）は動作しません。閲覧・翻訳専用です

## インストール（開発者モードで読み込み）

1. このリポジトリをクローンまたはダウンロードする
2. Chrome で `chrome://extensions` を開く
3. 右上の「デベロッパーモード」をオンにする
4. 「パッケージ化されていない拡張機能を読み込む」でこのフォルダを選択する
5. ツールバーに拡張機能のアイコンが表示される

## 使い方

1. 翻訳したいページを開き、拡張機能アイコンをクリック（または `Alt+Shift+T`）
2. サイドパネルが開き、本文の抽出・翻訳が始まる
3. 必要な場合は右上の「設定」でヘッダーを開き、翻訳元（自動検出または手動）・翻訳先の言語とモデル設定を選べる
4. 原文側・パネル側のどちらでスクロール/ホバーしても、もう片方が連動する
5. 処理が重いと感じたら「一時停止」ボタンで翻訳を止められる（再開ボタンで続きから再開）
6. 翻訳に失敗した文（赤い破線の枠）はクリックすると再翻訳される
7. 右下の「AI」でパネル下部にLocal LLMチャットを開き、現在表示中の箇所や選択中の文章について質問できる

「設定」と「AI」のフローティングボタンはドラッグで移動でき、位置は保存されます。チャット枠上端のハンドルを上下にドラッグすると高さを変更でき、その高さも保存されます（ダブルクリックで初期値に戻ります）。

## Local LLM チャット

チャット上部で、Chrome内蔵の Prompt API（Gemini Nano）または保存済みのOllama・OpenAI互換API・Anthropic設定を選べます。Google Cloud TranslationとAzure AI Translatorは翻訳専用APIのため、チャットには利用できません。ホバー中または表示中のブロック周辺とその訳文、パネル内で選択した文章をコンテキストとして渡します。Web検索機能はありません。

利用モデルを変更するには、チャット上部の「モデル設定」を押し、「モデル設定を編集」でプロバイダー・URL・モデル名などを変更します。複数の設定がある場合は、チャット上部の選択欄で使用する設定を切り替えます。Chrome内蔵Local LLMのモデル自体はChromeが管理するため、モデル名は変更できません。

会話履歴とモデルセッションはドメイン・接続設定ごとに分離します。履歴は `chrome.storage.session` に保存され、ブラウザーを終了すると消去されます。Chrome内蔵LLMはモデルの初回取得後、文章や会話を外部へ送信せず端末内で処理します。初回のモデル取得や実行には、Chromeが定めるメモリ・CPU/GPU・空き容量の要件を満たす必要があります。Ollama・OpenAI互換API・Anthropicを選んだ場合は、ページ文脈と会話が設定した接続先へ送信されます。

## モデル設定（翻訳バックエンド）

ツールバーの「モデル設定」から、保存済みの設定を切り替えられます。「モデル設定を編集」を開くと、名前・プロバイダー・接続先URL・APIキー・モデル名を編集できます。「新規追加」で別の設定を追加し、用途に応じて使い分けられます（例: 普段はローカルのOllama、精度重視のときだけクラウドのモデル）。

### ブラウザー内蔵翻訳（Chrome / Edge、ローカル、無料）

デスクトップ版 Chrome 138 以降または対応版Edgeの Translator API を使います。初回の翻訳時にブラウザーが必要な言語モデルをダウンロードし、以降の翻訳は端末内で実行します。APIキーやOllamaのインストールは不要です。翻訳元は本文から自動検出しますが、誤検出するページではツールバーから手動指定できます。実際に使用中の言語ペア（例: `en → ja`）も進捗欄に表示します。

### Ollama（ローカル、無料、オフラインで使える）

既定のモデルは [`mitmul/plamo-2-translate`](https://ollama.com/mitmul/plamo-2-translate) で、日英翻訳に特化した専用のプロンプト処理（文単位の分割、暴走検出、再試行）を行います。モデル名に `plamo` を含まない Ollama モデルを指定した場合は、Ollama 標準のチャットテンプレートに素直な翻訳指示を渡す汎用処理に切り替わります（他言語や、好みのモデルを使いたい場合向け）。

セットアップ:

```sh
# Ollama をインストール後
ollama pull mitmul/plamo-2-translate
# ブラウザ拡張機能からのアクセスを許可する
OLLAMA_ORIGINS="chrome-extension://*" ollama serve
```

Mac で `launchctl` 経由で起動している場合は、環境変数の設定方法が異なります。`launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"` を実行してから Ollama を再起動してください。

### OpenAI互換API

OpenAI本体のほか、Groq・OpenRouter・DeepSeek・LM Studio・text-generation-webui など、`/chat/completions` エンドポイントを持つサービス全般に対応します。URL には `/v1` までを含めて入力してください（例: `https://api.openai.com/v1`）。APIキーが必要です。

### Anthropic

Claude の Messages API を使います。URL の既定値は `https://api.anthropic.com`。APIキーが必要です。

### Google Cloud Translation

翻訳専用の公式API（Basic v2）です。チャット用のモデル名や指示文（テンプレート）の概念はありません。[Google Cloud Console](https://console.cloud.google.com/apis/credentials) でAPIキーを発行してください。**月50万文字まで無料**（期限なし）、以降は100万文字あたり$20です。

### Azure AI Translator

Microsoft の翻訳専用API（v3.0）です。こちらもモデル名や指示文はありません。[Azure Portal](https://portal.azure.com/) で Translator リソースを作成し、サブスクリプションキーを取得してください。多くのリソースでは**リージョン**の指定も必要です（リソース作成時に選んだリージョン、例: `japaneast`。グローバルリソースの場合は `global`）。**月200万文字まで無料**（期限なし）、以降は100万文字あたり$10です。

### 自前サーバーや他のクラウドAPIを使う場合（ホスト権限）

`localhost` / `127.0.0.1`（Ollama）、`api.openai.com`、`api.anthropic.com`、`translation.googleapis.com`、`api.cognitive.microsofttranslator.com` 以外のURLを設定すると、Chromeがそのサイトへのアクセス許可を一度確認します。モデル設定のURL欄を保存すると許可ダイアログが出るので、許可してください。許可されなかった場合は通知欄にその旨が表示されます。

## プライバシー

- Chrome内蔵翻訳とOllamaでは翻訳を端末内で処理します。OpenAI/Anthropic等の外部APIを選んだ場合は翻訳テキストがそのAPIに送信されるため、機密情報を含むページではご注意ください
- チャットでChrome内蔵LLMを選んだ場合は端末内処理です。Ollama・OpenAI互換API・Anthropicを選んだ場合は、質問・会話履歴・関連するページ文章が設定した接続先へ送信されます。Web検索は行いません
- APIキーは `chrome.storage.local`（この拡張機能専用のローカルストレージ）に保存されます。外部に送信されるのは設定した翻訳APIへのリクエストのみです
- 翻訳結果はタブごとのキャッシュとして `chrome.storage.session`（ブラウザを閉じると消える）に保存されます

## 開発者向け: 構成

| ファイル | 役割 |
| --- | --- |
| `background.js` | アイコンクリックで本文を抽出・保存。ページ遷移時に古い抽出結果を破棄 |
| `content.js` | 元ページに常駐。本文ブロックの抽出、複製HTMLの生成、ホバー/スクロール同期 |
| `compose.js` | 訳文を元のDOM構造（リンク・強調など）に復元する |
| `scrollsync.js` | 本文のスクロール領域を自動検出するロジック（`content.js`・`viewer.js` で共用） |
| `translate.js` | 翻訳バックエンド（Chrome内蔵翻訳 / Ollama / OpenAI互換 / Anthropic / Google Cloud Translation / Azure AI Translator）の呼び出し |
| `viewer.js` / `viewer.html` / `viewer.css` | サイドパネル本体 |

content.js と viewer.js 側の両方で、スクロール連動・モデル設定・プロファイル切り替えのロジックが動いています。詳しい設計意図は各ファイル冒頭のコメントを参照してください。

## ライセンス

[MIT License](LICENSE)

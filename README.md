# Split Translate

Webページを左右に並べて表示する Chrome 拡張機能です。左（元のタブ）が原文、右（サイドパネル）がページをそのまま複製して文章だけを訳文に差し替えたもので、レイアウト・画像・リンクは元のページと同じまま読めます。

- マウスホバーで、原文⇔訳文の対応するブロックが連動してハイライトされます
- どちらをスクロールしても、もう片方が同じ位置まで追従します
- 翻訳は **Ollama（ローカル）** / **OpenAI互換API** / **Anthropic（Claude）** / **Google Cloud Translation** / **Azure AI Translator** から選べます。複数の接続設定を保存しておき、ツールバーから切り替えられます

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
3. パネル上部のツールバーで、翻訳先の言語とモデル設定を選べる
4. 原文側・パネル側のどちらでスクロール/ホバーしても、もう片方が連動する
5. 処理が重いと感じたら「一時停止」ボタンで翻訳を止められる（再開ボタンで続きから再開）
6. 翻訳に失敗した文（赤い破線の枠）はクリックすると再翻訳される

## モデル設定（翻訳バックエンド）

ツールバーの「モデル設定」から、保存済みの設定を切り替えられます。「モデル設定を編集」を開くと、名前・プロバイダー・接続先URL・APIキー・モデル名を編集できます。「新規追加」で別の設定を追加し、用途に応じて使い分けられます（例: 普段はローカルのOllama、精度重視のときだけクラウドのモデル）。

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

- 翻訳したいテキストは、設定したモデル（ローカルのOllama、またはOpenAI/Anthropic等の外部API）に送信されます。機密情報を含むページを外部APIで翻訳する場合はご注意ください
- APIキーは `chrome.storage.local`（この拡張機能専用のローカルストレージ）に保存されます。外部に送信されるのは設定した翻訳APIへのリクエストのみです
- 翻訳結果はタブごとのキャッシュとして `chrome.storage.session`（ブラウザを閉じると消える）に保存されます

## 開発者向け: 構成

| ファイル | 役割 |
| --- | --- |
| `background.js` | アイコンクリックで本文を抽出・保存。ページ遷移時に古い抽出結果を破棄 |
| `content.js` | 元ページに常駐。本文ブロックの抽出、複製HTMLの生成、ホバー/スクロール同期 |
| `compose.js` | 訳文を元のDOM構造（リンク・強調など）に復元する |
| `scrollsync.js` | 本文のスクロール領域を自動検出するロジック（`content.js`・`viewer.js` で共用） |
| `translate.js` | 翻訳バックエンド（Ollama / OpenAI互換 / Anthropic / Google Cloud Translation / Azure AI Translator）の呼び出し |
| `viewer.js` / `viewer.html` / `viewer.css` | サイドパネル本体 |

content.js と viewer.js 側の両方で、スクロール連動・モデル設定・プロファイル切り替えのロジックが動いています。詳しい設計意図は各ファイル冒頭のコメントを参照してください。

## ライセンス

[MIT License](LICENSE)

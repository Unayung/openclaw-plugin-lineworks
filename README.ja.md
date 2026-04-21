# @unayung/lineworks

[![npm](https://img.shields.io/npm/v/@unayung/lineworks.svg?label=npm)](https://www.npmjs.com/package/@unayung/lineworks)
[![GitHub release](https://img.shields.io/github/v/tag/Unayung/openclaw-plugin-lineworks.svg?label=github&sort=semver)](https://github.com/Unayung/openclaw-plugin-lineworks/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

[English](./README.md) · [繁體中文](./README.zh-TW.md) · **日本語**

**LINE WORKS**(Works Mobile)向けの OpenClaw サードパーティチャネルプラグイン
です。LINE が提供する**エンタープライズ向け**メッセージング製品で、一般の LINE
とはプラットフォーム、API、Bot モデルがすべて異なります。

エンドツーエンドのエージェント統合:Bot が DM とグループメッセージ(テキスト・
画像・ファイル・スタンプ・位置情報・ポストバック)を受信して openclaw agent に
転送し、agent の返信をテキスト・画像・動画・音声・ファイル・Flex カード・位置
ピン・クイックリプライボタンとして返します。

- ✅ **Inbound**:テキスト + 添付(画像は自動ダウンロードされ、ビジョン対応モデル
  が直接見られる)
- ✅ **Outbound**:テキスト・画像・動画・音声・ファイル(HTTPS URL またはローカル
  ファイルの自動アップロード)・Flex メッセージ・位置情報・クイックリプライボタン
- ✅ **Thinking ack**:エージェントの処理が 5 秒を超えたときに送る「⋯」プレース
  ホルダー(任意)
- ✅ **Multi-account**:1 回のインストールで複数の LINE WORKS Bot を動かせる
- ✅ **Pairing-gated DMs**:バンドルの LINE プラグインと同じセキュリティモデル

---

## クイックスタート

### 1. 前提条件

- **openclaw gateway** が起動済みで、パブリックインターネットから到達可能で
  あること。[openclaw remote-access パターン](https://docs.openclaw.ai/gateway/remote)
  を参照 —— VPS + リバースプロキシ、Tailscale Funnel、Cloudflare Tunnel いずれも可。
  LINE WORKS のサーバーから `POST /lineworks/webhook` が届く必要があります。
- **LINE WORKS Developer Console** のアカウントで app + bot を作成済みであること。
- `bot` と `bot.read` スコープが **付与済み**の **Service Account**(ステップ 3 参照)。

### 2. プラグインのインストール

**推奨 —— npm(または ClawHub)からインストール:**

```bash
openclaw plugins install @unayung/lineworks
openclaw gateway restart
```

`openclaw plugins install` は ClawHub を先に探し、ヒットしなければ npm にフォール
バックするため、このワンコマンドでどちらの registry に登録されていても動きます。

ほかの形:

```bash
# ClawHub を明示的に指定(ClawHub → npm のフォールバック順をスキップ):
openclaw plugins install clawhub:lineworks

# 特定の npm バージョンを固定:
openclaw plugins install @unayung/lineworks@0.1.0-poc.1

# 開発 / ローカル checkout(ソース dir を symlink するので、コード編集後は
# `openclaw gateway restart` だけで反映される、再インストール不要):
git clone https://github.com/Unayung/openclaw-plugin-lineworks.git
openclaw plugins install --link /absolute/path/to/openclaw-plugin-lineworks
```

ロード確認:

```bash
openclaw plugins list | grep lineworks      # "loaded" と表示されるはず
openclaw plugins inspect lineworks
```

### 3. Developer Console 設定 —— 以下を全て行う

[developers.worksmobile.com/console](https://developers.worksmobile.com/console/) にて:

1. **App を作成**し、**Service Account** を発行して RSA 秘密鍵(PKCS#8 PEM)を
   取得する。`.pem` ファイルはローカルに保存。
2. App / Service Account に **OAuth スコープを付与**:
   - ✅ `bot`(必須 —— メッセージ送信)
   - ✅ `bot.read`(必須 —— 添付ファイルのダウンロード)
3. App 配下に **Bot を作成**。**Bot ID** と **Bot Secret** をコピー。
4. 必要な **コールバックイベント** を有効化。最低限:
   - ✅ `message.text`(テキスト受信)
   - ✅ `message.image`(画像受信 → agent ビジョン)
   - ✅ `message.file`(ファイル受信 —— 任意)
   - ✅ `message.sticker` / `message.location` / `postback`(任意)
5. **Callback URL** を gateway の公開 URL + `/lineworks/webhook` に設定:
   ```
   https://<your-gateway-host>/lineworks/webhook
   ```

### 4. openclaw 側でチャネルを設定

PEM を保護されたパスへ保存:

```bash
mkdir -p ~/.openclaw/keys && chmod 700 ~/.openclaw/keys
mv /path/to/service-account.pem ~/.openclaw/keys/lineworks-default.pem
chmod 600 ~/.openclaw/keys/lineworks-default.pem
```

次のブロックを `~/.openclaw/openclaw.json` に追加(`agents` / `gateway` と同階層):

```json5
{
  "channels": {
    "lineworks": {
      "enabled": true,
      "clientId":       "<app client ID>",
      "clientSecret":   "<app client secret>",
      "serviceAccount": "<uuid>.serviceaccount@<domain>",
      "privateKeyFile": "/Users/<you>/.openclaw/keys/lineworks-default.pem",
      "botId":          "<bot ID>",
      "botSecret":      "<bot secret>",
      "domainId":       "<domain ID>",        // 任意
      "dmPolicy":       "pairing",             // open | allowlist | pairing | disabled
      "groupPolicy":    "allowlist",           // open | allowlist | disabled

      // 任意 —— agent が 5 秒超で返事しないとき "⋯" を自動送信。
      // "thinkingAck": { "delayMs": 5000, "text": "⋯" }
    }
  }
}
```

次に:

```bash
openclaw gateway restart
openclaw channels status         # "LINE WORKS default: enabled" が見えるはず
```

### 5. Bot に DM

完了です。gateway は起動時に
`Registered HTTP route: /lineworks/webhook for LINE WORKS` をログ出力し、返信が
流れ始めます。

---

## 設定リファレンス

### 認証情報キー(config は camelCase、env は UPPER_SNAKE)

| Config キー | Env フォールバック | 用途 |
|---|---|---|
| `clientId` | `LINEWORKS_CLIENT_ID` | Developer Console の app client ID |
| `clientSecret` | `LINEWORKS_CLIENT_SECRET` | App client secret |
| `serviceAccount` | `LINEWORKS_SERVICE_ACCOUNT` | `<uuid>.serviceaccount@<domain>` |
| `privateKey` | `LINEWORKS_PRIVATE_KEY` | インライン PKCS#8 PEM(1 行 env なら `\n` で改行) |
| `privateKeyFile` | — | **推奨。** ディスク上の PKCS#8 PEM ファイルパス |
| `botId` | `LINEWORKS_BOT_ID` | Bot ID(数値文字列) |
| `botSecret` | `LINEWORKS_BOT_SECRET` | Bot secret(webhook 署名検証用の HMAC キー) |
| `domainId` | `LINEWORKS_DOMAIN_ID` | 任意の domain / tenant ID |

Config が env より優先(`merged.clientId ?? process.env.LINEWORKS_CLIENT_ID`)。
**インライン `privateKey` より `privateKeyFile` を推奨** —— PEM を JSON
config loader 経由でラウンドトリップすると静かに壊れることがあります。

### 挙動ノブ

```json5
{
  "channels": {
    "lineworks": {
      // Bot に DM できるユーザー
      "dmPolicy": "pairing",           // open | allowlist | pairing | disabled
      "allowFrom": ["user-id-a", "user-id-b"],

      // グループチャットで Bot にメッセージを送れる相手
      "groupPolicy": "allowlist",      // open | allowlist | disabled
      "groupAllowFrom": ["channel-id-a"],

      // Gateway が LINE WORKS callback 用に登録するパス
      "webhookPath": "/lineworks/webhook",

      // Thinking インジケータ(LINE WORKS にネイティブ API は無い;遅延送信の
      // テキストメッセージで模倣)。delayMs: 0 で無効化。
      "thinkingAck": { "delayMs": 5000, "text": "⋯" },

      // グループ内で @メンション された時のみ応答する。botMentionHandle と併設。
      "groupRequireMention": true,
      "botMentionHandle": "Racco"
    }
  }
}
```

### 複数アカウント

```json5
{
  "channels": {
    "lineworks": {
      "enabled": true,
      "defaultAccount": "main",
      "accounts": {
        "main":      { "botId": "...", "botSecret": "...", "privateKeyFile": "..." },
        "support":   { "botId": "...", "botSecret": "...", "privateKeyFile": "..." }
      }
    }
  }
}
```

---

## Outbound メッセージ形式

Agent が reply payload を生成します。このプラグインは `text`、`mediaUrls` /
`mediaUrl`、`channelData.lineworks`、および返信文内の**テキストディレクティブ**
を調べます。順序:media → text → Flex → location。クイックリプライのチップは
シーケンスの最後のメッセージに付きます。

### テキスト

```js
{ text: "Hello!" }
```

約 2000 文字を超えると改行境界で自動分割。

### メディア(画像 / 動画 / 音声 / ファイル)

reply に `mediaUrl`(単一)または `mediaUrls`(リスト)を置き、以下のいずれかを
指定:

- **HTTPS URL** —— LINE WORKS が直接取得しに行く。
- **ローカルファイルパス** —— プラグインが LINE WORKS の attachment API で 2 段
  階アップロード(uploadUrl 要求 → multipart POST)した後、fileId メッセージ
  として送信。

拡張子でメッセージ種別が決まる:

| 拡張子 | メッセージ種別 |
|---|---|
| `.jpg .jpeg .png .gif .webp .heic` | インライン画像 |
| `.mp4 .mov .m4v .avi .webm` | インライン動画 |
| `.mp3 .m4a .wav .aac .ogg` | インライン音声 |
| それ以外(`.md .pdf .csv .txt` …) | ファイル添付 |

制限:
- 動画を HTTPS URL で送るにはプレビューサムネイルが必須;無ければローカルファイル
  アップロードを使ってください。
- 音声の再生時間は指定が無いと約 10 秒にフォールバック。
- ローカルファイルアップロードの上限は約 15 MB。

### Flex メッセージ —— `[[flex: <altText> ||| <JSON>]]`

リッチカード(bubble / carousel)。コンシューマ LINE の Flex と形式が完全に同一。

```
[[flex: Order #1234 ||| {"type":"bubble","body":{"type":"box","layout":"vertical","contents":[{"type":"text","text":"Order #1234","weight":"bold"},{"type":"text","text":"Total: $12"}]}}]]
```

またはプログラム的に:

```js
{
  text: "Order received",
  channelData: {
    lineworks: {
      flexMessage: { altText: "Order #1234", contents: { /* bubble */ } }
    }
  }
}
```

### 位置情報 —— `[[location: <title> | <address> | <lat> | <lng>]]`

```
[[location: 東京スカイツリー | 東京都墨田区押上1-1-2 | 35.7101 | 139.8107]]
```

### クイックリプライボタン —— `[[quick_replies: label1, label2, label3]]`

直前のメッセージに付くタップチップ。最大 13 個。項目ごとのバリアント:

| 構文 | アクション |
|---|---|
| `Label` | `"Label"` をユーザー発言として送信 |
| `Label > text` | 任意テキストをユーザー発言として送信 |
| `Label > https://example.com` | URL を開く |
| `Label > data:foo=bar` | postback イベントを返す、`data=foo=bar` |

```
Pick one: [[quick_replies: Yes, No, Maybe, Learn more > https://help.example]]
```

### 組み合わせ

```js
{
  text: "レポートはこちら 👇\n[[quick_replies: Download, Share, Cancel]]",
  mediaUrl: "/path/to/report.pdf"     // ファイル添付としてアップロード
}
```

---

## Agent 向けディレクティブ・チートシート

Agent の system prompt を制御できるなら、以下のブロックを入れておくと agent が
自律的にリッチ形式を出せます:

```
LINE WORKS チャネルは返信テキスト内で以下のディレクティブをサポートします:

- [[flex: <altText> ||| <JSON>]]
    リッチカード(LINE Flex bubble/carousel JSON)。

- [[location: <title> | <address> | <lat> | <lng>]]
    マップのピン。

- [[quick_replies: Label1, Label2 > text, Label3 > https://url, Label4 > data:x]]
    タップチップ(≤13)。既定の動作は message(text=label);矢印の後に続けることで
    uri / postback 動作に切り替わる。

ファイル / メディアは reply payload に `mediaUrl: "/path/or/https URL"` を出力。
拡張子(.png/.mp4/.mp3/.pdf/…)で適切なメッセージ種別が自動選択される。
```

これらのヒントは `agentPrompt.messageToolHints` にも注入され、openclaw の
**native** agent runner が読みます。`claude-cli`(Claude Code)経由で agent を
実行している場合、現状ヒントは伝わりません —— 上記ブロックを agent 自身の
system prompt に直接貼り付けてください。

---

## トラブルシューティング

| 症状 | 想定原因 / 対処 |
|---|---|
| Install が "credential harvesting" scan で止まる | プラグインツリー内に `process.env` と `fetch` が同じファイルに混在している。entry ファイル + `src/` のみ配布、開発スクリプトは除外。 |
| `Plugin manifest id "lineworks" differs from npm package name …` | 参考情報のみ。Package 名は manifest id または `@scope/` の unscoped 部分と一致する必要がある。このプラグインは `@unayung/lineworks` を使い、条件を満たす。 |
| 送信時 `www.worksapis.com` から 401 | Service Account に `bot` / `bot.read` スコープが Developer Console で付与されていない。トークン要求時の scope 指定だけでは不十分 —— app の認可が必要。 |
| `error:0680008E:asn1 encoding routines::not enough data` | 秘密鍵文字列が JSON ラウンドトリップで壊れた。`privateKeyFile` でディスク上の PEM ファイルを指す方式に切り替え。 |
| 添付ダウンロードで 401 | 上と同じ(scope)、**または** Node の fetch が 302 redirect で Authorization を剥がした。このプラグインは手動処理済み;それでも出るならやはり scope。 |
| `content.previewImageUrl must begin with https://` | Agent がローカルファイルパスを mediaUrl に出力。通常は自動アップロードされる。`outbound.sendMedia` を直接叩いた場合(稀)は HTTPS URL が必要。 |
| テキストは届くが画像は届かない | Developer Console のコールバックイベントで `message.text` しか有効化されていない。`message.image`(必要なら `message.file` 等)を有効化。 |
| `Agent reply started` は出るが delivery が無い | Agent バックエンドがハング / 認証情報なし。`/tmp/openclaw/openclaw-*.log` で model provider の `FailoverError` を確認。 |
| Gateway ログに `pairing required` 1008 error が大量 | **このプラグインとは無関係。** ローカルの別 openclaw CLI がスコープアップグレードを試みている。`~/.openclaw/devices/pending.json` を確認し、`openclaw devices list` → `approve <id>` or `reject`。 |
| 長い agent 返信がファイルではなくインラインテキストで届く | Agent の system prompt が「長文は mediaUrl で」を知らない。上のディレクティブ・チートシートを prompt に貼る。 |
| Outbound 画像が壊れたプレースホルダで表示 | 拡張子が画像ではない。プラグインは拡張子で分岐する —— 画像は `.png`/`.jpg` 等に;それ以外はファイル添付扱い。 |

---

## アーキテクチャ概観

```
   LINE WORKS server
         │
         │  HTTPS POST + X-WORKS-Signature
         ▼
   あなたの公開 URL  →  openclaw gateway  →  /lineworks/webhook
                                │
                                │  署名検証(HMAC-SHA256)
                                │  イベント解析(fileId 対応)
                                │  添付ダウンロード(bot.read scope)
                                ▼
                         agent route 解決
                                │
                                ▼
                      dispatchReplyWithBufferedBlockDispatcher
                                │
                                │  deliver(payload)
                                ▼
         [directives + media + flex + location + quick-replies]
                                │
                                ▼
        JWT service account → access token (bot bot.read)
                                │
                                ▼
   POST https://www.worksapis.com/v1.0/bots/{botId}/{users|channels}/{id}/messages
```

各層は独立してユニットテストされています。`src/channel.ts` の ChannelPlugin
SDK ワイヤリングは openclaw repo 内バンドルの `synology-chat` と `line`
プラグインと同じパターンに従います。

---

## 開発

```bash
pnpm install       # または npm install
pnpm typecheck
pnpm test          # 48+ 個のユニットテスト;約 500ms
```

プロジェクト構成:

```
src/
  accounts.ts          — マルチアカウント resolver + env フォールバック + PEM 正規化
  attachments.ts       — inbound ダウンロード(302-redirect 対応)+ outbound アップロード
  auth.ts              — JWT RS256 + single-flight token refresh
  channel.ts           — createChatChannelPlugin 全アダプタ込み
  config-schema.ts     — チャネル設定の zod スキーマ
  directives.ts        — flex / location / quick_replies パーサ
  gateway-runtime.ts   — /lineworks/webhook の registerPluginHttpRoute
  inbound-context.ts   — FinalizedMsgContext 構築(media payload 含む)
  inbound-turn.ts      — 返信 dispatcher + 遅延 ack + outbound シーケンサ
  runtime.ts           — PluginRuntime ストア
  send.ts              — POST /bots/{botId}/(users|channels)/{id}/messages
  session-key.ts       — buildAgentSessionKey
  setup-surface.ts     — ChannelSetupAdapter + ウィザード
  types.ts             — LINE WORKS コンテンツ型の全定義
  webhook-handler.ts   — openclaw webhook-ingress primitives を使う HTTP handler
  webhook.ts           — 署名検証 + イベントパース
index.ts               — defineBundledChannelEntry
api.ts                 — 公開 export(index.ts の specifier が使用)
setup-entry.ts         — defineBundledChannelSetupEntry
setup-api.ts           — setup wizard export
openclaw.plugin.json   — プラグイン manifest(id、channels、env vars、schema)
```

---

## 参考

- [LINE WORKS Developers](https://developers.worksmobile.com/en/docs/api)
- [LINE WORKS Node.js サンプル(bot-echo-express)](https://github.com/lineworks/works-api-code-samples/tree/master/samples/nodejs/bot-echo-express)
- [OpenClaw plugin SDK](https://docs.openclaw.ai/plugins/sdk-overview)
- openclaw repo 内のリファレンステンプレート:
  - `extensions/line/` —— コンシューマ LINE(Flex 形式は同じ)
  - `extensions/synology-chat/` —— 類似の ChannelPlugin 構造(webhook + upload)
  - `extensions/feishu/` —— 類似の JWT service-account 認証

## License

MIT

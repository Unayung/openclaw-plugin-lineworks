# @unayung/lineworks

[![npm](https://img.shields.io/npm/v/@unayung/lineworks.svg?label=npm)](https://www.npmjs.com/package/@unayung/lineworks)
[![GitHub release](https://img.shields.io/github/v/tag/Unayung/openclaw-plugin-lineworks.svg?label=github&sort=semver)](https://github.com/Unayung/openclaw-plugin-lineworks/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

[English](./README.md) · **繁體中文** · [日本語](./README.ja.md)

為 OpenClaw 打造的第三方 **LINE WORKS**(Works Mobile)頻道外掛 —— LINE 推出的
企業級通訊平台。平台、API 與 Bot 模型皆與一般 LINE 不同。

端對端的 Agent 整合:Bot 接收私訊與群組訊息(文字、圖片、檔案、貼圖、位置、
postback),轉送給你的 openclaw agent,並將 agent 的回覆以文字、圖片、影片、
語音、檔案、Flex 卡片、釘選位置、快速回覆按鈕等形式送回。

- ✅ **Inbound**:文字 + 附件(圖片會自動下載,讓視覺模型直接看到)
- ✅ **Outbound**:文字、圖片、影片、語音、檔案(HTTPS URL 或本地檔案自動上傳)、
  Flex 訊息、位置、快速回覆按鈕
- ✅ **Thinking ack**:選擇性的 "⋯" 佔位訊息,當 agent 處理超過 5 秒時送出
- ✅ **Multi-account**:一次安裝即可驅動多個 LINE WORKS Bot
- ✅ **Pairing-gated DMs**:與內建 LINE 外掛相同的安全模型

---

## 快速上手

### 1. 前置需求

- 一個 **openclaw gateway** 正在執行,且可從公網存取。參考
  [openclaw remote-access 模式](https://docs.openclaw.ai/gateway/remote)
  —— VPS + reverse proxy、Tailscale Funnel 或 Cloudflare Tunnel 都可以。
  LINE WORKS 的伺服器必須能 `POST /lineworks/webhook` 到你的 gateway。
- 一個 **LINE WORKS Developer Console** 帳號,已建立 app + bot。
- 一個 **Service Account**,已授予 `bot` 與 `bot.read` scope(見步驟 3)。

### 2. 安裝外掛

**建議作法 —— 從 npm(或 ClawHub)安裝:**

```bash
openclaw plugins install @unayung/lineworks
openclaw gateway restart
```

`openclaw plugins install` 會先查 ClawHub 再 fallback 到 npm,因此這一行指令
無論外掛登記在哪個 registry 都能正確找到。

其他安裝方式:

```bash
# 明確指定 ClawHub 查詢(跳過 ClawHub → npm 的 fallback 順序):
openclaw plugins install clawhub:lineworks

# 鎖定 npm 的特定版本:
openclaw plugins install @unayung/lineworks@0.1.0-poc.1

# 開發 / 本地 checkout(建立 symlink,修改原始碼後只要重新啟動 gateway
# 即可生效,不需重新 install):
git clone https://github.com/Unayung/openclaw-plugin-lineworks.git
openclaw plugins install --link /absolute/path/to/openclaw-plugin-lineworks
```

驗證是否已載入:

```bash
openclaw plugins list | grep lineworks      # 應顯示 "loaded"
openclaw plugins inspect lineworks
```

### 3. Developer Console 設定 —— 以下全部都要做

於 [developers.worksmobile.com/console](https://developers.worksmobile.com/console/):

1. **建立一個 app**,核發 **Service Account** 並取得 RSA 私鑰(PKCS#8 PEM)。
   將 `.pem` 檔案存在本地。
2. **授予 OAuth scopes** 給 app / Service Account:
   - ✅ `bot`(必須 —— 送訊息)
   - ✅ `bot.read`(必須 —— 下載附件)
3. **在 app 下建立 bot**。複製 **Bot ID** 與 **Bot Secret**。
4. **啟用你需要的 callback events**。至少包含:
   - ✅ `message.text`(inbound 文字)
   - ✅ `message.image`(inbound 圖片 → agent 視覺)
   - ✅ `message.file`(inbound 檔案 —— 選擇性)
   - ✅ `message.sticker` / `message.location` / `postback`(選擇性)
5. **設定 Callback URL** 為你的 gateway 公開 URL 加 `/lineworks/webhook`:
   ```
   https://<your-gateway-host>/lineworks/webhook
   ```

### 4. 在 openclaw 中設定此頻道

將 PEM 存到權限受保護的位置:

```bash
mkdir -p ~/.openclaw/keys && chmod 700 ~/.openclaw/keys
mv /path/to/service-account.pem ~/.openclaw/keys/lineworks-default.pem
chmod 600 ~/.openclaw/keys/lineworks-default.pem
```

把以下區塊加到 `~/.openclaw/openclaw.json`(與 `agents` / `gateway` 同層):

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
      "domainId":       "<domain ID>",        // 選擇性
      "dmPolicy":       "pairing",             // open | allowlist | pairing | disabled
      "groupPolicy":    "allowlist",           // open | allowlist | disabled

      // 選擇性 —— 若 agent 處理超過 5 秒,自動送出 "⋯" 佔位訊息。
      // "thinkingAck": { "delayMs": 5000, "text": "⋯" }
    }
  }
}
```

接著:

```bash
openclaw gateway restart
openclaw channels status         # 應顯示 "LINE WORKS default: enabled"
```

### 5. 私訊你的 Bot

完成了!Gateway 啟動時會在 log 印出
`Registered HTTP route: /lineworks/webhook for LINE WORKS`,回覆會正常流動。

---

## 設定參考

### 憑證欄位(config 用 camelCase、env 用 UPPER_SNAKE)

| Config key | Env fallback | 用途 |
|---|---|---|
| `clientId` | `LINEWORKS_CLIENT_ID` | Developer Console 的 app client ID |
| `clientSecret` | `LINEWORKS_CLIENT_SECRET` | App client secret |
| `serviceAccount` | `LINEWORKS_SERVICE_ACCOUNT` | `<uuid>.serviceaccount@<domain>` |
| `privateKey` | `LINEWORKS_PRIVATE_KEY` | 行內 PKCS#8 PEM(若使用單行 env,以 `\n` 分行) |
| `privateKeyFile` | — | **推薦作法。** 指向磁碟上的 PKCS#8 PEM 檔案路徑 |
| `botId` | `LINEWORKS_BOT_ID` | Bot ID(純數字字串) |
| `botSecret` | `LINEWORKS_BOT_SECRET` | Bot secret(webhook 簽章驗證用的 HMAC key) |
| `domainId` | `LINEWORKS_DOMAIN_ID` | 選擇性的 domain / tenant ID |

Config 優先於 env(`merged.clientId ?? process.env.LINEWORKS_CLIENT_ID`)。
**建議使用 `privateKeyFile` 而非行內的 `privateKey`** —— PEM 透過 JSON config
loader 來回序列化時可能會被破壞。

### 行為調整旋鈕

```json5
{
  "channels": {
    "lineworks": {
      // 誰可以私訊 bot
      "dmPolicy": "pairing",           // open | allowlist | pairing | disabled
      "allowFrom": ["user-id-a", "user-id-b"],

      // 誰可以在群組中對 bot 發訊息
      "groupPolicy": "allowlist",      // open | allowlist | disabled
      "groupAllowFrom": ["channel-id-a"],

      // Gateway 註冊 LINE WORKS callback 的 path
      "webhookPath": "/lineworks/webhook",

      // Thinking 指示(LINE WORKS 沒有原生 API;這裡用一則延遲文字訊息模擬)。
      // delayMs: 0 表示停用。
      "thinkingAck": { "delayMs": 5000, "text": "⋯" },

      // 群組中僅在被 @提及 時才回應。需同時設定 botMentionHandle。
      "groupRequireMention": true,
      "botMentionHandle": "Racco"
    }
  }
}
```

### 多帳號

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

## Outbound 訊息格式

Agent 產生回覆 payload。本外掛會檢查 `text`、`mediaUrls` / `mediaUrl`、
`channelData.lineworks`,再加上回覆文字中嵌入的**文字指示符(directive)**。
順序:media → text → Flex → location。快速回覆按鈕附著在序列的最後一則訊息上。

### 文字

```js
{ text: "Hello!" }
```

超過約 2000 字時,以換行為邊界自動切段。

### 多媒體(圖片 / 影片 / 語音 / 檔案)

回覆中放 `mediaUrl`(單個)或 `mediaUrls`(列表),指向:

- **HTTPS URL** —— LINE WORKS 會直接去抓。
- **本地檔案路徑** —— 外掛會用 LINE WORKS 的 attachment API 分兩步上傳
  (要求 uploadUrl → 上傳 multipart),再以 fileId 訊息送出。

訊息型態由副檔名決定:

| 副檔名 | 訊息型態 |
|---|---|
| `.jpg .jpeg .png .gif .webp .heic` | 行內圖片 |
| `.mp4 .mov .m4v .avi .webm` | 行內影片 |
| `.mp3 .m4a .wav .aac .ogg` | 行內語音 |
| 其他(`.md .pdf .csv .txt` …) | 檔案附件 |

限制:
- 以 HTTPS URL 送影片需附預覽縮圖;若沒有可改用本地檔案上傳。
- 語音若未提供時長,預設為約 10 秒。
- 本地檔案上傳約 15 MB 上限。

### Flex 訊息 —— `[[flex: <altText> ||| <JSON>]]`

豐富卡片(bubble 或 carousel),格式與 LINE 消費端的 Flex 完全相同。

```
[[flex: Order #1234 ||| {"type":"bubble","body":{"type":"box","layout":"vertical","contents":[{"type":"text","text":"Order #1234","weight":"bold"},{"type":"text","text":"Total: $12"}]}}]]
```

或以結構化方式:

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

### 位置 —— `[[location: <title> | <address> | <lat> | <lng>]]`

```
[[location: 台北 101 | 信義區信義路五段 7 號 | 25.0330 | 121.5654]]
```

### 快速回覆按鈕 —— `[[quick_replies: label1, label2, label3]]`

附著在最後一則訊息下方的 chip。最多 13 個。每個項目可用:

| 語法 | 行為 |
|---|---|
| `Label` | 送出 `"Label"` 作為使用者回覆 |
| `Label > text` | 送出指定文字作為使用者回覆 |
| `Label > https://example.com` | 開啟 URL |
| `Label > data:foo=bar` | 回傳 postback event,`data=foo=bar` |

```
Pick one: [[quick_replies: Yes, No, Maybe, Learn more > https://help.example]]
```

### 組合使用

```js
{
  text: "這是你的報告 👇\n[[quick_replies: Download, Share, Cancel]]",
  mediaUrl: "/path/to/report.pdf"     // 以檔案附件上傳
}
```

---

## 給 Agent 的指示符速查表

若你可以控制 agent 的 system prompt,把下面這段放進去,agent 就能自主輸出
豐富格式:

```
LINE WORKS 頻道支援下列回覆文字的 directive:

- [[flex: <altText> ||| <JSON>]]
    豐富卡片(LINE Flex bubble/carousel JSON)。

- [[location: <title> | <address> | <lat> | <lng>]]
    釘選地圖位置。

- [[quick_replies: Label1, Label2 > text, Label3 > https://url, Label4 > data:x]]
    Tap-chip(≤13)。預設動作為 message(text=label);箭頭後的標的切換為
    uri / postback 動作。

檔案 / 媒體:在回覆 payload 輸出 `mediaUrl: "/path/or/https URL"`。
副檔名(.png/.mp4/.mp3/.pdf/…)會自動選擇對應的訊息型態。
```

這些提示也會注入到 `agentPrompt.messageToolHints`,openclaw 的 **native** agent
runner 會讀取。若你的 agent 經由 `claude-cli`(Claude Code)執行,這個提示
目前不會傳遞進去 —— 請把上面那段直接貼進 agent 自己的 system prompt。

---

## 疑難排解

| 症狀 | 可能原因 / 修正 |
|---|---|
| Install 被 "credential harvesting" scan 擋住 | 外掛檔案樹中有檔案同時使用 `process.env` 與 `fetch`。只發佈 entry 檔 + `src/`,排除開發腳本。 |
| `Plugin manifest id "lineworks" differs from npm package name …` | 警告訊息而已。Package name 必須等於 manifest id,或其 `@scope/` 的 unscoped 部分。這個外掛用 `@unayung/lineworks`,符合檢查。 |
| 外送到 `www.worksapis.com` 時回傳 401 | Service Account 在 Developer Console 中沒有授予 `bot` / `bot.read` scope。在 token 請求時指定 scope 不夠 —— app 必須先被授權。 |
| `error:0680008E:asn1 encoding routines::not enough data` | 私鑰透過 JSON 來回序列化時被破壞。改用 `privateKeyFile` 指向磁碟上真實 PEM 檔。 |
| 下載附件時 401 | 同上(scope),**或** Node 的 fetch 在 302 redirect 時把 Authorization header 剝掉了。外掛已手動處理;若仍看到,多半是 scope 問題。 |
| `content.previewImageUrl must begin with https://` | Agent 把本地檔案路徑當成 mediaUrl;正常流程會自動上傳。若訊息直接經由 `outbound.sendMedia`(罕見),URL 必須是 HTTPS。 |
| 收得到文字但收不到圖片 | Developer Console 的 callback events 只勾了 `message.text`。去勾選 `message.image`(以及需要的 `message.file` 等)。 |
| `Agent reply started` 有跑但沒 delivery | Agent 後端卡住 / 缺憑證。檢查 `/tmp/openclaw/openclaw-*.log`,找 model provider 的 `FailoverError`。 |
| Gateway log 塞滿 `pairing required` 1008 errors | **與本外掛無關。** 是本機另一個 openclaw CLI 在嘗試升級 scope。檢查 `~/.openclaw/devices/pending.json`,然後 `openclaw devices list` 再 `approve <id>` 或 `reject`。 |
| Agent 長回覆以行內文字送出,而非檔案 | Agent 的 system prompt 不知道長內容要用 mediaUrl。把上方指示符速查表貼進 agent prompt。 |
| Outbound 圖片顯示為破損的預覽 | 檔案的副檔名不是圖片。外掛依副檔名分流 —— 圖片要 `.png`/`.jpg` 等;其他副檔名會走檔案附件。 |

---

## 架構概覽

```
   LINE WORKS server
         │
         │  HTTPS POST + X-WORKS-Signature
         ▼
   你的公開 URL  →  openclaw gateway  →  /lineworks/webhook
                                │
                                │  簽章驗證(HMAC-SHA256)
                                │  事件解析(支援 fileId)
                                │  下載附件(bot.read scope)
                                ▼
                         解析 agent route
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

每一層都獨立並有單元測試。`src/channel.ts` 的 ChannelPlugin SDK 整合遵循
openclaw repo 內建 `synology-chat` 與 `line` 外掛的相同模式。

---

## 開發

```bash
pnpm install       # 或 npm install
pnpm typecheck
pnpm test          # 48+ 個單元測試;約 500ms
```

專案結構:

```
src/
  accounts.ts          — 多帳號解析 + env fallback + PEM 正規化
  attachments.ts       — inbound 下載(處理 302 redirect)+ outbound 上傳
  auth.ts              — JWT RS256 + single-flight token refresh
  channel.ts           — createChatChannelPlugin 包含所有 adapter
  config-schema.ts     — 頻道設定的 zod schema
  directives.ts        — flex / location / quick_replies 解析器
  gateway-runtime.ts   — registerPluginHttpRoute for /lineworks/webhook
  inbound-context.ts   — 建構 FinalizedMsgContext(含 media payload)
  inbound-turn.ts      — 回覆 dispatcher + 延遲 ack + outbound 排序
  runtime.ts           — PluginRuntime store
  send.ts              — POST /bots/{botId}/(users|channels)/{id}/messages
  session-key.ts       — buildAgentSessionKey
  setup-surface.ts     — ChannelSetupAdapter + wizard
  types.ts             — 所有 LINE WORKS 內容型態的型別定義
  webhook-handler.ts   — 使用 openclaw webhook-ingress primitives 的 HTTP handler
  webhook.ts           — 簽章驗證 + 事件解析
index.ts               — defineBundledChannelEntry
api.ts                 — 對外 export(index.ts 的 specifier 會用)
setup-entry.ts         — defineBundledChannelSetupEntry
setup-api.ts           — setup wizard exports
openclaw.plugin.json   — 外掛 manifest(id、channels、env vars、schema)
```

---

## 參考資料

- [LINE WORKS Developers](https://developers.worksmobile.com/en/docs/api)
- [LINE WORKS Node.js 範例(bot-echo-express)](https://github.com/lineworks/works-api-code-samples/tree/master/samples/nodejs/bot-echo-express)
- [OpenClaw plugin SDK](https://docs.openclaw.ai/plugins/sdk-overview)
- openclaw repo 內的參考模板:
  - `extensions/line/` —— 消費端 LINE(Flex 格式相同)
  - `extensions/synology-chat/` —— 類似的 ChannelPlugin 結構(webhook + upload)
  - `extensions/feishu/` —— 類似的 JWT service-account 認證

## License

MIT

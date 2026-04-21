# @unayung/lineworks

[![npm](https://img.shields.io/npm/v/@unayung/lineworks.svg?label=npm)](https://www.npmjs.com/package/@unayung/lineworks)
[![GitHub release](https://img.shields.io/github/v/tag/Unayung/openclaw-plugin-lineworks.svg?label=github&sort=semver)](https://github.com/Unayung/openclaw-plugin-lineworks/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Third-party OpenClaw channel plugin for **LINE WORKS** (Works Mobile) — the
enterprise messaging product by LINE. Different platform, different API, and
different bot model than consumer LINE.

End-to-end agent integration: the bot receives DMs and group messages (text,
image, file, sticker, location, postback), forwards them to your openclaw
agent, and delivers the agent's replies back as text, image, video, audio,
file, Flex cards, pinned locations, and tap-reply buttons.

- ✅ **Inbound**: text + attachments (images are auto-downloaded so vision
  models see them directly)
- ✅ **Outbound**: text, image, video, audio, file (HTTPS URL or local-file
  auto-upload), Flex messages, locations, quick-reply buttons
- ✅ **Thinking ack**: optional "⋯" placeholder if the agent takes > 5s
- ✅ **Multi-account**: one plugin install can drive multiple LINE WORKS bots
- ✅ **Pairing-gated DMs**: same security model as the bundled LINE plugin

---

## Quick start

### 1. Prerequisites

- An **openclaw gateway** already running and reachable on the public
  internet. See [openclaw remote-access patterns](https://docs.openclaw.ai/gateway/remote)
  — VPS + reverse proxy, Tailscale Funnel, or Cloudflare Tunnel all work.
  LINE WORKS servers must be able to `POST /lineworks/webhook` to your gateway.
- A **LINE WORKS Developer Console** account with an app + bot created.
- A **Service Account** with scopes `bot` and `bot.read` **granted** (see step 3).

### 2. Install the plugin

**Recommended — install from npm (or ClawHub):**

```bash
openclaw plugins install @unayung/lineworks
openclaw gateway restart
```

`openclaw plugins install` hits ClawHub first and falls back to npm, so this
one command works whichever registry the plugin is indexed on.

Alternative forms:

```bash
# explicit ClawHub lookup (skips the ClawHub-then-npm fallback order):
openclaw plugins install clawhub:lineworks

# pinning an exact npm version:
openclaw plugins install @unayung/lineworks@0.1.0-poc.1

# dev / local checkout (symlinks the source dir so code edits are picked up
# on the next `openclaw gateway restart` without reinstalling):
git clone https://github.com/Unayung/openclaw-plugin-lineworks.git
openclaw plugins install --link /absolute/path/to/openclaw-plugin-lineworks
```

Verify it loaded:

```bash
openclaw plugins list | grep lineworks      # should show "loaded"
openclaw plugins inspect lineworks
```

### 3. Developer Console setup — do all of these

In [developers.worksmobile.com/console](https://developers.worksmobile.com/console/):

1. **Create an app** and issue a **Service Account** with an RSA private key
   (PKCS#8 PEM). Save the `.pem` file locally.
2. **Grant OAuth scopes** to the app / Service Account:
   - ✅ `bot` (required — send messages)
   - ✅ `bot.read` (required — download attachments)
3. **Create a bot** under the app. Copy the **Bot ID** and **Bot Secret**.
4. **Enable the callback events** you care about. At minimum:
   - ✅ `message.text` (inbound text)
   - ✅ `message.image` (inbound images → agent vision)
   - ✅ `message.file` (inbound files — optional)
   - ✅ `message.sticker` / `message.location` / `postback` (optional)
5. **Set the Callback URL** to your gateway's public URL + `/lineworks/webhook`:
   ```
   https://<your-gateway-host>/lineworks/webhook
   ```

### 4. Configure the channel in openclaw

Save the PEM to a protected path:

```bash
mkdir -p ~/.openclaw/keys && chmod 700 ~/.openclaw/keys
mv /path/to/service-account.pem ~/.openclaw/keys/lineworks-default.pem
chmod 600 ~/.openclaw/keys/lineworks-default.pem
```

Add the channel block to `~/.openclaw/openclaw.json` (sibling of `agents` /
`gateway`):

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
      "domainId":       "<domain ID>",        // optional
      "dmPolicy":       "pairing",             // open | allowlist | pairing | disabled
      "groupPolicy":    "allowlist",           // open | allowlist | disabled

      // Optional — auto-send a "⋯" message if the agent takes > 5s.
      // "thinkingAck": { "delayMs": 5000, "text": "⋯" }
    }
  }
}
```

Then:

```bash
openclaw gateway restart
openclaw channels status         # should show "LINE WORKS default: enabled"
```

### 5. DM your bot

You're done. The gateway will log `Registered HTTP route: /lineworks/webhook
for LINE WORKS` on startup, and replies will flow.

---

## Configuration reference

### Credential keys (camelCase in config; UPPER_SNAKE in env)

| Config key | Env fallback | Purpose |
|---|---|---|
| `clientId` | `LINEWORKS_CLIENT_ID` | App client ID from Developer Console |
| `clientSecret` | `LINEWORKS_CLIENT_SECRET` | App client secret |
| `serviceAccount` | `LINEWORKS_SERVICE_ACCOUNT` | `<uuid>.serviceaccount@<domain>` |
| `privateKey` | `LINEWORKS_PRIVATE_KEY` | Inline PKCS#8 PEM (use `\n` if single-line env) |
| `privateKeyFile` | — | **Preferred.** Path to PKCS#8 PEM file on disk |
| `botId` | `LINEWORKS_BOT_ID` | Bot ID (numeric string) |
| `botSecret` | `LINEWORKS_BOT_SECRET` | Bot secret (HMAC key for webhook verification) |
| `domainId` | `LINEWORKS_DOMAIN_ID` | Optional domain/tenant ID |

Config wins over env (`merged.clientId ?? process.env.LINEWORKS_CLIENT_ID`).
**Prefer `privateKeyFile` over inline `privateKey`** — JSON round-tripping the
PEM through config loaders can subtly corrupt it.

### Behavior knobs

```json5
{
  "channels": {
    "lineworks": {
      // Who may DM the bot
      "dmPolicy": "pairing",           // open | allowlist | pairing | disabled
      "allowFrom": ["user-id-a", "user-id-b"],

      // Who may message the bot in group chats
      "groupPolicy": "allowlist",      // open | allowlist | disabled
      "groupAllowFrom": ["channel-id-a"],

      // Path the gateway registers for LINE WORKS callbacks
      "webhookPath": "/lineworks/webhook",

      // Thinking indicator (no native API on LINE WORKS; we fake it with a
      // delayed text message). delayMs: 0 disables.
      "thinkingAck": { "delayMs": 5000, "text": "⋯" }
    }
  }
}
```

### Multiple accounts

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

## Outbound message formats

The agent produces a reply payload. This plugin inspects `text`, `mediaUrls` /
`mediaUrl`, and `channelData.lineworks`, plus **text directives** embedded in
the reply. Ordering: media first, then text, then Flex, then location.
Quick-reply chips attach to the last message in the sequence.

### Text

```js
{ text: "Hello!" }
```

Auto-chunked at ~2000 chars on newline boundaries.

### Media (image / video / audio / file)

Emit `mediaUrl` (single) or `mediaUrls` (list) pointing at either:

- An **HTTPS URL** — LINE WORKS fetches it directly.
- A **local file path** — the plugin uploads it via LINE WORKS's attachment
  API (two-step: request uploadUrl → multipart POST) and sends a fileId
  message.

File extension drives the message type:

| Extensions | Message type |
|---|---|
| `.jpg .jpeg .png .gif .webp .heic` | inline image |
| `.mp4 .mov .m4v .avi .webm` | inline video |
| `.mp3 .m4a .wav .aac .ogg` | inline audio |
| everything else (`.md .pdf .csv .txt` …) | file attachment |

Limitations:
- Video via HTTPS URL requires a preview thumbnail; use an uploaded local
  file if you don't have one.
- Audio duration defaults to ~10s unless supplied.
- Local file uploads cap at ~15 MB.

### Flex messages — `[[flex: <altText> ||| <JSON>]]`

Rich cards (bubble or carousel), identical to LINE consumer's Flex format.

```
[[flex: Order #1234 ||| {"type":"bubble","body":{"type":"box","layout":"vertical","contents":[{"type":"text","text":"Order #1234","weight":"bold"},{"type":"text","text":"Total: $12"}]}}]]
```

Or programmatically:

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

### Location — `[[location: <title> | <address> | <lat> | <lng>]]`

```
[[location: Taipei 101 | No. 7, Xinyi Rd | 25.0330 | 121.5654]]
```

### Quick-reply buttons — `[[quick_replies: label1, label2, label3]]`

Chips under the last message. Max 13 items. Per-item variants:

| Syntax | Action |
|---|---|
| `Label` | Sends `"Label"` as a user reply |
| `Label > text` | Sends custom text as a user reply |
| `Label > https://example.com` | Opens the URL |
| `Label > data:foo=bar` | Returns a postback event with `data=foo=bar` |

```
Pick one: [[quick_replies: Yes, No, Maybe, Learn more > https://help.example]]
```

### Combining

```js
{
  text: "Here's your report 👇\n[[quick_replies: Download, Share, Cancel]]",
  mediaUrl: "/path/to/report.pdf"     // uploaded as file attachment
}
```

---

## Message directives cheat-sheet for agents

If you control the agent's system prompt, include this block so it can emit
rich formats autonomously:

```
LINE WORKS channel supports these directives in your reply text:

- [[flex: <altText> ||| <JSON>]]
    Rich card (LINE Flex bubble/carousel JSON).

- [[location: <title> | <address> | <lat> | <lng>]]
    Pinned map location.

- [[quick_replies: Label1, Label2 > text, Label3 > https://url, Label4 > data:x]]
    Tap-chips (≤13). Default action is message(text=label); arrow-target
    syntax switches to uri / postback.

For files/media, emit `mediaUrl: "/path/or/https URL"` in your reply payload.
Extension (.png/.mp4/.mp3/.pdf/…) picks the right message type automatically.
```

These hints are also injected into `agentPrompt.messageToolHints`, which the
openclaw **native** agent runner reads. If your agent runs via `claude-cli`
(Claude Code), hints don't currently flow through — paste the block above
into the agent's own system prompt instead.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Install blocked by "credential harvesting" scan | Something in the plugin tree mixes `process.env` + `fetch` in one file. Ship only entry-point files + `src/`; exclude dev scripts. |
| `Plugin manifest id "lineworks" differs from npm package name …` | Informational. Package name must equal manifest id or its `@scope/` unscoped form. This plugin uses `@unayung/lineworks` which satisfies the check. |
| Webhook fails with 401 from `www.worksapis.com` on outbound | Service Account doesn't have `bot` / `bot.read` scopes granted in the Developer Console. Granting scopes in the token request isn't enough — the app must be authorized for them. |
| `error:0680008E:asn1 encoding routines::not enough data` | Private key string corrupted by JSON round-trip. Switch to `privateKeyFile` pointing at a real PEM file on disk. |
| 401 on attachment download | Same as above (scopes) **or** Node's fetch stripped the Authorization header on 302 redirect. This plugin handles that manually — if you still see it, likely scopes. |
| `content.previewImageUrl must begin with https://` | Agent emitted a local filesystem path as mediaUrl; we normally auto-upload. If it hit `outbound.sendMedia` directly (rare), the URL must be HTTPS. |
| Bot receives text but not images | Callback event subscriptions in the Developer Console only have `message.text` ticked. Enable `message.image` (and `message.file` etc. as needed). |
| `Agent reply started` fires but no delivery ever | Agent backend hung / no credentials. Check `/tmp/openclaw/openclaw-*.log` for `FailoverError` on the agent's model provider. |
| Gateway log full of `pairing required` 1008 errors | **Unrelated to this plugin.** Some other local openclaw CLI tool is trying to upgrade scope. Check `~/.openclaw/devices/pending.json`, then `openclaw devices list` + `openclaw devices approve <id>` or `reject`. |
| Long agent replies coming as inline text, not files | Agent's system prompt doesn't know to use mediaUrl for long content. Paste the directives cheat-sheet above into its prompt. |
| Outbound image delivered as broken placeholder | File wasn't image by extension. The plugin branches on extension — images should be `.png`/`.jpg`/etc.; other extensions go through as file attachments. |

---

## Architecture at a glance

```
   LINE WORKS server
         │
         │  HTTPS POST + X-WORKS-Signature
         ▼
   your public URL  →  openclaw gateway  →  /lineworks/webhook
                                │
                                │  signature verify (HMAC-SHA256)
                                │  parse event (fileId-aware)
                                │  download attachments (bot.read scope)
                                ▼
                         resolve agent route
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

Each layer is isolated and unit-tested. The ChannelPlugin SDK wiring in
`src/channel.ts` follows the same pattern as the bundled `synology-chat` and
`line` plugins in the openclaw repo.

---

## Development

```bash
pnpm install       # or npm install
pnpm typecheck
pnpm test          # 48+ unit tests; ~500ms
```

Project layout:

```
src/
  accounts.ts          — multi-account resolver + env fallback + PEM normalize
  attachments.ts       — inbound download (302-redirect aware) + outbound upload
  auth.ts              — JWT RS256 + single-flight token refresh
  channel.ts           — createChatChannelPlugin with all adapters
  config-schema.ts     — zod schema for channel config
  directives.ts        — flex / location / quick_replies parser
  gateway-runtime.ts   — registerPluginHttpRoute for /lineworks/webhook
  inbound-context.ts   — builds FinalizedMsgContext with media payload
  inbound-turn.ts      — reply dispatcher + delayed ack + outbound sequencer
  runtime.ts           — PluginRuntime store
  send.ts              — POST /bots/{botId}/(users|channels)/{id}/messages
  session-key.ts       — buildAgentSessionKey
  setup-surface.ts     — ChannelSetupAdapter + wizard
  types.ts             — all LINE WORKS content type definitions
  webhook-handler.ts   — HTTP handler using openclaw webhook-ingress primitives
  webhook.ts           — signature verify + event parser
index.ts               — defineBundledChannelEntry
api.ts                 — public exports (consumed by index.ts specifier)
setup-entry.ts         — defineBundledChannelSetupEntry
setup-api.ts           — setup wizard exports
openclaw.plugin.json   — plugin manifest (id, channels, env vars, schema)
```

---

## References

- [LINE WORKS Developers](https://developers.worksmobile.com/en/docs/api)
- [LINE WORKS Node.js sample (bot-echo-express)](https://github.com/lineworks/works-api-code-samples/tree/master/samples/nodejs/bot-echo-express)
- [OpenClaw plugin SDK](https://docs.openclaw.ai/plugins/sdk-overview)
- Reference templates in the openclaw repo:
  - `extensions/line/` — consumer LINE (shares Flex format with LINE WORKS)
  - `extensions/synology-chat/` — similar ChannelPlugin shape (webhook + upload)
  - `extensions/feishu/` — similar JWT service-account auth

## License

MIT

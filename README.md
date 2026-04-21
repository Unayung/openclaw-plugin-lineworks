# openclaw-plugin-lineworks (PoC)

Third-party OpenClaw channel plugin for **LINE WORKS** (Works Mobile) — LINE's
enterprise collaboration platform. Separate product and API from consumer LINE.

**Status:** proof-of-concept scaffold. The primitives (JWT auth, webhook
parsing + signature verification, outbound sender, config schema) are shipped.
The full `ChannelPlugin` adapter wiring is stubbed — see `src/channel.ts`.

## What's implemented

| Module | Status | Notes |
|---|---|---|
| `src/auth.ts` | Working | JWT service-account flow (API 2.1); single-flight refresh; per-account token cache |
| `src/webhook.ts` | Working | HMAC-SHA256 verify with timing-safe compare; parser for user/channel/postback/member events |
| `src/send.ts` | Working | Text + image outbound; 2000-char text chunking |
| `src/accounts.ts` | Working | Multi-account resolver |
| `src/config-schema.ts` | Working | Zod schema, DM + group routing |
| `src/types.ts` | Working | |
| `src/channel.ts` | Stub | ChannelPlugin wiring; see file for TODO list |
| `setup-entry.ts`, `setup-api.ts` | Stubs | |

## Spec verification

Cross-checked against the official LINE WORKS Node.js sample
([`lineworks/works-api-code-samples/samples/nodejs/bot-echo-express`](https://github.com/lineworks/works-api-code-samples/tree/master/samples/nodejs/bot-echo-express))
and the Developers docs. Confirmed:

| Item | Spec value | Implemented |
|---|---|---|
| Token endpoint | `https://auth.worksmobile.com/oauth2/v2.0/token` | ✅ |
| `grant_type` | `urn:ietf:params:oauth:grant-type:jwt-bearer` | ✅ |
| JWT alg | `RS256` | ✅ |
| JWT claims | `iss` = client ID, `sub` = service account, `iat`, `exp` | ✅ |
| Default scope | `bot` | ✅ |
| Send URL (user) | `https://www.worksapis.com/v1.0/bots/{botId}/users/{userId}/messages` | ✅ |
| Send URL (channel) | `https://www.worksapis.com/v1.0/bots/{botId}/channels/{channelId}/messages` | ✅ |
| Send body shape | `{ "content": { "type": "...", ... } }` | ✅ |
| Text content | `{ "type": "text", "text": "..." }` | ✅ |
| Image content | `{ "type": "image", "previewUrl": "...", "resourceUrl": "..." }` | ✅ (fixed — earlier draft used LINE-consumer field names) |
| Signature header | `X-WORKS-Signature` | ✅ |
| Signature algorithm | HMAC-SHA256 over raw body, base64 | ✅ |

## Open decisions

1. **Rich messages (Flex) scope** — not yet scoped. Text + image only today.
   LINE WORKS Flex messages are JSON-compatible with LINE Flex, so mapping
   can be ported from `extensions/line/src/flex-templates.ts` in the openclaw
   repo when needed.
2. **Host wiring** — `src/channel.ts` is a stub until we pin an `openclaw`
   host version and implement the `ChannelPlugin` adapters.
3. **Text-chunk limit (2000 chars in `src/send.ts`)** — conservative guess.
   LINE WORKS does not publish a clear per-message text limit in the English
   docs. Verify with a live tenant before relying on it.
4. **Inbound event type strings** — the parser in `src/webhook.ts` maps
   `message`/`join`/`leave`/`memberJoined`/`memberLeft`/`postback`, which
   follows LINE-family convention but is not independently confirmed from
   LINE WORKS English docs. Verify against a live callback sample.

## Testing

### Unit tests (offline, no tenant needed)

```bash
npm install
npm run typecheck
npm test
```

Covers: JWT assertion shape + signing, single-flight token refresh, failed-refresh recovery, HMAC signature verify (valid / tampered / wrong secret / missing header / truncated), inbound event parser (user / channel / sticker / location / join / leave / member / postback / unknown), outbound URL building, URL encoding of IDs, content envelope, error propagation, long-text chunking.

### Live smoke tests (needs your bot credentials)

Copy `.env.example` to `.env` and fill in the LINE WORKS credentials.

Send a message to a user:
```bash
npm run smoke:send -- user <userId> "hello from the plugin"
```

Send a message to a channel:
```bash
npm run smoke:send -- channel <channelId> "hello from the plugin"
```

Receive webhooks (with signature verification and optional echo):
```bash
LINEWORKS_ECHO=1 npm run smoke:callback
# in another terminal:
ngrok http 8787
# paste https://<something>.ngrok-free.app/callback into the Developer Console as the bot Callback URL
# then DM your bot — the callback server will log parsed events and echo text back
```

If `parseInboundEvent` logs `{ kind: "unknown" }` on a real event, the LINE WORKS event-type string is something other than what the parser currently maps — grab the raw `type` from the log and add it to `src/webhook.ts`.

### Install into openclaw (blocked — ChannelPlugin stub)

Not runnable yet. Once `src/channel.ts` is wired against a pinned openclaw host version:

```bash
openclaw plugin install openclaw-plugin-lineworks
# or, for local dev:
openclaw plugin install /path/to/openclaw-plugin-lineworks
```

## Configuration

Env vars (picked up automatically when the plugin is registered):

- `LINEWORKS_CLIENT_ID`
- `LINEWORKS_CLIENT_SECRET`
- `LINEWORKS_SERVICE_ACCOUNT`
- `LINEWORKS_PRIVATE_KEY` (PKCS#8 PEM; or use `privateKeyFile`)
- `LINEWORKS_BOT_ID`
- `LINEWORKS_BOT_SECRET`
- `LINEWORKS_DOMAIN_ID` (optional)

Or in `~/.openclaw/config.toml`:

```toml
[channels.lineworks]
clientId = "..."
clientSecret = "..."
serviceAccount = "..."
privateKey = "..."
botId = "..."
botSecret = "..."
```

## References

- LINE WORKS Developers: https://developers.worksmobile.com/en/docs/api
- OpenClaw plugin SDK: https://openclaw.ai/docs/plugins/sdk-overview
- Consumer LINE plugin (reference template): `openclaw/openclaw:extensions/line`
- Feishu plugin (JWT-auth reference): `openclaw/openclaw:extensions/feishu`

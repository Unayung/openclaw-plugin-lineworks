# openclaw-plugin-lineworks (PoC)

Third-party OpenClaw channel plugin for **LINE WORKS** (Works Mobile) — LINE's
enterprise collaboration platform. Separate product and API from consumer LINE.

**Status:** first runnable PoC. Primitives, full `ChannelPlugin` wiring, setup
wizard, webhook ingress, and reply-pipeline dispatch are all in place. Text-only
outbound; rich messages deferred.

## What's implemented

| Module | Status | Notes |
|---|---|---|
| `src/auth.ts` | Working | JWT service-account flow (API 2.1); single-flight refresh; per-account token cache |
| `src/webhook.ts` | Working | HMAC-SHA256 verify with timing-safe compare; parser for user/channel/postback/member events |
| `src/send.ts` | Working | Text + image outbound; 2000-char text chunking |
| `src/accounts.ts` | Working | Multi-account resolver + env-var fallback |
| `src/config-schema.ts` | Working | Zod schema; DM + group policies |
| `src/webhook-handler.ts` | Working | HTTP handler using openclaw webhook-ingress primitives |
| `src/gateway-runtime.ts` | Working | `registerPluginHttpRoute` for `/lineworks/webhook` |
| `src/inbound-turn.ts` | Working | Reply-pipeline dispatch via `PluginRuntime` |
| `src/setup-surface.ts` | Working | Setup adapter + wizard (bot secret prompt) |
| `src/channel.ts` | Working | `createChatChannelPlugin` — meta/capabilities/config/messaging/gateway/outbound/security/pairing |
| `index.ts`, `setup-entry.ts` | Working | `defineBundledChannelEntry` / setup entry |

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

### Live integration test (the whole point)

Install the plugin into a running openclaw host and DM your bot — see the
"Install into openclaw" section below. The openclaw gateway is the real
integration surface; unit tests cover the primitives offline.

Earlier drafts shipped standalone smoke scripts under `smoke/` (direct
LINE WORKS API calls from Node). Those were removed because they trigger
openclaw's plugin security scanner ("env var access + outbound fetch"
flags the credential-harvesting heuristic). The exact same code paths
(`getAccessToken`, `verifySignature`, `parseInboundEvent`, `sendText`)
run inside the installed plugin.

### Install into openclaw (end-to-end with the agent)

Assumes an existing openclaw deployment reachable at `https://<gateway-host>` (VPS + reverse proxy, Tailscale Funnel, Cloudflare Tunnel, etc.). See [docs/gateway/remote.md](https://docs.openclaw.ai/gateway/remote) for deployment patterns.

```bash
# from a local path during dev:
openclaw plugins install /absolute/path/to/openclaw-plugin-lineworks

# or (once published):
openclaw plugins install openclaw-plugin-lineworks
```

Run the setup wizard:

```bash
openclaw channels setup lineworks
```

It will prompt for the bot secret (used for webhook signature verification) and enable the channel. Everything else (JWT client id, service account, private key, bot id) is picked up from env vars:

```
LINEWORKS_CLIENT_ID
LINEWORKS_CLIENT_SECRET
LINEWORKS_SERVICE_ACCOUNT
LINEWORKS_PRIVATE_KEY            # PKCS#8 PEM; newlines as \n if single-line
LINEWORKS_BOT_ID
LINEWORKS_BOT_SECRET             # fallback if not set via wizard
LINEWORKS_DOMAIN_ID              # optional
```

Or in `~/.openclaw/config.toml`:

```toml
[channels.lineworks]
enabled = true
clientId = "..."
clientSecret = "..."
serviceAccount = "..."
privateKey = """-----BEGIN PRIVATE KEY-----
...
-----END PRIVATE KEY-----"""
botId = "..."
botSecret = "..."
dmPolicy = "pairing"
# webhookPath = "/lineworks/webhook"  # default
```

Finally, in the LINE WORKS Developer Console, set the bot's **Callback URL** to:

```
https://<your-gateway-host>/lineworks/webhook
```

DM your bot. The openclaw agent should reply.

### Troubleshooting

- `401 Invalid signature` in gateway logs → bot secret in openclaw config doesn't match the one in the Developer Console.
- `405 Method not allowed` on `/lineworks/webhook` → LINE WORKS is probing with GET; that's expected. Only POST is accepted.
- Nothing happens on inbound → check `openclaw channels status lineworks` for startup issues (missing credentials, disabled account). Check that `channels.lineworks.dmPolicy` isn't `"disabled"`.
- 401 from `www.worksapis.com` on outbound → JWT token expired or scope missing; `src/auth.ts` auto-refreshes on expiry, but verify the service account has `bot` scope.

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

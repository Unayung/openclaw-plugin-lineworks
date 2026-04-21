/**
 * LINE WORKS ChannelPlugin wiring (PoC stub).
 *
 * This file is where the LINE WORKS channel ties into the OpenClaw plugin SDK
 * via `createChatChannelPlugin` from `openclaw/plugin-sdk/channel-core`. The
 * full wiring requires these adapters (see `extensions/line/src/channel.ts` in
 * the openclaw repo for a reference):
 *
 *   - setup       : onboarding flow (collect JWT credentials, bot ID, secret)
 *   - status      : health probe + token-validity check
 *   - gateway     : HTTP route registration for the inbound webhook
 *   - bindings    : inbound event -> conversation resolution
 *   - outbound    : reply payload -> sendText/sendMessage
 *   - directory   : use createEmptyChannelDirectoryAdapter() for PoC
 *   - security    : DM / group allowlist + pairing policy
 *   - messaging   : target normalization + reply transform
 *
 * For the PoC we ship the **working primitives** (auth.ts, webhook.ts,
 * send.ts, config-schema.ts, types.ts, accounts.ts) so you can unit-test them
 * in isolation against a real LINE WORKS tenant. The glue below is left as a
 * structured TODO because the SDK adapter types are the part you should wire
 * against a pinned openclaw host version.
 *
 * To flesh this out:
 *   1. Pick a target `openclaw` host version and `pnpm add -D` it.
 *   2. Copy the adapter shape from extensions/line/src/channel.ts.
 *   3. Replace LINE-specific helpers with the ones in this package:
 *        - `@line/bot-sdk`                -> `./send.ts` + `./auth.ts`
 *        - `validateSignature(...)`       -> `./webhook.ts:verifySignature`
 *        - `parseLineEvent(...)`          -> `./webhook.ts:parseInboundEvent`
 *        - `resolveLineAccount(...)`      -> `./accounts.ts:resolveLineWorksAccount`
 *   4. Register the plugin through `createChatChannelPlugin({ id: "lineworks", ... })`.
 */

export const LINEWORKS_CHANNEL_ID = "lineworks" as const;

// Re-export the building blocks so consumers can wire them however they want
// while the full ChannelPlugin remains under construction.
export { getAccessToken, clearAccessTokenCache } from "./auth.js";
export {
  LINEWORKS_SIGNATURE_HEADER,
  LINEWORKS_BOT_ID_HEADER,
  verifySignature,
  parseInboundEvent,
} from "./webhook.js";
export { sendMessage, sendText } from "./send.js";
export {
  DEFAULT_ACCOUNT_ID,
  listLineWorksAccountIds,
  resolveDefaultLineWorksAccountId,
  resolveLineWorksAccount,
} from "./accounts.js";
export { LineWorksConfigSchema, LineWorksChannelConfigSchema } from "./config-schema.js";

#!/usr/bin/env node
/**
 * Live outbound smoke test.
 *
 * Usage:
 *   node --env-file=.env --experimental-strip-types smoke/send.ts user <userId> "your message"
 *   node --env-file=.env --experimental-strip-types smoke/send.ts channel <channelId> "your message"
 *
 * Requires LINEWORKS_* env vars from .env.example.
 */
import { hasLineWorksCredentials, resolveLineWorksAccount } from "../src/accounts.js";
import { sendText } from "../src/send.js";
import type { LineWorksConfig } from "../src/types.js";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function envOpt(name: string): string | undefined {
  return process.env[name] || undefined;
}

const [, , kindArg, idArg, ...rest] = process.argv;
const text = rest.join(" ");

if (!["user", "channel"].includes(kindArg ?? "") || !idArg || !text) {
  console.error(
    "Usage: node --env-file=.env --experimental-strip-types smoke/send.ts <user|channel> <id> <text>",
  );
  process.exit(2);
}

const lineworksConfig: LineWorksConfig = {
  clientId: env("LINEWORKS_CLIENT_ID"),
  clientSecret: env("LINEWORKS_CLIENT_SECRET"),
  serviceAccount: env("LINEWORKS_SERVICE_ACCOUNT"),
  privateKey: env("LINEWORKS_PRIVATE_KEY").replace(/\\n/g, "\n"),
  botId: env("LINEWORKS_BOT_ID"),
  botSecret: env("LINEWORKS_BOT_SECRET"),
  domainId: envOpt("LINEWORKS_DOMAIN_ID"),
};

const account = resolveLineWorksAccount({ channels: { lineworks: lineworksConfig } });
if (!hasLineWorksCredentials(account)) {
  console.error("Could not resolve LINE WORKS account from env; check required vars are set.");
  process.exit(1);
}

const target =
  kindArg === "user"
    ? ({ type: "user" as const, userId: idArg })
    : ({ type: "channel" as const, channelId: idArg });

console.log(`[smoke] sending ${text.length}-char message to ${kindArg} ${idArg}...`);
await sendText({ account, target, text });
console.log("[smoke] ok");

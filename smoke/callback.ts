#!/usr/bin/env node
/**
 * Live inbound smoke test.
 *
 * Usage:
 *   node --env-file=.env --experimental-strip-types smoke/callback.ts
 *   # then expose via: ngrok http 8787
 *   # and paste the ngrok URL into your bot's Callback URL in the Developer Console.
 *
 * What it does:
 *   - Starts an HTTP server on PORT (default 8787) that preserves the raw
 *     request body (critical for HMAC verification).
 *   - On every request, runs verifySignature() and parseInboundEvent() and
 *     logs the result. If you set LINEWORKS_ECHO=1, it will also echo text
 *     messages back via the LINE WORKS send API.
 */
import express from "express";
import { hasLineWorksCredentials, resolveLineWorksAccount } from "../src/accounts.js";
import { sendText } from "../src/send.js";
import type { LineWorksConfig } from "../src/types.js";
import {
  LINEWORKS_SIGNATURE_HEADER,
  parseInboundEvent,
  verifySignature,
} from "../src/webhook.js";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}
function envOpt(name: string): string | undefined {
  return process.env[name] || undefined;
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
  console.error("Could not resolve LINE WORKS account from env");
  process.exit(1);
}

const shouldEcho = process.env.LINEWORKS_ECHO === "1";
const port = Number(process.env.PORT ?? 8787);
const app = express();

app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody: Buffer }).rawBody = buf;
    },
  }),
);

app.post("/callback", async (req, res) => {
  const rawBody = (req as unknown as { rawBody: Buffer | undefined }).rawBody ?? Buffer.alloc(0);
  const sig = req.get(LINEWORKS_SIGNATURE_HEADER) ?? req.get("x-works-signature");
  const valid = verifySignature({
    rawBody,
    signatureHeader: sig,
    botSecret: account.botSecret,
  });
  if (!valid) {
    console.warn("[callback] signature INVALID — rejecting", {
      sig,
      bodyPreview: rawBody.toString("utf8").slice(0, 120),
    });
    res.status(401).send("invalid signature");
    return;
  }

  const event = parseInboundEvent(req.body);
  console.log("[callback]", JSON.stringify(event, null, 2));

  if (shouldEcho && event?.content?.type === "text") {
    const target =
      event.source.type === "channel"
        ? { type: "channel" as const, channelId: event.source.channelId }
        : { type: "user" as const, userId: event.source.userId };
    try {
      await sendText({ account, target, text: `echo: ${event.content.text}` });
    } catch (err) {
      console.error("[callback] echo failed:", (err as Error).message);
    }
  }

  res.status(200).send("ok");
});

app.get("/health", (_req, res) => res.send("ok"));

app.listen(port, () => {
  console.log(`[callback] listening on :${port}  (echo=${shouldEcho})`);
  console.log(`[callback] expose with:  ngrok http ${port}`);
  console.log(
    `[callback] then set Callback URL in Developer Console to  https://<ngrok>.ngrok-free.app/callback`,
  );
});

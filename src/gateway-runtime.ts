import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { registerPluginHttpRoute } from "openclaw/plugin-sdk/webhook-ingress";
import { hasLineWorksCredentials } from "./accounts.js";
import { dispatchLineWorksInboundTurn } from "./inbound-turn.js";
import { handleOAuthCallback, handleOAuthStart } from "./oauth.js";
import type { ResolvedLineWorksAccount } from "./types.js";
import { createLineWorksWebhookHandler } from "./webhook-handler.js";

const CHANNEL_ID = "lineworks";

type LineWorksGatewayLog = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

type LineWorksStartupIssueCode = "disabled" | "missing-credentials";
type LineWorksStartupIssue = {
  code: LineWorksStartupIssueCode;
  logLevel: "info" | "warn";
  message: string;
};

const activeRouteUnregisters = new Map<string, () => void>();

function createLogAdapter(log?: LineWorksGatewayLog) {
  if (!log) return undefined;
  const fmt = (v: unknown) =>
    typeof v === "string" ? v : v instanceof Error ? v.message : String(v);
  return {
    info: (...args: unknown[]) => log.info?.(fmt(args[0])),
    warn: (...args: unknown[]) => log.warn?.(fmt(args[0])),
    error: (...args: unknown[]) => log.error?.(fmt(args[0])),
  };
}

function logStartupIssues(log: LineWorksGatewayLog | undefined, issues: LineWorksStartupIssue[]) {
  for (const issue of issues) {
    const message = `LINE WORKS ${issue.message}`;
    if (issue.logLevel === "info") {
      log?.info?.(message);
      continue;
    }
    log?.warn?.(message);
  }
}

export function collectLineWorksStartupIssues(params: {
  cfg: OpenClawConfig;
  account: ResolvedLineWorksAccount;
  accountId: string;
}): LineWorksStartupIssue[] {
  const { account, accountId } = params;
  const issues: LineWorksStartupIssue[] = [];
  if (!account.enabled) {
    issues.push({
      code: "disabled",
      logLevel: "info",
      message: `account ${accountId} is disabled, skipping`,
    });
    return issues;
  }
  if (!hasLineWorksCredentials(account)) {
    issues.push({
      code: "missing-credentials",
      logLevel: "warn",
      message: `account ${accountId} is missing credentials (need clientId, clientSecret, serviceAccount, privateKey, botId, botSecret)`,
    });
  }
  return issues;
}

export function validateLineWorksStartup(params: {
  cfg: OpenClawConfig;
  account: ResolvedLineWorksAccount;
  accountId: string;
  log?: LineWorksGatewayLog;
}): { ok: true } | { ok: false } {
  const issues = collectLineWorksStartupIssues(params);
  if (issues.length > 0) {
    logStartupIssues(params.log, issues);
    return { ok: false };
  }
  return { ok: true };
}

export function registerLineWorksWebhookRoute(params: {
  account: ResolvedLineWorksAccount;
  accountId: string;
  log?: LineWorksGatewayLog;
}): () => void {
  const { account, log } = params;
  const key = `${account.accountId}:${account.webhookPath}`;
  const prev = activeRouteUnregisters.get(key);
  if (prev) {
    log?.info?.(`Deregistering stale route before re-register: ${account.webhookPath}`);
    prev();
    activeRouteUnregisters.delete(key);
  }

  const handler = createLineWorksWebhookHandler({
    account,
    deliver: async (msg) =>
      await dispatchLineWorksInboundTurn({
        account,
        msg,
        log: createLogAdapter(log),
      }),
    log: createLogAdapter(log),
  });

  const unregister = registerPluginHttpRoute({
    path: account.webhookPath,
    auth: "plugin",
    pluginId: CHANNEL_ID,
    accountId: account.accountId,
    log: (msg: string) => log?.info?.(msg),
    handler,
  });

  // Register OAuth start + callback routes alongside the webhook when
  // oauth.enabled is set AND a public base URL is configured. Skipped
  // silently otherwise — mail/task/drive features will fall back to
  // "need grant" prompts.
  let unregisterOAuthStart: (() => void) | undefined;
  let unregisterOAuthCallback: (() => void) | undefined;
  if (account.oauthEnabled && account.publicBaseUrl) {
    const adapterLog = createLogAdapter(log);
    unregisterOAuthStart = registerPluginHttpRoute({
      path: account.oauthStartPath,
      auth: "plugin",
      pluginId: CHANNEL_ID,
      accountId: account.accountId,
      log: (msg: string) => log?.info?.(msg),
      handler: async (req, res) =>
        await handleOAuthStart({ req, res, account, log: adapterLog }),
    });
    unregisterOAuthCallback = registerPluginHttpRoute({
      path: account.oauthCallbackPath,
      auth: "plugin",
      pluginId: CHANNEL_ID,
      accountId: account.accountId,
      log: (msg: string) => log?.info?.(msg),
      handler: async (req, res) =>
        await handleOAuthCallback({ req, res, account, log: adapterLog }),
    });
    log?.info?.(
      `LINE WORKS OAuth routes registered: ${account.oauthStartPath} + ${account.oauthCallbackPath} (redirect_uri: ${account.publicBaseUrl}${account.oauthCallbackPath})`,
    );
  } else if (account.oauthEnabled && !account.publicBaseUrl) {
    log?.warn?.(
      "LINE WORKS: oauth.enabled=true but channels.lineworks.publicBaseUrl is unset — OAuth routes NOT registered",
    );
  }

  activeRouteUnregisters.set(key, unregister);
  return () => {
    unregister();
    unregisterOAuthStart?.();
    unregisterOAuthCallback?.();
    activeRouteUnregisters.delete(key);
  };
}

import type {
  LineWorksGroupPolicy,
  ResolvedLineWorksChannelEntry,
} from "./types.js";

/**
 * Decision returned by `resolveLineWorksChannelConfig`.
 *
 * - `allowed`: false → reject the inbound message at preflight (silent ack).
 * - `requireMention`: effective per-channel mention requirement, derived from
 *   the matched entry (or `*` wildcard, or account-level default).
 * - `users`: per-channel sender allowlist (normalized userIds). When empty,
 *   no per-channel sender restriction applies.
 * - `matchKey`: which key in the `channels` map produced this result
 *   (`<channelId>`, `*`, or undefined if no match). Useful for logging.
 */
export interface LineWorksChannelConfigResolved {
  allowed: boolean;
  requireMention: boolean;
  users: string[];
  matchKey?: string;
}

export interface ResolveLineWorksChannelConfigParams {
  channelId: string;
  channels: Record<string, ResolvedLineWorksChannelEntry>;
  groupPolicy: LineWorksGroupPolicy;
  defaultRequireMention: boolean;
}

/**
 * Resolve per-channel access control for a LINE WORKS group/channel inbound.
 * Mirrors the Slack plugin's `resolveSlackChannelConfig` semantics so the
 * config surface stays aligned across providers.
 *
 * Decision matrix:
 *
 *   groupPolicy=disabled               → allowed=false (always)
 *   groupPolicy=open                   → allowed=true (no allowlist)
 *   groupPolicy=allowlist (default):
 *     channels map empty               → allowed=true (open by default until
 *                                        any per-channel entry exists)
 *     channelId match found            → allowed=entry.enabled
 *     no match but `*` wildcard set    → allowed=wildcard.enabled
 *     non-empty map, no match, no `*`  → allowed=false (implicit allowlist)
 *
 * `requireMention` falls back: matchedEntry > `*` entry > `defaultRequireMention`.
 * `users` falls back: matchedEntry > `*` entry > [].
 */
export function resolveLineWorksChannelConfig(
  params: ResolveLineWorksChannelConfigParams,
): LineWorksChannelConfigResolved {
  const { channelId, channels, groupPolicy, defaultRequireMention } = params;

  if (groupPolicy === "disabled") {
    return { allowed: false, requireMention: defaultRequireMention, users: [] };
  }

  const entries = channels ?? {};
  const matched = entries[channelId];
  const wildcard = entries["*"];
  const resolved = matched ?? wildcard;
  const matchKey = matched ? channelId : wildcard ? "*" : undefined;

  if (groupPolicy === "open") {
    return {
      allowed: true,
      requireMention: resolved?.requireMention ?? defaultRequireMention,
      users: resolved?.users ?? [],
      matchKey,
    };
  }

  // groupPolicy === "allowlist"
  const hasAnyEntries = Object.keys(entries).length > 0;
  if (!hasAnyEntries) {
    return { allowed: true, requireMention: defaultRequireMention, users: [] };
  }

  if (!resolved) {
    return {
      allowed: false,
      requireMention: defaultRequireMention,
      users: [],
    };
  }

  return {
    allowed: resolved.enabled,
    requireMention: resolved.requireMention ?? defaultRequireMention,
    users: resolved.users,
    matchKey,
  };
}

/**
 * Is the sender allowed by the resolved entry's `users` list?
 * Empty list = no restriction (allowed). `*` in the list = anyone allowed.
 */
export function isSenderAllowedByUsers(
  users: string[],
  senderId: string | undefined,
): boolean {
  if (!users.length) return true;
  if (users.includes("*")) return true;
  if (!senderId) return false;
  return users.includes(senderId);
}

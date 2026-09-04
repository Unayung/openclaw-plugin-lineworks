// openclaw >=2026.7 warns at every startup when a channel plugin's manifest
// declares a channel without matching `channelConfigs` metadata, and `doctor`
// treats the plugin's installed-index entry as stale while that warning stands.
// The normalizer silently drops any entry whose `schema` is not an object, so
// assert the shape the host actually requires.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(
  readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
) as {
  channels: string[];
  channelConfigs?: Record<string, { schema?: unknown }>;
};

describe("openclaw.plugin.json", () => {
  it("declares channelConfigs metadata for every channel it registers", () => {
    expect(manifest.channels.length).toBeGreaterThan(0);
    for (const channelId of manifest.channels) {
      const entry = manifest.channelConfigs?.[channelId];
      expect(entry, `missing channelConfigs.${channelId}`).toBeDefined();
      // A non-object schema is dropped by the host normalizer, which brings the
      // startup warning back without any other visible symptom.
      expect(typeof entry?.schema).toBe("object");
      expect(Array.isArray(entry?.schema)).toBe(false);
    }
  });

  it("keeps the channel schema open so unmirrored account keys are not rejected", () => {
    // channelConfigs.<id>.schema becomes the cold-path validator for
    // `channels.<id>`; the authoritative shape lives in src/config-schema.ts.
    for (const channelId of manifest.channels) {
      const schema = manifest.channelConfigs?.[channelId]?.schema as {
        additionalProperties?: boolean;
      };
      expect(schema.additionalProperties).toBe(true);
    }
  });
});

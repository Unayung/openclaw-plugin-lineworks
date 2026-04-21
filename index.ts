import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "lineworks",
  name: "LINE WORKS",
  description: "LINE WORKS (Works Mobile) channel plugin for OpenClaw",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./api.js",
    exportName: "lineWorksPlugin",
  },
  runtime: {
    specifier: "./api.js",
    exportName: "setLineWorksRuntime",
  },
});

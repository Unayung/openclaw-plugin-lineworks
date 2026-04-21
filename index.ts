// Plugin entry. Once channel wiring lands, replace this with a
// `defineBundledChannelEntry({...})` call pointing at ./api.js and
// ./runtime-api.js (see extensions/line/index.ts for a reference).
//
// For the PoC, this file re-exports the public API so consumers can import
// the building blocks directly while the ChannelPlugin wiring is completed.
export * from "./api.js";

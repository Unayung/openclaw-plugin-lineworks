# Changelog

## 0.9.1

openclaw 2026.9.1 相容性修正。0.9.0 在 2026.9.1 上收得到 webhook，但一個字都回不了。

### 需求變更（breaking）

`peerDependencies.openclaw` 從 `^2026.4.15` 提到 `^2026.7.2`，
`openclaw.install.minHostVersion` 與 `openclaw.compat.pluginApi` 同步改成 `>=2026.7.2`。

沒有做舊版 feature-detect。`runDetachedWebhookWork` 是 2026.7 才有的 SDK 匯出，
要相容 2026.4 就得把它改成動態 import 加 fallback，而 fallback 分支在任何目標平台上
都不會執行到；`config.current` 也是同一版才有的。與其留兩條路都沒人走，不如把地板拉高
講清楚。要跑舊 gateway 請留在 0.9.0。

### 修正

- **`openclaw/plugin-sdk/zod` 這個 package export 在 2026.9.1 被移除**，
  plugin 載入直接失敗。`src/config-schema.ts` 改成 `import { z } from "zod"`，
  並把 `zod` 列進 `dependencies`。版本**釘死 `4.4.3`**（不是 `^4.4.3`）：
  openclaw 自己也釘 `4.4.3`，caret 會裝到 4.5.x 而讓 plugin 與 host 拿到兩份不同的
  zod 實例，`buildChannelConfigSchema()` 當場型別不相容。

- **`rt.config.loadConfig()` 不存在了**（`src/inbound-turn.ts`）。2026.7 起
  `PluginRuntime["config"]` 只有 `current / mutateConfigFile / replaceConfigFile`，
  舊呼叫在 webhook 已經回 204 之後才丟 `TypeError`，訊息就這樣掉了。改用
  `rt.config.current()`；回傳型別是 deep readonly，照 bundled channel plugin 的做法
  以 `as OpenClawConfig` 放寬。

- **agent 回合被 gateway 工作准入擋掉**（`src/webhook-handler.ts`）。handler 先
  `respondNoContent(res)`，`void deliver(msg)` 排出去的非同步鏈會繼承這個 request 的
  准入 root，而 `finally` 裡的 `requestLifecycle.release()` 緊接著就釋放它 —— 2026.7 起
  從已釋放的 root 排隊會被判成
  `GatewayDrainingError: Gateway is draining; new tasks are not accepted`。改用
  SDK 的 `runDetachedWebhookWork()` 包住 deliver。包在 handler 這一層（不是
  `gateway-runtime.ts` 的 `deliver` 定義處）才對得上 SDK 註解的要求：必須在 request
  仍被准入時同步呼叫，而 release 就在這個 handler 的 `finally`。

- **manifest 少了 `channelConfigs`**（`openclaw.plugin.json`）。2026.9.1 每次啟動都警告
  `channel plugin manifest declares lineworks without channelConfigs metadata`，
  而且 `doctor` 會用這行警告把 plugin 的 installed-index 判成 stale。補上
  `channelConfigs.lineworks`，附 `label` / `description` / `schema` / `uiHints`。
  `schema` 保持 `additionalProperties: true` —— 它會變成 `channels.lineworks` 的
  cold-path 驗證器，列不全就會在 runtime 載入前擋掉合法欄位；真正權威的形狀仍在
  `src/config-schema.ts`。

### 其他

- `openclaw` 加進 `devDependencies`（`^2026.9.1`），測試才跑得到真的 SDK 匯出；
  `openclaw.build.openclawVersion` 改成 `2026.9.1`。
- 新增 `src/inbound-turn.compat.test.ts`、`src/webhook-handler.detached.test.ts`、
  `src/manifest.test.ts`，各自覆蓋上面三項。

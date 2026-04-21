import { createPluginRuntimeStore, type PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

const { setRuntime: setLineWorksRuntime, getRuntime: getLineWorksRuntime } =
  createPluginRuntimeStore<PluginRuntime>({
    pluginId: "lineworks",
    errorMessage: "LINE WORKS runtime not initialized — plugin not registered",
  });

export { getLineWorksRuntime, setLineWorksRuntime };

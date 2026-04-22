import { injectable } from "inversify";

import {
  OpenClawPluginHost,
  OpenClawPluginRuntime,
  type PluginRuntimeOptions,
} from "@a2a-channels/openclaw-compat";

import { registerAllPlugins } from "../register-plugins.js";

@injectable()
export class PluginHostProvider {
  createRuntime(options: PluginRuntimeOptions): OpenClawPluginRuntime {
    return new OpenClawPluginRuntime(options);
  }

  create(runtime: OpenClawPluginRuntime): OpenClawPluginHost {
    const host = new OpenClawPluginHost(runtime);
    registerAllPlugins(host);
    return host;
  }
}

import { injectable } from "inversify";

import {
  OpenClawPluginHost,
  OpenClawPluginRuntime,
  type PluginRuntimeOptions,
} from "@a2a-channels/openclaw-compat";

import { registerAllPlugins } from "../register-plugins.js";

export interface OpenClawRuntimeAssembly {
  runtime: OpenClawPluginRuntime;
  pluginHost: OpenClawPluginHost;
}

@injectable()
export class OpenClawRuntimeAssembler {
  assemble(options: PluginRuntimeOptions): OpenClawRuntimeAssembly {
    const runtime = this.createRuntime(options);
    const pluginHost = this.createPluginHost(runtime);
    return { runtime, pluginHost };
  }

  protected createRuntime(
    options: PluginRuntimeOptions,
  ): OpenClawPluginRuntime {
    return new OpenClawPluginRuntime(options);
  }

  protected createPluginHost(
    runtime: OpenClawPluginRuntime,
  ): OpenClawPluginHost {
    const host = new OpenClawPluginHost(runtime);
    registerAllPlugins(host);
    return host;
  }
}

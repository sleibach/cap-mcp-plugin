const cds = global.cds; // enforce host app cds instance
const McpPlugin = require("./lib/mcp").default;
const McpBuild = require("./lib/config/build");

// Build tasks
McpBuild.registerBuildTask();

const plugin = new McpPlugin();

// Plugin hooks event registration
cds.on("bootstrap", async (app) => {
  await plugin?.onBootstrap(app);
});

// `loaded` fires for each CSN fragment BEFORE the model is compiled. We use
// it to inject the session-store entity in db mode so `cds deploy` creates
// the backing table as part of the hosting app's normal deploy flow.
cds.on("loaded", (model) => {
  plugin?.onModelLoaded(model);
});

cds.on("serving", async () => {
  await plugin?.onLoaded(cds.model);
});

cds.on("shutdown", async () => {
  await plugin?.onShutdown();
});

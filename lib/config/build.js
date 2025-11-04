"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerBuildTask = registerBuildTask;
const logger_1 = require("../logger");
const json_parser_1 = require("./json-parser");
/* @ts-ignore */
const cds = global.cds || require("@sap/cds"); // This is a work around for missing cds context
function registerBuildTask() {
    cds.build?.register("mcp", class McpBuildPlugin extends cds.build.Plugin {
        static taskDefaults = {};
        static instructionsPath;
        static hasTask() {
            const config = cds.env.mcp;
            if (!config) {
                return false;
            }
            else if (typeof config === "object") {
                this.instructionsPath =
                    typeof config.instructions === "object"
                        ? config.instructions.file
                        : undefined;
                return (this.instructionsPath !== undefined &&
                    this.instructionsPath.length > 0);
            }
            const parsed = (0, json_parser_1.parseCAPConfiguration)(config);
            if (!parsed || typeof parsed.instructions !== "object") {
                return false;
            }
            this.instructionsPath =
                typeof parsed.instructions === "object"
                    ? parsed.instructions.file
                    : undefined;
            return (this.instructionsPath !== undefined &&
                this.instructionsPath.length > 0);
        }
        async build() {
            logger_1.LOGGER.debug("Performing build task - copy MCP instructions");
            if (!McpBuildPlugin.instructionsPath) {
                return;
            }
            if (cds.utils.fs.existsSync(this.task.src, McpBuildPlugin.instructionsPath)) {
                await this.copy(McpBuildPlugin.instructionsPath).to(cds.utils.path.join("srv", McpBuildPlugin.instructionsPath));
            }
        }
    });
}

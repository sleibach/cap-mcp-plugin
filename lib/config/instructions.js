"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getMcpInstructions = getMcpInstructions;
exports.readInstructionsFile = readInstructionsFile;
const cds_1 = require("@sap/cds");
function getMcpInstructions(config) {
    if (!config.instructions) {
        return undefined;
    }
    if (typeof config.instructions === "string") {
        return config.instructions;
    }
    return config.instructions.file
        ? readInstructionsFile(config.instructions.file)
        : undefined;
}
function readInstructionsFile(path) {
    if (!containsMarkdownType(path)) {
        throw new Error("Invalid file type provided for instructions");
    }
    else if (!cds_1.utils.fs.existsSync(path)) {
        throw new Error("Instructions file not found");
    }
    const file = cds_1.utils.fs.readFileSync(path);
    return file.toString("utf8");
}
function containsMarkdownType(path) {
    const extension = path.substring(path.length - 3);
    return extension === ".md";
}

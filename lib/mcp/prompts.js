"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assignPromptToServer = assignPromptToServer;
const logger_1 = require("../logger");
const utils_1 = require("./utils");
// NOTE: Not satisfied with below implementation, will need to be revised for full effect
/*
annotate CatalogService with @mcp.prompts: [{
  name      : 'give-me-book-abstract',
  title     : 'Book Abstract',
  description: 'Gives an abstract of a book based on the title',
  template  : 'Search the internet and give me an abstract of the book {{book-id}}', = template
  inputs    : [{ Inputs = Args
    key : 'book-id',
    type: 'String'
  }]
}];
 */
/**
 * Registers prompt templates from a prompt annotation with the MCP server
 * Each prompt template supports variable substitution using {{variable}} syntax
 * @param model - The prompt annotation containing template definitions and inputs
 * @param server - The MCP server instance to register prompts with
 */
function assignPromptToServer(model, server) {
    logger_1.LOGGER.debug("Adding prompt", model);
    for (const prompt of model.prompts) {
        const inputs = constructInputArgs(prompt.inputs);
        server.registerPrompt(prompt.name, {
            title: prompt.title,
            description: prompt.description,
            argsSchema: inputs,
        }, async (args) => {
            let parsedMsg = prompt.template;
            for (const [k, v] of Object.entries(args)) {
                parsedMsg = parsedMsg.replaceAll(`{{${k}}}`, String(v));
            }
            return {
                messages: [
                    {
                        role: prompt.role,
                        content: {
                            type: "text",
                            text: parsedMsg,
                        },
                    },
                ],
            };
        });
    }
}
/**
 * Builds Zod schema definitions for prompt input parameters
 * Converts CDS type strings to appropriate Zod validation schemas
 * @param inputs - Array of prompt input parameter definitions
 * @returns Record mapping parameter names to Zod schemas, or undefined if no inputs
 */
function constructInputArgs(inputs) {
    // Not happy with using any here, but zod types are hard to figure out....
    if (!inputs || inputs.length <= 0)
        return undefined;
    const result = {};
    for (const el of inputs) {
        result[el.key] = (0, utils_1.determineMcpParameterType)(el.type);
    }
    return result;
}

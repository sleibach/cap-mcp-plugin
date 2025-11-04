"use strict";
/* ======================================
 * How it will look in the .cdsrc or package.json
 * "cds": {
 *  ...
 *    "mcp": {
 *      "name": "my-mcp-server", // This is optional - otherwise grabbed from package.json name
 *      "version": "1.0.0", // Optional, otherwise grabbed from package.json version
 *      "auth": "inherit", // By default this will inherit auth from CAP, otherwise values can be 'inherit'|'api-key'|'none'
 *      "capabilities": {
 *        "resources": {
 *          "listChanged": true, // If not provided - default value = true
 *          "subscribe": true, // If not provided - default value = false
 *        },
 *        "tools": {
 *          "listChanged": true // If not provided - default value = true
 *        },
 *        "prompts": {
 *          "listChanged": true // If not provided - default value = true
 *        }
 *      }
 *    },
 *  ...
 * }
 * ======================================
 */
Object.defineProperty(exports, "__esModule", { value: true });

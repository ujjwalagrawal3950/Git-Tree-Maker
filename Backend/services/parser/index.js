const { ParserRegistry, defaultRegistry } = require("./ParserRegistry");
const { scheduleRepositoryParse, DEFAULT_SCHEDULER_CONFIG } = require("./ParserScheduler");
const BaseAdapter = require("./adapters/BaseAdapter");
const UnsupportedAdapter = require("./adapters/UnsupportedAdapter");
const { JavaScriptAdapter } = require("./adapters/javascript/JavaScriptAdapter");
const { TypeScriptAdapter } = require("./adapters/javascript/TypeScriptAdapter");
const { PythonAdapter } = require("./adapters/python/PythonAdapter");
const { JavaAdapter } = require("./adapters/java/JavaAdapter");
const { CAdapter } = require("./adapters/c/CAdapter");
const { CppAdapter } = require("./adapters/cpp/CppAdapter");
const { HeaderAdapter } = require("./adapters/c_cpp_shared/HeaderAdapter");
const { JavaScriptModuleResolver } = require("./resolvers/javascript/JavaScriptModuleResolver");
const { PythonImportResolver } = require("./resolvers/python/PythonImportResolver");
const { JavaImportResolver } = require("./resolvers/java/JavaImportResolver");
const { CppIncludeResolver } = require("./resolvers/c_cpp/CppIncludeResolver");
const irBuilder = require("./irBuilder");
const irValidator = require("./irValidator");

/**
 * High-level service function to parse an array of retrieved repository files into unified FileIR documents.
 *
 * @param {object} params
 * @param {object} params.repository - { owner, name, fullName, commitSha }
 * @param {Array<object>} params.files - Files from Phase 04 retrieval
 * @param {object} [params.options]
 * @returns {Promise<object>}
 */
async function parseRepositoryFiles({ repository, files, options = {} }) {
  return scheduleRepositoryParse({
    repository,
    files,
    options,
  });
}

module.exports = {
  ParserRegistry,
  defaultRegistry,
  scheduleRepositoryParse,
  parseRepositoryFiles,
  DEFAULT_SCHEDULER_CONFIG,
  BaseAdapter,
  UnsupportedAdapter,
  JavaScriptAdapter,
  TypeScriptAdapter,
  PythonAdapter,
  JavaAdapter,
  CAdapter,
  CppAdapter,
  HeaderAdapter,
  JavaScriptModuleResolver,
  PythonImportResolver,
  JavaImportResolver,
  CppIncludeResolver,
  irBuilder,
  irValidator,
};


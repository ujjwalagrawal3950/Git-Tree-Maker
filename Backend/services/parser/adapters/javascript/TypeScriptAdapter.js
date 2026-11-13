const BaseAdapter = require("../BaseAdapter");
const { parseJsTsFile } = require("./JavaScriptAdapter");

/**
 * TypeScript Language Parser Adapter.
 * Supports .ts, .tsx, .mts, and .cts files.
 */
class TypeScriptAdapter extends BaseAdapter {
  constructor() {
    super({
      adapterId: "typescript-adapter",
      adapterVersion: "1.0.0",
      engine: "typescript",
      engineVersion: "5.9.3",
      grammarVersion: null,
      capabilities: ["symbols", "imports", "exports", "calls", "type_references", "inheritance"],
    });
  }

  getSupportedLanguages() {
    return ["typescript"];
  }

  async parseFile(file, options = {}) {
    return parseJsTsFile(this, file, options);
  }
}

module.exports = {
  TypeScriptAdapter,
};


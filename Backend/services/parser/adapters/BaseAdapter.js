/**
 * Abstract Base Class for Language Parser Adapters.
 * Every language-specific adapter (TypeScript, Python, Java, etc.) extends this class.
 */
class BaseAdapter {
  constructor(config = {}) {
    this.adapterId = config.adapterId || "base-adapter";
    this.adapterVersion = config.adapterVersion || "1.0.0";
    this.engine = config.engine || "generic";
    this.engineVersion = config.engineVersion || "1.0.0";
    this.grammarVersion = config.grammarVersion || null;
    this.capabilities = config.capabilities || ["symbols", "imports", "exports"];
  }

  /**
   * Returns array of canonical language IDs this adapter supports.
   * @returns {string[]}
   */
  getSupportedLanguages() {
    throw new Error("getSupportedLanguages() must be implemented by adapter subclass.");
  }

  /**
   * Parses a single file into a FileIR document.
   *
   * @param {object} file
   * @param {string} file.path
   * @param {string} file.blobSha
   * @param {string} file.language
   * @param {string} file.content
   * @param {object} [file.repository]
   * @param {object} [options]
   * @returns {Promise<object>} FileIR document
   */
  async parseFile(file, options = {}) {
    throw new Error("parseFile() must be implemented by adapter subclass.");
  }
}

module.exports = BaseAdapter;


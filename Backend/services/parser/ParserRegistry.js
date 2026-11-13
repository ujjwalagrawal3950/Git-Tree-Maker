const UnsupportedAdapter = require("./adapters/UnsupportedAdapter");
const { SOURCE_LANGUAGES } = require("../languageRegistry");

/**
 * Central registry managing language parser adapters.
 * Dispatches file parsing requests to the appropriate language-specific adapter
 * or gracefully falls back to UnsupportedAdapter.
 */
class ParserRegistry {
  constructor() {
    this.adapters = new Map();
    this.fallbackAdapter = new UnsupportedAdapter();
  }

  /**
   * Returns the canonical language IDs recognized by Cartograph (from Phase 04 Language Registry).
   * @returns {string[]}
   */
  getCanonicalLanguages() {
    return Object.keys(SOURCE_LANGUAGES);
  }

  /**
   * Registers a language parser adapter.
   *
   * @param {import('./adapters/BaseAdapter')} adapter
   * @param {object} [options]
   * @param {boolean} [options.replace=false] - Allow overwriting an existing registration
   */
  registerAdapter(adapter, { replace = false } = {}) {
    if (!adapter || typeof adapter.getSupportedLanguages !== "function") {
      throw new Error("Invalid adapter: must implement getSupportedLanguages()");
    }

    const languages = adapter.getSupportedLanguages();
    for (const lang of languages) {
      const clean = lang.toLowerCase().trim();
      if (this.adapters.has(clean) && !replace) {
        throw new Error(`Adapter for language "${clean}" is already registered. Pass { replace: true } to overwrite.`);
      }
      this.adapters.set(clean, adapter);
    }
  }

  /**
   * Retrieves the adapter registered for the given language identifier.
   * Falls back to UnsupportedAdapter if no specific adapter is found.
   *
   * @param {string} language
   * @returns {import('./adapters/BaseAdapter')}
   */
  getAdapter(language) {
    if (!language || typeof language !== "string") {
      return this.fallbackAdapter;
    }
    const clean = language.toLowerCase().trim();
    return this.adapters.get(clean) || this.fallbackAdapter;
  }

  /**
   * Checks if an adapter is explicitly registered for the language.
   *
   * @param {string} language
   * @returns {boolean}
   */
  hasAdapter(language) {
    if (!language || typeof language !== "string") return false;
    return this.adapters.has(language.toLowerCase().trim());
  }

  /**
   * Returns list of all explicitly supported language keys currently registered.
   * @returns {string[]}
   */
  getSupportedLanguages() {
    return Array.from(this.adapters.keys());
  }
}

// Default singleton instance
const defaultRegistry = new ParserRegistry();

// Pre-register production JavaScript, TypeScript, Python, Java, C, and C++ language adapters
const { JavaScriptAdapter } = require("./adapters/javascript/JavaScriptAdapter");
const { TypeScriptAdapter } = require("./adapters/javascript/TypeScriptAdapter");
const { PythonAdapter } = require("./adapters/python/PythonAdapter");
const { JavaAdapter } = require("./adapters/java/JavaAdapter");
const { CAdapter } = require("./adapters/c/CAdapter");
const { CppAdapter } = require("./adapters/cpp/CppAdapter");

defaultRegistry.registerAdapter(new JavaScriptAdapter());
defaultRegistry.registerAdapter(new TypeScriptAdapter());
defaultRegistry.registerAdapter(new PythonAdapter());
defaultRegistry.registerAdapter(new JavaAdapter());
defaultRegistry.registerAdapter(new CAdapter());
defaultRegistry.registerAdapter(new CppAdapter());

module.exports = {
  ParserRegistry,
  defaultRegistry,
};


const BaseAdapter = require("./BaseAdapter");
const { buildFileIR, createFileId } = require("../irBuilder");

/**
 * Fallback Adapter for unsupported or un-registered languages.
 * Produces a schema-compliant FileIR document with status "unsupported" and an informational diagnostic.
 */
class UnsupportedAdapter extends BaseAdapter {
  constructor() {
    super({
      adapterId: "unsupported-adapter",
      adapterVersion: "1.0.0",
      engine: "none",
      engineVersion: "0.0.0",
      grammarVersion: null,
      capabilities: [],
    });
  }

  getSupportedLanguages() {
    return ["*"];
  }

  async parseFile(file, options = {}) {
    const startTime = Date.now();
    const repository = file.repository || options.repository || {
      owner: "unknown",
      name: "unknown",
      fullName: "unknown/unknown",
      commitSha: "0000000000000000000000000000000000000000",
    };

    const fileId = file.fileId || createFileId(repository.fullName, file.path);
    const durationMs = Date.now() - startTime;

    return buildFileIR({
      repository,
      file: {
        fileId,
        path: file.path,
        blobSha: file.blobSha,
        language: file.language || "unknown",
        category: file.category || "source",
        sizeBytes: typeof file.size === "number" ? file.size : (file.content ? Buffer.byteLength(file.content, "utf8") : 0),
        content: file.content,
      },
      parser: {
        adapterId: this.adapterId,
        adapterVersion: this.adapterVersion,
        engine: this.engine,
        engineVersion: this.engineVersion,
        grammarVersion: null,
        status: "unsupported",
        capabilities: [],
        durationMs,
      },
      symbols: [],
      imports: [],
      exports: [],
      occurrences: [],
      callSites: [],
      typeReferences: [],
      inheritance: [],
      diagnostics: [
        {
          code: "PARSER_UNAVAILABLE",
          severity: "info",
          message: `Parser for language "${file.language || "unknown"}" is not yet registered.`,
          location: null,
        },
      ],
    });
  }
}

module.exports = UnsupportedAdapter;


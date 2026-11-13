const BaseAdapter = require("../BaseAdapter");
const { classifyHeaderFile } = require("./headerClassifier");
const { CAdapter } = require("../c/CAdapter");
const { CppAdapter } = require("../cpp/CppAdapter");
const { createDiagnostic } = require("../../irBuilder");

/**
 * Adapter for .h headers whose language (C vs C++) requires evidence-based resolution.
 * Dispatches to CAdapter or CppAdapter according to classifyHeaderFile evidence,
 * or preserves ambiguity when evidence is inconclusive.
 */
class HeaderAdapter extends BaseAdapter {
  constructor() {
    super({
      adapterId: "c-cpp-header-adapter",
      adapterVersion: "1.0.0",
      engine: "tree-sitter",
      engineVersion: "0.25.1",
      grammarVersion: "0.23.4",
      capabilities: [
        "symbols",
        "imports",
        "exports",
        "calls",
        "type_references",
        "inheritance",
      ],
    });

    this.cAdapter = new CAdapter();
    this.cppAdapter = new CppAdapter();
  }

  getSupportedLanguages() {
    return ["c_cpp_header"];
  }

  async parseFile(file, options = {}) {
    const content = typeof file.content === "string" ? file.content : "";
    const classification = classifyHeaderFile(file.path, content, options);

    if (classification.language === "c") {
      const ir = await this.cAdapter.parseFile(
        { ...file, language: "c" },
        options
      );
      ir.parser.languageMetadata = {
        headerClassification: classification,
      };
      return ir;
    }

    if (classification.language === "cpp") {
      const ir = await this.cppAdapter.parseFile(
        { ...file, language: "cpp" },
        options
      );
      ir.parser.languageMetadata = {
        headerClassification: classification,
      };
      return ir;
    }

    // Ambiguous header: parse with Cpp grammar (which handles both C and C++ syntax)
    // while explicitly preserving language ambiguity in FileIR.
    const ir = await this.cppAdapter.parseFile(
      { ...file, language: "c_cpp_header" },
      options
    );

    ir.analysis.file.language = "c_cpp_header";
    ir.parser.adapterId = this.adapterId;
    ir.parser.adapterVersion = this.adapterVersion;
    ir.parser.languageMetadata = {
      isAmbiguousHeader: true,
      classificationReason: classification.reason,
      candidates: classification.candidates || ["c", "cpp"],
    };

    ir.diagnostics.push(
      createDiagnostic({
        code: "AMBIGUOUS_HEADER_LANGUAGE",
        severity: "info",
        message:
          "Header file is ambiguous between C and C++ due to insufficient classification evidence.",
        location: null,
      })
    );

    return ir;
  }
}

module.exports = {
  HeaderAdapter,
};


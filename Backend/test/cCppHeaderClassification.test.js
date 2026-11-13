const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyHeaderFile } = require("../services/parser/adapters/c_cpp_shared/headerClassifier");
const { HeaderAdapter } = require("../services/parser/adapters/c_cpp_shared/HeaderAdapter");
const { classifyFile } = require("../services/languageRegistry");
const { defaultRegistry } = require("../services/parser/ParserRegistry");
const { validateFileIR } = require("../services/parser/irValidator");

test("cCppHeaderClassification: languageRegistry classifies .h as eligible source with language c_cpp_header", () => {
  const result = classifyFile("include/my_header.h");
  assert.equal(result.category, "source");
  assert.equal(result.language, "c_cpp_header");
  assert.equal(result.isSource, true);
  assert.equal(result.isEligible, true);
});

test("cCppHeaderClassification: classifies .h as cpp when unambiguous C++ constructs are present", () => {
  const classHeader = "class MyService { public: void execute(); };";
  assert.equal(classifyHeaderFile("service.h", classHeader).language, "cpp");

  const templateHeader = "template <typename T> T max_val(T a, T b);";
  assert.equal(classifyHeaderFile("max.h", templateHeader).language, "cpp");

  const namespaceHeader = "namespace my_app::core { int run(); }";
  assert.equal(classifyHeaderFile("app.h", namespaceHeader).language, "cpp");

  const scopedEnumHeader = "enum class Mode { Fast, Safe };";
  assert.equal(classifyHeaderFile("mode.h", scopedEnumHeader).language, "cpp");

  const cppIncludeHeader = "#include <vector>\n#include <string>";
  assert.equal(classifyHeaderFile("types.h", cppIncludeHeader).language, "cpp");
});

test("cCppHeaderClassification: classifies .h using build metadata when compilation database entry exists", () => {
  const buildMetadataCpp = {
    translationUnits: new Map([
      ["src/config.h", { compilerStandard: "c++17", compiler: "clang++" }],
    ]),
  };
  const resCpp = classifyHeaderFile("src/config.h", "int config_val = 1;", {
    buildMetadata: buildMetadataCpp,
  });
  assert.equal(resCpp.language, "cpp");
  assert.equal(resCpp.confidence, "high");

  const buildMetadataC = {
    translationUnits: new Map([
      ["src/config.h", { compilerStandard: "c11", compiler: "gcc" }],
    ]),
  };
  const resC = classifyHeaderFile("src/config.h", "int config_val = 1;", {
    buildMetadata: buildMetadataC,
  });
  assert.equal(resC.language, "c");
  assert.equal(resC.confidence, "high");
});

test("cCppHeaderClassification: classifies .h based on includer relationships when local syntax is neutral", () => {
  const neutralContent = "struct Point { int x; int y; };";

  // Exclusively C++ includers
  const resCpp = classifyHeaderFile("point.h", neutralContent, {
    includers: ["src/main.cpp", "src/service.cpp"],
  });
  assert.equal(resCpp.language, "cpp");
  assert.equal(resCpp.confidence, "medium");

  // Exclusively C includers
  const resC = classifyHeaderFile("point.h", neutralContent, {
    includers: ["src/main.c", "src/util.c"],
  });
  assert.equal(resC.language, "c");
  assert.equal(resC.confidence, "medium");

  // Mixed includers preserve ambiguity
  const resMixed = classifyHeaderFile("point.h", neutralContent, {
    includers: ["src/main.c", "src/service.cpp"],
  });
  assert.equal(resMixed.language, "ambiguous");
  assert.equal(resMixed.confidence, "uncertain");
  assert.deepEqual(resMixed.candidates, ["c", "cpp"]);
});

test("cCppHeaderClassification: preserves uncertainty when evidence is insufficient", () => {
  const neutralContent = "int calculate(int a, int b);";
  const res = classifyHeaderFile("math_ops.h", neutralContent, {});

  assert.equal(res.language, "ambiguous");
  assert.equal(res.confidence, "uncertain");
  assert.equal(res.reason, "insufficient_evidence");
  assert.deepEqual(res.candidates, ["c", "cpp"]);
});

test("cCppHeaderClassification: HeaderAdapter parses ambiguous header and preserves uncertainty in FileIR", async () => {
  const adapter = new HeaderAdapter();
  const file = {
    path: "include/ambiguous_ops.h",
    content: "int compute(int x, int y);\nstruct Data { int val; };",
    language: "c_cpp_header",
  };

  const ir = await adapter.parseFile(file);
  const { isValid, errors } = validateFileIR(ir);
  assert.equal(isValid, true, `Validation failed: ${errors.join("; ")}`);

  assert.equal(ir.analysis.file.language, "c_cpp_header");
  assert.equal(ir.parser.languageMetadata.isAmbiguousHeader, true);
  assert.deepEqual(ir.parser.languageMetadata.candidates, ["c", "cpp"]);

  // Diagnostic emitted
  const diag = ir.diagnostics.find((d) => d.code === "AMBIGUOUS_HEADER_LANGUAGE");
  assert.ok(diag, "AMBIGUOUS_HEADER_LANGUAGE diagnostic must be present");
  assert.equal(diag.severity, "info");

  // Symbols extracted
  const fnSym = ir.symbols.find((s) => s.name === "compute");
  assert.ok(fnSym, "compute symbol must be extracted");
  const structSym = ir.symbols.find((s) => s.name === "Data");
  assert.ok(structSym, "Data struct symbol must be extracted");
});

test("cCppHeaderClassification: defaultRegistry dispatches c_cpp_header to HeaderAdapter", () => {
  assert.equal(defaultRegistry.hasAdapter("c_cpp_header"), true);
  const adapter = defaultRegistry.getAdapter("c_cpp_header");
  assert.ok(adapter instanceof HeaderAdapter);
});


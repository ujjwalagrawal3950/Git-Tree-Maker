const test = require("node:test");
const assert = require("node:assert/strict");
const { parseCSource, createCParser } = require("../services/parser/adapters/c/parserFactory");
const { parseCppSource, createCppParser } = require("../services/parser/adapters/cpp/parserFactory");
const { CAdapter } = require("../services/parser/adapters/c/CAdapter");
const { CppAdapter } = require("../services/parser/adapters/cpp/CppAdapter");
const { defaultRegistry, scheduleRepositoryParse } = require("../services/parser");
const { validateFileIR } = require("../services/parser/irValidator");

const MOCK_REPO = {
  owner: "torvalds",
  name: "sample-c-cpp",
  fullName: "torvalds/sample-c-cpp",
  commitSha: "0000111122223333444455556666777788889999",
};

test("cCppParser: C and C++ parsers load and parse valid translation units with zero diagnostics", () => {
  const cCode = "int main(int argc, char** argv) { return 0; }\n";
  const { tree: cTree, diagnostics: cDiag, hasErrors: cErr } = parseCSource(cCode, "main.c");
  assert.equal(cErr, false);
  assert.equal(cDiag.length, 0);
  assert.equal(cTree.rootNode.type, "translation_unit");

  const cppCode = "template<typename T>\nclass Container { T value; };\nint main() { return 0; }\n";
  const { tree: cppTree, diagnostics: cppDiag, hasErrors: cppErr } = parseCppSource(cppCode, "main.cpp");
  assert.equal(cppErr, false);
  assert.equal(cppDiag.length, 0);
  assert.equal(cppTree.rootNode.type, "translation_unit");
});

test("cCppParser: C and C++ parsers capture syntax error diagnostics on malformed code", () => {
  const badC = "int broken( {\n";
  const { diagnostics: cDiag, hasErrors: cErr } = parseCSource(badC, "bad.c");
  assert.equal(cErr, true);
  assert.ok(cDiag.length > 0);
  assert.equal(cDiag[0].code, "C_SYNTAX_ERROR");
  assert.equal(cDiag[0].severity, "error");

  const badCpp = "class Incomplete <>\n";
  const { diagnostics: cppDiag, hasErrors: cppErr } = parseCppSource(badCpp, "bad.cpp");
  assert.equal(cppErr, true);
  assert.ok(cppDiag.length > 0);
  assert.equal(cppDiag[0].code, "CPP_SYNTAX_ERROR");
  assert.equal(cppDiag[0].severity, "error");
});

test("cCppParser: CAdapter and CppAdapter parse empty files and produce valid FileIR", async () => {
  const cAdapter = new CAdapter();
  const cIR = await cAdapter.parseFile({
    path: "empty.c",
    content: "",
    language: "c",
    repository: MOCK_REPO,
  });

  assert.equal(cIR.irVersion, "1.0.0");
  assert.equal(cIR.analysis.file.path, "empty.c");
  assert.equal(cIR.parser.adapterId, "c-adapter");
  assert.equal(cIR.parser.status, "complete");
  const cValidation = validateFileIR(cIR);
  assert.equal(cValidation.isValid, true, `Validation failed: ${cValidation.errors.join(", ")}`);

  const cppAdapter = new CppAdapter();
  const cppIR = await cppAdapter.parseFile({
    path: "empty.cpp",
    content: "",
    language: "cpp",
    repository: MOCK_REPO,
  });

  assert.equal(cppIR.irVersion, "1.0.0");
  assert.equal(cppIR.analysis.file.path, "empty.cpp");
  assert.equal(cppIR.parser.adapterId, "cpp-adapter");
  assert.equal(cppIR.parser.status, "complete");
  const cppValidation = validateFileIR(cppIR);
  assert.equal(cppValidation.isValid, true, `Validation failed: ${cppValidation.errors.join(", ")}`);
});

test("cCppParser: CAdapter and CppAdapter handle CRLF and comments cleanly", async () => {
  const cAdapter = new CAdapter();
  const cCode = "/* C Header */\r\n#include <stdio.h>\r\n\r\n// main\r\nint main() { return 0; }\r\n";
  const cIR = await cAdapter.parseFile({
    path: "src/main.c",
    content: cCode,
    language: "c",
    repository: MOCK_REPO,
  });
  assert.equal(cIR.parser.status, "complete");
  const cValidation = validateFileIR(cIR);
  assert.equal(cValidation.isValid, true);

  const cppAdapter = new CppAdapter();
  const cppCode = "// C++ File\r\n#include <iostream>\r\n\r\nint main() {\r\n    std::cout << \"ok\";\r\n    return 0;\r\n}\r\n";
  const cppIR = await cppAdapter.parseFile({
    path: "src/main.cpp",
    content: cppCode,
    language: "cpp",
    repository: MOCK_REPO,
  });
  assert.equal(cppIR.parser.status, "complete");
  const cppValidation = validateFileIR(cppIR);
  assert.equal(cppValidation.isValid, true);
});

test("cCppParser: CAdapter and CppAdapter set partial status on syntax error while preserving schema validity", async () => {
  const cAdapter = new CAdapter();
  const brokenC = "int f(int a { return;\n";
  const cIR = await cAdapter.parseFile({
    path: "broken.c",
    content: brokenC,
    language: "c",
    repository: MOCK_REPO,
  });
  assert.equal(cIR.parser.status, "partial");
  assert.ok(cIR.diagnostics.length > 0);
  const cValidation = validateFileIR(cIR);
  assert.equal(cValidation.isValid, true);

  const cppAdapter = new CppAdapter();
  const brokenCpp = "namespace { class A { void m( } };\n";
  const cppIR = await cppAdapter.parseFile({
    path: "broken.cpp",
    content: brokenCpp,
    language: "cpp",
    repository: MOCK_REPO,
  });
  assert.equal(cppIR.parser.status, "partial");
  assert.ok(cppIR.diagnostics.length > 0);
  const cppValidation = validateFileIR(cppIR);
  assert.equal(cppValidation.isValid, true);
});

test("cCppParser: ParserRegistry registers CAdapter for 'c' and CppAdapter for 'cpp'", () => {
  assert.equal(defaultRegistry.hasAdapter("c"), true);
  assert.equal(defaultRegistry.hasAdapter("cpp"), true);
  assert.equal(defaultRegistry.hasAdapter("C"), true);
  assert.equal(defaultRegistry.hasAdapter("CPP"), true);

  const cAdapter = defaultRegistry.getAdapter("c");
  assert.equal(cAdapter.adapterId, "c-adapter");
  assert.equal(cAdapter.engine, "tree-sitter");

  const cppAdapter = defaultRegistry.getAdapter("cpp");
  assert.equal(cppAdapter.adapterId, "cpp-adapter");
  assert.equal(cppAdapter.engine, "tree-sitter");
});

test("cCppParser: scheduleRepositoryParse dispatches .c to CAdapter and .cpp/.cc/.hpp to CppAdapter", async () => {
  const files = [
    {
      path: "src/utils.c",
      language: "c",
      blobSha: "sha_c_1",
      content: "int add(int a, int b) { return a + b; }\n",
    },
    {
      path: "src/main.cpp",
      language: "cpp",
      blobSha: "sha_cpp_1",
      content: "int main() { return 0; }\n",
    },
    {
      path: "include/types.hpp",
      language: "cpp",
      blobSha: "sha_hpp_1",
      content: "struct Point { int x; int y; };\n",
    },
  ];

  const result = await scheduleRepositoryParse({
    repository: MOCK_REPO,
    files,
  });

  assert.equal(result.status, "complete");
  assert.equal(result.summary.totalFiles, 3);
  assert.equal(result.summary.parsedComplete, 3);
  assert.equal(result.summary.failed, 0);

  const cIR = result.files.find((f) => f.analysis.file.path === "src/utils.c");
  assert.ok(cIR);
  assert.equal(cIR.parser.adapterId, "c-adapter");
  assert.equal(cIR.parser.status, "complete");

  const cppIR = result.files.find((f) => f.analysis.file.path === "src/main.cpp");
  assert.ok(cppIR);
  assert.equal(cppIR.parser.adapterId, "cpp-adapter");
  assert.equal(cppIR.parser.status, "complete");

  const hppIR = result.files.find((f) => f.analysis.file.path === "include/types.hpp");
  assert.ok(hppIR);
  assert.equal(hppIR.parser.adapterId, "cpp-adapter");
  assert.equal(hppIR.parser.status, "complete");
});


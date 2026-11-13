const test = require("node:test");
const assert = require("node:assert/strict");
const { CppIncludeResolver } = require("../services/parser/resolvers/c_cpp/CppIncludeResolver");
const { CppRepositoryIndex } = require("../services/parser/resolvers/c_cpp/candidateResolver");

const manifest = [
  "src/core/main.cpp",
  "src/core/local_helper.h",
  "src/utils/math.h",
  "include/app/config.h",
  "include/common/types.h",
  "submodule_a/util.h",
  "submodule_b/util.h",
];

test("cCppResolver: quoted include resolves relative to source directory", () => {
  const resolver = new CppIncludeResolver({ manifest });
  const res = resolver.resolveInclude("src/core/main.cpp", "local_helper.h", {
    includeType: "quoted",
  });

  assert.equal(res.status, "internal_resolved");
  assert.equal(res.resolvedPath, "src/core/local_helper.h");
  assert.equal(res.rule, "source_relative_directory");
});

test("cCppResolver: legitimate parent relative include (../) resolves without escaping", () => {
  const resolver = new CppIncludeResolver({ manifest });
  const res = resolver.resolveInclude("src/core/main.cpp", "../utils/math.h", {
    includeType: "quoted",
  });

  assert.equal(res.status, "internal_resolved");
  assert.equal(res.resolvedPath, "src/utils/math.h");
  assert.equal(res.rule, "source_relative_directory");
});

test("cCppResolver: path traversal escaping repository root is rejected securely", () => {
  const resolver = new CppIncludeResolver({ manifest });
  const res = resolver.resolveInclude("src/core/main.cpp", "../../../../etc/passwd", {
    includeType: "quoted",
  });

  assert.equal(res.status, "unresolved");
  assert.equal(res.rule, "path_traversal_escapes_repository");
  assert.equal(res.resolvedPath, null);
});

test("cCppResolver: resolves include via configured include directories", () => {
  const resolver = new CppIncludeResolver({ manifest, includeDirectories: ["include"] });
  const res = resolver.resolveInclude("src/core/main.cpp", "app/config.h", {
    includeType: "quoted",
  });

  assert.equal(res.status, "internal_resolved");
  assert.equal(res.resolvedPath, "include/app/config.h");
  assert.equal(res.rule, "configured_include_directory");
});

test("cCppResolver: angle-bracket include resolves to repository-owned header before falling back", () => {
  const resolver = new CppIncludeResolver({ manifest, includeDirectories: ["include"] });
  const res = resolver.resolveInclude("src/core/main.cpp", "common/types.h", {
    includeType: "system",
  });

  assert.equal(res.status, "internal_resolved");
  assert.equal(res.resolvedPath, "include/common/types.h");
  assert.equal(res.rule, "configured_include_directory");
});

test("cCppResolver: classifies standard C, C++, POSIX, and platform headers authoritatively", () => {
  const resolver = new CppIncludeResolver({ manifest });

  // C Standard
  const stdio = resolver.resolveInclude("src/main.c", "stdio.h", { includeType: "system" });
  assert.equal(stdio.status, "standard_library");
  assert.equal(stdio.category, "c_standard");

  // C++ Standard
  const iostream = resolver.resolveInclude("src/main.cpp", "iostream", { includeType: "system" });
  assert.equal(iostream.status, "standard_library");
  assert.equal(iostream.category, "cpp_standard");

  const vector = resolver.resolveInclude("src/main.cpp", "vector", { includeType: "system" });
  assert.equal(vector.status, "standard_library");
  assert.equal(vector.category, "cpp_standard");

  // POSIX
  const unistd = resolver.resolveInclude("src/main.c", "unistd.h", { includeType: "system" });
  assert.equal(unistd.status, "standard_library");
  assert.equal(unistd.category, "posix_standard");

  // Platform
  const windows = resolver.resolveInclude("src/main.cpp", "windows.h", { includeType: "system" });
  assert.equal(windows.status, "standard_library");
  assert.equal(windows.category, "platform_api");
});

test("cCppResolver: preserves ambiguity when multiple repository candidates match", () => {
  const resolver = new CppIncludeResolver({ manifest });
  const res = resolver.resolveInclude("src/main.cpp", "util.h", { includeType: "quoted" });

  assert.equal(res.status, "ambiguous");
  assert.equal(res.resolvedPath, null);
  assert.ok(Array.isArray(res.candidates));
  assert.equal(res.candidates.length, 2);
  assert.ok(res.candidates.includes("submodule_a/util.h"));
  assert.ok(res.candidates.includes("submodule_b/util.h"));
});

test("cCppResolver: preserves unsupported status for macro-computed includes", () => {
  const resolver = new CppIncludeResolver({ manifest });
  const res = resolver.resolveInclude("src/main.cpp", "HEADER_MACRO", {
    includeType: "computed_macro",
  });

  assert.equal(res.status, "unsupported");
  assert.equal(res.rule, "computed_macro_include");
});

test("cCppResolver: preserves conditional compilation evidence in resolution records", () => {
  const resolver = new CppIncludeResolver({ manifest });
  const mockFileIR = {
    analysis: {
      file: {
        fileId: "file_test_main_c",
        path: "src/core/main.cpp",
      },
    },
    imports: [
      {
        id: "import_0",
        rawSource: "local_helper.h",
        languageMetadata: {
          includeType: "quoted",
          isConditional: true,
          condition: "#ifdef USE_HELPER",
        },
        location: {
          start: { line: 5, column: 0 },
          end: { line: 5, column: 25 },
        },
      },
    ],
  };

  const fileRes = resolver.resolveFileIR(mockFileIR);
  assert.equal(fileRes.resolutions.length, 1);
  const r = fileRes.resolutions[0];
  assert.equal(r.status, "internal_resolved");
  assert.equal(r.resolvedPath, "src/core/local_helper.h");
  assert.equal(r.evidence.isConditional, true);
  assert.equal(r.evidence.condition, "#ifdef USE_HELPER");
});

test("cCppResolver: resolveRepository aggregates summary statistics accurately", () => {
  const resolver = new CppIncludeResolver({ manifest });
  const mockIRs = [
    {
      analysis: { file: { fileId: "file1", path: "src/core/main.cpp" } },
      imports: [
        { id: "i1", rawSource: "local_helper.h", languageMetadata: { includeType: "quoted" } },
        { id: "i2", rawSource: "iostream", languageMetadata: { includeType: "system" } },
        { id: "i3", rawSource: "missing.h", languageMetadata: { includeType: "quoted" } },
      ],
    },
  ];

  const { summary, files } = resolver.resolveRepository(mockIRs);
  assert.equal(summary.totalIncludes, 3);
  assert.equal(summary.internalResolved, 1);
  assert.equal(summary.standardLibrary, 1);
  assert.equal(summary.unresolved, 1);
  assert.equal(files.length, 1);
});


const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseCompileCommandsJson,
  tokenizeCommandLine,
  readCppBuildMetadata,
} = require("../services/parser/resolvers/c_cpp/buildMetadataReader");
const { CppIncludeResolver } = require("../services/parser/resolvers/c_cpp/CppIncludeResolver");

test("cCppBuildMetadata: safely tokenizes command line without shell execution", () => {
  const cmd = 'g++ -I"my include/dir" -I../ext -DVERSION="1.0.0" -DFEATURE_X -c src/main.cpp -o build/main.o';
  const tokens = tokenizeCommandLine(cmd);

  assert.equal(tokens[0], "g++");
  assert.equal(tokens[1], "-Imy include/dir");
  assert.equal(tokens[2], "-I../ext");
  assert.equal(tokens[3], "-DVERSION=1.0.0");
  assert.equal(tokens[4], "-DFEATURE_X");
  assert.equal(tokens[5], "-c");
  assert.equal(tokens[6], "src/main.cpp");
  assert.equal(tokens[7], "-o");
  assert.equal(tokens[8], "build/main.o");
});

test("cCppBuildMetadata: parses compile_commands.json with arguments array and command string", () => {
  const jsonContent = JSON.stringify([
    {
      directory: "build",
      file: "../src/main.cpp",
      arguments: [
        "/usr/bin/clang++",
        "-I../include",
        "-I../vendor/liba",
        "-DDEBUG=1",
        "-std=c++20",
        "-c",
        "../src/main.cpp",
      ],
    },
    {
      directory: "build",
      file: "../src/helper.c",
      command: 'gcc -I../include -DHELPER_VER="2.0" -c ../src/helper.c',
    },
  ]);

  const parsed = parseCompileCommandsJson(jsonContent);
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.totalEntries, 2);

  // Main TU
  const mainTU = parsed.translationUnits.get("src/main.cpp");
  assert.ok(mainTU, "src/main.cpp TU must exist");
  assert.deepEqual(mainTU.includeDirectories, ["include", "vendor/liba"]);
  assert.equal(mainTU.compilerStandard, "c++20");
  assert.deepEqual(mainTU.macros, [{ name: "DEBUG", value: "1" }]);

  // Helper TU
  const helperTU = parsed.translationUnits.get("src/helper.c");
  assert.ok(helperTU, "src/helper.c TU must exist");
  assert.deepEqual(helperTU.includeDirectories, ["include"]);
  assert.deepEqual(helperTU.macros, [{ name: "HELPER_VER", value: "2.0" }]);
});

test("cCppBuildMetadata: rejects include paths escaping repository root", () => {
  const jsonContent = JSON.stringify([
    {
      directory: "build",
      file: "../src/secure.cpp",
      arguments: [
        "clang++",
        "-I../../../../usr/local/include",
        "-I/etc/ssl/include",
        "-I../legit_include",
        "-c",
        "../src/secure.cpp",
      ],
    },
  ]);

  const parsed = parseCompileCommandsJson(jsonContent);
  assert.equal(parsed.errors.length, 0);
  const tu = parsed.translationUnits.get("src/secure.cpp");
  assert.ok(tu);
  // Only the repository-internal path should be admitted
  assert.deepEqual(tu.includeDirectories, ["legit_include"]);
});

test("cCppBuildMetadata: preserves translation-unit specificity and does not leak includes globally", () => {
  const manifest = [
    "src/module_a.cpp",
    "src/module_b.cpp",
    "custom_a/header_a.h",
    "custom_b/header_b.h",
  ];

  const supportingFiles = {
    "compile_commands.json": JSON.stringify([
      {
        directory: ".",
        file: "src/module_a.cpp",
        arguments: ["clang++", "-Icustom_a", "-c", "src/module_a.cpp"],
      },
      {
        directory: ".",
        file: "src/module_b.cpp",
        arguments: ["clang++", "-Icustom_b", "-c", "src/module_b.cpp"],
      },
    ]),
  };

  const resolver = new CppIncludeResolver({ manifest, supportingFiles, includeDirectories: [] });

  // module_a can resolve header_a.h via its TU-specific custom_a include dir
  const resA = resolver.resolveInclude("src/module_a.cpp", "header_a.h", { includeType: "quoted" });
  assert.equal(resA.status, "internal_resolved");
  assert.equal(resA.resolvedPath, "custom_a/header_a.h");

  // module_a CANNOT resolve header_b.h because custom_b belongs only to module_b!
  const resAtoB = resolver.resolveInclude("src/module_a.cpp", "header_b.h", { includeType: "quoted" });
  assert.equal(resAtoB.status, "unresolved");

  // module_b can resolve header_b.h via its TU-specific custom_b include dir
  const resB = resolver.resolveInclude("src/module_b.cpp", "header_b.h", { includeType: "quoted" });
  assert.equal(resB.status, "internal_resolved");
  assert.equal(resB.resolvedPath, "custom_b/header_b.h");
});

test("cCppBuildMetadata: handles malformed JSON and non-array root safely", () => {
  // Malformed JSON
  const malformed = parseCompileCommandsJson("INVALID JSON {[[");
  assert.ok(malformed.errors.length > 0);
  assert.equal(malformed.totalEntries, 0);

  // Non-array root
  const nonArray = parseCompileCommandsJson(JSON.stringify({ notAnArray: true }));
  assert.ok(nonArray.errors.length > 0);
  assert.equal(nonArray.totalEntries, 0);
});


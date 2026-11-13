const test = require("node:test");
const assert = require("node:assert/strict");
const { CAdapter } = require("../services/parser/adapters/c/CAdapter");
const { validateFileIR } = require("../services/parser/irValidator");

const sampleC = `
#include <stdio.h>
#include "my_math.h"

#define BUFFER_SIZE 4096
#define MAX(a, b) ((a) > (b) ? (a) : (b))

#ifdef __linux__
#include <unistd.h>
#endif

typedef unsigned long ulong_t;

struct Point {
    int x;
    int y;
};

typedef struct {
    double r;
    double theta;
} PolarCoord;

union Variant {
    int intVal;
    float floatVal;
};

enum Status {
    STATUS_OK = 0,
    STATUS_ERROR = 1
};

extern int global_counter;
static const int MAX_RETRIES = 5;

int multiply(int a, int b);

int multiply(int a, int b) {
    int product = a * b;
    printf("Result: %d\\n", product);
    return product;
}

static void helper(void) {
    int casted = (int)3.14;
}
`;

test("cParser: extracts preprocessor includes, macros, and conditional context", async () => {
  const adapter = new CAdapter();
  const file = {
    path: "src/math_ops.c",
    content: sampleC,
    language: "c",
  };

  const ir = await adapter.parseFile(file);
  const { isValid, errors } = validateFileIR(ir);
  assert.equal(isValid, true, `Validation failed: ${errors.join("; ")}`);

  // Directives
  const stdio = ir.imports.find((i) => i.rawSource === "stdio.h");
  assert.ok(stdio, "stdio.h include must be extracted");
  assert.equal(stdio.sourceKind, "system");
  assert.equal(stdio.languageMetadata.includeType, "system");
  assert.equal(stdio.languageMetadata.delimiter, "<>");
  assert.equal(stdio.languageMetadata.isConditional, false);

  const localHeader = ir.imports.find((i) => i.rawSource === "my_math.h");
  assert.ok(localHeader, "my_math.h include must be extracted");
  assert.equal(localHeader.sourceKind, "relative");
  assert.equal(localHeader.languageMetadata.includeType, "quoted");
  assert.equal(localHeader.languageMetadata.delimiter, '""');

  const unistd = ir.imports.find((i) => i.rawSource === "unistd.h");
  assert.ok(unistd, "unistd.h conditional include must be extracted");
  assert.equal(unistd.languageMetadata.isConditional, true);
  assert.ok(unistd.languageMetadata.condition.includes("__linux__"));

  // Macros
  const bufferSizeMacro = ir.symbols.find((s) => s.name === "BUFFER_SIZE");
  assert.ok(bufferSizeMacro, "BUFFER_SIZE macro must be extracted");
  assert.equal(bufferSizeMacro.kind, "macro");
  assert.equal(bufferSizeMacro.languageMetadata.isFunctionLike, false);

  const maxMacro = ir.symbols.find((s) => s.name === "MAX");
  assert.ok(maxMacro, "MAX function-like macro must be extracted");
  assert.equal(maxMacro.kind, "macro");
  assert.equal(maxMacro.languageMetadata.isFunctionLike, true);
  assert.deepEqual(maxMacro.languageMetadata.parameters, ["a", "b"]);
});

test("cParser: extracts functions (prototype vs definition, static visibility, parameters)", async () => {
  const adapter = new CAdapter();
  const file = {
    path: "src/functions.c",
    content: sampleC,
    language: "c",
  };

  const ir = await adapter.parseFile(file);
  const { isValid, errors } = validateFileIR(ir);
  assert.equal(isValid, true, `Validation failed: ${errors.join("; ")}`);

  // Prototype
  const proto = ir.symbols.find(
    (s) => s.name === "multiply" && s.languageKind === "function_declaration"
  );
  assert.ok(proto, "multiply prototype must be extracted");
  assert.equal(proto.kind, "function");
  assert.equal(proto.returnType, "int");
  assert.equal(proto.languageMetadata.isDefinition, false);
  assert.equal(proto.parameters.length, 2);
  assert.equal(proto.parameters[0].name, "a");
  assert.equal(proto.parameters[1].name, "b");

  // Definition
  const def = ir.symbols.find(
    (s) => s.name === "multiply" && s.languageKind === "function_definition"
  );
  assert.ok(def, "multiply definition must be extracted");
  assert.equal(def.kind, "function");
  assert.equal(def.returnType, "int");
  assert.equal(def.languageMetadata.isDefinition, true);
  assert.equal(def.visibility, "public");
  assert.equal(def.isExported, true);

  // Static function
  const helper = ir.symbols.find((s) => s.name === "helper");
  assert.ok(helper, "helper function must be extracted");
  assert.equal(helper.visibility, "internal");
  assert.equal(helper.isExported, false);
  assert.ok(helper.modifiers.includes("static"));
});

test("cParser: extracts structs, unions, enums, enum members, and struct fields", async () => {
  const adapter = new CAdapter();
  const file = {
    path: "src/types.c",
    content: sampleC,
    language: "c",
  };

  const ir = await adapter.parseFile(file);
  const { isValid, errors } = validateFileIR(ir);
  assert.equal(isValid, true, `Validation failed: ${errors.join("; ")}`);

  // Struct Point
  const point = ir.symbols.find((s) => s.name === "Point");
  assert.ok(point, "struct Point must be extracted");
  assert.equal(point.kind, "struct");
  assert.equal(point.languageKind, "struct");

  const pointFields = ir.symbols.filter((s) => s.parentSymbolId === point.id);
  assert.equal(pointFields.length, 2);
  assert.equal(pointFields[0].name, "x");
  assert.equal(pointFields[0].kind, "field");
  assert.equal(pointFields[1].name, "y");
  assert.equal(pointFields[1].kind, "field");

  // Union Variant
  const variant = ir.symbols.find((s) => s.name === "Variant");
  assert.ok(variant, "union Variant must be extracted");
  assert.equal(variant.kind, "struct");
  assert.equal(variant.languageKind, "union");
  const variantFields = ir.symbols.filter((s) => s.parentSymbolId === variant.id);
  assert.equal(variantFields.length, 2);
  assert.equal(variantFields[0].name, "intVal");
  assert.equal(variantFields[1].name, "floatVal");

  // Enum Status
  const status = ir.symbols.find((s) => s.name === "Status");
  assert.ok(status, "enum Status must be extracted");
  assert.equal(status.kind, "enum");
  const enumMembers = ir.symbols.filter((s) => s.parentSymbolId === status.id);
  assert.equal(enumMembers.length, 2);
  assert.equal(enumMembers[0].name, "STATUS_OK");
  assert.equal(enumMembers[0].kind, "enum_member");
  assert.equal(enumMembers[1].name, "STATUS_ERROR");
  assert.equal(enumMembers[1].kind, "enum_member");

  // Typedefs
  const ulong = ir.symbols.find((s) => s.name === "ulong_t");
  assert.ok(ulong, "ulong_t typedef must be extracted");
  assert.equal(ulong.kind, "type_alias");

  const polar = ir.symbols.find((s) => s.name === "PolarCoord");
  assert.ok(polar, "PolarCoord typedef struct must be extracted");
  assert.equal(polar.kind, "type_alias");
  const polarFields = ir.symbols.filter((s) => s.parentSymbolId === polar.id);
  assert.equal(polarFields.length, 2);
  assert.equal(polarFields[0].name, "r");
  assert.equal(polarFields[1].name, "theta");
});

test("cParser: extracts global variables, externs, and constants", async () => {
  const adapter = new CAdapter();
  const file = {
    path: "src/vars.c",
    content: sampleC,
    language: "c",
  };

  const ir = await adapter.parseFile(file);
  const { isValid, errors } = validateFileIR(ir);
  assert.equal(isValid, true, `Validation failed: ${errors.join("; ")}`);

  const globalCounter = ir.symbols.find((s) => s.name === "global_counter");
  assert.ok(globalCounter, "global_counter must be extracted");
  assert.equal(globalCounter.kind, "variable");
  assert.equal(globalCounter.languageKind, "extern_variable");
  assert.ok(globalCounter.modifiers.includes("extern"));

  const maxRetries = ir.symbols.find((s) => s.name === "MAX_RETRIES");
  assert.ok(maxRetries, "MAX_RETRIES constant must be extracted");
  assert.equal(maxRetries.kind, "constant");
  assert.ok(maxRetries.modifiers.includes("static"));
  assert.ok(maxRetries.modifiers.includes("const"));
});

test("cParser: extracts function call sites with argument count and enclosing symbol linkage", async () => {
  const adapter = new CAdapter();
  const file = {
    path: "src/calls.c",
    content: sampleC,
    language: "c",
  };

  const ir = await adapter.parseFile(file);
  const { isValid, errors } = validateFileIR(ir);
  assert.equal(isValid, true, `Validation failed: ${errors.join("; ")}`);

  const printfCall = ir.callSites.find((c) => c.calleeText === "printf");
  assert.ok(printfCall, "printf call site must be extracted");
  assert.equal(printfCall.calleeKind, "identifier");
  assert.equal(printfCall.argumentCount, 2);

  const multiplyDef = ir.symbols.find(
    (s) => s.name === "multiply" && s.languageKind === "function_definition"
  );
  assert.ok(multiplyDef, "multiply definition must exist");
  assert.equal(printfCall.enclosingSymbolId, multiplyDef.id);
});

test("cParser: extracts type references including parameter, return, variable, and cast contexts", async () => {
  const adapter = new CAdapter();
  const file = {
    path: "src/types_ref.c",
    content: sampleC,
    language: "c",
  };

  const ir = await adapter.parseFile(file);
  const { isValid, errors } = validateFileIR(ir);
  assert.equal(isValid, true, `Validation failed: ${errors.join("; ")}`);

  // Parameter type references
  const paramTypes = ir.typeReferences.filter((t) => t.context === "parameter");
  assert.ok(paramTypes.length >= 2, "Parameter type references must be extracted");
  assert.equal(paramTypes[0].text, "int");

  // Cast context
  const castTypes = ir.typeReferences.filter((t) => t.context === "cast");
  assert.ok(castTypes.length >= 1, "Cast type references must be extracted");
  assert.equal(castTypes[0].text, "int");
});

test("cParser: malformed C code yields partial status, captures diagnostics, and produces valid FileIR", async () => {
  const adapter = new CAdapter();
  const file = {
    path: "src/broken.c",
    content: `
      #include <stdio.h>
      int broken_function(int a {
          return a +
      }
    `,
    language: "c",
  };

  const ir = await adapter.parseFile(file);
  const { isValid, errors } = validateFileIR(ir);
  assert.equal(isValid, true, `Validation failed: ${errors.join("; ")}`);

  assert.equal(ir.parser.status, "partial");
  assert.ok(ir.diagnostics.length > 0, "Syntax diagnostics must be recorded");
  assert.equal(ir.diagnostics[0].severity, "error");
  assert.ok(ir.diagnostics[0].code.includes("SYNTAX_ERROR"));
});


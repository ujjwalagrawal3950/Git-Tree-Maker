const test = require("node:test");
const assert = require("node:assert/strict");
const { CppAdapter } = require("../services/parser/adapters/cpp/CppAdapter");
const { validateFileIR } = require("../services/parser/irValidator");

const sampleCpp = `
#include <iostream>
#include <vector>
#include "my_header.hpp"

#define MAX_BUFFER 8192

namespace app::core {

template <typename T>
class Container {
private:
    T value_;
public:
    Container(T val) : value_(val) {}
    virtual ~Container() {}

    T getValue() const {
        return value_;
    }

    void setValue(T val);
};

enum class Color : int {
    Red = 0,
    Green,
    Blue
};

using StringList = std::vector<std::string>;

class Derived : public Container<int> {
public:
    Derived() : Container<int>(0) {}
    bool operator==(const Derived& other) const {
        return getValue() == other.getValue();
    }
};

} // namespace app::core

int main() {
    app::core::Derived d;
    int casted = static_cast<int>(3.14);
    std::cout << casted << std::endl;
    return 0;
}
`;

test("cppParser: extracts namespaces and nested namespaces with qualified names", async () => {
  const adapter = new CppAdapter();
  const file = {
    path: "src/container.cpp",
    content: sampleCpp,
    language: "cpp",
  };

  const ir = await adapter.parseFile(file);
  const { isValid, errors } = validateFileIR(ir);
  assert.equal(isValid, true, `Validation failed: ${errors.join("; ")}`);

  const ns = ir.symbols.find((s) => s.kind === "namespace");
  assert.ok(ns, "Namespace symbol must exist");
  assert.equal(ns.name, "app::core");
  assert.equal(ns.qualifiedName, "app::core");

  const containerClass = ir.symbols.find((s) => s.name === "Container");
  assert.ok(containerClass, "Container class symbol must exist");
  assert.equal(containerClass.parentSymbolId, ns.id);
  assert.equal(containerClass.qualifiedName, "app::core::Container");
});

test("cppParser: extracts classes, base class inheritance, constructors, destructors, and operators", async () => {
  const adapter = new CppAdapter();
  const file = {
    path: "src/hierarchy.cpp",
    content: sampleCpp,
    language: "cpp",
  };

  const ir = await adapter.parseFile(file);
  const { isValid, errors } = validateFileIR(ir);
  assert.equal(isValid, true, `Validation failed: ${errors.join("; ")}`);

  // Container class & members
  const containerClass = ir.symbols.find((s) => s.name === "Container");
  assert.ok(containerClass, "Container class must exist");
  assert.equal(containerClass.kind, "class");
  assert.equal(containerClass.languageMetadata.isTemplate, true);

  const ctor = ir.symbols.find((s) => s.name === "Container" && s.kind === "constructor");
  assert.ok(ctor, "Constructor must exist");
  assert.equal(ctor.languageKind, "constructor");
  assert.equal(ctor.parentSymbolId, containerClass.id);

  const dtor = ir.symbols.find((s) => s.name === "~Container");
  assert.ok(dtor, "Destructor must exist");
  assert.equal(dtor.languageKind, "destructor");

  const getter = ir.symbols.find((s) => s.name === "getValue");
  assert.ok(getter, "getValue method must exist");
  assert.equal(getter.kind, "method");
  assert.equal(getter.visibility, "public");

  const field = ir.symbols.find((s) => s.name === "value_");
  assert.ok(field, "value_ field must exist");
  assert.equal(field.kind, "field");
  assert.equal(field.visibility, "private");

  // Derived class & inheritance
  const derivedClass = ir.symbols.find((s) => s.name === "Derived");
  assert.ok(derivedClass, "Derived class must exist");

  const op = ir.symbols.find((s) => s.name === "operator==");
  assert.ok(op, "operator== must exist");
  assert.equal(op.languageKind, "operator_overload");

  // Inheritance fact
  assert.ok(ir.inheritance.length > 0, "Inheritance facts must be extracted");
  const inh = ir.inheritance.find((i) => i.targetText === "Container<int>");
  assert.ok(inh, "Inheritance to Container<int> must be recorded");
  assert.equal(inh.kind, "extends");
  assert.equal(inh.sourceSymbolId, derivedClass.id);
});

test("cppParser: extracts scoped enums (enum class) and type aliases (using)", async () => {
  const adapter = new CppAdapter();
  const file = {
    path: "src/aliases.cpp",
    content: sampleCpp,
    language: "cpp",
  };

  const ir = await adapter.parseFile(file);
  const { isValid, errors } = validateFileIR(ir);
  assert.equal(isValid, true, `Validation failed: ${errors.join("; ")}`);

  // Scoped enum
  const colorEnum = ir.symbols.find((s) => s.name === "Color");
  assert.ok(colorEnum, "Color enum must exist");
  assert.equal(colorEnum.kind, "enum");
  assert.equal(colorEnum.languageKind, "scoped_enum");
  assert.equal(colorEnum.languageMetadata.isScoped, true);

  const redMember = ir.symbols.find((s) => s.name === "Red");
  assert.ok(redMember, "Red enum member must exist");
  assert.equal(redMember.parentSymbolId, colorEnum.id);

  // Type alias
  const alias = ir.symbols.find((s) => s.name === "StringList");
  assert.ok(alias, "StringList using alias must exist");
  assert.equal(alias.kind, "type_alias");
  assert.equal(alias.languageKind, "type_alias");
});

test("cppParser: extracts call sites and excludes C++ casts from function calls", async () => {
  const adapter = new CppAdapter();
  const file = {
    path: "src/calls.cpp",
    content: sampleCpp,
    language: "cpp",
  };

  const ir = await adapter.parseFile(file);
  const { isValid, errors } = validateFileIR(ir);
  assert.equal(isValid, true, `Validation failed: ${errors.join("; ")}`);

  // Call to other.getValue() inside operator==
  const memberCall = ir.callSites.find((c) => c.calleeText.includes("getValue"));
  assert.ok(memberCall, "getValue call must be extracted");

  // Verify static_cast is NOT recorded as a callSite
  const staticCastCall = ir.callSites.find((c) => c.calleeText.startsWith("static_cast"));
  assert.equal(staticCastCall, undefined, "static_cast must not be extracted as call site");
});

test("cppParser: extracts type references including inheritance, generic args, and casts", async () => {
  const adapter = new CppAdapter();
  const file = {
    path: "src/types.cpp",
    content: sampleCpp,
    language: "cpp",
  };

  const ir = await adapter.parseFile(file);
  const { isValid, errors } = validateFileIR(ir);
  assert.equal(isValid, true, `Validation failed: ${errors.join("; ")}`);

  // Base class type reference
  const inhRef = ir.typeReferences.find((t) => t.context === "inheritance");
  assert.ok(inhRef, "Inheritance type reference must exist");
  assert.equal(inhRef.text, "Container<int>");

  // Cast type reference
  const castRef = ir.typeReferences.find((t) => t.context === "cast");
  assert.ok(castRef, "Cast type reference must exist");
  assert.equal(castRef.text, "int");

  // Generic argument type reference
  const genericRef = ir.typeReferences.find((t) => t.context === "generic_argument");
  assert.ok(genericRef, "Generic argument type reference must exist");
});

test("cppParser: extracts includes and macros", async () => {
  const adapter = new CppAdapter();
  const file = {
    path: "src/preproc.cpp",
    content: sampleCpp,
    language: "cpp",
  };

  const ir = await adapter.parseFile(file);
  const { isValid, errors } = validateFileIR(ir);
  assert.equal(isValid, true, `Validation failed: ${errors.join("; ")}`);

  const iostreamInc = ir.imports.find((i) => i.rawSource === "iostream");
  assert.ok(iostreamInc, "iostream include must exist");
  assert.equal(iostreamInc.sourceKind, "system");

  const myHeaderInc = ir.imports.find((i) => i.rawSource === "my_header.hpp");
  assert.ok(myHeaderInc, "my_header.hpp include must exist");
  assert.equal(myHeaderInc.sourceKind, "relative");

  const macro = ir.symbols.find((s) => s.name === "MAX_BUFFER");
  assert.ok(macro, "MAX_BUFFER macro must exist");
  assert.equal(macro.kind, "macro");
});

test("cppParser: malformed C++ code yields partial status, captures diagnostics, and produces valid FileIR", async () => {
  const adapter = new CppAdapter();
  const file = {
    path: "src/broken.cpp",
    content: `
      namespace broken {
          class Unclosed {
              void test( {
          };
      }
    `,
    language: "cpp",
  };

  const ir = await adapter.parseFile(file);
  const { isValid, errors } = validateFileIR(ir);
  assert.equal(isValid, true, `Validation failed: ${errors.join("; ")}`);

  assert.equal(ir.parser.status, "partial");
  assert.ok(ir.diagnostics.length > 0, "Syntax diagnostics must be recorded");
  assert.equal(ir.diagnostics[0].severity, "error");
  assert.ok(ir.diagnostics[0].code.includes("SYNTAX_ERROR"));
});


const test = require("node:test");
const assert = require("node:assert/strict");

const { parsePythonSource } = require("../services/parser/adapters/python/parserFactory");
const { extractPythonDeclarations } = require("../services/parser/adapters/python/declarationExtractor");
const { extractPythonImports } = require("../services/parser/adapters/python/importExtractor");
const { extractCallSites } = require("../services/parser/adapters/python/callExtractor");
const { extractTypeFacts } = require("../services/parser/adapters/python/typeExtractor");
const { PythonAdapter } = require("../services/parser/adapters/python/PythonAdapter");
const { defaultRegistry } = require("../services/parser/ParserRegistry");
const { validateFileIR } = require("../services/parser/irValidator");

const MOCK_REPO = {
  owner: "tiangolo",
  name: "fastapi",
  fullName: "tiangolo/fastapi",
  commitSha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
};

// ========================================================
// 1. PYTHON DECLARATIONS & PARAMETER KINDS
// ========================================================
test("pythonParser: extracts functions, async functions, classes, and methods with decorators", () => {
  const code = `
@dataclass
class UserService:
    db_url: str = "sqlite:///:memory:"

    def __init__(self, timeout: int = 30):
        self.timeout = timeout

    @property
    def is_active(self) -> bool:
        return True

    @staticmethod
    def create_guest():
        return UserService(timeout=10)

async def fetch_user(user_id: int) -> dict:
    return {"id": user_id}
`;

  const { tree } = parsePythonSource(code, "services.py");
  const symbols = extractPythonDeclarations(tree.rootNode, code, "file_services_py");

  // Symbols expected:
  // 1. UserService (class)
  // 2. UserService.db_url (variable)
  // 3. UserService.__init__ (constructor)
  // 4. UserService.is_active (method)
  // 5. UserService.create_guest (method)
  // 6. fetch_user (function)
  assert.ok(symbols.length >= 6);

  const classSym = symbols.find((s) => s.name === "UserService" && s.kind === "class");
  assert.ok(classSym);
  assert.deepEqual(classSym.languageMetadata.decorators, ["dataclass"]);

  const initSym = symbols.find((s) => s.name === "__init__");
  assert.ok(initSym);
  assert.equal(initSym.kind, "constructor");
  assert.equal(initSym.parentSymbolId, classSym.id);

  const propSym = symbols.find((s) => s.name === "is_active");
  assert.ok(propSym);
  assert.equal(propSym.kind, "method");
  assert.ok(propSym.languageMetadata.decorators.includes("property"));

  const asyncFn = symbols.find((s) => s.name === "fetch_user");
  assert.ok(asyncFn);
  assert.equal(asyncFn.kind, "function");
  assert.equal(asyncFn.languageMetadata.isAsync, true);
});

test("pythonParser: extracts all 5 Python parameter kinds stored in languageMetadata without schema violation", () => {
  const code = `
def complex_fn(pos_only, /, pos_or_kw, *var_args, kw_only=True, **kw_args):
    pass
`;

  const { tree } = parsePythonSource(code, "params.py");
  const symbols = extractPythonDeclarations(tree.rootNode, code, "file_params_py");

  const fnSym = symbols.find((s) => s.name === "complex_fn");
  assert.ok(fnSym);
  assert.equal(fnSym.parameters.length, 5);

  // Schema check: parameters must strictly conform to IR_SCHEMA (variadic, optional, name, position)
  const [p0, p1, p2, p3, p4] = fnSym.parameters;
  assert.equal(p0.name, "pos_only");
  assert.equal(p1.name, "pos_or_kw");
  assert.equal(p2.name, "var_args");
  assert.equal(p2.variadic, true);
  assert.equal(p3.name, "kw_only");
  assert.equal(p3.optional, true);
  assert.equal(p4.name, "kw_args");
  assert.equal(p4.variadic, true);

  // Language metadata check: parameterKinds array
  const kinds = fnSym.languageMetadata.parameterKinds;
  assert.ok(Array.isArray(kinds));
  assert.equal(kinds.find((k) => k.name === "pos_only").kind, "positional_only");
  assert.equal(kinds.find((k) => k.name === "pos_or_kw").kind, "positional_or_keyword");
  assert.equal(kinds.find((k) => k.name === "var_args").kind, "var_positional");
  assert.equal(kinds.find((k) => k.name === "kw_only").kind, "keyword_only");
  assert.equal(kinds.find((k) => k.name === "kw_args").kind, "var_keyword");
});

// ========================================================
// 2. PYTHON IMPORT EXTRACTION
// ========================================================
test("pythonParser: extracts import forms, aliases, relative dots, and dynamic imports", () => {
  const code = `
import sys, math as m
from os import path, environ as env
from . import local_helpers
from ..database.models import User, Order as PurchaseOrder
from ...core import *
import importlib
dynamic_mod = importlib.import_module("plugins.auth")
legacy_mod = __import__("legacy_pkg")
`;

  const { tree } = parsePythonSource(code, "app.py");
  const imports = extractPythonImports(tree.rootNode, code, "file_app_py");

  // Expected imports:
  // 1. import sys
  // 2. import math as m
  // 3. from os import path, environ as env
  // 4. from . import local_helpers (relativeLevel: 1)
  // 5. from ..database.models import User, Order as PurchaseOrder (relativeLevel: 2)
  // 6. from ...core import * (relativeLevel: 3, isWildcard: true)
  // 7. import importlib
  // 8. importlib.import_module("plugins.auth") (isDynamic: true)
  // 9. __import__("legacy_pkg") (isDynamic: true)
  assert.ok(imports.length >= 9);

  const mathImp = imports.find((i) => i.rawSource === "math");
  assert.ok(mathImp);
  assert.equal(mathImp.specifiers[0].localName, "m");

  const rel1 = imports.find((i) => i.languageMetadata.relativeLevel === 1);
  assert.ok(rel1);
  assert.equal(rel1.languageMetadata.isRelative, true);

  const rel2 = imports.find((i) => i.languageMetadata.relativeLevel === 2);
  assert.ok(rel2);
  assert.equal(rel2.rawSource, "..database.models");

  const wildcardImp = imports.find((i) => i.languageMetadata.isWildcard === true);
  assert.ok(wildcardImp);
  assert.equal(wildcardImp.languageMetadata.relativeLevel, 3);

  const dynamicImp = imports.find((i) => i.languageMetadata.isDynamic === true && i.rawSource === "plugins.auth");
  assert.ok(dynamicImp);
});

// ========================================================
// 3. PYTHON CALL SITES EXTRACTION
// ========================================================
test("pythonParser: extracts direct calls, member calls, constructor calls, and links enclosing symbols", () => {
  const code = `
class Repository:
    def execute(self, query: str):
        conn = connect_db()
        cursor = conn.cursor()
        user = User(name="Alice")
        super().__init__()
        return cursor.fetchall()

standalone_call()
`;

  const { tree } = parsePythonSource(code, "repo.py");
  const symbols = extractPythonDeclarations(tree.rootNode, code, "file_repo_py");
  const callSites = extractCallSites(tree.rootNode, code, "file_repo_py", symbols);

  // Calls expected:
  // 1. connect_db() -> identifier
  // 2. conn.cursor() -> member_expression
  // 3. User(...) -> constructor
  // 4. super() -> identifier
  // 5. super().__init__() -> member_expression
  // 6. cursor.fetchall() -> member_expression
  // 7. standalone_call() -> identifier
  assert.ok(callSites.length >= 6);

  const userCall = callSites.find((c) => c.calleeText === "User");
  assert.ok(userCall);
  assert.equal(userCall.calleeKind, "constructor");

  const cursorCall = callSites.find((c) => c.calleeText === "cursor.fetchall");
  assert.ok(cursorCall);
  assert.equal(cursorCall.calleeKind, "member_expression");

  const execMethod = symbols.find((s) => s.name === "execute");
  assert.ok(execMethod);
  assert.equal(userCall.enclosingSymbolId, execMethod.id);
});

// ========================================================
// 4. PYTHON TYPE REFERENCES & INHERITANCE
// ========================================================
test("pythonParser: extracts inheritance hierarchy and parameter/return/variable type annotations", () => {
  const code = `
class Vehicle:
    pass

class ElectricCar(Vehicle):
    battery_level: float = 100.0

    def charge(self, amount: float) -> bool:
        return True
`;

  const { tree } = parsePythonSource(code, "car.py");
  const symbols = extractPythonDeclarations(tree.rootNode, code, "file_car_py");
  const { typeReferences, inheritance } = extractTypeFacts(tree.rootNode, code, "file_car_py", symbols);

  // Inheritance: ElectricCar extends Vehicle
  assert.equal(inheritance.length, 1);
  assert.equal(inheritance[0].kind, "extends");
  assert.equal(inheritance[0].targetText, "Vehicle");

  const carSym = symbols.find((s) => s.name === "ElectricCar");
  assert.ok(carSym);
  assert.equal(inheritance[0].sourceSymbolId, carSym.id);

  // Type references:
  // 1. return: bool
  // 2. parameter: float
  // 3. variable: float
  const returnRef = typeReferences.find((t) => t.context === "return");
  assert.ok(returnRef);
  assert.equal(returnRef.text, "bool");

  const paramRef = typeReferences.find((t) => t.context === "parameter");
  assert.ok(paramRef);
  assert.equal(paramRef.text, "float");

  const varRef = typeReferences.find((t) => t.context === "variable");
  assert.ok(varRef);
  assert.equal(varRef.text, "float");
});

// ========================================================
// 5. PYTHON ADAPTER END-TO-END & SCHEMA VALIDATION
// ========================================================
test("pythonParser: PythonAdapter parses valid Python file and passes IR schema validation", async () => {
  const adapter = new PythonAdapter();
  const code = `
"""Module docstring."""
import os
from typing import List

__all__ = ["greet", "Greeter"]

class Greeter:
    def __init__(self, greeting: str = "Hello"):
        self.greeting = greeting

    def say(self, name: str) -> str:
        return f"{self.greeting}, {name}!"

def greet(name: str) -> str:
    g = Greeter()
    return g.say(name)
`;

  const ir = await adapter.parseFile({
    path: "greeter.py",
    content: code,
    language: "python",
    repository: MOCK_REPO,
  });

  assert.equal(ir.parser.status, "complete");
  assert.equal(ir.parser.adapterId, "python-adapter");
  assert.equal(ir.parser.engine, "tree-sitter");

  // Validate __all__ exports
  assert.equal(ir.exports.length, 2);
  const exportedNames = ir.exports.map((e) => e.exportedName).sort();
  assert.deepEqual(exportedNames, ["Greeter", "greet"]);

  // Schema validation
  const validation = validateFileIR(ir);
  assert.equal(validation.isValid, true, `Validation errors: ${validation.errors.join(", ")}`);
});

// ========================================================
// 6. SYNTAX ERROR RECOVERY
// ========================================================
test("pythonParser: malformed Python source recovers gracefully with partial status and diagnostics", async () => {
  const adapter = defaultRegistry.getAdapter("python");
  const malformedCode = `
def broken_fn(x, y
    print("missing closing paren and colon"
`;

  const ir = await adapter.parseFile({
    path: "syntax_error.py",
    content: malformedCode,
    language: "python",
    repository: MOCK_REPO,
  });

  assert.equal(ir.parser.status, "partial");
  assert.ok(ir.diagnostics.length > 0);
  assert.equal(ir.diagnostics[0].code, "PY_SYNTAX_ERROR");
  assert.equal(ir.diagnostics[0].severity, "error");

  const validation = validateFileIR(ir);
  assert.equal(validation.isValid, true, `Validation errors: ${validation.errors.join(", ")}`);
});


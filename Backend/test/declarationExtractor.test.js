const test = require("node:test");
const assert = require("node:assert/strict");

const { createSourceAST } = require("../services/parser/adapters/javascript/parserFactory");
const { extractDeclarations } = require("../services/parser/adapters/javascript/declarationExtractor");
const { buildFileIR } = require("../services/parser/irBuilder");
const { validateFileIR } = require("../services/parser/irValidator");

const MOCK_REPO = {
  owner: "facebook",
  name: "react",
  fullName: "facebook/react",
  commitSha: "6dcb09b5b57875f334f61aebed695e2e4193db5e",
};

// ========================================================
// 1. FUNCTIONS AND ARROW FUNCTIONS EXTRACTION
// ========================================================
test("declarationExtractor: extracts function declarations and arrow functions", () => {
  const code = `
    export async function calculateTotal<T>(base: number, factor?: number, ...rest: number[]): Promise<number> {
      return base * (factor || 1);
    }

    const multiply = (x: number, y: number): number => x * y;
  `;

  const fileId = "file_test_math_ts";
  const { sourceFile } = createSourceAST("src/math.ts", code);
  const symbols = extractDeclarations(sourceFile, fileId);

  assert.equal(symbols.length, 2);

  // 1. Function declaration
  const fnSym = symbols[0];
  assert.equal(fnSym.id, `${fileId}#sym_0`);
  assert.equal(fnSym.name, "calculateTotal");
  assert.equal(fnSym.kind, "function");
  assert.equal(fnSym.isExported, true);
  assert.deepEqual(fnSym.typeParameters, ["T"]);
  assert.equal(fnSym.parameters.length, 3);
  assert.equal(fnSym.parameters[0].name, "base");
  assert.equal(fnSym.parameters[0].type.text, "number");
  assert.equal(fnSym.parameters[0].type.kind, "primitive");
  assert.equal(fnSym.parameters[1].name, "factor");
  assert.equal(fnSym.parameters[1].optional, true);
  assert.equal(fnSym.parameters[2].name, "rest");
  assert.equal(fnSym.parameters[2].variadic, true);
  assert.equal(fnSym.returnType.text, "Promise<number>");

  // 2. Arrow function
  const arrowSym = symbols[1];
  assert.equal(arrowSym.id, `${fileId}#sym_1`);
  assert.equal(arrowSym.name, "multiply");
  assert.equal(arrowSym.kind, "function");
  assert.equal(arrowSym.parameters.length, 2);
  assert.equal(arrowSym.returnType.text, "number");
});

// ========================================================
// 2. CLASSES, CONSTRUCTOR, METHODS, AND FIELDS WITH PARENT IDS
// ========================================================
test("declarationExtractor: extracts class hierarchy and sets parentSymbolId correctly", () => {
  const code = `
    export class UserService {
      private version: string = "1.0";
      #secretKey: string;

      constructor(initialKey: string) {
        this.#secretKey = initialKey;
      }

      public async findUser(id: string): Promise<object> {
        return { id };
      }

      protected validateId(id: string): boolean {
        return id.length > 0;
      }
    }
  `;

  const fileId = "file_user_service_ts";
  const { sourceFile } = createSourceAST("src/UserService.ts", code);
  const symbols = extractDeclarations(sourceFile, fileId);

  // Class + 2 fields (version, #secretKey) + constructor + 2 methods (findUser, validateId) = 6 symbols
  assert.equal(symbols.length, 6);

  const classSym = symbols[0];
  assert.equal(classSym.id, `${fileId}#sym_0`);
  assert.equal(classSym.name, "UserService");
  assert.equal(classSym.kind, "class");
  assert.equal(classSym.isExported, true);

  // Field: version
  const field1 = symbols[1];
  assert.equal(field1.name, "version");
  assert.equal(field1.kind, "field");
  assert.equal(field1.parentSymbolId, classSym.id);
  assert.equal(field1.visibility, "private");

  // Field: #secretKey (private identifier)
  const field2 = symbols[2];
  assert.equal(field2.name, "#secretKey");
  assert.equal(field2.visibility, "private");
  assert.equal(field2.parentSymbolId, classSym.id);

  // Constructor
  const ctor = symbols[3];
  assert.equal(ctor.name, "constructor");
  assert.equal(ctor.kind, "constructor");
  assert.equal(ctor.parentSymbolId, classSym.id);
  assert.equal(ctor.parameters.length, 1);

  // Method: findUser
  const method1 = symbols[4];
  assert.equal(method1.name, "findUser");
  assert.equal(method1.kind, "method");
  assert.equal(method1.visibility, "public");
  assert.equal(method1.parentSymbolId, classSym.id);
  assert.equal(method1.modifiers.includes("async"), true);

  // Method: validateId
  const method2 = symbols[5];
  assert.equal(method2.name, "validateId");
  assert.equal(method2.kind, "method");
  assert.equal(method2.visibility, "protected");
  assert.equal(method2.parentSymbolId, classSym.id);
});

// ========================================================
// 3. TYPESCRIPT INTERFACES, ALIASES, ENUMS & MEMBERS
// ========================================================
test("declarationExtractor: extracts interfaces, type aliases, and enums with members", () => {
  const code = `
    export interface Config<T> {
      data: T;
      timeout: number;
    }

    export type Status = "active" | "inactive";

    export enum Role {
      Admin = "admin",
      User = "user"
    }

    namespace Core {
      export function init() {}
    }
  `;

  const fileId = "file_types_ts";
  const { sourceFile } = createSourceAST("src/types.ts", code);
  const symbols = extractDeclarations(sourceFile, fileId);

  // Interface + Type + Enum + 2 EnumMembers + Namespace + Namespace Function = 7 symbols
  assert.equal(symbols.length, 7);

  // Interface
  const iface = symbols.find((s) => s.kind === "interface");
  assert.ok(iface);
  assert.equal(iface.name, "Config");
  assert.deepEqual(iface.typeParameters, ["T"]);

  // Type alias
  const typeAlias = symbols.find((s) => s.kind === "type_alias");
  assert.ok(typeAlias);
  assert.equal(typeAlias.name, "Status");

  // Enum and members
  const enumSym = symbols.find((s) => s.kind === "enum");
  assert.ok(enumSym);
  assert.equal(enumSym.name, "Role");

  const enumMembers = symbols.filter((s) => s.kind === "enum_member");
  assert.equal(enumMembers.length, 2);
  assert.equal(enumMembers[0].name, "Admin");
  assert.equal(enumMembers[0].parentSymbolId, enumSym.id);
  assert.equal(enumMembers[1].name, "User");
  assert.equal(enumMembers[1].parentSymbolId, enumSym.id);

  // Namespace and inner function
  const ns = symbols.find((s) => s.kind === "namespace");
  assert.ok(ns);
  assert.equal(ns.name, "Core");

  const nsFn = symbols.find((s) => s.kind === "function" && s.parentSymbolId === ns.id);
  assert.ok(nsFn);
  assert.equal(nsFn.name, "init");
  assert.equal(nsFn.qualifiedName, "Core.init");
});

// ========================================================
// 4. DETERMINISTIC SYMBOL IDS ACROSS IDENTICAL AST RUNS
// ========================================================
test("declarationExtractor: produces identical deterministic IDs on repeated runs", () => {
  const code = `
    export const PI = 3.14159;
    export function area(r: number) { return PI * r * r; }
  `;

  const fileId = "file_geometry_ts";
  const { sourceFile: sf1 } = createSourceAST("src/geo.ts", code);
  const { sourceFile: sf2 } = createSourceAST("src/geo.ts", code);

  const symbols1 = extractDeclarations(sf1, fileId);
  const symbols2 = extractDeclarations(sf2, fileId);

  assert.equal(symbols1.length, 2);
  assert.equal(symbols2.length, 2);

  for (let i = 0; i < symbols1.length; i++) {
    assert.equal(symbols1[i].id, symbols2[i].id);
    assert.equal(symbols1[i].name, symbols2[i].name);
    assert.equal(symbols1[i].location.start.line, symbols2[i].location.start.line);
  }
});

// ========================================================
// 5. SCHEMA VALIDATION CONFORMANCE
// ========================================================
test("declarationExtractor: all extracted symbols pass schema validation in buildFileIR", () => {
  const code = `
    export interface DataItem { id: string; }
    export class Repository<T extends DataItem> {
      private items: T[] = [];
      addItem(item: T): void { this.items.push(item); }
    }
  `;

  const file = {
    path: "src/Repository.ts",
    blobSha: "blob_repo_123",
    language: "typescript",
    content: code,
  };

  const { sourceFile, diagnostics } = createSourceAST(file.path, code);
  const symbols = extractDeclarations(sourceFile, "file_repo_ts");

  const fileIR = buildFileIR({
    repository: MOCK_REPO,
    file,
    parser: {
      adapterId: "typescript-adapter",
      adapterVersion: "1.0.0",
      engine: "typescript",
      engineVersion: "5.9.3",
      status: "complete",
      capabilities: ["symbols"],
    },
    symbols,
    diagnostics,
  });

  const validation = validateFileIR(fileIR);
  assert.equal(validation.isValid, true, `Validation failed: ${validation.errors.join("; ")}`);
  assert.equal(fileIR.stats.symbols, symbols.length);
});


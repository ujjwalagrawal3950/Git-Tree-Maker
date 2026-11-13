const test = require("node:test");
const assert = require("node:assert/strict");

const { createSourceAST } = require("../services/parser/adapters/javascript/parserFactory");
const { extractDeclarations } = require("../services/parser/adapters/javascript/declarationExtractor");
const { extractCallSites } = require("../services/parser/adapters/javascript/callExtractor");
const { extractTypeFacts } = require("../services/parser/adapters/javascript/typeExtractor");
const { buildFileIR } = require("../services/parser/irBuilder");
const { validateFileIR } = require("../services/parser/irValidator");

const MOCK_REPO = {
  owner: "facebook",
  name: "react",
  fullName: "facebook/react",
  commitSha: "6dcb09b5b57875f334f61aebed695e2e4193db5e",
};

// ========================================================
// 1. SYNTACTIC CALL SITES EXTRACTION
// ========================================================
test("callExtractor: extracts direct calls, member calls, constructor invocations, and enclosing symbols", () => {
  const code = `
    class DataProcessor {
      process(item: string) {
        const client = new HttpClient("https://api.test");
        console.log("processing", item);
        const result = transform(item);
        return result;
      }
    }
    const globalApp = startApp();
  `;

  const fileId = "file_processor_ts";
  const { sourceFile } = createSourceAST("src/processor.ts", code);
  const symbols = extractDeclarations(sourceFile, fileId);
  const callSites = extractCallSites(sourceFile, fileId, symbols);

  // Calls expected:
  // 1. new HttpClient(...) -> constructor
  // 2. console.log(...) -> member_expression
  // 3. transform(...) -> identifier
  // 4. startApp() -> identifier
  assert.equal(callSites.length, 4);

  // Constructor new
  const newCall = callSites.find((c) => c.calleeKind === "constructor");
  assert.ok(newCall);
  assert.equal(newCall.calleeText, "HttpClient");
  assert.equal(newCall.argumentCount, 1);

  // Method symbol ID enclosing the call
  const processMethod = symbols.find((s) => s.name === "process");
  assert.ok(processMethod);
  assert.equal(newCall.enclosingSymbolId, processMethod.id);

  // Member call: console.log
  const logCall = callSites.find((c) => c.calleeText === "console.log");
  assert.ok(logCall);
  assert.equal(logCall.calleeKind, "member_expression");
  assert.equal(logCall.argumentCount, 2);
  assert.equal(logCall.enclosingSymbolId, processMethod.id);

  // Direct call: transform(item)
  const transformCall = callSites.find((c) => c.calleeText === "transform");
  assert.ok(transformCall);
  assert.equal(transformCall.calleeKind, "identifier");
  assert.equal(transformCall.argumentCount, 1);

  // Top-level call: startApp()
  const topCall = callSites.find((c) => c.calleeText === "startApp");
  assert.ok(topCall);
  assert.equal(topCall.enclosingSymbolId, null);
});

// ========================================================
// 2. CLASS AND INTERFACE INHERITANCE EXTRACTION
// ========================================================
test("typeExtractor: extracts extends and implements clauses with source symbol linkage", () => {
  const code = `
    interface BaseEntity { id: string; }
    interface Auditable { createdAt: Date; }

    interface UserRecord extends BaseEntity, Auditable {
      username: string;
    }

    class AccountService extends BaseService implements IAccountService, IDisposable {
      init() {}
    }
  `;

  const fileId = "file_inheritance_ts";
  const { sourceFile } = createSourceAST("src/inheritance.ts", code);
  const symbols = extractDeclarations(sourceFile, fileId);
  const { inheritance } = extractTypeFacts(sourceFile, fileId, symbols);

  // Expected inheritance:
  // UserRecord extends BaseEntity
  // UserRecord extends Auditable
  // AccountService extends BaseService
  // AccountService implements IAccountService
  // AccountService implements IDisposable
  assert.equal(inheritance.length, 5);

  const ifaceSym = symbols.find((s) => s.name === "UserRecord");
  assert.ok(ifaceSym);

  const ifaceExtends = inheritance.filter((i) => i.sourceSymbolId === ifaceSym.id);
  assert.equal(ifaceExtends.length, 2);
  assert.equal(ifaceExtends[0].kind, "extends");
  assert.equal(ifaceExtends[0].targetText, "BaseEntity");
  assert.equal(ifaceExtends[1].targetText, "Auditable");

  const classSym = symbols.find((s) => s.name === "AccountService");
  assert.ok(classSym);

  const classInherits = inheritance.filter((i) => i.sourceSymbolId === classSym.id);
  assert.equal(classInherits.length, 3);
  assert.equal(classInherits[0].kind, "extends");
  assert.equal(classInherits[0].targetText, "BaseService");
  assert.equal(classInherits[1].kind, "implements");
  assert.equal(classInherits[1].targetText, "IAccountService");
  assert.equal(classInherits[2].kind, "implements");
  assert.equal(classInherits[2].targetText, "IDisposable");
});

// ========================================================
// 3. TYPESCRIPT TYPE REFERENCES AND CONTEXT CLASSIFICATION
// ========================================================
test("typeExtractor: extracts type references and classifies syntax context correctly", () => {
  const code = `
    function processRequest(user: UserProfile): Promise<ApiResponse> {
      const config: AppConfig = loadConfig();
      const items: Array<DataItem> = [];
      return Promise.resolve({ user });
    }
  `;

  const fileId = "file_typerefs_ts";
  const { sourceFile } = createSourceAST("src/request.ts", code);
  const symbols = extractDeclarations(sourceFile, fileId);
  const { typeReferences } = extractTypeFacts(sourceFile, fileId, symbols);

  assert.equal(typeReferences.length >= 4, true);

  // Parameter context: user: UserProfile
  const paramRef = typeReferences.find((r) => r.text === "UserProfile");
  assert.ok(paramRef);
  assert.equal(paramRef.context, "parameter");

  // Return context: Promise<ApiResponse>
  const returnRef = typeReferences.find((r) => r.text === "Promise");
  assert.ok(returnRef);
  assert.equal(returnRef.context, "return");

  // Variable context: config: AppConfig
  const varRef = typeReferences.find((r) => r.text === "AppConfig");
  assert.ok(varRef);
  assert.equal(varRef.context, "variable");

  // Generic argument context: Array<DataItem> -> DataItem
  const genericRef = typeReferences.find((r) => r.text === "DataItem");
  assert.ok(genericRef);
  assert.equal(genericRef.context, "generic_argument");
});

// ========================================================
// 4. SCHEMA VALIDATION WITH EXTRACTED CALLS AND TYPE FACTS
// ========================================================
test("callTypeExtractor: FileIR with calls, typeReferences, and inheritance passes schema validation", () => {
  const code = `
    interface Repository<T> {
      findById(id: string): Promise<T>;
    }

    class SqlRepository<T> extends BaseRepo implements Repository<T> {
      async findById(id: string): Promise<T> {
        const query = this.buildQuery(id);
        const result = await this.db.execute(query);
        return result;
      }
    }
  `;

  const file = {
    path: "src/SqlRepository.ts",
    blobSha: "blob_sql_repo",
    language: "typescript",
    content: code,
  };

  const fileId = "file_sql_repo_ts";
  const { sourceFile, diagnostics } = createSourceAST(file.path, code);
  const symbols = extractDeclarations(sourceFile, fileId);
  const callSites = extractCallSites(sourceFile, fileId, symbols);
  const { typeReferences, inheritance } = extractTypeFacts(sourceFile, fileId, symbols);

  const fileIR = buildFileIR({
    repository: MOCK_REPO,
    file,
    parser: {
      adapterId: "typescript-adapter",
      adapterVersion: "1.0.0",
      engine: "typescript",
      engineVersion: "5.9.3",
      status: "complete",
      capabilities: ["symbols", "calls", "type_references", "inheritance"],
    },
    symbols,
    callSites,
    typeReferences,
    inheritance,
    diagnostics,
  });

  const validation = validateFileIR(fileIR);
  assert.equal(validation.isValid, true, `Validation failed: ${validation.errors.join("; ")}`);
  assert.equal(fileIR.stats.callSites, callSites.length);
  assert.equal(fileIR.stats.typeReferences, typeReferences.length);
});


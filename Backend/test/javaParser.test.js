const test = require("node:test");
const assert = require("node:assert/strict");
const { parseJavaSource } = require("../services/parser/adapters/java/parserFactory");
const { JavaAdapter } = require("../services/parser/adapters/java/JavaAdapter");
const { validateFileIR } = require("../services/parser/irValidator");

const MOCK_REPO = {
  owner: "octocat",
  name: "Hello-Java",
  fullName: "octocat/Hello-Java",
  commitSha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
};

test("javaParser: parses clean Java source and reports zero diagnostics", () => {
  const code = `package com.example;
public class HelloWorld {
    public static void main(String[] args) {
        System.out.println("Hello, World!");
    }
}
`;
  const { tree, diagnostics, hasErrors } = parseJavaSource(code, "HelloWorld.java");
  assert.equal(hasErrors, false);
  assert.equal(diagnostics.length, 0);
  assert.ok(tree);
  assert.equal(tree.rootNode.type, "program");
});

test("javaParser: recovers gracefully from malformed Java syntax with diagnostics", () => {
  const malformed = `package com.example;
public class Broken {
    public void brokenMethod( {
        // missing closing parenthesis and block
`;
  const { tree, diagnostics, hasErrors } = parseJavaSource(malformed, "Broken.java");
  assert.equal(hasErrors, true);
  assert.ok(diagnostics.length > 0);
  assert.equal(diagnostics[0].code, "JAVA_SYNTAX_ERROR");
  assert.equal(diagnostics[0].severity, "error");
  assert.ok(diagnostics[0].location.start.line >= 1);
  assert.ok(tree);
});

test("javaParser: JavaAdapter parses empty Java file and produces valid FileIR", async () => {
  const adapter = new JavaAdapter();
  const ir = await adapter.parseFile({
    path: "Empty.java",
    content: "",
    language: "java",
    repository: MOCK_REPO,
  });

  assert.equal(ir.irVersion, "1.0.0");
  assert.equal(ir.analysis.file.path, "Empty.java");
  assert.equal(ir.parser.status, "complete");
  assert.equal(ir.symbols.length, 0);
  assert.equal(ir.diagnostics.length, 0);

  const validation = validateFileIR(ir);
  assert.equal(validation.isValid, true, `Validation errors: ${validation.errors.join(", ")}`);
});

test("javaParser: JavaAdapter handles CRLF and comments, passing FileIR validation", async () => {
  const adapter = new JavaAdapter();
  const crlfCode = "/* File header comment */\r\npackage com.example;\r\n\r\npublic class Greeter {\r\n    // inline comment\r\n}\r\n";
  const ir = await adapter.parseFile({
    path: "Greeter.java",
    content: crlfCode,
    language: "java",
    repository: MOCK_REPO,
  });

  assert.equal(ir.parser.status, "complete");
  assert.ok(ir.symbols.length >= 1);
  assert.equal(ir.symbols[0].name, "Greeter");

  const validation = validateFileIR(ir);
  assert.equal(validation.isValid, true, `Validation errors: ${validation.errors.join(", ")}`);
});

test("javaParser: JavaAdapter produces partial status on syntax error while preserving schema validity", async () => {
  const adapter = new JavaAdapter();
  const brokenCode = "package com.example;\npublic class Incomplete {\n    public int count = \n";
  const ir = await adapter.parseFile({
    path: "Incomplete.java",
    content: brokenCode,
    language: "java",
    repository: MOCK_REPO,
  });

  assert.equal(ir.parser.status, "partial");
  assert.ok(ir.diagnostics.length > 0);

  const validation = validateFileIR(ir);
  assert.equal(validation.isValid, true, `Validation errors: ${validation.errors.join(", ")}`);
});

test("javaParser: extracts package, classes, methods, constructors, fields, and constants", async () => {
  const adapter = new JavaAdapter();
  const code = `package com.example.service;

import java.io.IOException;

@Deprecated
public class UserService {
    private static final int MAX_RETRIES = 3;
    private String dbUrl;

    public UserService(String dbUrl) {
        this.dbUrl = dbUrl;
    }

    public User findUser(String id) throws IOException {
        return null;
    }

    void internalHelper() {}
}
`;

  const ir = await adapter.parseFile({
    path: "src/main/java/com/example/service/UserService.java",
    content: code,
    language: "java",
    repository: MOCK_REPO,
  });

  assert.equal(ir.parser.status, "complete");

  // 1. Class Symbol
  const classSym = ir.symbols.find((s) => s.name === "UserService");
  assert.ok(classSym);
  assert.equal(classSym.kind, "class");
  assert.equal(classSym.visibility, "public");
  assert.equal(classSym.isExported, true);
  assert.ok(classSym.languageMetadata.annotations.some((a) => a.name === "Deprecated"));

  // 2. Constants vs Fields
  const constSym = ir.symbols.find((s) => s.name === "MAX_RETRIES");
  assert.ok(constSym);
  assert.equal(constSym.kind, "constant");
  assert.equal(constSym.parentSymbolId, classSym.id);
  assert.equal(constSym.visibility, "private");

  const fieldSym = ir.symbols.find((s) => s.name === "dbUrl");
  assert.ok(fieldSym);
  assert.equal(fieldSym.kind, "field");
  assert.equal(fieldSym.parentSymbolId, classSym.id);

  // 3. Constructor
  const ctorSym = ir.symbols.find((s) => s.name === "UserService" && s.kind === "constructor");
  assert.ok(ctorSym);
  assert.equal(ctorSym.parentSymbolId, classSym.id);
  assert.equal(ctorSym.parameters.length, 1);
  assert.equal(ctorSym.parameters[0].name, "dbUrl");

  // 4. Method with throws
  const methodSym = ir.symbols.find((s) => s.name === "findUser");
  assert.ok(methodSym);
  assert.equal(methodSym.kind, "method");
  assert.equal(methodSym.visibility, "public");
  assert.deepEqual(methodSym.languageMetadata.throws, ["IOException"]);

  // 5. Package-private method
  const internalSym = ir.symbols.find((s) => s.name === "internalHelper");
  assert.ok(internalSym);
  assert.equal(internalSym.visibility, "internal");
  assert.equal(internalSym.languageMetadata.packagePrivate, true);

  const validation = validateFileIR(ir);
  assert.equal(validation.isValid, true, `Validation errors: ${validation.errors.join(", ")}`);
});

test("javaParser: extracts Java 14+ records, annotation types, enums, and interfaces", async () => {
  const adapter = new JavaAdapter();
  const code = `package com.example.model;

public record Point(int x, int y) {}

public enum Priority {
    LOW, MEDIUM, HIGH;
}

public interface Executable {
    void execute();
}

@interface Audited {
    String value() default "general";
}
`;

  const ir = await adapter.parseFile({
    path: "src/main/java/com/example/model/Types.java",
    content: code,
    language: "java",
    repository: MOCK_REPO,
  });

  assert.equal(ir.parser.status, "complete");

  // 1. Record
  const recordSym = ir.symbols.find((s) => s.name === "Point");
  assert.ok(recordSym);
  assert.equal(recordSym.kind, "class");
  assert.equal(recordSym.languageMetadata.isRecord, true);
  assert.equal(recordSym.parameters.length, 2);
  assert.equal(recordSym.parameters[0].name, "x");
  assert.equal(recordSym.parameters[1].name, "y");

  // 2. Enum and Enum members
  const enumSym = ir.symbols.find((s) => s.name === "Priority" && s.kind === "enum");
  assert.ok(enumSym);
  const lowSym = ir.symbols.find((s) => s.name === "LOW" && s.kind === "enum_member");
  assert.ok(lowSym);
  assert.equal(lowSym.parentSymbolId, enumSym.id);

  // 3. Interface
  const ifaceSym = ir.symbols.find((s) => s.name === "Executable" && s.kind === "interface");
  assert.ok(ifaceSym);

  // 4. Annotation Type (@interface)
  const annotSym = ir.symbols.find((s) => s.name === "Audited");
  assert.ok(annotSym);
  assert.equal(annotSym.kind, "interface");
  assert.equal(annotSym.languageMetadata.isAnnotationType, true);

  const validation = validateFileIR(ir);
  assert.equal(validation.isValid, true, `Validation errors: ${validation.errors.join(", ")}`);
});

test("javaParser: extracts varargs and preserves deterministic symbol IDs on repeated runs", async () => {
  const adapter = new JavaAdapter();
  const code = `package com.example.util;

public class StringUtils {
    public static String join(String delimiter, Object... items) {
        return "";
    }
}
`;

  const ir1 = await adapter.parseFile({
    path: "StringUtils.java",
    content: code,
    language: "java",
    repository: MOCK_REPO,
  });

  const ir2 = await adapter.parseFile({
    path: "StringUtils.java",
    content: code,
    language: "java",
    repository: MOCK_REPO,
  });

  const method1 = ir1.symbols.find((s) => s.name === "join");
  assert.ok(method1);
  assert.equal(method1.parameters.length, 2);
  assert.equal(method1.parameters[0].name, "delimiter");
  assert.equal(method1.parameters[1].name, "items");
  assert.equal(method1.parameters[1].variadic, true);

  assert.deepEqual(
    ir1.symbols.map((s) => s.id),
    ir2.symbols.map((s) => s.id)
  );

  const validation = validateFileIR(ir1);
  assert.equal(validation.isValid, true, `Validation errors: ${validation.errors.join(", ")}`);
});

test("javaParser: extracts single-type, wildcard, static single-member, and static wildcard imports", async () => {
  const adapter = new JavaAdapter();
  const code = `package com.example.service;

import java.util.List;
import java.util.Map;
import java.io.*;
import static java.lang.Math.PI;
import static java.lang.Math.max;
import static java.util.Collections.*;

public class ImporterService {}
`;

  const ir = await adapter.parseFile({
    path: "src/main/java/com/example/service/ImporterService.java",
    content: code,
    language: "java",
    repository: MOCK_REPO,
  });

  assert.equal(ir.parser.status, "complete");
  assert.equal(ir.imports.length, 6);

  // 1. Single-type imports
  const listImport = ir.imports[0];
  assert.equal(listImport.rawSource, "java.util.List");
  assert.equal(listImport.kind, "module_import");
  assert.equal(listImport.sourceKind, "package");
  assert.equal(listImport.specifiers[0].kind, "named");
  assert.equal(listImport.specifiers[0].importedName, "List");
  assert.equal(listImport.languageMetadata.isStatic, false);
  assert.equal(listImport.languageMetadata.isWildcard, false);
  assert.equal(listImport.languageMetadata.packageName, "java.util");
  assert.equal(listImport.languageMetadata.importedType, "List");

  // 2. Wildcard import
  const ioWildcard = ir.imports[2];
  assert.equal(ioWildcard.rawSource, "java.io.*");
  assert.equal(ioWildcard.kind, "package_import");
  assert.equal(ioWildcard.specifiers[0].kind, "wildcard");
  assert.equal(ioWildcard.specifiers[0].importedName, "*");
  assert.equal(ioWildcard.languageMetadata.isStatic, false);
  assert.equal(ioWildcard.languageMetadata.isWildcard, true);
  assert.equal(ioWildcard.languageMetadata.packageName, "java.io");

  // 3. Static single-member import
  const staticPi = ir.imports[3];
  assert.equal(staticPi.rawSource, "java.lang.Math.PI");
  assert.equal(staticPi.kind, "module_import");
  assert.equal(staticPi.specifiers[0].kind, "named");
  assert.equal(staticPi.specifiers[0].importedName, "PI");
  assert.equal(staticPi.languageMetadata.isStatic, true);
  assert.equal(staticPi.languageMetadata.isWildcard, false);
  assert.equal(staticPi.languageMetadata.packageName, "java.lang");
  assert.equal(staticPi.languageMetadata.className, "Math");
  assert.equal(staticPi.languageMetadata.memberName, "PI");

  // 4. Static wildcard import
  const staticCollections = ir.imports[5];
  assert.equal(staticCollections.rawSource, "java.util.Collections.*");
  assert.equal(staticCollections.kind, "package_import");
  assert.equal(staticCollections.specifiers[0].kind, "wildcard");
  assert.equal(staticCollections.languageMetadata.isStatic, true);
  assert.equal(staticCollections.languageMetadata.isWildcard, true);
  assert.equal(staticCollections.languageMetadata.packageName, "java.util");
  assert.equal(staticCollections.languageMetadata.className, "Collections");

  const validation = validateFileIR(ir);
  assert.equal(validation.isValid, true, `Validation errors: ${validation.errors.join(", ")}`);
});

test("javaParser: handles duplicate imports, comments within imports, and root package imports cleanly", async () => {
  const adapter = new JavaAdapter();
  const code = `// Package-less file in default root package
/* Leading comment */
import java.util.List;
// Duplicate import
import java.util.List;
import /* inline comment */ java.net.URI;
import RootType;

public class TestClass {}
`;

  const ir = await adapter.parseFile({
    path: "TestClass.java",
    content: code,
    language: "java",
    repository: MOCK_REPO,
  });

  assert.equal(ir.parser.status, "complete");
  assert.equal(ir.imports.length, 4);

  assert.equal(ir.imports[0].rawSource, "java.util.List");
  assert.equal(ir.imports[1].rawSource, "java.util.List");
  assert.notEqual(ir.imports[0].id, ir.imports[1].id);
  assert.notEqual(ir.imports[0].location.start.line, ir.imports[1].location.start.line);

  assert.equal(ir.imports[2].rawSource, "java.net.URI");
  assert.equal(ir.imports[2].specifiers[0].importedName, "URI");

  assert.equal(ir.imports[3].rawSource, "RootType");
  assert.equal(ir.imports[3].specifiers[0].importedName, "RootType");
  assert.equal(ir.imports[3].languageMetadata.packageName, "");

  const validation = validateFileIR(ir);
  assert.equal(validation.isValid, true, `Validation errors: ${validation.errors.join(", ")}`);
});

test("javaParser: extracts direct calls, member calls, constructor invocations, super/this, and method references", async () => {
  const adapter = new JavaAdapter();
  const code = `package com.example.service;

public class OrderService extends BaseService {
    public OrderService() {
        this("default");
    }

    public OrderService(String name) {
        super(name);
    }

    public void processOrder() {
        validate();
        System.out.println("processing");
        User user = new User("alice", 100);
        Runnable r = OrderService::logCompletion;
    }

    private static void logCompletion() {}
    private void validate() {}
}
`;

  const ir = await adapter.parseFile({
    path: "src/main/java/com/example/service/OrderService.java",
    content: code,
    language: "java",
    repository: MOCK_REPO,
  });

  assert.equal(ir.parser.status, "complete");
  assert.ok(ir.callSites.length >= 5);

  // 1. this("default") constructor invocation
  const thisCall = ir.callSites.find((c) => c.calleeText === "this");
  assert.ok(thisCall);
  assert.equal(thisCall.calleeKind, "constructor");
  assert.equal(thisCall.argumentCount, 1);
  assert.equal(thisCall.resolution.status, "not_attempted");

  // 2. super(name) constructor invocation
  const superCall = ir.callSites.find((c) => c.calleeText === "super");
  assert.ok(superCall);
  assert.equal(superCall.calleeKind, "constructor");
  assert.equal(superCall.argumentCount, 1);

  // 3. validate() direct method call
  const directCall = ir.callSites.find((c) => c.calleeText === "validate");
  assert.ok(directCall);
  assert.equal(directCall.calleeKind, "identifier");
  assert.equal(directCall.argumentCount, 0);

  // 4. System.out.println() member invocation
  const memberCall = ir.callSites.find((c) => c.calleeText.includes("System.out.println"));
  assert.ok(memberCall);
  assert.equal(memberCall.calleeKind, "member_expression");
  assert.equal(memberCall.argumentCount, 1);

  // 5. new User("alice", 100) object creation
  const ctorCall = ir.callSites.find((c) => c.calleeText === "User");
  assert.ok(ctorCall);
  assert.equal(ctorCall.calleeKind, "constructor");
  assert.equal(ctorCall.argumentCount, 2);

  // 6. OrderService::logCompletion method reference
  const methodRef = ir.callSites.find((c) => c.calleeText.includes("::"));
  assert.ok(methodRef);
  assert.equal(methodRef.calleeKind, "function_pointer");

  // Enclosing callable symbol linkage
  const processMethod = ir.symbols.find((s) => s.name === "processOrder");
  assert.ok(processMethod);
  assert.equal(directCall.enclosingSymbolId, processMethod.id);
  assert.equal(memberCall.enclosingSymbolId, processMethod.id);
  assert.equal(ctorCall.enclosingSymbolId, processMethod.id);

  const validation = validateFileIR(ir);
  assert.equal(validation.isValid, true, `Validation errors: ${validation.errors.join(", ")}`);
});

test("javaParser: extracts class/interface/record inheritance and type references across contexts", async () => {
  const adapter = new JavaAdapter();
  const code = `package com.example.repo;

import java.io.Serializable;
import java.io.IOException;
import java.util.List;

public class UserRepository extends BaseRepository implements CrudRepository, Serializable {
    private List<User> cache;

    @Override
    public List<User> findAll(int page) throws IOException {
        String query = (String) buildQuery();
        return cache;
    }

    private Object buildQuery() { return ""; }
}

interface CrudRepository extends BaseCrud {}

record UserRecord(String id) implements Serializable {}
`;

  const ir = await adapter.parseFile({
    path: "src/main/java/com/example/repo/UserRepository.java",
    content: code,
    language: "java",
    repository: MOCK_REPO,
  });

  assert.equal(ir.parser.status, "complete");

  // 1. Inheritance checks
  const classSym = ir.symbols.find((s) => s.name === "UserRepository");
  assert.ok(classSym);

  const extendsRepo = ir.inheritance.find((i) => i.kind === "extends" && i.targetText === "BaseRepository");
  assert.ok(extendsRepo);
  assert.equal(extendsRepo.sourceSymbolId, classSym.id);

  const implementsCrud = ir.inheritance.find((i) => i.kind === "implements" && i.targetText === "CrudRepository");
  assert.ok(implementsCrud);
  assert.equal(implementsCrud.sourceSymbolId, classSym.id);

  const implementsSerial = ir.inheritance.find((i) => i.kind === "implements" && i.targetText === "Serializable" && i.sourceSymbolId === classSym.id);
  assert.ok(implementsSerial);

  // Interface extends
  const ifaceSym = ir.symbols.find((s) => s.name === "CrudRepository");
  assert.ok(ifaceSym);
  const ifaceExtends = ir.inheritance.find((i) => i.sourceSymbolId === ifaceSym.id);
  assert.ok(ifaceExtends);
  assert.equal(ifaceExtends.kind, "extends");
  assert.equal(ifaceExtends.targetText === "BaseCrud", true);

  // Record implements
  const recordSym = ir.symbols.find((s) => s.name === "UserRecord");
  assert.ok(recordSym);
  const recordImplements = ir.inheritance.find((i) => i.sourceSymbolId === recordSym.id);
  assert.ok(recordImplements);
  assert.equal(recordImplements.kind, "implements");
  assert.equal(recordImplements.targetText === "Serializable", true);

  // 2. Type references across contexts
  const paramTypeRef = ir.typeReferences.find((t) => t.context === "parameter" && t.text === "int");
  assert.ok(paramTypeRef);

  const returnTypeRef = ir.typeReferences.find((t) => t.context === "return" && t.text.includes("List<User>"));
  assert.ok(returnTypeRef);

  const genericTypeRef = ir.typeReferences.find((t) => t.context === "generic_argument" && t.text === "User");
  assert.ok(genericTypeRef);

  const varTypeRef = ir.typeReferences.find((t) => t.context === "variable" && t.text.includes("List<User>"));
  assert.ok(varTypeRef);

  const castTypeRef = ir.typeReferences.find((t) => t.context === "cast" && t.text === "String");
  assert.ok(castTypeRef);

  const annotTypeRef = ir.typeReferences.find((t) => t.context === "annotation" && t.text === "Override");
  assert.ok(annotTypeRef);

  const throwsTypeRef = ir.typeReferences.find((t) => t.context === "other" && t.text === "IOException");
  assert.ok(throwsTypeRef);

  const validation = validateFileIR(ir);
  assert.equal(validation.isValid, true, `Validation errors: ${validation.errors.join(", ")}`);
});

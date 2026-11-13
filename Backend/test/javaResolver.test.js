const test = require("node:test");
const assert = require("node:assert/strict");
const { JavaImportResolver } = require("../services/parser/resolvers/java/JavaImportResolver");
const { JavaRepositoryIndex, inferFromPath } = require("../services/parser/resolvers/java/candidateResolver");
const { checkJdkPackage } = require("../services/parser/resolvers/java/jdkPackages");
const { parsePomXml, parseBuildGradle } = require("../services/parser/resolvers/java/buildMetadataReader");
const { JavaAdapter } = require("../services/parser/adapters/java/JavaAdapter");

const MOCK_REPO = {
  owner: "acme",
  name: "java-sample",
  fullName: "acme/java-sample",
  commitSha: "1111222233334444555566667777888899990000",
};

test("javaResolver: inferFromPath correctly strips various source roots and infers FQN", () => {
  assert.deepEqual(inferFromPath("src/main/java/com/example/service/UserService.java"), {
    packageName: "com.example.service",
    typeName: "UserService",
    fullyQualifiedName: "com.example.service.UserService",
  });

  assert.deepEqual(inferFromPath("app/src/main/java/org/demo/App.java"), {
    packageName: "org.demo",
    typeName: "App",
    fullyQualifiedName: "org.demo.App",
  });

  assert.deepEqual(inferFromPath("src/test/java/com/example/TestRunner.java"), {
    packageName: "com.example",
    typeName: "TestRunner",
    fullyQualifiedName: "com.example.TestRunner",
  });

  assert.deepEqual(inferFromPath("RootClass.java"), {
    packageName: "",
    typeName: "RootClass",
    fullyQualifiedName: "RootClass",
  });
});

test("javaResolver: checkJdkPackage accurately identifies JDK platform packages", () => {
  assert.equal(checkJdkPackage("java.util.List").isJdk, true);
  assert.equal(checkJdkPackage("java.io.*").isJdk, true);
  assert.equal(checkJdkPackage("javax.crypto.Cipher").isJdk, true);
  assert.equal(checkJdkPackage("java.lang.Math.PI").isJdk, true);
  assert.equal(checkJdkPackage("org.w3c.dom.Document").isJdk, true);

  assert.equal(checkJdkPackage("com.example.MyService").isJdk, false);
  assert.equal(checkJdkPackage("org.apache.commons.lang3.StringUtils").isJdk, false);
});

test("javaResolver: parsePomXml and parseBuildGradle extract dependencies and target versions safely", () => {
  const pom = `
<project>
  <properties>
    <java.version>17</java.version>
  </properties>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
      <version>3.2.0</version>
    </dependency>
    <dependency>
      <groupId>com.google.guava</groupId>
      <artifactId>guava</artifactId>
      <version>32.1.2-jre</version>
    </dependency>
  </dependencies>
</project>
`;
  const pomMeta = parsePomXml(pom);
  assert.equal(pomMeta.targetJavaVersion, "17");
  assert.equal(pomMeta.declaredDependencies.length, 2);
  assert.ok(pomMeta.declaredPackages.has("org.springframework.boot"));
  assert.ok(pomMeta.declaredPackages.has("com.google.guava"));

  const gradle = `
plugins {
    id 'java'
}
sourceCompatibility = '21'
dependencies {
    implementation 'org.slf4j:slf4j-api:2.0.9'
    testImplementation "org.junit.jupiter:junit-jupiter:5.10.0"
}
`;
  const gradleMeta = parseBuildGradle(gradle);
  assert.equal(gradleMeta.targetJavaVersion, "21");
  assert.equal(gradleMeta.declaredDependencies.length, 2);
  assert.ok(gradleMeta.declaredPackages.has("org.slf4j"));
  assert.ok(gradleMeta.declaredPackages.has("org.junit.jupiter"));
});

test("javaResolver: JavaRepositoryIndex handles single-type, static member, wildcards, and duplicates", () => {
  const index = JavaRepositoryIndex.build([
    "src/main/java/com/example/auth/AuthService.java",
    "src/main/java/com/example/auth/User.java",
    "src/main/java/com/example/util/Constants.java",
    "src/test/java/com/example/auth/AuthService.java", // Duplicate in test source root!
  ]);

  // 1. Exact match
  const userRes = index.resolveSingleType("com.example.auth.User");
  assert.equal(userRes.status, "internal_resolved");
  assert.equal(userRes.targetPath, "src/main/java/com/example/auth/User.java");

  // 2. Ambiguous match when duplicate declaration exists
  const authRes = index.resolveSingleType("com.example.auth.AuthService");
  assert.equal(authRes.status, "ambiguous");
  assert.equal(authRes.candidates.length, 2);

  // 3. Static member owning type resolution
  const constRes = index.resolveStaticMember("com.example.util.Constants", "MAX_RETRIES");
  assert.equal(constRes.status, "internal_resolved");
  assert.equal(constRes.targetPath, "src/main/java/com/example/util/Constants.java");

  // 4. Wildcard package resolution (does not fabricate class edges)
  const wildRes = index.resolveWildcardPackage("com.example.auth");
  assert.equal(wildRes.status, "wildcard");
  assert.ok(wildRes.candidates.length >= 2);
});

test("javaResolver: JavaImportResolver end-to-end resolves FileIR imports with evidence and summary", async () => {
  const adapter = new JavaAdapter();

  const serviceCode = `package com.example.service;

import com.example.model.Account;
import java.util.List;
import java.util.*;
import static com.example.util.Config.TIMEOUT;
import static java.lang.Math.PI;
import org.springframework.stereotype.Service;
import com.unknown.vendor.NonExistent;

public class MyService {}
`;

  const modelCode = `package com.example.model;
public class Account {}
`;

  const configCode = `package com.example.util;
public class Config {
    public static final int TIMEOUT = 5000;
}
`;

  const irService = await adapter.parseFile({
    path: "src/main/java/com/example/service/MyService.java",
    content: serviceCode,
    language: "java",
    repository: MOCK_REPO,
  });

  const irModel = await adapter.parseFile({
    path: "src/main/java/com/example/model/Account.java",
    content: modelCode,
    language: "java",
    repository: MOCK_REPO,
  });

  const irConfig = await adapter.parseFile({
    path: "src/main/java/com/example/util/Config.java",
    content: configCode,
    language: "java",
    repository: MOCK_REPO,
  });

  const pomXml = `
<project>
  <dependencies>
    <dependency>
      <groupId>org.springframework</groupId>
      <artifactId>spring-context</artifactId>
      <version>6.1.0</version>
    </dependency>
  </dependencies>
</project>
`;

  const resolver = new JavaImportResolver({
    manifest: [
      "src/main/java/com/example/service/MyService.java",
      "src/main/java/com/example/model/Account.java",
      "src/main/java/com/example/util/Config.java",
    ],
    parsedFiles: [irService, irModel, irConfig],
    supportingFiles: {
      "pom.xml": pomXml,
    },
  });

  const fileResolution = resolver.resolveFileIR(irService);
  assert.equal(fileResolution.filePath, "src/main/java/com/example/service/MyService.java");
  assert.equal(fileResolution.resolutions.length, 7);

  // 1. Internal resolved (com.example.model.Account)
  const accRes = fileResolution.resolutions[0];
  assert.equal(accRes.status, "internal_resolved");
  assert.equal(accRes.resolvedPath, "src/main/java/com/example/model/Account.java");
  assert.equal(accRes.rule, "exact_type_match");
  assert.ok(accRes.evidence.resolverVersion);

  // 2. JDK single import (java.util.List)
  const listRes = fileResolution.resolutions[1];
  assert.equal(listRes.status, "standard_library");
  assert.equal(listRes.rule, "java_se_platform_package");

  // 3. JDK wildcard import (java.util.*)
  const utilWildRes = fileResolution.resolutions[2];
  assert.equal(utilWildRes.status, "standard_library");
  assert.equal(utilWildRes.rule, "java_se_platform_package");

  // 4. Internal static member import (com.example.util.Config.TIMEOUT)
  const staticConfigRes = fileResolution.resolutions[3];
  assert.equal(staticConfigRes.status, "internal_resolved");
  assert.equal(staticConfigRes.resolvedPath, "src/main/java/com/example/util/Config.java");

  // 5. JDK static member import (java.lang.Math.PI)
  const staticMathRes = fileResolution.resolutions[4];
  assert.equal(staticMathRes.status, "standard_library");
  assert.equal(staticMathRes.rule, "java_se_platform_package");

  // 6. External package from pom.xml (org.springframework.stereotype.Service)
  const springRes = fileResolution.resolutions[5];
  assert.equal(springRes.status, "external_package");
  assert.equal(springRes.rule, "declared_build_dependency");

  // 7. Unresolved vendor import
  const unknownRes = fileResolution.resolutions[6];
  assert.equal(unknownRes.status, "unresolved");

  // Repository-wide resolution summary
  const repoSummary = resolver.resolveRepository([irService, irModel, irConfig]);
  assert.equal(repoSummary.summary.totalImports, 7);
  assert.equal(repoSummary.summary.internalResolved, 2);
  assert.equal(repoSummary.summary.standardLibrary, 3);
  assert.equal(repoSummary.summary.externalPackage, 1);
  assert.equal(repoSummary.summary.unresolved, 1);
});

test("javaResolver: classifies javax.servlet.* as external_package, javax.sql.* as Java SE, sun.* as JDK-internal, jdk.* as JDK-tool", () => {
  const resolver = new JavaImportResolver();

  // 1. javax.servlet.* -> external_package (Java EE specification)
  const servletRes = resolver.resolveImport("src/Test.java", "javax.servlet.http.HttpServletRequest");
  assert.equal(servletRes.status, "external_package");
  assert.equal(servletRes.rule, "java_ee_specification");

  const servletWild = resolver.resolveImport("src/Test.java", "javax.servlet.*");
  assert.equal(servletWild.status, "external_package");
  assert.equal(servletWild.rule, "java_ee_specification");

  const persistenceRes = resolver.resolveImport("src/Test.java", "javax.persistence.Entity");
  assert.equal(persistenceRes.status, "external_package");
  assert.equal(persistenceRes.rule, "java_ee_specification");

  // 2. javax.sql.* -> standard_library (Java SE)
  const sqlRes = resolver.resolveImport("src/Test.java", "javax.sql.DataSource");
  assert.equal(sqlRes.status, "standard_library");
  assert.equal(sqlRes.rule, "java_se_platform_package");

  const cryptoRes = resolver.resolveImport("src/Test.java", "javax.crypto.Cipher");
  assert.equal(cryptoRes.status, "standard_library");
  assert.equal(cryptoRes.rule, "java_se_platform_package");

  // 3. sun.* -> standard_library (JDK-internal API)
  const sunRes = resolver.resolveImport("src/Test.java", "sun.misc.Unsafe");
  assert.equal(sunRes.status, "standard_library");
  assert.equal(sunRes.rule, "jdk_internal_api");

  const comSunRes = resolver.resolveImport("src/Test.java", "com.sun.net.httpserver.HttpServer");
  assert.equal(comSunRes.status, "standard_library");
  assert.equal(comSunRes.rule, "jdk_internal_api");

  // 4. jdk.* -> standard_library (JDK-tool API)
  const jdkToolRes = resolver.resolveImport("src/Test.java", "jdk.jfr.Event");
  assert.equal(jdkToolRes.status, "standard_library");
  assert.equal(jdkToolRes.rule, "jdk_tool_api");
});

test("javaResolver: extracts nested type FQN, indexes nested record/interface/enum, resolves nested import to containing file, and flags duplicates as ambiguous", async () => {
  const adapter = new JavaAdapter();

  const outerCode = `package com.example;

public class Outer {
    public static class Inner {
        public static class DeepInner {}
    }

    public interface NestedInterface {}
    public enum NestedEnum { A, B }
    public record NestedRecord(String id) {}
}
`;

  const duplicateCode = `package com.example;
public class DuplicateHolder {
    public static class Inner {}
}
`;

  const irOuter = await adapter.parseFile({
    path: "src/main/java/com/example/Outer.java",
    content: outerCode,
    language: "java",
    repository: MOCK_REPO,
  });

  const irDuplicate = await adapter.parseFile({
    path: "src/test/java/com/example/Outer.java",
    content: outerCode,
    language: "java",
    repository: MOCK_REPO,
  });

  // 1. Correct hierarchical FQNs
  const innerSym = irOuter.symbols.find((s) => s.name === "Inner");
  assert.ok(innerSym);
  assert.equal(innerSym.qualifiedName, "com.example.Outer.Inner");

  const deepInnerSym = irOuter.symbols.find((s) => s.name === "DeepInner");
  assert.ok(deepInnerSym);
  assert.equal(deepInnerSym.qualifiedName, "com.example.Outer.Inner.DeepInner");

  const nestedIface = irOuter.symbols.find((s) => s.name === "NestedInterface");
  assert.ok(nestedIface);
  assert.equal(nestedIface.qualifiedName, "com.example.Outer.NestedInterface");

  const nestedEnum = irOuter.symbols.find((s) => s.name === "NestedEnum");
  assert.ok(nestedEnum);
  assert.equal(nestedEnum.qualifiedName, "com.example.Outer.NestedEnum");

  const nestedRec = irOuter.symbols.find((s) => s.name === "NestedRecord");
  assert.ok(nestedRec);
  assert.equal(nestedRec.qualifiedName, "com.example.Outer.NestedRecord");

  // 2. Indexing and resolving nested type import
  const resolver = new JavaImportResolver({
    manifest: ["src/main/java/com/example/Outer.java"],
    parsedFiles: [irOuter],
  });

  const resolvedNested = resolver.resolveImport("src/Consumer.java", "com.example.Outer.Inner");
  assert.equal(resolvedNested.status, "internal_resolved");
  assert.equal(resolvedNested.resolvedPath, "src/main/java/com/example/Outer.java");
  assert.equal(resolvedNested.resolvedSymbolName, "Inner");
  assert.equal(resolvedNested.resolvedSymbolId, innerSym.id);

  // 3. Resolving nested interface and record
  const resolvedIface = resolver.resolveImport("src/Consumer.java", "com.example.Outer.NestedInterface");
  assert.equal(resolvedIface.status, "internal_resolved");
  assert.equal(resolvedIface.resolvedPath, "src/main/java/com/example/Outer.java");

  const resolvedRec = resolver.resolveImport("src/Consumer.java", "com.example.Outer.NestedRecord");
  assert.equal(resolvedRec.status, "internal_resolved");
  assert.equal(resolvedRec.resolvedPath, "src/main/java/com/example/Outer.java");

  // 4. Duplicate nested type candidates across files -> ambiguous
  const ambigResolver = new JavaImportResolver({
    manifest: [
      "src/main/java/com/example/Outer.java",
      "src/test/java/com/example/Outer.java",
    ],
    parsedFiles: [irOuter, irDuplicate],
  });

  const ambigRes = ambigResolver.resolveImport("src/Consumer.java", "com.example.Outer.Inner");
  assert.equal(ambigRes.status, "ambiguous");
  assert.equal(ambigRes.candidates.length, 2);
  assert.ok(ambigRes.candidates.includes("src/main/java/com/example/Outer.java"));
  assert.ok(ambigRes.candidates.includes("src/test/java/com/example/Outer.java"));
});



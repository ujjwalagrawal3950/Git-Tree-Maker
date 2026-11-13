const test = require("node:test");
const assert = require("node:assert/strict");

const { PythonImportResolver } = require("../services/parser/resolvers/python/PythonImportResolver");
const { PythonAdapter } = require("../services/parser/adapters/python/PythonAdapter");

const MOCK_REPO = {
  owner: "octocat",
  name: "python-app",
  fullName: "octocat/python-app",
  commitSha: "1122334455667788990011223344556677889900",
};

const MOCK_MANIFEST = [
  "app/__init__.py",
  "app/main.py",
  "app/config.py",
  "app/services/__init__.py",
  "app/services/auth.py",
  "app/services/auth.pyi", // Typing stub accompanying auth.py
  "app/services/token.py",
  "app/models/__init__.py",
  "app/models/user.py",
  "app/types_stub_only.pyi", // Stub-only module without .py counterpart
  "tests/test_auth.py",
];

const MOCK_REQUIREMENTS = `
fastapi>=0.100.0
pydantic==2.5.0
requests
# comments and extras
uvicorn[standard]>=0.23.0
`;

// ========================================================
// 1. RELATIVE IMPORTS RESOLUTION
// ========================================================
test("pythonResolver: resolves single-dot and multi-dot relative imports within packages", () => {
  const resolver = new PythonImportResolver({ manifest: MOCK_MANIFEST });

  // from . import token (inside app/services/auth.py) -> app/services/token.py
  const res1 = resolver.resolveImport("app/services/auth.py", ".token", {
    isRelative: true,
    relativeLevel: 1,
  });
  assert.equal(res1.status, "internal_resolved");
  assert.equal(res1.resolvedPath, "app/services/token.py");
  assert.equal(res1.rule, "relative_module_probe");

  // from ..models import user (inside app/services/auth.py) -> app/models/user.py
  const res2 = resolver.resolveImport("app/services/auth.py", "..models.user", {
    isRelative: true,
    relativeLevel: 2,
  });
  assert.equal(res2.status, "internal_resolved");
  assert.equal(res2.resolvedPath, "app/models/user.py");

  // from ..config (inside app/services/auth.py) -> app/config.py
  const res3 = resolver.resolveImport("app/services/auth.py", "..config", {
    isRelative: true,
    relativeLevel: 2,
  });
  assert.equal(res3.status, "internal_resolved");
  assert.equal(res3.resolvedPath, "app/config.py");
});

test("pythonResolver: prevents escaping above repository root on excessive relative levels", () => {
  const resolver = new PythonImportResolver({ manifest: MOCK_MANIFEST });

  // From app/main.py, relative level 3 (../../../) escapes repository root
  const res = resolver.resolveImport("app/main.py", "...outside", {
    isRelative: true,
    relativeLevel: 3,
  });

  assert.equal(res.status, "unresolved");
  assert.equal(res.rule, "escapes_repository_root");
  assert.equal(res.resolvedPath, null);
});

// ========================================================
// 2. TYPING STUBS SEPARATION (.py vs .pyi)
// ========================================================
test("pythonResolver: prioritizes runtime .py module and associates .pyi stub separately", () => {
  const resolver = new PythonImportResolver({ manifest: MOCK_MANIFEST });

  // app/services/auth has BOTH auth.py and auth.pyi
  const res = resolver.resolveImport("app/main.py", "app.services.auth");

  assert.equal(res.status, "internal_resolved");
  assert.equal(res.resolvedPath, "app/services/auth.py"); // Primary runtime target
  assert.equal(res.stubPath, "app/services/auth.pyi"); // Stub separated per blueprint correction
});

test("pythonResolver: resolves stub-only files when no runtime .py module exists", () => {
  const resolver = new PythonImportResolver({ manifest: MOCK_MANIFEST });

  const res = resolver.resolveImport("app/main.py", "app.types_stub_only");

  assert.equal(res.status, "internal_resolved");
  assert.equal(res.resolvedPath, "app/types_stub_only.pyi");
  assert.equal(res.stubPath, "app/types_stub_only.pyi");
});

// ========================================================
// 3. ABSOLUTE IMPORTS & SUBMODULE PROBING
// ========================================================
test("pythonResolver: resolves absolute package and submodule imports", () => {
  const resolver = new PythonImportResolver({ manifest: MOCK_MANIFEST });

  // Package with __init__.py
  const pkgRes = resolver.resolveImport("tests/test_auth.py", "app.services");
  assert.equal(pkgRes.status, "internal_resolved");
  assert.equal(pkgRes.resolvedPath, "app/services/__init__.py");

  // Submodule from `from app.models import user`
  const subRes = resolver.resolveImport("tests/test_auth.py", "app.models", {
    importedNames: ["user"],
  });
  assert.equal(subRes.status, "internal_resolved");
  assert.equal(subRes.resolvedPath, "app/models/user.py");
});

// ========================================================
// 4. CANDIDATE PRECEDENCE (__init__.py vs .py)
// ========================================================
test("pythonResolver: package directory with __init__.py takes deterministic precedence over mod.py", () => {
  const resolver = new PythonImportResolver({
    manifest: [
      "pkg/__init__.py",
      "pkg/mod/__init__.py",
      "pkg/mod.py", // Competing candidate
    ],
  });

  const res = resolver.resolveImport("app.py", "pkg.mod");
  assert.equal(res.status, "internal_resolved");
  assert.equal(res.resolvedPath, "pkg/mod/__init__.py");
  assert.equal(res.rule, "package_init_precedence");
  assert.deepEqual(res.candidates, ["pkg/mod/__init__.py", "pkg/mod.py"]);
});

// ========================================================
// 5. STANDARD LIBRARY VS EXTERNAL PACKAGES (VERSION-AWARE)
// ========================================================
test("pythonResolver: identifies standard library modules and preserves version uncertainty", () => {
  const resolver = new PythonImportResolver({ manifest: MOCK_MANIFEST });

  const stdlibImports = ["sys", "os", "os.path", "typing", "json", "asyncio", "collections", "unittest"];
  for (const mod of stdlibImports) {
    const res = resolver.resolveImport("app/main.py", mod);
    assert.equal(res.status, "standard_library", `Expected ${mod} to be standard_library`);
    assert.equal(res.rule, "python_stdlib");
    assert.equal(res.versionCertainty, "confirmed");
  }

  // Version-sensitive modules without target version specified -> uncertainty preserved
  const tomllibRes = resolver.resolveImport("app/main.py", "tomllib");
  assert.equal(tomllibRes.status, "standard_library");
  assert.equal(tomllibRes.versionCertainty, "uncertain");
  assert.equal(tomllibRes.rule, "python_stdlib_version_uncertain");

  const cgiRes = resolver.resolveImport("app/main.py", "cgi");
  assert.equal(cgiRes.status, "standard_library");
  assert.equal(cgiRes.versionCertainty, "uncertain");
});

test("pythonResolver: uses requires-python from pyproject.toml to resolve version-sensitive stdlib modules", () => {
  // Target Python >= 3.11 confirms tomllib
  const resolver311 = new PythonImportResolver({
    manifest: MOCK_MANIFEST,
    supportingFiles: {
      "pyproject.toml": `
[project]
name = "my-app"
requires-python = ">=3.11"
`,
    },
  });

  const resTomllib = resolver311.resolveImport("app/main.py", "tomllib");
  assert.equal(resTomllib.status, "standard_library");
  assert.equal(resTomllib.versionCertainty, "confirmed");
  assert.equal(resTomllib.rule, "python_stdlib");

  // Target Python >= 3.13 confirms cgi is removed (treated as external/unresolved)
  const resolver313 = new PythonImportResolver({
    manifest: MOCK_MANIFEST,
    supportingFiles: {
      "pyproject.toml": `
[project]
name = "modern-app"
requires-python = ">=3.13"
`,
    },
  });

  const resCgi = resolver313.resolveImport("app/main.py", "cgi");
  assert.equal(resCgi.status, "external_package"); // Not in 3.13 stdlib
});

test("pythonResolver: identifies external packages declared in requirements.txt", () => {
  const resolver = new PythonImportResolver({
    manifest: MOCK_MANIFEST,
    supportingFiles: { "requirements.txt": MOCK_REQUIREMENTS },
  });

  const resFastAPI = resolver.resolveImport("app/main.py", "fastapi");
  assert.equal(resFastAPI.status, "external_package");
  assert.equal(resFastAPI.packageName, "fastapi");

  const resPydantic = resolver.resolveImport("app/main.py", "pydantic");
  assert.equal(resPydantic.status, "external_package");
  assert.equal(resPydantic.packageName, "pydantic");

  const resUvicorn = resolver.resolveImport("app/main.py", "uvicorn");
  assert.equal(resUvicorn.status, "external_package");
  assert.equal(resUvicorn.packageName, "uvicorn");
});

// ========================================================
// 5. DYNAMIC IMPORTS
// ========================================================
test("pythonResolver: flags dynamic import expressions with dynamic status", () => {
  const resolver = new PythonImportResolver({ manifest: MOCK_MANIFEST });

  const res = resolver.resolveImport("app/main.py", "plugins.payment", {
    isDynamic: true,
  });

  assert.equal(res.status, "dynamic");
  assert.equal(res.rule, "dynamic_expression");
  assert.equal(res.resolvedPath, null);
});

// ========================================================
// 6. REPOSITORY-LEVEL RESOLUTION & METRICS SUMMARY
// ========================================================
test("pythonResolver: resolveRepository aggregates resolutions and summary counts across FileIRs", async () => {
  const adapter = new PythonAdapter();
  const file1 = await adapter.parseFile({
    path: "app/main.py",
    content: `
import sys
import os
import requests
from .services import auth
from .models.user import User
dynamic_plug = __import__("dynamic_plugin")
`,
    language: "python",
    repository: MOCK_REPO,
  });

  const file2 = await adapter.parseFile({
    path: "app/services/auth.py",
    content: `
import json
from ..config import db_url
from .token import generate_token
`,
    language: "python",
    repository: MOCK_REPO,
  });

  const resolver = new PythonImportResolver({
    manifest: MOCK_MANIFEST,
    supportingFiles: { "requirements.txt": MOCK_REQUIREMENTS },
  });

  const repoRes = resolver.resolveRepository([file1, file2]);

  assert.equal(repoRes.files.length, 2);
  const summary = repoRes.summary;

  assert.equal(summary.totalResolutions, 9);
  // stdlib: sys, os, json -> 3
  assert.equal(summary.standardLibrary, 3);
  // external: requests -> 1
  assert.equal(summary.externalPackages, 1);
  // internal: auth (has .pyi too), user, config, token -> 4
  assert.equal(summary.internalResolved, 4);
  // dynamic: dynamic_plugin -> 1
  assert.equal(summary.dynamic, 1);
  // stub count: auth has auth.pyi -> 1
  assert.equal(summary.stubCount, 1);
});


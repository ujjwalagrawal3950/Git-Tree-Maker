const path = require("node:path").posix;

/**
 * Centralized, extensible source language definitions.
 * Maps language identifier to its file extensions.
 */
const SOURCE_LANGUAGES = {
  javascript: {
    name: "JavaScript",
    extensions: [".js", ".jsx", ".mjs", ".cjs"],
  },
  typescript: {
    name: "TypeScript",
    extensions: [".ts", ".tsx", ".mts", ".cts"],
  },
  python: {
    name: "Python",
    extensions: [".py", ".pyi"],
  },
  java: {
    name: "Java",
    extensions: [".java"],
  },
  c: {
    name: "C",
    extensions: [".c"],
  },
  cpp: {
    name: "C++",
    extensions: [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"],
  },
  c_cpp_header: {
    name: "C/C++ Header",
    extensions: [".h"],
  },
  go: {
    name: "Go",
    extensions: [".go"],
  },
  rust: {
    name: "Rust",
    extensions: [".rs"],
  },
  csharp: {
    name: "C#",
    extensions: [".cs"],
  },
  php: {
    name: "PHP",
    extensions: [".php"],
  },
  ruby: {
    name: "Ruby",
    extensions: [".rb"],
  },
  kotlin: {
    name: "Kotlin",
    extensions: [".kt", ".kts"],
  },
  swift: {
    name: "Swift",
    extensions: [".swift"],
  },
  dart: {
    name: "Dart",
    extensions: [".dart"],
  },
  scala: {
    name: "Scala",
    extensions: [".scala", ".sc"],
  },
};

/**
 * Supporting file categories (dependencies, configuration, build, schemas, documentation).
 * These are classified distinctly and not treated as source code.
 */
const SUPPORTING_CATEGORIES = {
  dependency_manifest: {
    name: "Dependency Manifest",
    filenames: [
      "package.json",
      "requirements.txt",
      "cargo.toml",
      "go.mod",
      "pom.xml",
      "gemfile",
      "composer.json",
      "build.gradle",
      "build.gradle.kts",
      "setup.py",
      "setup.cfg",
    ],
    extensions: [],
  },
  configuration: {
    name: "Configuration",
    filenames: [
      "tsconfig.json",
      "jsconfig.json",
      "pyproject.toml",
      "compile_commands.json",
      ".eslintrc.json",
      ".eslintrc.js",
      ".prettierrc",
      ".editorconfig",
      "gradle.properties",
    ],
    extensions: [".toml", ".ini", ".conf"],
  },
  build: {
    name: "Build",
    filenames: ["cmakelists.txt", "makefile", "gnumakefile", "rakefile"],
    extensions: [".mk"],
  },
  schema: {
    name: "Schema",
    filenames: [],
    extensions: [".proto", ".graphql", ".gql"],
  },
  documentation: {
    name: "Documentation",
    filenames: [
      "readme",
      "readme.md",
      "readme.txt",
      "contributing.md",
      "license",
      "license.md",
      "license.txt",
      "changelog.md",
    ],
    extensions: [".md", ".markdown", ".rst", ".adoc"],
  },
};

/**
 * Known binary, media, font, document, and archive extensions.
 * These are non-code assets that must be omitted from source code dependency analysis.
 */
const IGNORED_ASSET_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp", ".bmp", ".tiff",
  ".mp4", ".mp3", ".wav", ".ogg", ".webm", ".avi", ".mov",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".zip", ".tar", ".gz", ".7z", ".rar", ".bz2",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".wasm",
  ".class", ".pyc", ".pyo", ".o", ".obj",
  ".ttf", ".otf", ".woff", ".woff2", ".eot",
]);

// Fast lookup maps built from configuration
const extensionToSourceLang = new Map();
for (const [langKey, def] of Object.entries(SOURCE_LANGUAGES)) {
  for (const ext of def.extensions) {
    extensionToSourceLang.set(ext.toLowerCase(), langKey);
  }
}

const filenameToSupportingCategory = new Map();
const extensionToSupportingCategory = new Map();
for (const [catKey, def] of Object.entries(SUPPORTING_CATEGORIES)) {
  for (const fname of def.filenames) {
    filenameToSupportingCategory.set(fname.toLowerCase(), catKey);
  }
  for (const ext of def.extensions) {
    extensionToSupportingCategory.set(ext.toLowerCase(), catKey);
  }
}

/**
 * Registers an additional source language dynamically.
 *
 * @param {string} langKey - Unique identifier (e.g. "lua")
 * @param {object} options
 * @param {string} options.name - Display name (e.g. "Lua")
 * @param {string[]} options.extensions - e.g. [".lua"]
 */
function registerLanguage(langKey, { name, extensions = [] }) {
  SOURCE_LANGUAGES[langKey] = { name: name || langKey, extensions };
  for (const ext of extensions) {
    extensionToSourceLang.set(ext.toLowerCase(), langKey);
  }
}

/**
 * Classifies a repository-relative file path into category and language.
 *
 * @param {string} filePath - Repository-relative file path
 * @param {object} [options]
 * @param {boolean} [options.includeDocumentation=false]
 * @returns {object} Classification result
 */
function classifyFile(filePath, options = {}) {
  if (!filePath || typeof filePath !== "string") {
    return {
      category: "unknown",
      tier: "unknown",
      language: null,
      isSource: false,
      isSupporting: false,
      isDocumentation: false,
      isIgnoredAsset: false,
      isRequiredConfig: false,
      isEligible: false,
    };
  }

  const basename = path.basename(filePath).toLowerCase();
  const ext = path.extname(filePath).toLowerCase();

  // 1. Check if it matches a supporting file by exact filename (e.g. package.json, build.gradle.kts, setup.py, Makefile)
  const categoryByFilename = filenameToSupportingCategory.get(basename);
  if (categoryByFilename) {
    const isDoc = categoryByFilename === "documentation";
    const isConfig =
      categoryByFilename === "dependency_manifest" ||
      categoryByFilename === "configuration" ||
      categoryByFilename === "build";
    const isEligible = isDoc ? Boolean(options.includeDocumentation) : true;
    return {
      category: categoryByFilename,
      tier: isDoc ? "documentation" : isConfig ? "required_config" : "supporting",
      language: null,
      isSource: false,
      isSupporting: !isDoc,
      isDocumentation: isDoc,
      isIgnoredAsset: false,
      isRequiredConfig: isConfig,
      isEligible,
    };
  }

  // 2. Check if it matches a known source code language
  const sourceLang = extensionToSourceLang.get(ext);
  if (sourceLang) {
    return {
      category: "source",
      tier: "analyzable_source",
      language: sourceLang,
      isSource: true,
      isSupporting: false,
      isDocumentation: false,
      isIgnoredAsset: false,
      isRequiredConfig: false,
      isEligible: true,
    };
  }

  // 3. Check if it matches a supporting file by extension (e.g. .proto, .graphql, .md)
  const categoryByExt = extensionToSupportingCategory.get(ext);
  if (categoryByExt) {
    const isDoc = categoryByExt === "documentation";
    const isConfig =
      categoryByExt === "dependency_manifest" ||
      categoryByExt === "configuration" ||
      categoryByExt === "build";
    const isEligible = isDoc ? Boolean(options.includeDocumentation) : true;
    return {
      category: categoryByExt,
      tier: isDoc ? "documentation" : isConfig ? "required_config" : "supporting",
      language: null,
      isSource: false,
      isSupporting: !isDoc,
      isDocumentation: isDoc,
      isIgnoredAsset: false,
      isRequiredConfig: isConfig,
      isEligible,
    };
  }

  // 4. Check if it matches known binary/media/font/archive assets to ignore
  if (IGNORED_ASSET_EXTENSIONS.has(ext)) {
    return {
      category: "asset",
      tier: "ignored_asset",
      language: null,
      isSource: false,
      isSupporting: false,
      isDocumentation: false,
      isIgnoredAsset: true,
      isRequiredConfig: false,
      isEligible: false,
    };
  }

  // 5. Unknown / unsupported file type
  return {
    category: "unknown",
    tier: "unknown",
    language: null,
    isSource: false,
    isSupporting: false,
    isDocumentation: false,
    isIgnoredAsset: false,
    isRequiredConfig: false,
    isEligible: false,
  };
}

/**
 * Returns true if the path points to an analyzable source code file.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
function isSourceCodePath(filePath) {
  if (!filePath || typeof filePath !== "string") return false;
  const ext = path.extname(filePath).toLowerCase();
  return extensionToSourceLang.has(ext);
}

/**
 * Returns true if the path points to a required configuration/metadata file.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
function isRequiredConfigPath(filePath) {
  if (!filePath || typeof filePath !== "string") return false;
  const basename = path.basename(filePath).toLowerCase();
  const ext = path.extname(filePath).toLowerCase();
  const catByFilename = filenameToSupportingCategory.get(basename);
  if (
    catByFilename === "dependency_manifest" ||
    catByFilename === "configuration" ||
    catByFilename === "build"
  ) {
    return true;
  }
  const catByExt = extensionToSupportingCategory.get(ext);
  return (
    catByExt === "dependency_manifest" ||
    catByExt === "configuration" ||
    catByExt === "build"
  );
}

/**
 * Returns true if the path points to documentation.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
function isDocumentationPath(filePath) {
  if (!filePath || typeof filePath !== "string") return false;
  const basename = path.basename(filePath).toLowerCase();
  const ext = path.extname(filePath).toLowerCase();
  return (
    filenameToSupportingCategory.get(basename) === "documentation" ||
    extensionToSupportingCategory.get(ext) === "documentation"
  );
}

/**
 * Returns true if the path points to an ignored non-code asset (media, binary, font, etc.).
 *
 * @param {string} filePath
 * @returns {boolean}
 */
function isIgnoredAssetPath(filePath) {
  if (!filePath || typeof filePath !== "string") return false;
  const ext = path.extname(filePath).toLowerCase();
  return IGNORED_ASSET_EXTENSIONS.has(ext);
}

module.exports = {
  SOURCE_LANGUAGES,
  SUPPORTING_CATEGORIES,
  IGNORED_ASSET_EXTENSIONS,
  registerLanguage,
  classifyFile,
  isSourceCodePath,
  isRequiredConfigPath,
  isDocumentationPath,
  isIgnoredAssetPath,
};


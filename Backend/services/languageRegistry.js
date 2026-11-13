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
    ],
    extensions: [],
  },
  configuration: {
    name: "Configuration",
    filenames: [
      "tsconfig.json",
      "pyproject.toml",
      ".eslintrc.json",
      ".eslintrc.js",
      ".prettierrc",
      ".editorconfig",
    ],
    extensions: [".toml", ".ini", ".conf"],
  },
  build: {
    name: "Build",
    filenames: ["cmakelists.txt", "makefile", "rakefile"],
    extensions: [".mk"],
  },
  schema: {
    name: "Schema",
    filenames: [],
    extensions: [".proto", ".graphql", ".gql"],
  },
  documentation: {
    name: "Documentation",
    filenames: ["readme", "readme.md", "readme.txt", "contributing.md", "license", "license.md"],
    extensions: [".md", ".markdown"],
  },
};

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
      language: null,
      isSource: false,
      isSupporting: false,
      isDocumentation: false,
      isEligible: false,
    };
  }

  const basename = path.basename(filePath).toLowerCase();
  const ext = path.extname(filePath).toLowerCase();

  // 1. Check if it matches a known source code language
  const sourceLang = extensionToSourceLang.get(ext);
  if (sourceLang) {
    return {
      category: "source",
      language: sourceLang,
      isSource: true,
      isSupporting: false,
      isDocumentation: false,
      isEligible: true,
    };
  }

  // 2. Check if it matches a supporting file by exact filename (e.g. package.json, Makefile)
  const categoryByFilename = filenameToSupportingCategory.get(basename);
  if (categoryByFilename) {
    const isDoc = categoryByFilename === "documentation";
    const isEligible = isDoc ? Boolean(options.includeDocumentation) : true;
    return {
      category: categoryByFilename,
      language: null,
      isSource: false,
      isSupporting: !isDoc,
      isDocumentation: isDoc,
      isEligible,
    };
  }

  // 3. Check if it matches a supporting file by extension (e.g. .proto, .graphql, .md)
  const categoryByExt = extensionToSupportingCategory.get(ext);
  if (categoryByExt) {
    const isDoc = categoryByExt === "documentation";
    const isEligible = isDoc ? Boolean(options.includeDocumentation) : true;
    return {
      category: categoryByExt,
      language: null,
      isSource: false,
      isSupporting: !isDoc,
      isDocumentation: isDoc,
      isEligible,
    };
  }

  // 4. Unknown / unsupported file type
  return {
    category: "unknown",
    language: null,
    isSource: false,
    isSupporting: false,
    isDocumentation: false,
    isEligible: false,
  };
}

module.exports = {
  SOURCE_LANGUAGES,
  SUPPORTING_CATEGORIES,
  registerLanguage,
  classifyFile,
};


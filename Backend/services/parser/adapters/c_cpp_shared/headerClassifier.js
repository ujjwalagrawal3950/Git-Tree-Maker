const { normalizePath } = require("./locationMapper");

/**
 * Patterns that indicate unambiguous C++ syntax constructs.
 */
const CPP_SYNTAX_PATTERNS = [
  /\bnamespace\s+[a-zA-Z0-9_:]+\s*\{/,
  /\bclass\s+[a-zA-Z0-9_]+/,
  /\btemplate\s*</,
  /\b(public|protected|private)\s*:/,
  /\busing\s+[a-zA-Z0-9_]+\s*=/,
  /\benum\s+(class|struct)\b/,
  /\b(constexpr|consteval|decltype|noexcept|static_assert)\b/,
  /#include\s+<(iostream|vector|string|memory|algorithm|map|set|utility|thread|mutex|chrono|type_traits)>/,
  /\bvirtual\s+/,
  /\boperator\s*([+\-*/%=!<>&|^~]+|\[\]|\(\))\s*\(/,
];

/**
 * Classifies a .h header file into "c", "cpp", or "ambiguous" based on:
 * 1. Build metadata (compile_commands.json flags/compiler).
 * 2. Unambiguous local syntactic evidence in the file content.
 * 3. Include relationships across the repository.
 *
 * Never silently forces a language classification when evidence is insufficient.
 *
 * @param {string} filePath - Repository-relative path of the header
 * @param {string} [content=""] - Source code content of the header
 * @param {object} [options={}]
 * @param {object} [options.buildMetadata] - Parsed compilation database
 * @param {string[]} [options.includers] - Array of source file paths that include this header
 * @param {string[]} [options.manifest] - Repository manifest file paths
 * @returns {{
 *   language: "c"|"cpp"|"ambiguous",
 *   confidence: "high"|"medium"|"low"|"uncertain",
 *   reason: string,
 *   candidates?: string[]
 * }}
 */
function classifyHeaderFile(filePath, content = "", options = {}) {
  const normPath = (filePath || "").replace(/\\/g, "/");

  // 1. Check build metadata (compile_commands.json)
  if (options.buildMetadata && options.buildMetadata.translationUnits) {
    const tu = options.buildMetadata.translationUnits.get(normPath);
    if (tu) {
      if (tu.compilerStandard && tu.compilerStandard.toLowerCase().includes("++")) {
        return { language: "cpp", confidence: "high", reason: "build_metadata_cpp_standard" };
      }
      if (tu.compiler && (tu.compiler.includes("++") || tu.compiler.includes("g++") || tu.compiler.includes("clang++"))) {
        return { language: "cpp", confidence: "high", reason: "build_metadata_cpp_compiler" };
      }
      if (tu.compilerStandard && /^c[0-9]{2}/i.test(tu.compilerStandard)) {
        return { language: "c", confidence: "high", reason: "build_metadata_c_standard" };
      }
    }
  }

  // 2. Check local syntactic evidence in header content
  if (typeof content === "string" && content.length > 0) {
    for (const pattern of CPP_SYNTAX_PATTERNS) {
      if (pattern.test(content)) {
        return { language: "cpp", confidence: "high", reason: "syntax_analysis_cpp_constructs" };
      }
    }
  }

  // 3. Check include relationships (who includes this header)
  let includers = options.includers;
  if (!includers && options.manifest && Array.isArray(options.manifest)) {
    // If includers list not explicitly passed, can scan manifest if desired
    includers = null;
  }

  if (includers && Array.isArray(includers) && includers.length > 0) {
    const cppIncluders = includers.filter((p) => /\.(cpp|cc|cxx|hpp|hh|hxx)$/i.test(p));
    const cIncluders = includers.filter((p) => /\.c$/i.test(p));

    if (cppIncluders.length > 0 && cIncluders.length === 0) {
      return { language: "cpp", confidence: "medium", reason: "includers_all_cpp" };
    }
    if (cIncluders.length > 0 && cppIncluders.length === 0) {
      return { language: "c", confidence: "medium", reason: "includers_all_c" };
    }
    if (cIncluders.length > 0 && cppIncluders.length > 0) {
      return {
        language: "ambiguous",
        confidence: "uncertain",
        reason: "mixed_c_and_cpp_includers",
        candidates: ["c", "cpp"],
      };
    }
  }

  // 4. Check repository-wide language presence if manifest is supplied
  if (options.manifest && Array.isArray(options.manifest)) {
    const hasC = options.manifest.some((p) => /\.c$/i.test(p));
    const hasCpp = options.manifest.some((p) => /\.(cpp|cc|cxx)$/i.test(p));

    if (hasCpp && !hasC) {
      return { language: "cpp", confidence: "low", reason: "repository_cpp_only" };
    }
    if (hasC && !hasCpp) {
      return { language: "c", confidence: "low", reason: "repository_c_only" };
    }
  }

  // 5. Default: preserve genuine uncertainty
  return {
    language: "ambiguous",
    confidence: "uncertain",
    reason: "insufficient_evidence",
    candidates: ["c", "cpp"],
  };
}

module.exports = {
  classifyHeaderFile,
  CPP_SYNTAX_PATTERNS,
};


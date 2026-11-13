const path = require("node:path").posix;
const { normalizePath, isPathEscapingRoot } = require("./candidateResolver");

const MAX_COMPILE_COMMANDS_BYTES = 10 * 1024 * 1024; // 10 MB bounded limit

/**
 * Safely tokenizes a command-line string into an array of arguments
 * without executing a shell or subprocess.
 *
 * @param {string} cmdLine
 * @returns {string[]}
 */
function tokenizeCommandLine(cmdLine) {
  const args = [];
  if (!cmdLine || typeof cmdLine !== "string") return args;

  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escape = false;

  for (let i = 0; i < cmdLine.length; i++) {
    const ch = cmdLine[i];

    if (escape) {
      current += ch;
      escape = false;
      continue;
    }

    if (ch === "\\") {
      escape = true;
      continue;
    }

    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (/\s/.test(ch) && !inSingleQuote && !inDoubleQuote) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (current.length > 0) {
    args.push(current);
  }

  return args;
}

/**
 * Resolves a path specified in compile_commands.json relative to the entry's compilation directory.
 *
 * @param {string} entryDirectory
 * @param {string} targetPath
 * @returns {{ path: string|null, escapes: boolean }}
 */
function resolveEntryPath(entryDirectory, targetPath) {
  if (!targetPath || typeof targetPath !== "string") {
    return { path: null, escapes: false };
  }

  const normTarget = normalizePath(targetPath);
  if (normTarget.startsWith("/")) {
    // Treat absolute system paths as non-repository paths
    return { path: normTarget, escapes: true };
  }

  const normDir = normalizePath(entryDirectory || ".");
  const combined = path.normalize(path.join(normDir, normTarget));

  if (isPathEscapingRoot(combined)) {
    return { path: null, escapes: true };
  }

  return { path: combined, escapes: false };
}

/**
 * Parses compile_commands.json content into translation-unit-specific metadata.
 * Never executes compiler commands.
 * Never applies translation-unit-specific macros or includes globally.
 *
 * @param {string} content - Raw JSON text
 * @returns {{
 *   translationUnits: Map<string, {
 *     filePath: string,
 *     directory: string,
 *     includeDirectories: string[],
 *     macros: Array<{ name: string, value: string|null }>,
 *     compilerStandard: string|null,
 *     compiler: string|null
 *   }>,
 *   totalEntries: number,
 *   errors: string[]
 * }}
 */
function parseCompileCommandsJson(content) {
  const result = {
    translationUnits: new Map(),
    totalEntries: 0,
    errors: [],
  };

  if (!content || typeof content !== "string") {
    return result;
  }

  if (content.length > MAX_COMPILE_COMMANDS_BYTES) {
    result.errors.push(`compile_commands.json exceeds maximum size limit of ${MAX_COMPILE_COMMANDS_BYTES} bytes`);
    return result;
  }

  let entries;
  try {
    entries = JSON.parse(content);
  } catch (err) {
    result.errors.push(`Malformed compile_commands.json: ${err.message}`);
    return result;
  }

  if (!Array.isArray(entries)) {
    result.errors.push("compile_commands.json root must be a JSON array");
    return result;
  }

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || typeof entry !== "object") continue;

    const rawFile = entry.file;
    if (!rawFile || typeof rawFile !== "string") continue;

    const directory = typeof entry.directory === "string" ? entry.directory : ".";

    // Resolve file path relative to entry directory if relative
    let resolvedFilePath = normalizePath(rawFile);
    if (!resolvedFilePath.startsWith("/")) {
      const { path: normFile, escapes } = resolveEntryPath(directory, rawFile);
      if (!escapes && normFile) {
        resolvedFilePath = normFile;
      }
    }

    // Extract arguments from arguments array or command string
    let args = [];
    if (Array.isArray(entry.arguments)) {
      args = entry.arguments.filter((a) => typeof a === "string");
    } else if (typeof entry.command === "string") {
      args = tokenizeCommandLine(entry.command);
    }

    const includeDirs = [];
    const macros = [];
    let compilerStandard = null;
    let compiler = args.length > 0 ? path.basename(args[0]) : null;

    for (let j = 0; j < args.length; j++) {
      const arg = args[j];

      // 1. Include paths: -I<dir>, -isystem <dir>, -iquote <dir>, /I<dir>
      if (arg.startsWith("-I") && arg.length > 2) {
        const incPath = arg.slice(2);
        const { path: resolvedInc, escapes } = resolveEntryPath(directory, incPath);
        if (!escapes && resolvedInc && !includeDirs.includes(resolvedInc)) {
          includeDirs.push(resolvedInc);
        }
      } else if (arg === "-I" || arg === "-isystem" || arg === "-iquote" || arg === "/I") {
        if (j + 1 < args.length) {
          const incPath = args[++j];
          const { path: resolvedInc, escapes } = resolveEntryPath(directory, incPath);
          if (!escapes && resolvedInc && !includeDirs.includes(resolvedInc)) {
            includeDirs.push(resolvedInc);
          }
        }
      } else if (arg.startsWith("/I") && arg.length > 2) {
        const incPath = arg.slice(2);
        const { path: resolvedInc, escapes } = resolveEntryPath(directory, incPath);
        if (!escapes && resolvedInc && !includeDirs.includes(resolvedInc)) {
          includeDirs.push(resolvedInc);
        }
      }

      // 2. Macro definitions: -D<macro>, -D<macro>=<val>, /D<macro>
      else if (arg.startsWith("-D") && arg.length > 2) {
        const macroBody = arg.slice(2);
        const eqIdx = macroBody.indexOf("=");
        if (eqIdx !== -1) {
          macros.push({
            name: macroBody.slice(0, eqIdx),
            value: macroBody.slice(eqIdx + 1),
          });
        } else {
          macros.push({ name: macroBody, value: null });
        }
      } else if (arg === "-D" || arg === "/D") {
        if (j + 1 < args.length) {
          const macroBody = args[++j];
          const eqIdx = macroBody.indexOf("=");
          if (eqIdx !== -1) {
            macros.push({
              name: macroBody.slice(0, eqIdx),
              value: macroBody.slice(eqIdx + 1),
            });
          } else {
            macros.push({ name: macroBody, value: null });
          }
        }
      }

      // 3. Language standard: -std=c++20, -std=gnu17
      else if (arg.startsWith("-std=")) {
        compilerStandard = arg.slice(5);
      }
    }

    result.translationUnits.set(resolvedFilePath, {
      filePath: resolvedFilePath,
      directory,
      includeDirectories: includeDirs,
      macros,
      compilerStandard,
      compiler,
    });

    result.totalEntries++;
  }

  return result;
}

/**
 * Safely extracts C/C++ build metadata from supporting repository files
 * (compile_commands.json, build/compile_commands.json).
 *
 * @param {object} supportingFiles - Map of relative path to file content
 * @returns {{
 *   hasCompilationDatabase: boolean,
 *   translationUnits: Map<string, object>,
 *   totalEntries: number,
 *   errors: string[]
 * }}
 */
function readCppBuildMetadata(supportingFiles = {}) {
  const compileCommandsContent =
    supportingFiles["compile_commands.json"] ||
    supportingFiles["build/compile_commands.json"] ||
    null;

  if (compileCommandsContent) {
    const parsed = parseCompileCommandsJson(compileCommandsContent);
    return {
      hasCompilationDatabase: true,
      translationUnits: parsed.translationUnits,
      totalEntries: parsed.totalEntries,
      errors: parsed.errors,
    };
  }

  return {
    hasCompilationDatabase: false,
    translationUnits: new Map(),
    totalEntries: 0,
    errors: [],
  };
}

module.exports = {
  tokenizeCommandLine,
  parseCompileCommandsJson,
  readCppBuildMetadata,
  MAX_COMPILE_COMMANDS_BYTES,
};


/**
 * Python Standard Library Module Catalog (Python 3.10 - 3.13).
 *
 * Source: Official Python sys.stdlib_module_names (introduced in Python 3.10).
 *
 * Note on PEP 594:
 * PEP 594 ("Removing dead batteries from the standard library") did NOT define the standard library;
 * rather, it deprecated legacy modules in Python 3.11 and executed their formal removal in Python 3.13.
 * Python 3.12 also removed distutils (PEP 632) and imp.
 * Python 3.11 added tomllib (PEP 680).
 */

// Universal modules present across Python 3.10, 3.11, 3.12, and 3.13
const UNIVERSAL_STDLIB_MODULES = new Set([
  "abc",
  "argparse",
  "array",
  "ast",
  "asyncio",
  "atexit",
  "base64",
  "bdb",
  "binascii",
  "bisect",
  "builtins",
  "bz2",
  "calendar",
  "cmath",
  "cmd",
  "code",
  "codecs",
  "codeop",
  "collections",
  "colorsys",
  "compileall",
  "concurrent",
  "configparser",
  "contextlib",
  "contextvars",
  "copy",
  "copyreg",
  "cProfile",
  "csv",
  "ctypes",
  "curses",
  "dataclasses",
  "datetime",
  "dbm",
  "decimal",
  "difflib",
  "dis",
  "doctest",
  "email",
  "encodings",
  "ensurepip",
  "enum",
  "errno",
  "faulthandler",
  "fcntl",
  "filecmp",
  "fileinput",
  "fnmatch",
  "fractions",
  "ftplib",
  "functools",
  "gc",
  "getopt",
  "getpass",
  "gettext",
  "glob",
  "graphlib",
  "grp",
  "gzip",
  "hashlib",
  "heapq",
  "hmac",
  "html",
  "http",
  "idlelib",
  "imaplib",
  "inspect",
  "io",
  "ipaddress",
  "itertools",
  "json",
  "keyword",
  "linecache",
  "locale",
  "logging",
  "lzma",
  "mailbox",
  "marshal",
  "math",
  "mimetypes",
  "mmap",
  "modulefinder",
  "multiprocessing",
  "netrc",
  "numbers",
  "operator",
  "optparse",
  "os",
  "pathlib",
  "pdb",
  "pickle",
  "pickletools",
  "pkgutil",
  "platform",
  "plistlib",
  "poplib",
  "posix",
  "posixpath",
  "pprint",
  "profile",
  "pstats",
  "pty",
  "pwd",
  "py_compile",
  "pyclbr",
  "pydoc",
  "queue",
  "quopri",
  "random",
  "re",
  "readline",
  "reprlib",
  "resource",
  "rlcompleter",
  "runpy",
  "sched",
  "secrets",
  "select",
  "selectors",
  "shelve",
  "shlex",
  "shutil",
  "signal",
  "site",
  "smtplib",
  "socket",
  "socketserver",
  "sqlite3",
  "ssl",
  "stat",
  "statistics",
  "string",
  "stringprep",
  "struct",
  "subprocess",
  "symtable",
  "sys",
  "sysconfig",
  "syslog",
  "tabnanny",
  "tarfile",
  "tempfile",
  "termios",
  "test",
  "textwrap",
  "threading",
  "time",
  "timeit",
  "tkinter",
  "token",
  "tokenize",
  "trace",
  "traceback",
  "tracemalloc",
  "tty",
  "turtle",
  "turtledemo",
  "types",
  "typing",
  "unicodedata",
  "unittest",
  "urllib",
  "uuid",
  "venv",
  "warnings",
  "wave",
  "weakref",
  "webbrowser",
  "wsgiref",
  "xml",
  "xmlrpc",
  "zipapp",
  "zipfile",
  "zipimport",
  "zlib",
  "_thread",
]);

// Modules added in Python 3.11 (PEP 680)
const PYTHON_311_ADDED_MODULES = new Set(["tomllib"]);

// Modules removed in Python 3.12 (PEP 632 / deprecations)
const PYTHON_312_REMOVED_MODULES = new Set(["distutils", "imp"]);

// Modules removed in Python 3.13 under PEP 594 (dead batteries)
const PYTHON_313_REMOVED_PEP594_MODULES = new Set([
  "aifc",
  "asynchat",
  "asyncore",
  "audioop",
  "cgi",
  "cgitb",
  "chunk",
  "crypt",
  "imghdr",
  "mailcap",
  "msilib",
  "nis",
  "nntplib",
  "pipes",
  "sndhdr",
  "spwd",
  "sunau",
  "telnetlib",
  "uu",
  "xdrlib",
]);

// Full union set across Python 3.10 - 3.13
const PYTHON_STDLIB_MODULES = new Set([
  ...UNIVERSAL_STDLIB_MODULES,
  ...PYTHON_311_ADDED_MODULES,
  ...PYTHON_312_REMOVED_MODULES,
  ...PYTHON_313_REMOVED_PEP594_MODULES,
]);

/**
 * Classifies whether a module specifier is standard library, considering optional target Python version.
 *
 * @param {string} specifier - Module import path (e.g. "os", "tomllib", "cgi")
 * @param {number|null} [targetVersion=null] - Target Python minor version (e.g. 3.10, 3.11, 3.12, 3.13)
 * @returns {{
 *   isStdlib: boolean,
 *   versionCertainty: "confirmed"|"uncertain",
 *   rule: string
 * }}
 */
function classifyStdlibModule(specifier, targetVersion = null) {
  if (!specifier || typeof specifier !== "string") {
    return { isStdlib: false, versionCertainty: "confirmed", rule: "invalid_specifier" };
  }

  const topLevel = specifier.split(".")[0];

  // 1. Universal stdlib module
  if (UNIVERSAL_STDLIB_MODULES.has(topLevel)) {
    return {
      isStdlib: true,
      versionCertainty: "confirmed",
      rule: "python_stdlib",
    };
  }

  // 2. Added in Python 3.11 (e.g. tomllib)
  if (PYTHON_311_ADDED_MODULES.has(topLevel)) {
    if (typeof targetVersion === "number") {
      if (targetVersion >= 3.11) {
        return { isStdlib: true, versionCertainty: "confirmed", rule: "python_stdlib" };
      } else {
        return { isStdlib: false, versionCertainty: "confirmed", rule: "not_in_target_python" };
      }
    }
    // Unknown target version -> preserve uncertainty
    return {
      isStdlib: true,
      versionCertainty: "uncertain",
      rule: "python_stdlib_version_uncertain",
    };
  }

  // 3. Removed in Python 3.12 (e.g. distutils, imp)
  if (PYTHON_312_REMOVED_MODULES.has(topLevel)) {
    if (typeof targetVersion === "number") {
      if (targetVersion >= 3.12) {
        return { isStdlib: false, versionCertainty: "confirmed", rule: "removed_in_target_python" };
      } else {
        return { isStdlib: true, versionCertainty: "confirmed", rule: "python_stdlib" };
      }
    }
    return {
      isStdlib: true,
      versionCertainty: "uncertain",
      rule: "python_stdlib_version_uncertain",
    };
  }

  // 4. Removed in Python 3.13 under PEP 594 (dead batteries)
  if (PYTHON_313_REMOVED_PEP594_MODULES.has(topLevel)) {
    if (typeof targetVersion === "number") {
      if (targetVersion >= 3.13) {
        return { isStdlib: false, versionCertainty: "confirmed", rule: "removed_in_target_python" };
      } else {
        return { isStdlib: true, versionCertainty: "confirmed", rule: "python_stdlib" };
      }
    }
    return {
      isStdlib: true,
      versionCertainty: "uncertain",
      rule: "python_stdlib_version_uncertain",
    };
  }

  return {
    isStdlib: false,
    versionCertainty: "confirmed",
    rule: "not_stdlib",
  };
}

/**
 * Checks whether an import specifier refers to a Python standard library module.
 *
 * @param {string} specifier - Raw module specifier (e.g. "os", "os.path", "typing.List")
 * @returns {boolean}
 */
function isPythonStdlib(specifier) {
  if (!specifier || typeof specifier !== "string") return false;
  const topLevel = specifier.split(".")[0];
  return PYTHON_STDLIB_MODULES.has(topLevel);
}

module.exports = {
  UNIVERSAL_STDLIB_MODULES,
  PYTHON_311_ADDED_MODULES,
  PYTHON_312_REMOVED_MODULES,
  PYTHON_313_REMOVED_PEP594_MODULES,
  PYTHON_STDLIB_MODULES,
  classifyStdlibModule,
  isPythonStdlib,
};

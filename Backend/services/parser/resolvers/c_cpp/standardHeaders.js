/**
 * Catalogue of C and C++ standard library, POSIX, and platform headers.
 * Used for authoritative evidence-based classification of standard headers.
 */

// C Standard Library Headers (ISO C89/C99/C11/C17/C23)
const C_STANDARD_HEADERS = new Set([
  "assert.h",
  "complex.h",
  "ctype.h",
  "errno.h",
  "fenv.h",
  "float.h",
  "inttypes.h",
  "iso646.h",
  "limits.h",
  "locale.h",
  "math.h",
  "setjmp.h",
  "signal.h",
  "stdalign.h",
  "stdarg.h",
  "stdatomic.h",
  "stdbool.h",
  "stdckdint.h",
  "stddef.h",
  "stdint.h",
  "stdio.h",
  "stdlib.h",
  "stdnoreturn.h",
  "string.h",
  "tgmath.h",
  "threads.h",
  "time.h",
  "uchar.h",
  "wchar.h",
  "wctype.h",
]);

// C++ C-compatibility wrappers (<c...>)
const CPP_C_WRAPPERS = new Set([
  "cassert",
  "cctype",
  "cerrno",
  "cfenv",
  "cfloat",
  "cinttypes",
  "ciso646",
  "climits",
  "clocale",
  "cmath",
  "csetjmp",
  "csignal",
  "cstdalign",
  "cstdarg",
  "cstdbool",
  "cstddef",
  "cstdint",
  "cstdio",
  "cstdlib",
  "cstring",
  "ctgmath",
  "ctime",
  "cuchar",
  "cwchar",
  "cwctype",
]);

// C++ Standard Library Headers (ISO C++98 through C++23)
const CPP_STANDARD_HEADERS = new Set([
  "algorithm",
  "any",
  "array",
  "atomic",
  "barrier",
  "bit",
  "bitset",
  "charconv",
  "chrono",
  "codecvt",
  "compare",
  "complex",
  "concepts",
  "condition_variable",
  "coroutine",
  "deque",
  "exception",
  "execution",
  "expected",
  "filesystem",
  "flat_map",
  "flat_set",
  "format",
  "forward_list",
  "fstream",
  "functional",
  "future",
  "generator",
  "hazard_pointer",
  "initializer_list",
  "iomanip",
  "ios",
  "iosfwd",
  "iostream",
  "istream",
  "iterator",
  "latch",
  "limits",
  "list",
  "locale",
  "map",
  "mdspan",
  "memory",
  "memory_resource",
  "mutex",
  "new",
  "numbers",
  "numeric",
  "optional",
  "ostream",
  "print",
  "queue",
  "random",
  "ranges",
  "ratio",
  "rcu",
  "regex",
  "scoped_allocator",
  "semaphore",
  "set",
  "shared_mutex",
  "source_location",
  "span",
  "spanstream",
  "sstream",
  "stack",
  "stacktrace",
  "stdexcept",
  "stdfloat",
  "stop_token",
  "streambuf",
  "string",
  "string_view",
  "syncstream",
  "system_error",
  "text_encoding",
  "thread",
  "tuple",
  "type_traits",
  "typeindex",
  "typeinfo",
  "unordered_map",
  "unordered_set",
  "utility",
  "valarray",
  "variant",
  "vector",
  "version",
]);

// POSIX and UNIX Standard System Headers
const POSIX_HEADERS = new Set([
  "unistd.h",
  "fcntl.h",
  "pthread.h",
  "dirent.h",
  "poll.h",
  "termios.h",
  "dlfcn.h",
  "sys/types.h",
  "sys/stat.h",
  "sys/socket.h",
  "sys/time.h",
  "sys/mman.h",
  "sys/wait.h",
  "sys/select.h",
  "sys/resource.h",
  "sys/ioctl.h",
  "sys/uio.h",
  "sys/un.h",
  "netinet/in.h",
  "netinet/tcp.h",
  "arpa/inet.h",
  "netdb.h",
]);

// Windows Platform Headers
const WINDOWS_PLATFORM_HEADERS = new Set([
  "windows.h",
  "winsock2.h",
  "ws2tcpip.h",
  "winbase.h",
  "winnls.h",
  "windef.h",
  "tchar.h",
]);

/**
 * Classifies a raw include string as standard library or platform API.
 *
 * @param {string} rawHeader - Clean include header (e.g. "iostream", "stdio.h", "sys/types.h")
 * @returns {{
 *   isStandard: boolean,
 *   category: "c_standard"|"cpp_standard"|"posix_standard"|"platform_api"|null
 * }}
 */
function classifyStandardHeader(rawHeader) {
  if (!rawHeader || typeof rawHeader !== "string") {
    return { isStandard: false, category: null };
  }

  const clean = rawHeader.toLowerCase().trim();

  if (C_STANDARD_HEADERS.has(clean)) {
    return { isStandard: true, category: "c_standard" };
  }
  if (CPP_C_WRAPPERS.has(clean) || CPP_STANDARD_HEADERS.has(clean)) {
    return { isStandard: true, category: "cpp_standard" };
  }
  if (POSIX_HEADERS.has(clean)) {
    return { isStandard: true, category: "posix_standard" };
  }
  if (WINDOWS_PLATFORM_HEADERS.has(clean)) {
    return { isStandard: true, category: "platform_api" };
  }

  return { isStandard: false, category: null };
}

module.exports = {
  classifyStandardHeader,
  C_STANDARD_HEADERS,
  CPP_STANDARD_HEADERS,
  CPP_C_WRAPPERS,
  POSIX_HEADERS,
  WINDOWS_PLATFORM_HEADERS,
};


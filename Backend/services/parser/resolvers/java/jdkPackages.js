/**
 * Dataset and classifier for Java Platform / JDK packages (Java SE 8 through 21+).
 * Distinguishes official Java SE platform packages, Java EE / Jakarta EE specifications,
 * JDK-internal APIs (sun.*, com.sun.*), and JDK-specific tool APIs (jdk.*).
 */

const JAVA_EE_PACKAGE_PREFIXES = [
  "javax.servlet",
  "javax.persistence",
  "javax.ws.rs",
  "javax.inject",
  "javax.ejb",
  "javax.jms",
  "javax.validation",
  "javax.mail",
  "javax.enterprise",
  "javax.transaction",
  "javax.faces",
  "javax.websocket",
  "javax.batch",
  "javax.json",
  "javax.security.jacc",
  "javax.security.enterprise",
];

const JDK_INTERNAL_PREFIXES = ["sun.", "com.sun."];

const JDK_TOOL_PREFIXES = ["jdk."];

const KNOWN_JAVA_SE_PACKAGES = new Set([
  // java.lang and subpackages
  "java.lang",
  "java.lang.annotation",
  "java.lang.constant",
  "java.lang.instrument",
  "java.lang.invoke",
  "java.lang.management",
  "java.lang.module",
  "java.lang.ref",
  "java.lang.reflect",
  "java.lang.runtime",

  // java.util and subpackages
  "java.util",
  "java.util.concurrent",
  "java.util.concurrent.atomic",
  "java.util.concurrent.locks",
  "java.util.function",
  "java.util.jar",
  "java.util.logging",
  "java.util.prefs",
  "java.util.regex",
  "java.util.spi",
  "java.util.stream",
  "java.util.zip",

  // java.io and java.nio
  "java.io",
  "java.nio",
  "java.nio.channels",
  "java.nio.channels.spi",
  "java.nio.charset",
  "java.nio.charset.spi",
  "java.nio.file",
  "java.nio.file.attribute",
  "java.nio.file.spi",

  // java.net
  "java.net",
  "java.net.http",
  "java.net.spi",

  // java.time
  "java.time",
  "java.time.chrono",
  "java.time.format",
  "java.time.temporal",
  "java.time.zone",

  // java.math, text, sql
  "java.math",
  "java.text",
  "java.text.spi",
  "java.sql",

  // java.security
  "java.security",
  "java.security.cert",
  "java.security.interfaces",
  "java.security.spec",

  // java.awt and beans
  "java.awt",
  "java.awt.color",
  "java.awt.datatransfer",
  "java.awt.dnd",
  "java.awt.event",
  "java.awt.font",
  "java.awt.geom",
  "java.awt.im",
  "java.awt.image",
  "java.awt.print",
  "java.beans",
  "java.beans.beancontext",

  // Standard Java SE javax.* packages
  "javax.annotation.processing",
  "javax.crypto",
  "javax.crypto.interfaces",
  "javax.crypto.spec",
  "javax.imageio",
  "javax.imageio.event",
  "javax.imageio.metadata",
  "javax.imageio.plugins.bmp",
  "javax.imageio.plugins.jpeg",
  "javax.imageio.spi",
  "javax.imageio.stream",
  "javax.lang.model",
  "javax.lang.model.element",
  "javax.lang.model.type",
  "javax.lang.model.util",
  "javax.management",
  "javax.management.loading",
  "javax.management.modelmbean",
  "javax.management.monitor",
  "javax.management.openmbean",
  "javax.management.relation",
  "javax.management.remote",
  "javax.management.remote.rmi",
  "javax.management.timer",
  "javax.naming",
  "javax.naming.directory",
  "javax.naming.event",
  "javax.naming.ldap",
  "javax.naming.spi",
  "javax.net",
  "javax.net.ssl",
  "javax.print",
  "javax.print.attribute",
  "javax.print.attribute.standard",
  "javax.print.event",
  "javax.rmi.ssl",
  "javax.script",
  "javax.security.auth",
  "javax.security.auth.callback",
  "javax.security.auth.kerberos",
  "javax.security.auth.login",
  "javax.security.auth.spi",
  "javax.security.auth.x500",
  "javax.security.cert",
  "javax.sound.midi",
  "javax.sound.midi.spi",
  "javax.sound.sampled",
  "javax.sound.sampled.spi",
  "javax.sql",
  "javax.sql.rowset",
  "javax.sql.rowset.serial",
  "javax.sql.rowset.spi",
  "javax.swing",
  "javax.swing.border",
  "javax.swing.colorchooser",
  "javax.swing.event",
  "javax.swing.filechooser",
  "javax.swing.plaf",
  "javax.swing.plaf.basic",
  "javax.swing.plaf.metal",
  "javax.swing.plaf.multi",
  "javax.swing.plaf.nimbus",
  "javax.swing.plaf.synth",
  "javax.swing.table",
  "javax.swing.text",
  "javax.swing.text.html",
  "javax.swing.text.html.parser",
  "javax.swing.text.rtf",
  "javax.swing.tree",
  "javax.swing.undo",
  "javax.tools",
  "javax.xml",
  "javax.xml.catalog",
  "javax.xml.crypto",
  "javax.xml.crypto.dom",
  "javax.xml.crypto.dsig",
  "javax.xml.crypto.dsig.dom",
  "javax.xml.crypto.dsig.keyinfo",
  "javax.xml.crypto.dsig.spec",
  "javax.xml.datatype",
  "javax.xml.namespace",
  "javax.xml.parsers",
  "javax.xml.stream",
  "javax.xml.stream.events",
  "javax.xml.stream.util",
  "javax.xml.transform",
  "javax.xml.transform.dom",
  "javax.xml.transform.sax",
  "javax.xml.transform.stax",
  "javax.xml.transform.stream",
  "javax.xml.validation",
  "javax.xml.xpath",

  // Standard org.* packages bundled with Java SE
  "org.ietf.jgss",
  "org.w3c.dom",
  "org.w3c.dom.bootstrap",
  "org.w3c.dom.events",
  "org.w3c.dom.ls",
  "org.w3c.dom.views",
  "org.xml.sax",
  "org.xml.sax.ext",
  "org.xml.sax.helpers",
]);

/**
 * Classifies a Java import package specifier into:
 * - "java_se": Official standard Java SE API
 * - "java_ee": External Java EE / Jakarta specification API (e.g. javax.servlet, javax.persistence)
 * - "jdk_internal": JDK-internal proprietary API (e.g. sun.*, com.sun.*)
 * - "jdk_tool": JDK-specific tool/compiler API (e.g. jdk.jfr, jdk.incubator)
 * - "unknown": Not in the known JDK catalogue
 *
 * @param {string} specifier
 * @returns {{
 *   category: "java_se"|"java_ee"|"jdk_internal"|"jdk_tool"|"unknown",
 *   matchedPackage: string|null
 * }}
 */
function classifyJavaPackage(specifier) {
  if (!specifier || typeof specifier !== "string") {
    return { category: "unknown", matchedPackage: null };
  }

  const clean = specifier.replace(/\.\*$/, "").trim();

  // 1. Check known Java EE / Jakarta specifications first (removes blanket javax.* assumption)
  for (const eePrefix of JAVA_EE_PACKAGE_PREFIXES) {
    if (clean === eePrefix || clean.startsWith(eePrefix + ".")) {
      return { category: "java_ee", matchedPackage: eePrefix };
    }
  }

  // 2. Check JDK-internal APIs (sun.*, com.sun.*)
  for (const internalPrefix of JDK_INTERNAL_PREFIXES) {
    if (clean.startsWith(internalPrefix)) {
      return { category: "jdk_internal", matchedPackage: clean };
    }
  }

  // 3. Check JDK-specific tool APIs (jdk.*)
  for (const toolPrefix of JDK_TOOL_PREFIXES) {
    if (clean.startsWith(toolPrefix)) {
      return { category: "jdk_tool", matchedPackage: clean };
    }
  }

  // 4. Check explicit Java SE package catalogue
  if (KNOWN_JAVA_SE_PACKAGES.has(clean)) {
    return { category: "java_se", matchedPackage: clean };
  }

  // Prefix walk against known Java SE packages
  const parts = clean.split(".");
  for (let i = parts.length; i >= 1; i--) {
    const candidate = parts.slice(0, i).join(".");
    if (KNOWN_JAVA_SE_PACKAGES.has(candidate)) {
      return { category: "java_se", matchedPackage: candidate };
    }
  }

  // Java SE root: java.* that isn't sub-categorized above
  if (clean.startsWith("java.")) {
    return { category: "java_se", matchedPackage: clean };
  }

  return { category: "unknown", matchedPackage: null };
}

/**
 * Backward compatibility wrapper.
 *
 * @param {string} specifier
 * @returns {{ isJdk: boolean, matchedPackage: string|null }}
 */
function checkJdkPackage(specifier) {
  const result = classifyJavaPackage(specifier);
  const isJdk = result.category === "java_se" || result.category === "jdk_internal" || result.category === "jdk_tool";
  return {
    isJdk,
    matchedPackage: result.matchedPackage,
  };
}

module.exports = {
  classifyJavaPackage,
  checkJdkPackage,
  KNOWN_JAVA_SE_PACKAGES,
  JAVA_EE_PACKAGE_PREFIXES,
  JDK_INTERNAL_PREFIXES,
  JDK_TOOL_PREFIXES,
};

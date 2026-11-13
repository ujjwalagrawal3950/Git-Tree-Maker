const MAX_CONFIG_BYTES = 256 * 1024; // 256 KB safety limit

/**
 * Safely extracts dependency coordinates and Java version properties from pom.xml
 * without executing Maven or XML external entities (pure regex parsing).
 *
 * @param {string} content
 * @returns {{
 *   declaredDependencies: Array<{ groupId: string, artifactId: string }>,
 *   declaredPackages: Set<string>,
 *   targetJavaVersion: string|null
 * }}
 */
function parsePomXml(content) {
  const result = {
    declaredDependencies: [],
    declaredPackages: new Set(),
    targetJavaVersion: null,
  };

  if (!content || typeof content !== "string") return result;
  const boundedContent = content.slice(0, MAX_CONFIG_BYTES);

  // 1. Extract Java version from properties if present
  const javaVersionMatch =
    boundedContent.match(/<java\.version>\s*([^<\s]+)\s*<\/java\.version>/i) ||
    boundedContent.match(/<maven\.compiler\.source>\s*([^<\s]+)\s*<\/maven\.compiler\.source>/i) ||
    boundedContent.match(/<maven\.compiler\.release>\s*([^<\s]+)\s*<\/maven\.compiler\.release>/i);

  if (javaVersionMatch && javaVersionMatch[1]) {
    result.targetJavaVersion = javaVersionMatch[1].trim();
  }

  // 2. Extract <dependency> blocks
  const depBlockRegex = /<dependency>([\s\S]*?)<\/dependency>/gi;
  let blockMatch;

  while ((blockMatch = depBlockRegex.exec(boundedContent)) !== null) {
    const block = blockMatch[1];
    const groupMatch = block.match(/<groupId>\s*([^<\s]+)\s*<\/groupId>/i);
    const artifactMatch = block.match(/<artifactId>\s*([^<\s]+)\s*<\/artifactId>/i);

    if (groupMatch && groupMatch[1] && artifactMatch && artifactMatch[1]) {
      const groupId = groupMatch[1].trim();
      const artifactId = artifactMatch[1].trim();
      result.declaredDependencies.push({ groupId, artifactId });
      result.declaredPackages.add(groupId);
      result.declaredPackages.add(artifactId);
    }
  }

  return result;
}

/**
 * Safely extracts dependency coordinates and Java version properties from build.gradle or build.gradle.kts
 * without executing Gradle scripts or running the JVM (pure regex parsing).
 *
 * @param {string} content
 * @returns {{
 *   declaredDependencies: Array<{ groupId: string, artifactId: string }>,
 *   declaredPackages: Set<string>,
 *   targetJavaVersion: string|null
 * }}
 */
function parseBuildGradle(content) {
  const result = {
    declaredDependencies: [],
    declaredPackages: new Set(),
    targetJavaVersion: null,
  };

  if (!content || typeof content !== "string") return result;
  const boundedContent = content.slice(0, MAX_CONFIG_BYTES);

  // 1. Extract target Java version if present
  const jvmMatch =
    boundedContent.match(/sourceCompatibility\s*=\s*['"]?([0-9.]+)['"]?/i) ||
    boundedContent.match(/jvmToolchain\s*\(\s*([0-9]+)\s*\)/i);

  if (jvmMatch && jvmMatch[1]) {
    result.targetJavaVersion = jvmMatch[1].trim();
  }

  // 2. Extract configuration lines: e.g. implementation 'org.springframework.boot:spring-boot-starter-web'
  const depRegex =
    /(?:implementation|api|compileOnly|runtimeOnly|testImplementation)\s*\(?\s*['"]([^'":]+):([^'":]+)(?::[^'"]+)?['"]\s*\)?/g;
  let match;

  while ((match = depRegex.exec(boundedContent)) !== null) {
    const groupId = match[1].trim();
    const artifactId = match[2].trim();
    result.declaredDependencies.push({ groupId, artifactId });
    result.declaredPackages.add(groupId);
    result.declaredPackages.add(artifactId);
  }

  return result;
}

/**
 * Reads supporting build files and aggregates declared external package coordinates.
 *
 * @param {object} supportingFiles
 * @returns {{
 *   declaredPackages: Set<string>,
 *   declaredDependencies: Array<{ groupId: string, artifactId: string }>,
 *   targetJavaVersion: string|null
 * }}
 */
function readBuildMetadata(supportingFiles = {}) {
  const aggregated = {
    declaredPackages: new Set(),
    declaredDependencies: [],
    targetJavaVersion: null,
  };

  if (!supportingFiles || typeof supportingFiles !== "object") {
    return aggregated;
  }

  // Check pom.xml
  if (supportingFiles["pom.xml"]) {
    const pomMeta = parsePomXml(supportingFiles["pom.xml"]);
    pomMeta.declaredPackages.forEach((p) => aggregated.declaredPackages.add(p));
    aggregated.declaredDependencies.push(...pomMeta.declaredDependencies);
    if (pomMeta.targetJavaVersion) {
      aggregated.targetJavaVersion = pomMeta.targetJavaVersion;
    }
  }

  // Check build.gradle / build.gradle.kts
  const gradleContent = supportingFiles["build.gradle"] || supportingFiles["build.gradle.kts"];
  if (gradleContent) {
    const gradleMeta = parseBuildGradle(gradleContent);
    gradleMeta.declaredPackages.forEach((p) => aggregated.declaredPackages.add(p));
    aggregated.declaredDependencies.push(...gradleMeta.declaredDependencies);
    if (!aggregated.targetJavaVersion && gradleMeta.targetJavaVersion) {
      aggregated.targetJavaVersion = gradleMeta.targetJavaVersion;
    }
  }

  return aggregated;
}

module.exports = {
  parsePomXml,
  parseBuildGradle,
  readBuildMetadata,
};


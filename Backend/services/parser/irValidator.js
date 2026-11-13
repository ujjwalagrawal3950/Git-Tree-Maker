/**
 * Cartograph Unified Intermediate Representation (FileIR) Validator.
 * Validates FileIR objects against the constraints of IR_SCHEMA.json (Draft 2020-12, v1.0.0).
 */

const ALLOWED_CATEGORIES = new Set([
  "source",
  "dependency_manifest",
  "configuration",
  "build",
  "schema",
  "documentation",
  "other",
]);

const ALLOWED_PARSER_STATUSES = new Set([
  "complete",
  "partial",
  "unsupported",
  "failed",
  "skipped",
]);

const ALLOWED_CAPABILITIES = new Set([
  "symbols",
  "imports",
  "exports",
  "occurrences",
  "calls",
  "type_references",
  "inheritance",
  "documentation",
]);

const ALLOWED_SYMBOL_KINDS = new Set([
  "module",
  "namespace",
  "class",
  "interface",
  "struct",
  "enum",
  "trait",
  "type_alias",
  "function",
  "method",
  "constructor",
  "property",
  "field",
  "variable",
  "constant",
  "parameter",
  "enum_member",
  "macro",
  "annotation",
  "unknown",
]);

const ALLOWED_DIAGNOSTIC_SEVERITIES = new Set(["error", "warning", "info"]);

const ALLOWED_CALLEE_KINDS = new Set([
  "identifier",
  "member_expression",
  "constructor",
  "function_pointer",
  "operator",
  "other",
]);

const ALLOWED_TYPE_CONTEXTS = new Set([
  "parameter",
  "return",
  "variable",
  "generic_argument",
  "inheritance",
  "cast",
  "annotation",
  "other",
]);

const ALLOWED_INHERITANCE_KINDS = new Set([
  "extends",
  "implements",
  "trait_use",
  "mixin",
  "protocol_conformance",
  "unknown",
]);

/**
 * Validates a normalized source location range.
 *
 * @param {object} loc
 * @param {string} path - Breadcrumb for error reporting
 * @param {string[]} errors - Accumulator
 */
function validateLocation(loc, path, errors) {
  if (!loc || typeof loc !== "object") {
    errors.push(`${path}: must be an object`);
    return;
  }
  if (!loc.start || typeof loc.start !== "object") {
    errors.push(`${path}.start: must be a position object`);
    return;
  }
  if (!loc.end || typeof loc.end !== "object") {
    errors.push(`${path}.end: must be a position object`);
    return;
  }

  const { line: sLine, column: sCol } = loc.start;
  const { line: eLine, column: eCol } = loc.end;

  if (typeof sLine !== "number" || sLine < 1) {
    errors.push(`${path}.start.line: must be integer >= 1`);
  }
  if (typeof sCol !== "number" || sCol < 0) {
    errors.push(`${path}.start.column: must be integer >= 0`);
  }
  if (typeof eLine !== "number" || eLine < 1) {
    errors.push(`${path}.end.line: must be integer >= 1`);
  }
  if (typeof eCol !== "number" || eCol < 0) {
    errors.push(`${path}.end.column: must be integer >= 0`);
  }

  if (typeof sLine === "number" && typeof eLine === "number") {
    if (eLine < sLine || (eLine === sLine && typeof sCol === "number" && typeof eCol === "number" && eCol < sCol)) {
      errors.push(`${path}: end position (${eLine}:${eCol}) cannot precede start position (${sLine}:${sCol})`);
    }
  }
}

/**
 * Validates a FileIR document against the Cartograph IR standard.
 *
 * @param {object} ir - The FileIR object to validate
 * @returns {{ isValid: boolean, errors: string[] }}
 */
function validateFileIR(ir) {
  const errors = [];

  if (!ir || typeof ir !== "object") {
    return { isValid: false, errors: ["FileIR must be a non-null object"] };
  }

  // 1. Version check
  if (ir.irVersion !== "1.0.0") {
    errors.push(`irVersion: expected "1.0.0", received "${ir.irVersion}"`);
  }

  // 2. Analysis & Repository checks
  if (!ir.analysis || typeof ir.analysis !== "object") {
    errors.push("analysis: must be an object");
  } else {
    const { repository, file } = ir.analysis;

    if (!repository || typeof repository !== "object") {
      errors.push("analysis.repository: must be an object");
    } else {
      if (repository.provider !== "github") errors.push(`analysis.repository.provider: expected "github", received "${repository.provider}"`);
      if (typeof repository.owner !== "string" || repository.owner.length === 0) errors.push("analysis.repository.owner: must be a non-empty string");
      if (typeof repository.name !== "string" || repository.name.length === 0) errors.push("analysis.repository.name: must be a non-empty string");
      if (typeof repository.fullName !== "string" || repository.fullName.length < 3) errors.push("analysis.repository.fullName: must be a string of length >= 3");
      if (typeof repository.commitSha !== "string" || repository.commitSha.length < 7) errors.push("analysis.repository.commitSha: must be a string of length >= 7");
    }

    if (!file || typeof file !== "object") {
      errors.push("analysis.file: must be an object");
    } else {
      if (typeof file.fileId !== "string" || file.fileId.length === 0) errors.push("analysis.file.fileId: must be a non-empty string");
      if (typeof file.path !== "string" || file.path.length === 0) errors.push("analysis.file.path: must be a non-empty string");
      if (typeof file.blobSha !== "string" || file.blobSha.length === 0) errors.push("analysis.file.blobSha: must be a non-empty string");
      if (typeof file.language !== "string" || file.language.length === 0) errors.push("analysis.file.language: must be a non-empty string");
      if (!ALLOWED_CATEGORIES.has(file.category)) errors.push(`analysis.file.category: invalid category "${file.category}"`);
      if (typeof file.sizeBytes !== "number" || file.sizeBytes < 0) errors.push("analysis.file.sizeBytes: must be an integer >= 0");
    }
  }

  // 3. Parser checks
  if (!ir.parser || typeof ir.parser !== "object") {
    errors.push("parser: must be an object");
  } else {
    const p = ir.parser;
    if (typeof p.adapterId !== "string" || p.adapterId.length === 0) errors.push("parser.adapterId: must be a non-empty string");
    if (typeof p.adapterVersion !== "string" || p.adapterVersion.length === 0) errors.push("parser.adapterVersion: must be a non-empty string");
    if (typeof p.engine !== "string" || p.engine.length === 0) errors.push("parser.engine: must be a non-empty string");
    if (typeof p.engineVersion !== "string" || p.engineVersion.length === 0) errors.push("parser.engineVersion: must be a non-empty string");
    if (!ALLOWED_PARSER_STATUSES.has(p.status)) errors.push(`parser.status: invalid status "${p.status}"`);
    if (!Array.isArray(p.capabilities)) {
      errors.push("parser.capabilities: must be an array");
    } else {
      for (const cap of p.capabilities) {
        if (!ALLOWED_CAPABILITIES.has(cap)) errors.push(`parser.capabilities: invalid capability "${cap}"`);
      }
    }
    if (typeof p.durationMs !== "number" || p.durationMs < 0) errors.push("parser.durationMs: must be a number >= 0");
  }

  // 4. Arrays checks
  const arrayFields = ["symbols", "imports", "exports", "occurrences", "callSites", "typeReferences", "inheritance", "diagnostics"];
  for (const field of arrayFields) {
    if (!Array.isArray(ir[field])) {
      errors.push(`${field}: must be an array`);
    }
  }

  // Validate symbols
  if (Array.isArray(ir.symbols)) {
    ir.symbols.forEach((sym, idx) => {
      const p = `symbols[${idx}]`;
      if (!sym || typeof sym !== "object") {
        errors.push(`${p}: must be an object`);
        return;
      }
      if (typeof sym.id !== "string" || sym.id.length === 0) errors.push(`${p}.id: must be a non-empty string`);
      if (typeof sym.name !== "string" || sym.name.length === 0) errors.push(`${p}.name: must be a non-empty string`);
      if (!ALLOWED_SYMBOL_KINDS.has(sym.kind)) errors.push(`${p}.kind: invalid kind "${sym.kind}"`);
      validateLocation(sym.location, `${p}.location`, errors);
      if (sym.nameLocation) validateLocation(sym.nameLocation, `${p}.nameLocation`, errors);
    });
  }

  // Validate diagnostics
  if (Array.isArray(ir.diagnostics)) {
    ir.diagnostics.forEach((diag, idx) => {
      const p = `diagnostics[${idx}]`;
      if (!diag || typeof diag !== "object") {
        errors.push(`${p}: must be an object`);
        return;
      }
      if (typeof diag.code !== "string" || diag.code.length === 0) errors.push(`${p}.code: must be a non-empty string`);
      if (!ALLOWED_DIAGNOSTIC_SEVERITIES.has(diag.severity)) errors.push(`${p}.severity: invalid severity "${diag.severity}"`);
      if (typeof diag.message !== "string" || diag.message.length === 0) errors.push(`${p}.message: must be a non-empty string`);
      if (diag.location) validateLocation(diag.location, `${p}.location`, errors);
    });
  }

  // Validate callSites
  if (Array.isArray(ir.callSites)) {
    ir.callSites.forEach((call, idx) => {
      const p = `callSites[${idx}]`;
      if (!call || typeof call !== "object") {
        errors.push(`${p}: must be an object`);
        return;
      }
      if (typeof call.id !== "string" || call.id.length === 0) errors.push(`${p}.id: must be a non-empty string`);
      if (typeof call.calleeText !== "string" || call.calleeText.length === 0) errors.push(`${p}.calleeText: must be a non-empty string`);
      if (!ALLOWED_CALLEE_KINDS.has(call.calleeKind)) errors.push(`${p}.calleeKind: invalid kind "${call.calleeKind}"`);
      validateLocation(call.location, `${p}.location`, errors);
    });
  }

  // Validate typeReferences
  if (Array.isArray(ir.typeReferences)) {
    ir.typeReferences.forEach((ref, idx) => {
      const p = `typeReferences[${idx}]`;
      if (!ref || typeof ref !== "object") {
        errors.push(`${p}: must be an object`);
        return;
      }
      if (typeof ref.id !== "string" || ref.id.length === 0) errors.push(`${p}.id: must be a non-empty string`);
      if (typeof ref.text !== "string" || ref.text.length === 0) errors.push(`${p}.text: must be a non-empty string`);
      if (!ALLOWED_TYPE_CONTEXTS.has(ref.context)) errors.push(`${p}.context: invalid context "${ref.context}"`);
      validateLocation(ref.location, `${p}.location`, errors);
    });
  }

  // Validate inheritance
  if (Array.isArray(ir.inheritance)) {
    ir.inheritance.forEach((inh, idx) => {
      const p = `inheritance[${idx}]`;
      if (!inh || typeof inh !== "object") {
        errors.push(`${p}: must be an object`);
        return;
      }
      if (typeof inh.id !== "string" || inh.id.length === 0) errors.push(`${p}.id: must be a non-empty string`);
      if (typeof inh.targetText !== "string" || inh.targetText.length === 0) errors.push(`${p}.targetText: must be a non-empty string`);
      if (!ALLOWED_INHERITANCE_KINDS.has(inh.kind)) errors.push(`${p}.kind: invalid kind "${inh.kind}"`);
      validateLocation(inh.location, `${p}.location`, errors);
    });
  }

  // 5. Stats checks
  if (!ir.stats || typeof ir.stats !== "object") {
    errors.push("stats: must be an object");
  } else {
    const s = ir.stats;
    const statProps = ["lines", "symbols", "imports", "exports", "occurrences", "callSites", "typeReferences"];
    for (const prop of statProps) {
      if (typeof s[prop] !== "number" || s[prop] < 0) {
        errors.push(`stats.${prop}: must be an integer >= 0`);
      }
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

module.exports = {
  validateFileIR,
  validateLocation,
  ALLOWED_CATEGORIES,
  ALLOWED_PARSER_STATUSES,
  ALLOWED_CAPABILITIES,
  ALLOWED_SYMBOL_KINDS,
};


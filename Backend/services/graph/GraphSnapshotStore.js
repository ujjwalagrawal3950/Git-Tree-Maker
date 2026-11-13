/**
 * Cartograph Unified Graph Snapshot Store & In-Memory Cache Manager.
 *
 * Manages the lifecycle of immutable Graph Snapshots and their corresponding
 * indexed GraphQueryService instances with strict memory bounds and deterministic LRU eviction.
 *
 * Cache keys are strictly 5-dimensional:
 *   cartograph:graph:${repositoryId}:${commitSha}:bld_${builderVersion}:ir_${fileIrVersion}:rf_${resolverFingerprint}
 *
 * Enforces:
 * - Maximum cache entries bound with deterministic LRU eviction.
 * - Explicit index release on eviction to guarantee GC reclamation.
 * - Active revision metadata consistency.
 * - Strict multi-tenant isolation: repositories bound to their authorized organization context.
 */

const { AppError } = require("../../lib/errors");
const { computeGraphCacheKey, computeResolverFingerprint } = require("./identity");
const { GraphValidator } = require("./GraphValidator");
const { GraphQueryService } = require("./GraphQueryService");

const DEFAULT_MAX_CACHE_ENTRIES = 20;

class GraphSnapshotStore {
  /**
   * @param {object} [options]
   * @param {number} [options.maxEntries=20] - Maximum snapshots retained in memory
   */
  constructor(options = {}) {
    this.maxEntries = Math.max(1, parseInt(options.maxEntries, 10) || DEFAULT_MAX_CACHE_ENTRIES);
    // cacheKey -> { snapshot, queryService, cacheKey, repositoryId, commitSha, organizationId, accessSeq, lastAccessedAt }
    this.cache = new Map();
    // repositoryId -> latestCommitSha
    this.activeRevisions = new Map();
    // repositoryId -> organizationId (Tenant ownership tracking)
    this.repoTenants = new Map();
    this.accessCounter = 0;
  }

  /**
   * Binds a repository to an organization context.
   *
   * @param {string} repositoryId
   * @param {string} organizationId
   */
  bindRepositoryToOrganization(repositoryId, organizationId) {
    if (!repositoryId || !organizationId) return;
    this.repoTenants.set(repositoryId, organizationId);
  }

  /**
   * Returns the organization ID owning a repository, or null if unbound.
   *
   * @param {string} repositoryId
   * @returns {string|null}
   */
  getRepositoryOrganization(repositoryId) {
    return this.repoTenants.get(repositoryId) || null;
  }

  /**
   * Verifies that a repository belongs to the authorized organization context.
   * Throws 403 TENANT_ACCESS_DENIED if repository belongs to another tenant.
   *
   * @param {string} repositoryId
   * @param {string} organizationId
   */
  verifyRepositoryAccess(repositoryId, organizationId) {
    if (!repositoryId || !organizationId) {
      throw new AppError(400, "INVALID_TENANT_CONTEXT", "repositoryId and organizationId are required");
    }

    const boundOrg = this.repoTenants.get(repositoryId);
    if (boundOrg && boundOrg !== organizationId) {
      throw new AppError(
        403,
        "TENANT_ACCESS_DENIED",
        `Access denied: Repository '${repositoryId}' belongs to a different organization.`
      );
    }
  }

  /**
   * Explicitly releases query-service indexes and dereferences snapshot memory.
   *
   * @param {object} entry
   * @private
   */
  _releaseEntry(entry) {
    if (!entry) return;

    if (entry.queryService) {
      if (entry.queryService.nodeMap) entry.queryService.nodeMap.clear();
      if (entry.queryService.outgoingIndex) entry.queryService.outgoingIndex.clear();
      if (entry.queryService.incomingIndex) entry.queryService.incomingIndex.clear();
      if (entry.queryService.edgeMap) entry.queryService.edgeMap.clear();
      if (entry.queryService.typeIndex) entry.queryService.typeIndex.clear();
      if (entry.queryService.fileNodesByPath) entry.queryService.fileNodesByPath.clear();
      if (entry.queryService.symbolsByFilePath) entry.queryService.symbolsByFilePath.clear();
      entry.queryService.nodes = [];
      entry.queryService.edges = [];
      entry.queryService.unresolvedReferences = [];
      entry.queryService.diagnostics = [];
      entry.queryService.snapshot = null;
      entry.queryService = null;
    }

    entry.snapshot = null;
  }

  /**
   * Performs deterministic LRU eviction if cache exceeds maxEntries.
   *
   * @private
   */
  _evictLruIfNeeded() {
    while (this.cache.size >= this.maxEntries) {
      let oldestKey = null;
      let lowestSeq = Infinity;

      for (const [key, entry] of this.cache.entries()) {
        if (entry.accessSeq < lowestSeq) {
          lowestSeq = entry.accessSeq;
          oldestKey = key;
        }
      }

      if (!oldestKey) break;

      const evicted = this.cache.get(oldestKey);
      this.cache.delete(oldestKey);
      this._releaseEntry(evicted);

      // Reconcile active revision metadata to prevent stale pointers
      if (evicted && this.activeRevisions.get(evicted.repositoryId) === evicted.commitSha) {
        let remainingCommit = null;
        let highestSeq = -1;

        for (const entry of this.cache.values()) {
          if (entry.repositoryId === evicted.repositoryId && entry.accessSeq > highestSeq) {
            highestSeq = entry.accessSeq;
            remainingCommit = entry.commitSha;
          }
        }

        if (remainingCommit) {
          this.activeRevisions.set(evicted.repositoryId, remainingCommit);
        } else {
          this.activeRevisions.delete(evicted.repositoryId);
        }
      }
    }
  }

  /**
   * Validates and stores a Graph Snapshot, building its secondary query index.
   *
   * @param {object} snapshot - Validated Graph Snapshot
   * @param {object} [options]
   * @param {string} [options.organizationId] - Owning organization ID
   * @returns {{ cacheKey: string, queryService: GraphQueryService, snapshot: object }}
   */
  put(snapshot, options = {}) {
    if (!snapshot || typeof snapshot !== "object") {
      throw new Error("GraphSnapshotStore.put requires a valid snapshot object");
    }

    // 1. Enforce Graph Integrity
    const validation = GraphValidator.validate(snapshot);
    if (!validation.isValid) {
      const err = new Error(`Cannot store invalid graph snapshot: ${validation.errors.join("; ")}`);
      err.code = "INVALID_GRAPH_SNAPSHOT";
      err.validationErrors = validation.errors;
      throw err;
    }

    const repositoryId = snapshot.repository.repositoryId;
    const commitSha = snapshot.revision.commitSha;
    const organizationId =
      options.organizationId ||
      snapshot.organizationId ||
      (snapshot.repository && snapshot.repository.organizationId) ||
      null;

    // 2. Validate tenant tenancy if already bound
    if (organizationId) {
      this.verifyRepositoryAccess(repositoryId, organizationId);
      this.bindRepositoryToOrganization(repositoryId, organizationId);
    }

    const builderVersion = snapshot.builder ? snapshot.builder.version : "1.0.0";
    const fileIrVersion = snapshot.builder ? snapshot.builder.fileIrVersion : "1.0.0";
    const resolverFingerprint =
      (snapshot.builder && snapshot.builder.resolverFingerprint) || computeResolverFingerprint();

    // 3. 5-Dimensional Deterministic Cache Key
    const cacheKey = computeGraphCacheKey({
      repositoryId,
      commitSha,
      builderVersion,
      fileIrVersion,
      resolverFingerprint,
    });

    // 4. Bound Cache Size before inserting new entry
    if (!this.cache.has(cacheKey)) {
      this._evictLruIfNeeded();
    }

    // 5. Build Indexed Query Service
    const queryService = new GraphQueryService(snapshot);
    const now = Date.now();

    const entry = {
      cacheKey,
      repositoryId,
      commitSha,
      organizationId,
      snapshot,
      queryService,
      cachedAt: new Date(now).toISOString(),
      lastAccessedAt: now,
      accessSeq: ++this.accessCounter,
    };

    this.cache.set(cacheKey, entry);
    this.activeRevisions.set(repositoryId, commitSha);

    return {
      cacheKey,
      queryService,
      snapshot,
    };
  }

  /**
   * Retrieves a cached snapshot and its query service.
   *
   * Enforces:
   * - Strict organization matching if organizationId is passed.
   * - Strict commitSha matching: if a specific commitSha is requested, it matches ONLY
   *   that exact commit and NEVER falls back to another revision.
   * - Updates LRU access tracking.
   *
   * @param {object} params
   * @param {string} params.repositoryId
   * @param {string} [params.commitSha] - If omitted, uses active revision; if provided, matches ONLY this commit
   * @param {string} [params.organizationId] - Tenant context to enforce
   * @param {string} [params.builderVersion="1.0.0"]
   * @param {string} [params.fileIrVersion="1.0.0"]
   * @param {string} [params.resolverFingerprint]
   * @returns {{ cacheKey: string, queryService: GraphQueryService, snapshot: object }|null}
   */
  get({
    repositoryId,
    commitSha = null,
    organizationId = null,
    builderVersion = "1.0.0",
    fileIrVersion = "1.0.0",
    resolverFingerprint = null,
  }) {
    if (!repositoryId) return null;

    // Tenant check
    if (organizationId) {
      const boundOrg = this.repoTenants.get(repositoryId);
      if (boundOrg && boundOrg !== organizationId) {
        return null;
      }
    }

    const targetSha = commitSha || this.activeRevisions.get(repositoryId);
    if (!targetSha) return null;

    const fingerprint = resolverFingerprint || computeResolverFingerprint();
    const cacheKey = computeGraphCacheKey({
      repositoryId,
      commitSha: targetSha,
      builderVersion,
      fileIrVersion,
      resolverFingerprint: fingerprint,
    });

    let entry = this.cache.get(cacheKey);

    // Secondary scan by (repositoryId, commitSha) if fingerprint differed
    if (!entry) {
      for (const candidate of this.cache.values()) {
        if (candidate.repositoryId === repositoryId && candidate.commitSha === targetSha) {
          entry = candidate;
          break;
        }
      }
    }

    if (!entry) return null;

    // Strict commit check: if commitSha was requested, verify exact match
    if (commitSha && entry.commitSha !== commitSha) {
      return null;
    }

    // Strict tenant check: verify organization matches
    if (organizationId && entry.organizationId && entry.organizationId !== organizationId) {
      return null;
    }

    // Update LRU tracking
    entry.lastAccessedAt = Date.now();
    entry.accessSeq = ++this.accessCounter;

    return entry;
  }

  /**
   * Checks whether a snapshot is cached for the given repository and revision.
   *
   * @param {object} params
   * @returns {boolean}
   */
  has(params) {
    return Boolean(this.get(params));
  }

  /**
   * Evicts cached snapshots.
   *
   * @param {string} [repositoryId] - If provided, clears only that repository; otherwise clears all
   */
  clear(repositoryId = null) {
    if (!repositoryId) {
      for (const entry of this.cache.values()) {
        this._releaseEntry(entry);
      }
      this.cache.clear();
      this.activeRevisions.clear();
      this.repoTenants.clear();
      return;
    }

    this.activeRevisions.delete(repositoryId);
    this.repoTenants.delete(repositoryId);

    for (const [key, entry] of this.cache.entries()) {
      if (entry.repositoryId === repositoryId) {
        this.cache.delete(key);
        this._releaseEntry(entry);
      }
    }
  }

  /**
   * Returns total number of cached snapshots in memory.
   *
   * @returns {number}
   */
  size() {
    return this.cache.size;
  }

  /**
   * Lists all cached commit SHAs for a repository.
   *
   * @param {string} repositoryId
   * @returns {string[]}
   */
  listRevisions(repositoryId) {
    const shas = new Set();
    for (const entry of this.cache.values()) {
      if (entry.repositoryId === repositoryId) {
        shas.add(entry.commitSha);
      }
    }
    return Array.from(shas);
  }
}

// Default singleton store (20 snapshots max in-memory capacity)
const defaultStore = new GraphSnapshotStore({ maxEntries: 20 });

module.exports = {
  GraphSnapshotStore,
  defaultStore,
  DEFAULT_MAX_CACHE_ENTRIES,
};

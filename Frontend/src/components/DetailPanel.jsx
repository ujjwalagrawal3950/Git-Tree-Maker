import { useMemo } from 'react'
import { getKindMeta } from '../lib/kinds'
import { calculateImpactRadius } from '../lib/architecturalIntelligence'
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CloseIcon,
} from './Icons'

function DependencyList({ items, direction, onSelectNode }) {
  if (!items || items.length === 0) {
    return <p className="dep-empty">None</p>
  }

  return (
    <div className="dep-list">
      {items.map((item) => {
        const id = typeof item === 'string' ? item : item.id
        const label = typeof item === 'string' ? item : item.label || item.name || item.path || item.id
        const sub = typeof item === 'object' && item.type ? `(${item.type})` : ''

        return (
          <button
            key={id}
            type="button"
            className={`dep-item dep-item--${direction}`}
            title={id}
            onClick={() => onSelectNode(id)}
          >
            <span className="dep-item__arrow">
              {direction === 'outgoing' ? (
                <ArrowRightIcon />
              ) : (
                <ArrowLeftIcon />
              )}
            </span>
            <span className="dep-item__path">
              {label} {sub}
            </span>
          </button>
        )
      })}
    </div>
  )
}

export default function DetailPanel({
  repository,
  // Backend canonical node props
  backendNode,
  manifestFile,
  incomingEdges = [],
  outgoingEdges = [],
  isLoadingDetails,
  onExpandNeighborhood,

  // Mock compatibility props
  file,
  neighbours,
  fileMap,

  onSelectNode,
  onSelectFile,
  onClose,
}) {
  const isBackend = Boolean(backendNode || manifestFile)
  const selectHandler = onSelectNode || onSelectFile

  const canonicalId = isBackend
    ? backendNode?.id || manifestFile?.id || (manifestFile?.path || backendNode?.data?.path)
    : file?.id

  const impactAnalysis = useMemo(() => {
    if (!repository || !canonicalId) return null
    return calculateImpactRadius(canonicalId, repository, null, {
      maxDepth: 5,
      maxNodes: 100,
    })
  }, [repository, canonicalId])

  if (!isBackend && !file) return null

  // If using backend or manifest file node
  if (isBackend) {
    const rawData = backendNode?.data || backendNode || {}
    const data = manifestFile ? { ...rawData, ...manifestFile } : rawData
    const nodeType = backendNode?.type || data.rawType || 'file'
    const name = manifestFile?.name || data.label || data.name || data.path || backendNode?.id || 'File'
    const qualifiedName = data.qualifiedName
    const path = manifestFile?.path || data.path
    const kind = manifestFile?.kind || data.kind || data.language || nodeType
    const meta = getKindMeta(kind)
    const isParsed = manifestFile ? Boolean(manifestFile.isParsed) : true
    const symbols = manifestFile?.symbols || data.symbols || []
    const sizeBytes = manifestFile?.sizeBytes || data.sizeBytes || 0
    const canonicalId = backendNode?.id || manifestFile?.id || path

    const outgoingTargets = outgoingEdges.map((e) => ({
      id: e.target,
      label: e.targetNode ? e.targetNode.name || e.targetNode.path || e.target : e.target,
      type: e.data?.edgeType || e.type,
    }))

    const incomingSources = incomingEdges.map((e) => ({
      id: e.source,
      label: e.sourceNode ? e.sourceNode.name || e.sourceNode.path || e.source : e.source,
      type: e.data?.edgeType || e.type,
    }))

    return (
      <aside className="detail-panel" aria-label="Node details">
        <div className="detail-header">
          <div className="detail-title-row">
            <span className="kind-badge" style={{ '--kind': meta.color }}>
              <span className="kind-dot" />
              {meta.label}
            </span>
            {manifestFile && (
              <span
                className={`detail-status-pill ${isParsed ? 'status-parsed' : 'status-unparsed'}`}
              >
                {isParsed ? 'Parsed' : 'Unparsed'}
              </span>
            )}
            <button
              type="button"
              className="icon-button detail-close"
              aria-label="Close details"
              title="Close details"
              onClick={onClose}
            >
              <CloseIcon />
            </button>
          </div>
          <div className="detail-name" style={{ wordBreak: 'break-all' }}>{name}</div>
          {path && <div className="detail-path" style={{ wordBreak: 'break-all' }}>{path}</div>}
          {qualifiedName && qualifiedName !== name && (
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px', wordBreak: 'break-all' }}>
              {qualifiedName}
            </div>
          )}
        </div>

        {!isParsed && (
          <div className="detail-unparsed-banner">
            <p className="detail-unparsed-text">
              {kind === 'doc'
                ? 'Documentation file — preserved in repository hierarchy without code AST analysis.'
                : kind === 'config'
                ? 'Configuration manifest — preserved in repository hierarchy without code AST analysis.'
                : 'Repository file — not analyzed for code declarations or dependencies.'}
            </p>
          </div>
        )}

        {isParsed && (
          <div className="detail-stats">
            <div className="stat-box">
              <div className="stat-box__value">{outgoingTargets.length}</div>
              <div className="stat-box__label">Fan-out</div>
            </div>
            <div className="stat-box">
              <div className="stat-box__value">{incomingSources.length}</div>
              <div className="stat-box__label">Fan-in</div>
            </div>
          </div>
        )}

        {/* Blast Radius / Impact Analysis Card */}
        {impactAnalysis && impactAnalysis.totalAffectedCount > 0 && (
          <div className="detail-impact-card">
            <div className="detail-impact-header">
              <span className="detail-impact-title">Blast Radius</span>
              <span className="detail-impact-badge">
                {impactAnalysis.isLowerBound ? `≥ ${impactAnalysis.blastRadiusPercentage}% (lower bound)` : `${impactAnalysis.blastRadiusPercentage}% of repo`}
              </span>
            </div>
            <div className="detail-impact-bar-track">
              <div
                className="detail-impact-bar-fill"
                style={{
                  width: `${Math.max(6, Math.min(100, impactAnalysis.blastRadiusPercentage))}%`,
                }}
              />
            </div>
            <div className="detail-impact-desc">
              Modifying this file {impactAnalysis.isLowerBound ? 'impacts at least' : 'directly impacts'} <strong>{impactAnalysis.totalAffectedCount}</strong> downstream {impactAnalysis.totalAffectedCount === 1 ? 'file' : 'files'} ({impactAnalysis.analyzedCodePercentage}% of analyzed code, {impactAnalysis.blastRadiusPercentage}% of all files) across <strong>{impactAnalysis.maxDepthReached}</strong> caller {impactAnalysis.maxDepthReached === 1 ? 'level' : 'levels'}.
            </div>
            {impactAnalysis.truncated && (
              <div className="detail-impact-sub" style={{ color: '#f59e0b', fontWeight: 600 }}>
                ⚠ Incomplete result: bounded by {impactAnalysis.truncationReason === 'max_depth_exceeded' ? `depth limit (${impactAnalysis.maxDepthReached} levels)` : 'node limit'}. True blast radius may be larger.
              </div>
            )}
            {impactAnalysis.cyclesDetected && (
              <div className="detail-impact-sub">
                Cyclic dependencies detected in downstream chain.
              </div>
            )}
          </div>
        )}

        {/* Declared Symbols Section */}
        {symbols.length > 0 && (
          <section className="detail-section">
            <div className="detail-section__head">
              <span className="detail-section__title">Declared Symbols</span>
              <span className="detail-section__count">{symbols.length}</span>
            </div>
            <div className="detail-symbol-list">
              {symbols.map((sym) => {
                const symMeta = getKindMeta(sym.kind || 'symbol')
                return (
                  <div key={sym.id} className="detail-symbol-item" title={sym.id}>
                    <span className="detail-symbol-badge" style={{ '--kind': symMeta.color }}>
                      <span className="kind-dot" />
                      {symMeta.label}
                    </span>
                    <span className="detail-symbol-name">{sym.name}</span>
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {isParsed && onExpandNeighborhood && backendNode && (
          <div style={{ padding: '0 16px 12px 16px' }}>
            <button
              type="button"
              onClick={() => onExpandNeighborhood(backendNode.id)}
              style={{
                width: '100%',
                padding: '6px 12px',
                fontSize: '11px',
                fontWeight: 600,
                borderRadius: '4px',
                border: '1px solid var(--brand, #38bdf8)',
                background: 'var(--brand-muted, rgba(56, 189, 248, 0.15))',
                color: 'var(--brand, #38bdf8)',
                cursor: 'pointer',
              }}
            >
              Expand Neighborhood (1-hop)
            </button>
          </div>
        )}

        {isLoadingDetails && (
          <div style={{ padding: '12px 16px', fontSize: '11px', color: 'var(--text-muted)' }}>
            Updating node relationships...
          </div>
        )}

        {isParsed && (
          <>
            <section className="detail-section">
              <div className="detail-section__head">
                <span className="detail-section__title">Outgoing Dependencies</span>
                <span className="detail-section__count">
                  {outgoingTargets.length}
                </span>
              </div>
              <DependencyList
                items={outgoingTargets}
                direction="outgoing"
                onSelectNode={selectHandler}
              />
            </section>

            <section className="detail-section">
              <div className="detail-section__head">
                <span className="detail-section__title">Incoming Dependents</span>
                <span className="detail-section__count">
                  {incomingSources.length}
                </span>
              </div>
              <DependencyList
                items={incomingSources}
                direction="incoming"
                onSelectNode={selectHandler}
              />
            </section>
          </>
        )}

        <div style={{ padding: '16px', borderTop: '1px solid var(--border)', fontSize: '10px', color: 'var(--text-faint)' }}>
          <div><strong>Canonical ID:</strong></div>
          <div style={{ fontFamily: 'var(--font-mono, monospace)', wordBreak: 'break-all', marginTop: '2px' }}>
            {canonicalId}
          </div>
          {sizeBytes > 0 && (
            <div style={{ marginTop: '6px' }}>
              <strong>Size:</strong> {(sizeBytes / 1024).toFixed(1)} KB ({sizeBytes} bytes)
            </div>
          )}
        </div>
      </aside>
    )
  }

  // Fallback for mock file mode
  const meta = getKindMeta(file.kind)

  return (
    <aside className="detail-panel" aria-label="File details">
      <div className="detail-header">
        <div className="detail-title-row">
          <span className="kind-badge" style={{ '--kind': meta.color }}>
            <span className="kind-dot" />
            {meta.label}
          </span>
          <button
            type="button"
            className="icon-button detail-close"
            aria-label="Close file details"
            title="Close file details"
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </div>
        <div className="detail-name">{file.name}</div>
        <div className="detail-path">{file.path}</div>
      </div>

      <div className="detail-stats">
        <div className="stat-box">
          <div className="stat-box__value">{neighbours.imports.length}</div>
          <div className="stat-box__label">Fan-out</div>
        </div>
        <div className="stat-box">
          <div className="stat-box__value">{neighbours.importedBy.length}</div>
          <div className="stat-box__label">Fan-in</div>
        </div>
      </div>

      {/* Blast Radius / Impact Analysis Card */}
      {impactAnalysis && impactAnalysis.totalAffectedCount > 0 && (
        <div className="detail-impact-card">
          <div className="detail-impact-header">
            <span className="detail-impact-title">Blast Radius</span>
            <span className="detail-impact-badge">
              {impactAnalysis.isLowerBound ? `≥ ${impactAnalysis.blastRadiusPercentage}% (lower bound)` : `${impactAnalysis.blastRadiusPercentage}% of repo`}
            </span>
          </div>
          <div className="detail-impact-bar-track">
            <div
              className="detail-impact-bar-fill"
              style={{
                width: `${Math.max(6, Math.min(100, impactAnalysis.blastRadiusPercentage))}%`,
              }}
            />
          </div>
          <div className="detail-impact-desc">
            Modifying this file {impactAnalysis.isLowerBound ? 'impacts at least' : 'directly impacts'} <strong>{impactAnalysis.totalAffectedCount}</strong> downstream {impactAnalysis.totalAffectedCount === 1 ? 'file' : 'files'} ({impactAnalysis.analyzedCodePercentage}% of analyzed code, {impactAnalysis.blastRadiusPercentage}% of all files) across <strong>{impactAnalysis.maxDepthReached}</strong> caller {impactAnalysis.maxDepthReached === 1 ? 'level' : 'levels'}.
          </div>
          {impactAnalysis.truncated && (
            <div className="detail-impact-sub" style={{ color: '#f59e0b', fontWeight: 600 }}>
              ⚠ Incomplete result: bounded by {impactAnalysis.truncationReason === 'max_depth_exceeded' ? `depth limit (${impactAnalysis.maxDepthReached} levels)` : 'node limit'}. True blast radius may be larger.
            </div>
          )}
          {impactAnalysis.cyclesDetected && (
            <div className="detail-impact-sub">
              Cyclic dependencies detected in downstream chain.
            </div>
          )}
        </div>
      )}

      <section className="detail-section">
        <div className="detail-section__head">
          <span className="detail-section__title">Imports</span>
          <span className="detail-section__count">
            {neighbours.imports.length}
          </span>
        </div>
        <DependencyList
          items={neighbours.imports.map((id) => ({ id, label: fileMap?.get(id)?.path ?? id }))}
          direction="outgoing"
          onSelectNode={selectHandler}
        />
      </section>

      <section className="detail-section">
        <div className="detail-section__head">
          <span className="detail-section__title">Imported by</span>
          <span className="detail-section__count">
            {neighbours.importedBy.length}
          </span>
        </div>
        <DependencyList
          items={neighbours.importedBy.map((id) => ({ id, label: fileMap?.get(id)?.path ?? id }))}
          direction="incoming"
          onSelectNode={selectHandler}
        />
      </section>

      <p className="detail-note">
        This panel is arithmetic over the sample edge list. No request was made.
      </p>
    </aside>
  )
}

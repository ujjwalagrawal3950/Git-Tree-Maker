import { getKindMeta } from '../lib/kinds'
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
  // Backend canonical node props
  backendNode,
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
  const isBackend = Boolean(backendNode)
  const selectHandler = onSelectNode || onSelectFile

  if (!isBackend && !file) return null

  // If using backend node
  if (isBackend) {
    const data = backendNode.data || backendNode
    const nodeType = backendNode.type || data.rawType || 'file'
    const name = data.label || data.name || data.path || backendNode.id
    const qualifiedName = data.qualifiedName
    const path = data.path
    const kind = data.kind || data.language || nodeType
    const meta = getKindMeta(kind)

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

        {onExpandNeighborhood && (
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

        <div style={{ padding: '16px', borderTop: '1px solid var(--border)', fontSize: '10px', color: 'var(--text-faint)' }}>
          <div><strong>Canonical ID:</strong></div>
          <div style={{ fontFamily: 'var(--font-mono, monospace)', wordBreak: 'break-all', marginTop: '2px' }}>
            {backendNode.id}
          </div>
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

import { useMemo } from 'react'
import { KIND_ORDER, getKindMeta } from '../lib/kinds'
import {
  buildTopologyMaps,
  identifyEntryPoints,
  identifyHubs,
} from '../lib/architecturalIntelligence'
import { deriveDirectoryHierarchy } from '../lib/repositoryGraph'

export default function LeftRail({
  repository,
  folderCount,
  onNavigateToItem,
  onSelectFile,
}) {
  const topology = useMemo(() => buildTopologyMaps(repository), [repository])
  const hubs = useMemo(
    () => identifyHubs(repository, topology).slice(0, 5),
    [repository, topology],
  )
  const entryPoints = useMemo(
    () => identifyEntryPoints(repository, topology),
    [repository, topology],
  )
  const subsystemEdges = useMemo(() => {
    try {
      const hierarchy = deriveDirectoryHierarchy(repository)
      return (hierarchy?.folderEdges || []).slice(0, 8)
    } catch {
      return []
    }
  }, [repository])

  const handleItemClick = (fileId, name, path) => {
    if (typeof onNavigateToItem === 'function') {
      onNavigateToItem({
        type: 'file',
        id: fileId,
        name: name || fileId.split('/').pop() || fileId,
        path: path || fileId,
      })
    } else if (typeof onSelectFile === 'function') {
      onSelectFile(fileId)
    }
  }

  return (
    <aside className="left-rail" aria-label="Repository overview">
      <section className="rail-section">
        <div className="rail-label">Repository</div>
        <div className="repo-heading">
          <span className="repo-name">{repository.name}</span>
          <span className="badge-sample">{repository.isLive ? 'Live' : 'Sample'}</span>
        </div>
        <div className="repo-branch">
          <span className="repo-branch__dot" />
          <span>{repository.branch}</span>
        </div>

        <div className="stat-grid">
          <div className="stat-box">
            <div className="stat-box__value">{repository.files.length}</div>
            <div className="stat-box__label">Files</div>
          </div>
          <div className="stat-box">
            <div className="stat-box__value">{repository.edges.length}</div>
            <div className="stat-box__label">Edges</div>
          </div>
          <div className="stat-box">
            <div className="stat-box__value">{folderCount}</div>
            <div className="stat-box__label">Folders</div>
          </div>
        </div>
      </section>

      {/* Architectural Hubs */}
      {hubs.length > 0 && (
        <section className="rail-section">
          <div className="rail-label">Architectural Hubs</div>
          <div className="rail-hub-list">
            {hubs.map((hub) => (
              <button
                key={hub.fileId}
                type="button"
                className="rail-hub-btn"
                title={`${hub.path} — in-degree: ${hub.inDegree}, out-degree: ${hub.outDegree} (${hub.role})`}
                onClick={() => handleItemClick(hub.fileId, hub.name, hub.path)}
              >
                <span className="rail-hub-name">{hub.name}</span>
                <span className="rail-hub-badge">
                  {hub.inDegree} in · {hub.role.replace('_', ' ')}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Entry Points & Candidates */}
      {entryPoints.all.length > 0 && (
        <section className="rail-section">
          <div className="rail-label">Entry Points</div>
          <div className="rail-entry-list">
            {entryPoints.all.slice(0, 5).map((entry) => (
              <button
                key={entry.fileId}
                type="button"
                className="rail-entry-btn"
                title={`${entry.path} (${entry.reason}) — ${entry.outDegree} outgoing imports`}
                onClick={() => handleItemClick(entry.fileId, entry.name, entry.path)}
              >
                <span className="rail-entry-name">{entry.name}</span>
                <span
                  className={`rail-entry-badge rail-entry-badge--${entry.type}`}
                >
                  {entry.type === 'verified' ? 'Verified' : 'Candidate'}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Subsystem Communication Flow */}
      {subsystemEdges.length > 0 && (
        <section className="rail-section">
          <div className="rail-label">Subsystem Communication</div>
          <div className="rail-subsystem-list" style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {subsystemEdges.map((channel) => (
              <div
                key={`${channel.source}->${channel.target}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '5px 8px',
                  background: '#131b2e',
                  border: '1px solid #1e293b',
                  borderRadius: '5px',
                  fontSize: '11px',
                }}
                title={`${channel.source} to ${channel.target}: ${channel.count} canonical dependencies`}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '5px', overflow: 'hidden' }}>
                  <span
                    style={{
                      fontFamily: 'var(--font-mono, monospace)',
                      color: '#cbd5e1',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {channel.source}
                  </span>
                  <span style={{ color: '#6366f1' }}>→</span>
                  <span
                    style={{
                      fontFamily: 'var(--font-mono, monospace)',
                      color: '#a5b4fc',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {channel.target}
                  </span>
                </div>
                <span
                  style={{
                    fontSize: '10px',
                    fontFamily: 'var(--font-mono, monospace)',
                    background: '#1e293b',
                    color: '#818cf8',
                    padding: '1px 5px',
                    borderRadius: '3px',
                    fontWeight: 600,
                  }}
                >
                  {channel.count}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="rail-section">
        <div className="rail-label">Edge direction</div>
        <div className="legend-list">
          <div className="legend-row">
            <span className="legend-line legend-line--incoming" />
            <span>Incoming</span>
          </div>
          <div className="legend-row">
            <span className="legend-line legend-line--outgoing" />
            <span>Outgoing</span>
          </div>
        </div>
      </section>

      <section className="rail-section">
        <div className="rail-label">File kinds</div>
        <div className="kind-list">
          {KIND_ORDER.map((kind) => {
            const meta = getKindMeta(kind)
            return (
              <div
                className="kind-item"
                key={kind}
                style={{ '--kind': meta.color }}
              >
                <span className="kind-dot" />
                <span>{meta.label}</span>
              </div>
            )
          })}
        </div>
      </section>

      <section className="rail-section">
        <div className="rail-label">How to read this</div>
        <ul className="rail-list">
          <li>Click a folder to reveal its subfolders &amp; links.</li>
          <li>Click a subfolder to expand its files.</li>
          <li>Click a file to inspect symbols &amp; trace edges.</li>
          <li>Green enters. Blue leaves.</li>
        </ul>
      </section>

      {!repository.isLive && (
        <section className="rail-section rail-section--last">
          <p className="rail-note">
            Bundled sample data. Enter a GitHub URL above to explore a live repository.
          </p>
        </section>
      )}
    </aside>
  )
}

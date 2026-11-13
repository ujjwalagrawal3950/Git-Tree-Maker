import { CloseIcon } from './Icons'

export default function ProvenancePanel({
  edgeId,
  evidenceData,
  isLoading,
  error,
  onClose,
}) {
  if (!edgeId) return null

  const evidenceList = (evidenceData && evidenceData.evidence) || []
  const edgeType = (evidenceData && evidenceData.type) || 'relationship'
  const sourceId = (evidenceData && evidenceData.source) || ''
  const targetId = (evidenceData && evidenceData.target) || ''

  return (
    <aside
      className="detail-panel provenance-panel"
      aria-label="Edge Provenance Details"
      style={{
        width: '360px',
        maxWidth: '100vw',
        borderLeft: '1px solid var(--border)',
        background: 'var(--canvas)',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        overflowY: 'auto',
        padding: '16px',
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: '1px solid var(--border)',
          paddingBottom: '12px',
          marginBottom: '16px',
        }}
      >
        <div>
          <span
            style={{
              fontSize: '10px',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              fontWeight: 600,
              padding: '2px 6px',
              borderRadius: '4px',
              background: 'var(--brand-muted, rgba(56, 189, 248, 0.2))',
              color: 'var(--brand, #38bdf8)',
            }}
          >
            {edgeType}
          </span>
          <h2 style={{ fontSize: '14px', fontWeight: 600, margin: '8px 0 0 0', color: 'var(--text)' }}>
            Dependency Provenance
          </h2>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          aria-label="Close provenance panel"
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}
        >
          <CloseIcon />
        </button>
      </div>

      <div style={{ marginBottom: '16px', fontSize: '12px', color: 'var(--text-muted)' }}>
        <div style={{ marginBottom: '6px' }}>
          <strong style={{ color: 'var(--text)' }}>Source:</strong>
          <div style={{ fontFamily: 'var(--font-mono, monospace)', wordBreak: 'break-all', fontSize: '11px', marginTop: '2px' }}>
            {sourceId}
          </div>
        </div>
        <div>
          <strong style={{ color: 'var(--text)' }}>Target:</strong>
          <div style={{ fontFamily: 'var(--font-mono, monospace)', wordBreak: 'break-all', fontSize: '11px', marginTop: '2px' }}>
            {targetId}
          </div>
        </div>
      </div>

      {isLoading && (
        <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>
          Loading evidence records...
        </div>
      )}

      {error && (
        <div
          role="alert"
          style={{
            padding: '12px',
            borderRadius: '6px',
            background: 'rgba(239, 68, 68, 0.1)',
            color: '#ef4444',
            fontSize: '12px',
            marginBottom: '16px',
          }}
        >
          {error.message || 'Failed to load edge provenance.'}
        </div>
      )}

      {!isLoading && !error && evidenceList.length === 0 && (
        <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          No detailed evidence records available for this edge.
        </p>
      )}

      {!isLoading && !error && evidenceList.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
            Verified Evidence ({evidenceList.length})
          </div>

          {evidenceList.map((item, idx) => (
            <div
              key={idx}
              style={{
                border: '1px solid var(--border)',
                borderRadius: '6px',
                padding: '10px',
                background: 'var(--canvas-subtle, #1e293b)',
                fontSize: '11px',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                <span style={{ fontWeight: 600, color: 'var(--brand, #38bdf8)' }}>
                  {item.resolver || 'Unknown Resolver'}
                </span>
                {item.resolverVersion && (
                  <span style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
                    v{item.resolverVersion}
                  </span>
                )}
              </div>

              {item.rule && (
                <div style={{ marginBottom: '4px', color: 'var(--text-muted)' }}>
                  <strong>Rule:</strong> {item.rule}
                </div>
              )}

              {item.sourceLocation && (
                <div style={{ marginBottom: '4px', color: 'var(--text-muted)' }}>
                  <strong>Location:</strong>{' '}
                  <span style={{ fontFamily: 'var(--font-mono, monospace)' }}>
                    line {item.sourceLocation.line || item.sourceLocation.start?.line}
                    {item.sourceLocation.column ? `:${item.sourceLocation.column}` : ''}
                  </span>
                </div>
              )}

              {item.rawSpecifier && (
                <div style={{ marginTop: '6px' }}>
                  <div style={{ color: 'var(--text-muted)', marginBottom: '2px' }}>
                    <strong>Specifier:</strong>
                  </div>
                  <pre
                    style={{
                      margin: 0,
                      padding: '4px 6px',
                      background: 'var(--canvas, #0f172a)',
                      borderRadius: '4px',
                      fontSize: '10px',
                      fontFamily: 'var(--font-mono, monospace)',
                      color: 'var(--text)',
                      overflowX: 'auto',
                    }}
                  >
                    {item.rawSpecifier}
                  </pre>
                </div>
              )}

              {item.rawFact && (
                <div style={{ marginTop: '6px' }}>
                  <div style={{ color: 'var(--text-muted)', marginBottom: '2px' }}>
                    <strong>Fact Snippet:</strong>
                  </div>
                  <pre
                    style={{
                      margin: 0,
                      padding: '4px 6px',
                      background: 'var(--canvas, #0f172a)',
                      borderRadius: '4px',
                      fontSize: '10px',
                      fontFamily: 'var(--font-mono, monospace)',
                      color: 'var(--text)',
                      overflowX: 'auto',
                    }}
                  >
                    {typeof item.rawFact === 'string' ? item.rawFact : JSON.stringify(item.rawFact, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </aside>
  )
}


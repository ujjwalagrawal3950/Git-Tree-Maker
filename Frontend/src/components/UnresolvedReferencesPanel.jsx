import { useState, useEffect } from 'react'
import { CloseIcon } from './Icons'
import { fetchUnresolvedReferences } from '../lib/api'

const STATUS_FILTERS = [
  { value: '', label: 'All' },
  { value: 'ambiguous', label: 'Ambiguous' },
  { value: 'unresolved', label: 'Unresolved' },
  { value: 'dynamic', label: 'Dynamic' },
  { value: 'unsupported', label: 'Unsupported' },
]

export default function UnresolvedReferencesPanel({
  repositoryId,
  token,
  getToken,
  orgId,
  isOpen,
  onClose,
}) {
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize] = useState(15)
  const [data, setData] = useState(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    let isCurrent = true

    if (!isOpen || !repositoryId || (!token && !getToken)) {
      return undefined
    }

    const runFetch = async () => {
      setIsLoading(true)
      setError(null)
      try {
        const authToken = getToken ? await getToken() : token
        const queryParams = { page, pageSize }
        if (status) queryParams.status = status
        const result = await fetchUnresolvedReferences(repositoryId, authToken, orgId, queryParams)
        if (isCurrent) {
          setData(result)
        }
      } catch (err) {
        if (isCurrent) {
          setError(err)
        }
      } finally {
        if (isCurrent) {
          setIsLoading(false)
        }
      }
    }

    Promise.resolve().then(runFetch)

    return () => {
      isCurrent = false
    }
  }, [isOpen, repositoryId, token, getToken, orgId, status, page, pageSize])

  const handleStatusChange = (newStatus) => {
    setStatus(newStatus)
    setPage(1)
  }

  const handleNextPage = () => {
    if (data && page < (data.totalPages || 1)) {
      setPage((prev) => prev + 1)
    }
  }

  const handlePrevPage = () => {
    if (page > 1) {
      setPage((prev) => prev - 1)
    }
  }

  if (!isOpen) return null

  const items = (data && data.items) || []
  const total = (data && data.total) || 0
  const totalPages = (data && data.totalPages) || 1

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="unresolved-title"
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        width: '440px',
        maxWidth: '100vw',
        background: 'var(--canvas, #0f172a)',
        borderLeft: '1px solid var(--border, #334155)',
        zIndex: 50,
        boxShadow: '-4px 0 24px rgba(0, 0, 0, 0.4)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '16px',
          borderBottom: '1px solid var(--border, #334155)',
        }}
      >
        <div>
          <h2
            id="unresolved-title"
            style={{ fontSize: '15px', fontWeight: 600, margin: 0, color: 'var(--text)' }}
          >
            Unresolved & Ambiguous Facts
          </h2>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
            Separate from confirmed graph edges ({total} total)
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close unresolved references panel"
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}
        >
          <CloseIcon />
        </button>
      </div>

      <div
        style={{
          padding: '12px 16px',
          borderBottom: '1px solid var(--border, #334155)',
          display: 'flex',
          gap: '6px',
          flexWrap: 'wrap',
          background: 'var(--canvas-subtle, #1e293b)',
        }}
      >
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => handleStatusChange(f.value)}
            style={{
              fontSize: '11px',
              padding: '4px 8px',
              borderRadius: '4px',
              border: status === f.value ? '1px solid var(--brand, #38bdf8)' : '1px solid var(--border, #334155)',
              background: status === f.value ? 'var(--brand-muted, rgba(56, 189, 248, 0.2))' : 'transparent',
              color: status === f.value ? 'var(--brand, #38bdf8)' : 'var(--text-muted)',
              cursor: 'pointer',
              fontWeight: status === f.value ? 600 : 400,
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>
        {isLoading && (
          <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-muted)', fontSize: '12px' }}>
            Loading unresolved references...
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
            }}
          >
            {error.message || 'Failed to load unresolved references.'}
          </div>
        )}

        {!isLoading && !error && items.length === 0 && (
          <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-muted)', fontSize: '12px' }}>
            No records found matching the selected filter.
          </div>
        )}

        {!isLoading && !error && items.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {items.map((item, idx) => {
              const statusColor =
                item.status === 'ambiguous'
                  ? '#f59e0b'
                  : item.status === 'dynamic'
                  ? '#a855f7'
                  : item.status === 'unsupported'
                  ? '#64748b'
                  : '#ef4444'

              return (
                <div
                  key={item.id || idx}
                  style={{
                    border: '1px solid var(--border, #334155)',
                    borderRadius: '6px',
                    padding: '10px',
                    background: 'var(--canvas-subtle, #1e293b)',
                    fontSize: '11px',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                    <span
                      style={{
                        textTransform: 'uppercase',
                        fontSize: '9px',
                        fontWeight: 700,
                        padding: '2px 5px',
                        borderRadius: '3px',
                        color: statusColor,
                        background: `${statusColor}22`,
                      }}
                    >
                      {item.status}
                    </span>
                    <span style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
                      {item.resolver || 'Resolver'}
                    </span>
                  </div>

                  <div style={{ marginBottom: '4px' }}>
                    <strong style={{ color: 'var(--text)' }}>Source:</strong>{' '}
                    <span style={{ fontFamily: 'var(--font-mono, monospace)', color: 'var(--text-muted)' }}>
                      {item.sourceFile || item.sourceFilePath || 'Unknown file'}
                      {item.sourceLocation ? `:${item.sourceLocation.line || item.sourceLocation.start?.line}` : ''}
                    </span>
                  </div>

                  {item.rawSpecifier && (
                    <div style={{ marginTop: '4px' }}>
                      <strong style={{ color: 'var(--text)' }}>Specifier / Name:</strong>
                      <div
                        style={{
                          fontFamily: 'var(--font-mono, monospace)',
                          background: 'var(--canvas, #0f172a)',
                          padding: '4px 6px',
                          borderRadius: '4px',
                          marginTop: '2px',
                          wordBreak: 'break-all',
                        }}
                      >
                        {item.rawSpecifier}
                      </div>
                    </div>
                  )}

                  {Array.isArray(item.candidates) && item.candidates.length > 0 && (
                    <div style={{ marginTop: '6px' }}>
                      <strong style={{ color: 'var(--text)' }}>Candidates ({item.candidates.length}):</strong>
                      <ul style={{ margin: '4px 0 0 0', paddingLeft: '16px', color: 'var(--text-muted)' }}>
                        {item.candidates.map((cand, cIdx) => (
                          <li key={cIdx} style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: '10px' }}>
                            {typeof cand === 'string' ? cand : cand.path || cand.id || JSON.stringify(cand)}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div
        style={{
          padding: '12px 16px',
          borderTop: '1px solid var(--border, #334155)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          background: 'var(--canvas-subtle, #1e293b)',
        }}
      >
        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
          Showing {items.length > 0 ? (page - 1) * pageSize + 1 : 0}-{Math.min(page * pageSize, total)} of {total} (Page {page} of {totalPages})
        </span>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            type="button"
            disabled={page <= 1 || isLoading}
            onClick={handlePrevPage}
            style={{
              padding: '4px 10px',
              fontSize: '11px',
              borderRadius: '4px',
              border: '1px solid var(--border, #334155)',
              background: 'transparent',
              color: page <= 1 ? 'var(--text-faint, #64748b)' : 'var(--text)',
              cursor: page <= 1 ? 'not-allowed' : 'pointer',
            }}
          >
            Previous
          </button>
          <button
            type="button"
            disabled={page >= totalPages || isLoading}
            onClick={handleNextPage}
            style={{
              padding: '4px 10px',
              fontSize: '11px',
              borderRadius: '4px',
              border: '1px solid var(--border, #334155)',
              background: 'transparent',
              color: page >= totalPages ? 'var(--text-faint, #64748b)' : 'var(--text)',
              cursor: page >= totalPages ? 'not-allowed' : 'pointer',
            }}
          >
            Next
          </button>
        </div>
      </div>
    </div>
  )
}

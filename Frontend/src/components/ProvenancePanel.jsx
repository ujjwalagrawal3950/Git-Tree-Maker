import { useMemo, useState, useEffect } from 'react'
import { ArrowRightIcon, ArrowUpRightIcon, CloseIcon } from './Icons'
import { paginateUnderlyingEdges, DEFAULT_PAGE_SIZE } from '../lib/provenancePagination.js'

const HTTP_METHOD_COLORS = {
  GET: { bg: 'rgba(34, 197, 94, 0.18)', color: '#4ade80', border: 'rgba(34, 197, 94, 0.35)' },
  POST: { bg: 'rgba(6, 182, 212, 0.18)', color: '#22d3ee', border: 'rgba(6, 182, 212, 0.35)' },
  PUT: { bg: 'rgba(245, 158, 11, 0.18)', color: '#fbbf24', border: 'rgba(245, 158, 11, 0.35)' },
  PATCH: { bg: 'rgba(168, 85, 247, 0.18)', color: '#c084fc', border: 'rgba(168, 85, 247, 0.35)' },
  DELETE: { bg: 'rgba(239, 68, 68, 0.18)', color: '#f87171', border: 'rgba(239, 68, 68, 0.35)' },
  HEAD: { bg: 'rgba(148, 163, 184, 0.18)', color: '#cbd5e1', border: 'rgba(148, 163, 184, 0.35)' },
  OPTIONS: { bg: 'rgba(148, 163, 184, 0.18)', color: '#cbd5e1', border: 'rgba(148, 163, 184, 0.35)' },
  ALL: { bg: 'rgba(217, 70, 239, 0.18)', color: '#e879f9', border: 'rgba(217, 70, 239, 0.35)' },
}

function getMethodBadgeStyle(method) {
  const m = (method || 'GET').toUpperCase()
  return HTTP_METHOD_COLORS[m] || { bg: 'rgba(6, 182, 212, 0.18)', color: '#22d3ee', border: 'rgba(6, 182, 212, 0.35)' }
}

export default function ProvenancePanel({
  edgeId,
  evidenceData,
  isLoading,
  error,
  onClose,
  onNavigateToItem,
}) {
  if (!edgeId) return null

  const isAggregated = Boolean(
    evidenceData?.isAggregated ||
    (evidenceData?.underlyingEdges && evidenceData.underlyingEdges.length > 0) ||
    edgeId.startsWith('edge:folder:'),
  )

  const underlyingEdges = evidenceData?.underlyingEdges || []
  const evidenceList = (!isAggregated && evidenceData?.evidence) || []
  const edgeType = (evidenceData && evidenceData.type) || 'relationship'
  const sourceId = (evidenceData && evidenceData.source) || ''
  const targetId = (evidenceData && evidenceData.target) || ''

  const isHttpEdge = Boolean(
    edgeType === 'http_request' ||
    evidenceData?.edgeType === 'http_request' ||
    evidenceData?.isHttpRequest ||
    evidenceData?.data?.isHttpRequest ||
    evidenceData?.data?.edgeType === 'http_request' ||
    evidenceData?.metadata?.httpMethod ||
    (Array.isArray(evidenceData?.evidence) &&
      evidenceData.evidence.some((e) => e.category === 'http_request'))
  )

  const httpMeta =
    evidenceData?.metadata ||
    evidenceData?.data?.metadata ||
    (Array.isArray(evidenceData?.evidence) && evidenceData.evidence[0]?.metadata) ||
    {}
  const httpMethod =
    httpMeta.httpMethod ||
    evidenceData?.httpMethod ||
    evidenceData?.data?.httpMethod ||
    (Array.isArray(evidenceData?.evidence) && evidenceData.evidence[0]?.target?.httpMethod) ||
    'GET'
  const composedRoutePath =
    httpMeta.composedRoutePath ||
    evidenceData?.composedRoutePath ||
    evidenceData?.data?.composedRoutePath ||
    (Array.isArray(evidenceData?.evidence) && evidenceData.evidence[0]?.target?.composedRoutePath) ||
    null
  const originalRoutePath =
    httpMeta.originalRoutePath ||
    (Array.isArray(evidenceData?.evidence) && evidenceData.evidence[0]?.target?.originalRoutePath) ||
    null
  const classification =
    httpMeta.classification ||
    (Array.isArray(evidenceData?.evidence) && evidenceData.evidence[0]?.status?.classification) ||
    'confirmed_exact'
  const mountChain =
    httpMeta.mountChain ||
    (Array.isArray(evidenceData?.evidence) && evidenceData.evidence[0]?.target?.mountChain) ||
    []

  const [searchQuery, setSearchQuery] = useState('')
  const [selectedTypeFilter, setSelectedTypeFilter] = useState('ALL')
  const [currentPage, setCurrentPage] = useState(1)
  const [showAll, setShowAll] = useState(false)

  // Reset pagination and search when a new edge is selected
  useEffect(() => {
    setSearchQuery('')
    setSelectedTypeFilter('ALL')
    setCurrentPage(1)
    setShowAll(false)
  }, [edgeId])
  const pagination = useMemo(() => {
    if (!isAggregated) {
      return {
        typeCounts: [],
        filteredEdges: [],
        visibleEdges: [],
        totalPages: 1,
        effectivePage: 1,
        pageSize: DEFAULT_PAGE_SIZE,
      }
    }
    return paginateUnderlyingEdges(underlyingEdges, {
      searchQuery,
      selectedTypeFilter,
      currentPage,
      pageSize: DEFAULT_PAGE_SIZE,
      showAll,
    })
  }, [isAggregated, underlyingEdges, searchQuery, selectedTypeFilter, currentPage, showAll])

  const {
    typeCounts,
    filteredEdges,
    visibleEdges,
    totalPages,
    effectivePage,
    pageSize: PAGE_SIZE,
  } = pagination

  const sourceLabel = sourceId.replace(/^folder:/, '').replace(/^file:/, '')
  const targetLabel = targetId.replace(/^folder:/, '').replace(/^file:/, '')

  const handleNavigateFile = (fileId, filePath, fileName) => {
    if (typeof onNavigateToItem === 'function') {
      onNavigateToItem({
        type: 'file',
        id: fileId,
        fileId,
        path: filePath,
        name: fileName || filePath?.split('/').pop() || fileId,
      })
    }
  }

  return (
    <aside
      className="detail-panel provenance-panel"
      aria-label="Edge Provenance Details"
      style={{
        width: '380px',
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
      {/* Header */}
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
              background: isAggregated
                ? 'rgba(168, 85, 247, 0.2)'
                : isHttpEdge
                  ? 'rgba(6, 182, 212, 0.2)'
                  : 'var(--brand-muted, rgba(56, 189, 248, 0.2))',
              color: isAggregated
                ? '#c084fc'
                : isHttpEdge
                  ? '#22d3ee'
                  : 'var(--brand, #38bdf8)',
            }}
          >
            {isAggregated
              ? evidenceData?.isCrossSubsystem
                ? 'Cross-Subsystem Coupling'
                : 'Aggregated Boundary'
              : isHttpEdge
                ? 'HTTP API Endpoint'
                : edgeType}
          </span>
          <h2
            style={{
              fontSize: '14px',
              fontWeight: 600,
              margin: '8px 0 0 0',
              color: 'var(--text)',
            }}
          >
            {isAggregated
              ? 'Aggregated Dependencies'
              : isHttpEdge
                ? 'HTTP Request Provenance'
                : 'Dependency Provenance'}
          </h2>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          aria-label="Close provenance panel"
          style={{
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--text-muted)',
          }}
        >
          <CloseIcon />
        </button>
      </div>

      {/* Endpoint summary */}
      <div
        style={{
          marginBottom: '16px',
          fontSize: '12px',
          background: 'var(--canvas-subtle, #0d1524)',
          border: '1px solid var(--border)',
          borderRadius: '6px',
          padding: '10px',
        }}
      >
        <div style={{ marginBottom: '6px' }}>
          <strong style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
            {isAggregated ? 'SOURCE CONTAINER:' : 'SOURCE:'}
          </strong>
          <div
            style={{
              fontFamily: 'var(--font-mono, monospace)',
              wordBreak: 'break-all',
              fontSize: '12px',
              color: 'var(--text)',
              marginTop: '2px',
              fontWeight: 500,
            }}
          >
            {sourceLabel}
          </div>
        </div>
        <div>
          <strong style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
            {isAggregated ? 'TARGET CONTAINER:' : 'TARGET:'}
          </strong>
          <div
            style={{
              fontFamily: 'var(--font-mono, monospace)',
              wordBreak: 'break-all',
              fontSize: '12px',
              color: 'var(--text)',
              marginTop: '2px',
              fontWeight: 500,
            }}
          >
            {targetLabel}
          </div>
        </div>
      </div>

      {/* Aggregated Mode View */}
      {isAggregated && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {/* Summary Badge & Interactive Type Breakdown */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
              padding: '10px',
              borderRadius: '6px',
              background: 'rgba(56, 189, 248, 0.08)',
              border: '1px solid rgba(56, 189, 248, 0.2)',
            }}
          >
            <div style={{ fontSize: '12px', fontWeight: 600, color: '#38bdf8' }}>
              {underlyingEdges.length} Underlying Canonical{' '}
              {underlyingEdges.length === 1 ? 'Dependency' : 'Dependencies'}
            </div>
            {typeCounts.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedTypeFilter('ALL')
                    setCurrentPage(1)
                  }}
                  style={{
                    fontSize: '10px',
                    fontFamily: 'var(--font-mono, monospace)',
                    background: selectedTypeFilter === 'ALL' ? '#38bdf8' : '#1e293b',
                    color: selectedTypeFilter === 'ALL' ? '#0f172a' : '#cbd5e1',
                    padding: '2px 6px',
                    borderRadius: '4px',
                    border: '1px solid #334155',
                    cursor: 'pointer',
                    fontWeight: selectedTypeFilter === 'ALL' ? 600 : 400,
                  }}
                  title="Show all dependency types"
                >
                  All ({underlyingEdges.length})
                </button>
                {typeCounts.map(({ type, count }) => {
                  const isHttp = type === 'http_request'
                  const isSelected = selectedTypeFilter === type
                  return (
                    <button
                      key={type}
                      type="button"
                      onClick={() => {
                        setSelectedTypeFilter(selectedTypeFilter === type ? 'ALL' : type)
                        setCurrentPage(1)
                      }}
                      style={{
                        fontSize: '10px',
                        fontFamily: 'var(--font-mono, monospace)',
                        background: isSelected
                          ? isHttp
                            ? '#06b6d4'
                            : '#38bdf8'
                          : isHttp
                            ? 'rgba(6, 182, 212, 0.15)'
                            : '#1e293b',
                        color: isSelected ? '#0f172a' : isHttp ? '#22d3ee' : '#cbd5e1',
                        padding: '2px 6px',
                        borderRadius: '4px',
                        border: `1px solid ${
                          isSelected
                            ? isHttp
                              ? '#0891b2'
                              : '#0284c7'
                            : isHttp
                              ? 'rgba(6, 182, 212, 0.3)'
                              : '#334155'
                        }`,
                        cursor: 'pointer',
                        fontWeight: isSelected ? 600 : 400,
                      }}
                      title={`Filter to ${type} dependencies only`}
                    >
                      {count} {type}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {/* Search filter input if > 5 items */}
          {underlyingEdges.length > 5 && (
            <div style={{ position: 'relative' }}>
              <input
                type="text"
                placeholder="Filter connections by file or path..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value)
                  setCurrentPage(1)
                }}
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  padding: '6px 26px 6px 8px',
                  fontSize: '11px',
                  fontFamily: 'var(--font-mono, monospace)',
                  background: 'var(--canvas-subtle, #1e293b)',
                  border: '1px solid var(--border)',
                  borderRadius: '4px',
                  color: 'var(--text)',
                  outline: 'none',
                }}
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery('')
                    setCurrentPage(1)
                  }}
                  style={{
                    position: 'absolute',
                    right: '6px',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    background: 'none',
                    border: 'none',
                    color: 'var(--text-muted)',
                    cursor: 'pointer',
                    padding: 0,
                    fontSize: '12px',
                  }}
                  title="Clear search filter"
                >
                  ×
                </button>
              )}
            </div>
          )}

          {/* List of underlying canonical dependencies with windowed pagination */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                fontSize: '11px',
                fontWeight: 600,
                color: 'var(--text-muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
              }}
            >
              <span>
                Traceable Connections ({filteredEdges.length}
                {filteredEdges.length !== underlyingEdges.length
                  ? ` of ${underlyingEdges.length}`
                  : ''}
                )
              </span>
              {filteredEdges.length > PAGE_SIZE && !showAll && (
                <span style={{ fontSize: '10px', textTransform: 'none', color: '#38bdf8' }}>
                  Page {effectivePage} of {totalPages}
                </span>
              )}
            </div>

            {/* Pagination Controls (Top) */}
            {filteredEdges.length > PAGE_SIZE && !showAll && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '6px 8px',
                  borderRadius: '4px',
                  background: 'var(--canvas-subtle, #1e293b)',
                  border: '1px solid var(--border)',
                  fontSize: '10.5px',
                }}
              >
                <span style={{ color: 'var(--text-muted)' }}>
                  {(effectivePage - 1) * PAGE_SIZE + 1}–
                  {Math.min(effectivePage * PAGE_SIZE, filteredEdges.length)} of{' '}
                  {filteredEdges.length}
                </span>
                <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                  <button
                    type="button"
                    disabled={effectivePage <= 1}
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    style={{
                      background: 'var(--canvas, #0f172a)',
                      border: '1px solid var(--border)',
                      borderRadius: '3px',
                      color: effectivePage <= 1 ? 'var(--text-muted)' : 'var(--text)',
                      cursor: effectivePage <= 1 ? 'not-allowed' : 'pointer',
                      padding: '2px 7px',
                      fontSize: '10px',
                    }}
                  >
                    Prev
                  </button>
                  <button
                    type="button"
                    disabled={effectivePage >= totalPages}
                    onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                    style={{
                      background: 'var(--canvas, #0f172a)',
                      border: '1px solid var(--border)',
                      borderRadius: '3px',
                      color: effectivePage >= totalPages ? 'var(--text-muted)' : 'var(--text)',
                      cursor: effectivePage >= totalPages ? 'not-allowed' : 'pointer',
                      padding: '2px 7px',
                      fontSize: '10px',
                    }}
                  >
                    Next
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowAll(true)}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: '#38bdf8',
                      cursor: 'pointer',
                      padding: '2px 4px',
                      fontSize: '10px',
                      textDecoration: 'underline',
                    }}
                  >
                    Show all
                  </button>
                </div>
              </div>
            )}

            {visibleEdges.length === 0 && (
              <div
                style={{
                  padding: '16px',
                  textAlign: 'center',
                  color: 'var(--text-muted)',
                  fontSize: '11px',
                  border: '1px dashed var(--border)',
                  borderRadius: '6px',
                }}
              >
                No connections match current filters.
              </div>
            )}

            {visibleEdges.map((item, idx) => {
              const itemIndex = showAll
                ? idx + 1
                : (effectivePage - 1) * PAGE_SIZE + idx + 1
              const isItemHttp = item.type === 'http_request'
              const itemHttpMethod =
                item.metadata?.httpMethod ||
                item.data?.httpMethod ||
                (Array.isArray(item.evidence) && item.evidence[0]?.target?.httpMethod) ||
                null
              const itemComposedPath =
                item.metadata?.composedRoutePath ||
                item.data?.composedRoutePath ||
                (Array.isArray(item.evidence) && item.evidence[0]?.target?.composedRoutePath) ||
                null
              const itemIsPattern = Boolean(
                item.metadata?.isPatternCompatible ||
                (Array.isArray(item.evidence) &&
                  item.evidence[0]?.status?.classification === 'pattern_compatible'),
              )

              return (
                <div
                  key={item.id || itemIndex}
                  style={{
                    border: `1px solid ${
                      isItemHttp ? 'rgba(6, 182, 212, 0.3)' : 'var(--border)'
                    }`,
                    borderRadius: '6px',
                    padding: '9px 10px',
                    background: isItemHttp
                      ? 'rgba(6, 182, 212, 0.04)'
                      : 'var(--canvas-subtle, #1e293b)',
                    fontSize: '11px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span
                        style={{
                          fontFamily: 'var(--font-mono, monospace)',
                          fontSize: '10px',
                          color: isItemHttp ? '#22d3ee' : '#38bdf8',
                          background: isItemHttp
                            ? 'rgba(6, 182, 212, 0.15)'
                            : 'rgba(56, 189, 248, 0.15)',
                          padding: '1px 5px',
                          borderRadius: '3px',
                          fontWeight: 600,
                        }}
                      >
                        {item.type || 'imports'}
                      </span>
                      {isItemHttp && itemHttpMethod && (
                        <span
                          style={{
                            fontFamily: 'var(--font-mono, monospace)',
                            fontSize: '9.5px',
                            fontWeight: 700,
                            padding: '1px 5px',
                            borderRadius: '3px',
                            ...getMethodBadgeStyle(itemHttpMethod),
                            border: `1px solid ${getMethodBadgeStyle(itemHttpMethod).border}`,
                          }}
                        >
                          {itemHttpMethod}
                        </span>
                      )}
                      {isItemHttp && itemIsPattern && (
                        <span
                          style={{
                            fontSize: '9px',
                            fontFamily: 'var(--font-mono, monospace)',
                            color: '#fbbf24',
                            background: 'rgba(245, 158, 11, 0.15)',
                            padding: '1px 4px',
                            borderRadius: '3px',
                            fontWeight: 600,
                          }}
                          title="Pattern-compatible route parameter match"
                        >
                          ≈ pattern
                        </span>
                      )}
                    </div>
                    <span
                      style={{
                        color: 'var(--text-muted)',
                        fontSize: '10px',
                      }}
                    >
                      #{itemIndex}
                    </span>
                  </div>

                  {isItemHttp && itemComposedPath && (
                    <div
                      style={{
                        fontSize: '11px',
                        fontFamily: 'var(--font-mono, monospace)',
                        color: '#67e8f9',
                        background: '#090e17',
                        padding: '3px 6px',
                        borderRadius: '4px',
                        border: '1px solid rgba(6, 182, 212, 0.2)',
                        wordBreak: 'break-all',
                      }}
                    >
                      {itemHttpMethod ? `${itemHttpMethod} ` : ''}
                      {itemComposedPath}
                    </div>
                  )}

                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '4px',
                      fontFamily: 'var(--font-mono, monospace)',
                      fontSize: '10.5px',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '4px',
                      }}
                    >
                      <span
                        title={item.sourcePath}
                        style={{
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          color: 'var(--text)',
                        }}
                      >
                        {item.sourceName || item.sourcePath}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          handleNavigateFile(item.sourceId, item.sourcePath, item.sourceName)
                        }
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: '#38bdf8',
                          cursor: 'pointer',
                          padding: '1px 4px',
                          fontSize: '10px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '2px',
                        }}
                        title={`Jump to source file: ${item.sourcePath}`}
                      >
                        <span>Focus</span>
                        <ArrowUpRightIcon />
                      </button>
                    </div>

                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '4px',
                        color: 'var(--text-muted)',
                        fontSize: '10px',
                      }}
                    >
                      <ArrowRightIcon />
                      <span>points to</span>
                    </div>

                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '4px',
                      }}
                    >
                      <span
                        title={item.targetPath}
                        style={{
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          color: '#a5b4fc',
                        }}
                      >
                        {item.targetName || item.targetPath}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          handleNavigateFile(item.targetId, item.targetPath, item.targetName)
                        }
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: '#a5b4fc',
                          cursor: 'pointer',
                          padding: '1px 4px',
                          fontSize: '10px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '2px',
                        }}
                        title={`Jump to target file: ${item.targetPath}`}
                      >
                        <span>Focus</span>
                        <ArrowUpRightIcon />
                      </button>
                    </div>
                  </div>

                  {item.evidence && (
                    <div
                      style={{
                        marginTop: '2px',
                        fontSize: '10px',
                        color: 'var(--text-muted)',
                        borderTop: '1px solid rgba(255, 255, 255, 0.06)',
                        paddingTop: '4px',
                      }}
                    >
                      Rule: {typeof item.evidence === 'string' ? item.evidence : item.evidence.rule || 'AST Fact'}
                    </div>
                  )}
                </div>
              )
            })}

            {/* Pagination Controls (Bottom) */}
            {filteredEdges.length > PAGE_SIZE && !showAll && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '6px 8px',
                  borderRadius: '4px',
                  background: 'var(--canvas-subtle, #1e293b)',
                  border: '1px solid var(--border)',
                  fontSize: '10.5px',
                  marginTop: '4px',
                }}
              >
                <span style={{ color: 'var(--text-muted)' }}>
                  Page {effectivePage} of {totalPages}
                </span>
                <div style={{ display: 'flex', gap: '4px' }}>
                  <button
                    type="button"
                    disabled={effectivePage <= 1}
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    style={{
                      background: 'var(--canvas, #0f172a)',
                      border: '1px solid var(--border)',
                      borderRadius: '3px',
                      color: effectivePage <= 1 ? 'var(--text-muted)' : 'var(--text)',
                      cursor: effectivePage <= 1 ? 'not-allowed' : 'pointer',
                      padding: '2px 7px',
                      fontSize: '10px',
                    }}
                  >
                    Prev
                  </button>
                  <button
                    type="button"
                    disabled={effectivePage >= totalPages}
                    onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                    style={{
                      background: 'var(--canvas, #0f172a)',
                      border: '1px solid var(--border)',
                      borderRadius: '3px',
                      color: effectivePage >= totalPages ? 'var(--text-muted)' : 'var(--text)',
                      cursor: effectivePage >= totalPages ? 'not-allowed' : 'pointer',
                      padding: '2px 7px',
                      fontSize: '10px',
                    }}
                  >
                    Next
                  </button>
                </div>
              </div>
            )}

            {showAll && filteredEdges.length > PAGE_SIZE && (
              <div style={{ textAlign: 'center', marginTop: '6px' }}>
                <button
                  type="button"
                  onClick={() => setShowAll(false)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: '#38bdf8',
                    cursor: 'pointer',
                    fontSize: '10px',
                    textDecoration: 'underline',
                  }}
                >
                  Switch back to paginated view ({PAGE_SIZE} per page)
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Non-Aggregated Mode: Verified AST Evidence */}
      {!isAggregated && (
        <>
          {/* HTTP Route Details Banner (Stage 5) */}
          {isHttpEdge && (
            <div
              style={{
                marginBottom: '16px',
                padding: '12px',
                borderRadius: '6px',
                background: 'rgba(6, 182, 212, 0.08)',
                border: '1px solid rgba(6, 182, 212, 0.25)',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span
                    style={{
                      fontFamily: 'var(--font-mono, monospace)',
                      fontSize: '11px',
                      fontWeight: 700,
                      padding: '2px 7px',
                      borderRadius: '4px',
                      ...getMethodBadgeStyle(httpMethod),
                      border: `1px solid ${getMethodBadgeStyle(httpMethod).border}`,
                    }}
                  >
                    {httpMethod}
                  </span>
                  <span
                    style={{
                      fontFamily: 'var(--font-mono, monospace)',
                      fontSize: '13px',
                      fontWeight: 600,
                      color: '#22d3ee',
                    }}
                  >
                    {composedRoutePath || '/'}
                  </span>
                </div>
                <span
                  style={{
                    fontSize: '10px',
                    fontFamily: 'var(--font-mono, monospace)',
                    padding: '2px 6px',
                    borderRadius: '4px',
                    background:
                      classification === 'confirmed_exact'
                        ? 'rgba(34, 197, 94, 0.15)'
                        : 'rgba(245, 158, 11, 0.15)',
                    color: classification === 'confirmed_exact' ? '#4ade80' : '#fbbf24',
                    border: `1px solid ${
                      classification === 'confirmed_exact'
                        ? 'rgba(34, 197, 94, 0.3)'
                        : 'rgba(245, 158, 11, 0.3)'
                    }`,
                    fontWeight: 600,
                  }}
                >
                  {classification === 'confirmed_exact' ? '✓ Exact' : '≈ Pattern'}
                </span>
              </div>

              {originalRoutePath && originalRoutePath !== composedRoutePath && (
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  Backend declaration:{' '}
                  <code style={{ color: '#cbd5e1', background: '#0f172a', padding: '1px 4px', borderRadius: '3px' }}>
                    {originalRoutePath}
                  </code>
                </div>
              )}

              {mountChain && mountChain.length > 0 && (
                <div style={{ marginTop: '2px' }}>
                  <div
                    style={{
                      fontSize: '10px',
                      color: 'var(--text-muted)',
                      marginBottom: '4px',
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                    }}
                  >
                    Mount Hierarchy:
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '3px',
                      fontSize: '10.5px',
                      fontFamily: 'var(--font-mono, monospace)',
                    }}
                  >
                    {mountChain.map((m, mIdx) => (
                      <div key={mIdx} style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#94a3b8' }}>
                        <span style={{ color: '#06b6d4' }}>↳</span>
                        <span style={{ color: '#f1f5f9' }}>{m.prefix || '/'}</span>
                        <span style={{ color: '#64748b', fontSize: '9.5px' }}>({m.routerFileId || 'router'})</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {isLoading && (
            <div
              style={{
                padding: '24px 0',
                textAlign: 'center',
                color: 'var(--text-muted)',
                fontSize: '12px',
              }}
            >
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
              <div
                style={{
                  fontSize: '11px',
                  fontWeight: 600,
                  color: 'var(--text-muted)',
                  textTransform: 'uppercase',
                }}
              >
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
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      marginBottom: '6px',
                    }}
                  >
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
                        {typeof item.rawFact === 'string'
                          ? item.rawFact
                          : JSON.stringify(item.rawFact, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </aside>
  )
}

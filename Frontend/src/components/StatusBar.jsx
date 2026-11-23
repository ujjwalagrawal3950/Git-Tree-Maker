export default function StatusBar({
  repository,
  graphSummary,
  expandedFolder,
  selectedFile,
  selectedNode,
  crossDirectoryOnly = false,
  relationshipFilter = 'all',
  viewMode = 'detailed',
  onOpenUnresolved,
}) {
  const isBackend = Boolean(graphSummary)
  const repoLabel =
    graphSummary?.repository?.repositoryId ||
    graphSummary?.repositoryId ||
    repository.name
  const revisionSha =
    graphSummary?.revision?.commitSha || graphSummary?.commitSha || null
  const fileCount =
    graphSummary?.statistics?.fileNodes ?? graphSummary?.counts?.files ?? 0
  const symbolCount =
    graphSummary?.statistics?.symbolNodes ?? graphSummary?.counts?.symbols ?? 0
  const edgeCount =
    graphSummary?.statistics?.totalEdges ?? graphSummary?.counts?.edges ?? 0
  const unresolvedCount =
    graphSummary?.statistics?.unresolvedReferences ??
    graphSummary?.counts?.unresolvedReferences

  return (
    <footer className="status-bar" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      <div className="status-bar__group" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <span className="status-dot" />
        <span className="status-mono">
          {isBackend ? repoLabel : repository.name}
        </span>
        {isBackend ? (
          <>
            <span
              className="status-sample"
              style={{ background: 'var(--brand-muted, rgba(56, 189, 248, 0.2))', color: 'var(--brand, #38bdf8)' }}
            >
              {revisionSha ? revisionSha.slice(0, 7) : 'Live Graph'}
            </span>
            <span className="status-separator">/</span>
            <span>{fileCount} files</span>
            <span className="status-separator">/</span>
            <span>{symbolCount} symbols</span>
            <span className="status-separator">/</span>
            <span>{edgeCount} edges</span>
            {unresolvedCount !== undefined && (
              <>
                <span className="status-separator">/</span>
                <button
                  type="button"
                  onClick={onOpenUnresolved}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    padding: 0,
                    cursor: 'pointer',
                    color: 'var(--brand, #38bdf8)',
                    textDecoration: 'underline',
                    fontSize: 'inherit',
                    fontFamily: 'inherit',
                  }}
                >
                  {unresolvedCount} unresolved
                </button>
              </>
            )}
          </>
        ) : (
          <>
            <span className="status-sample">Sample</span>
            <span className="status-separator">/</span>
            <span>{repository.files.length} files</span>
            <span className="status-separator">/</span>
            <span>{repository.edges.length} edges</span>
          </>
        )}
      </div>

      <div className="status-bar__spacer" style={{ flex: 1 }} />

      {viewMode === 'architecture' && (
        <span
          className="status-mono status-context"
          style={{ color: '#38bdf8', background: 'rgba(56, 189, 248, 0.12)', padding: '2px 6px', borderRadius: '4px' }}
        >
          🏛 Architecture Overview
        </span>
      )}

      {crossDirectoryOnly && (
        <span
          className="status-mono status-context"
          style={{ color: '#0284c7', background: 'rgba(2, 132, 199, 0.12)', padding: '2px 6px', borderRadius: '4px' }}
        >
          ⚡ Cross-Directory Only
        </span>
      )}

      {relationshipFilter === 'http' && (
        <span
          className="status-mono status-context"
          style={{ color: '#06b6d4', background: 'rgba(6, 182, 212, 0.12)', padding: '2px 6px', borderRadius: '4px' }}
        >
          🌐 HTTP APIs Only
        </span>
      )}

      {relationshipFilter === 'code' && (
        <span
          className="status-mono status-context"
          style={{ color: '#38bdf8', background: 'rgba(56, 189, 248, 0.12)', padding: '2px 6px', borderRadius: '4px' }}
        >
          📦 Code Dependencies Only
        </span>
      )}

      {expandedFolder && (
        <span className="status-mono status-context">
          {expandedFolder} expanded
        </span>
      )}

      {selectedFile && (
        <span className="status-mono status-context">
          {selectedFile.path}
        </span>
      )}

      {selectedNode && (
        <span className="status-mono status-context">
          {selectedNode.data?.path || selectedNode.data?.name || selectedNode.id}
        </span>
      )}

      <span className="status-hint">
        Click node to inspect · Click edge for provenance · Esc to clear
      </span>
    </footer>
  )
}

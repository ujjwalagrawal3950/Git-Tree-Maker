export default function StatusBar({
  repository,
  graphSummary,
  expandedFolder,
  selectedFile,
  selectedNode,
  onOpenUnresolved,
}) {
  const isBackend = Boolean(graphSummary)

  return (
    <footer className="status-bar" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      <div className="status-bar__group" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <span className="status-dot" />
        <span className="status-mono">
          {isBackend ? graphSummary.repositoryId : repository.name}
        </span>
        {isBackend ? (
          <>
            <span
              className="status-sample"
              style={{ background: 'var(--brand-muted, rgba(56, 189, 248, 0.2))', color: 'var(--brand, #38bdf8)' }}
            >
              {graphSummary.commitSha ? graphSummary.commitSha.slice(0, 7) : 'Live Graph'}
            </span>
            <span className="status-separator">/</span>
            <span>{graphSummary.counts?.files ?? 0} files</span>
            <span className="status-separator">/</span>
            <span>{graphSummary.counts?.symbols ?? 0} symbols</span>
            <span className="status-separator">/</span>
            <span>{graphSummary.counts?.edges ?? 0} edges</span>
            {graphSummary.counts?.unresolvedReferences !== undefined && (
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
                  {graphSummary.counts.unresolvedReferences} unresolved
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

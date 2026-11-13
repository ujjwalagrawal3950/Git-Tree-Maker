export default function StatusBar({
  repository,
  expandedFolder,
  selectedFile,
}) {
  return (
    <footer className="status-bar">
      <div className="status-bar__group">
        <span className="status-dot" />
        <span className="status-mono">{repository.name}</span>
        <span className="status-sample">Sample</span>
        <span className="status-separator">/</span>
        <span>{repository.files.length} files</span>
        <span className="status-separator">/</span>
        <span>{repository.edges.length} edges</span>
      </div>

      <div className="status-bar__spacer" />

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

      <span className="status-hint">
        Click folder to expand · Click file to inspect · Esc to clear
      </span>
    </footer>
  )
}

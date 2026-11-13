import { KIND_ORDER, getKindMeta } from '../lib/kinds'

export default function LeftRail({ repository, folderCount }) {
  return (
    <aside className="left-rail" aria-label="Repository overview">
      <section className="rail-section">
        <div className="rail-label">Repository</div>
        <div className="repo-heading">
          <span className="repo-name">{repository.name}</span>
          <span className="badge-sample">Sample</span>
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
          <li>Click a folder to open its files.</li>
          <li>Click a file to trace its edges.</li>
          <li>Green enters. Amber leaves.</li>
        </ul>
      </section>

      <section className="rail-section rail-section--last">
        <p className="rail-note">
          Bundled sample data. No repository has been parsed.
        </p>
      </section>
    </aside>
  )
}

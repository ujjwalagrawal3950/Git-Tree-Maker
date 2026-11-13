import { getKindMeta } from '../lib/kinds'
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CloseIcon,
} from './Icons'

function DependencyList({ ids, fileMap, direction, onSelectFile }) {
  if (ids.length === 0) {
    return <p className="dep-empty">None</p>
  }

  return (
    <div className="dep-list">
      {ids.map((id) => {
        const path = fileMap.get(id)?.path ?? id
        return (
          <button
            key={id}
            type="button"
            className={`dep-item dep-item--${direction}`}
            title={path}
            onClick={() => onSelectFile(id)}
          >
            <span className="dep-item__arrow">
              {direction === 'outgoing' ? (
                <ArrowRightIcon />
              ) : (
                <ArrowLeftIcon />
              )}
            </span>
            <span className="dep-item__path">{path}</span>
          </button>
        )
      })}
    </div>
  )
}

export default function DetailPanel({
  file,
  neighbours,
  fileMap,
  onSelectFile,
  onClose,
}) {
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
          ids={neighbours.imports}
          fileMap={fileMap}
          direction="outgoing"
          onSelectFile={onSelectFile}
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
          ids={neighbours.importedBy}
          fileMap={fileMap}
          direction="incoming"
          onSelectFile={onSelectFile}
        />
      </section>

      <p className="detail-note">
        This panel is arithmetic over the sample edge list. No request was made.
      </p>
    </aside>
  )
}

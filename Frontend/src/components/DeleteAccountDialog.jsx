import { useEffect, useRef } from 'react'

export default function DeleteAccountDialog({
  open,
  busy,
  error,
  onClose,
  onConfirm,
}) {
  const cancelRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined

    const handleKeyDown = (event) => {
      if (event.key === 'Escape' && !busy) onClose()
    }

    window.addEventListener('keydown', handleKeyDown)
    const focusTimer = window.setTimeout(() => cancelRef.current?.focus(), 0)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.clearTimeout(focusTimer)
    }
  }, [open, busy, onClose])

  if (!open) return null

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={() => {
        if (!busy) onClose()
      }}
    >
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-account-title"
        aria-describedby="delete-account-description"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="delete-account-title" className="modal-title">
          Delete account
        </h2>
        <p id="delete-account-description" className="modal-copy">
          This permanently deletes your Cartograph account and removes your
          profile and organization memberships from our database. This cannot
          be undone.
        </p>

        {error && (
          <p className="modal-error" role="alert">
            {error}
          </p>
        )}

        <div className="modal-actions">
          <button
            ref={cancelRef}
            type="button"
            className="button-secondary"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="button-danger"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? 'Deleting…' : 'Delete account'}
          </button>
        </div>
      </div>
    </div>
  )
}

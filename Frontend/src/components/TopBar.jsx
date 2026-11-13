import { useState } from 'react'
import {
  OrganizationSwitcher,
  Show,
  SignInButton,
  SignOutButton,
  SignUpButton,
  UserButton,
  useAuth,
  useClerk,
} from '@clerk/react'
import {
  LogoIcon,
  MonitorIcon,
  MoonIcon,
  SunIcon,
} from './Icons'
import DeleteAccountDialog from './DeleteAccountDialog'
import { deleteAccount } from '../lib/api'

const THEME_OPTIONS = [
  { value: 'system', label: 'Follow system theme', Icon: MonitorIcon },
  { value: 'light', label: 'Force light theme', Icon: SunIcon },
  { value: 'dark', label: 'Force dark theme', Icon: MoonIcon },
]

const PROFILE_APPEARANCE = {
  elements: {
    // Password changes are handled outside this app. Keep the account
    // deletion flow in our own dialog so it also removes database records.
    profileSection__password: { display: 'none' },
    profileSection__danger: { display: 'none' },
  },
}

export default function TopBar({
  preference,
  onPreferenceChange,
  repoUrl,
  onRepoUrlChange,
  onSubmit,
  canSubmit,
  isVerifying = false,
}) {
  const { getToken } = useAuth()
  const { signOut } = useClerk()
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')

  const isEmpty = repoUrl.trim().length === 0
  const isInvalid = !isEmpty && !canSubmit

  const openDeleteDialog = () => {
    setDeleteError('')
    setDeleteDialogOpen(true)
  }

  const closeDeleteDialog = () => {
    if (deleting) return
    setDeleteDialogOpen(false)
    setDeleteError('')
  }

  const handleDeleteAccount = async () => {
    setDeleting(true)
    setDeleteError('')

    try {
      const token = await getToken()
      await deleteAccount(token)
      setDeleteDialogOpen(false)

      try {
        await signOut({ redirectUrl: '/' })
      } catch {
        window.location.assign('/')
      }
    } catch (error) {
      setDeleteError(error.message || 'Account deletion failed.')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <header className="top-bar">
      <div className="brand">
        <span className="brand-mark">
          <LogoIcon />
        </span>
        <span className="brand-name">Cartograph</span>
      </div>

      <form className="repo-form" onSubmit={onSubmit} noValidate>
        <label className="visually-hidden" htmlFor="repo-url">
          GitHub repository URL
        </label>
        <input
          id="repo-url"
          className={`repo-input${isInvalid ? ' repo-input--invalid' : ''}`}
          type="url"
          inputMode="url"
          spellCheck={false}
          autoComplete="off"
          placeholder="https://github.com/owner/repository"
          value={repoUrl}
          onChange={(event) => onRepoUrlChange(event.target.value)}
          aria-invalid={isInvalid || undefined}
          aria-describedby="repo-url-helper"
        />
        <button
          className="button-primary"
          type="submit"
          disabled={!canSubmit || isVerifying}
        >
          {isVerifying ? 'Checking...' : 'Open'}
        </button>
        {isInvalid && (
          <p id="repo-url-helper" className="repo-helper" aria-live="polite">
            Enter a valid GitHub repository URL (e.g. https://github.com/owner/repository)
          </p>
        )}
      </form>

      <div className="theme-toggle" role="group" aria-label="Theme">
        {THEME_OPTIONS.map(({ value, label, Icon }) => (
          <button
            key={value}
            type="button"
            className="theme-toggle__button"
            aria-label={label}
            title={label}
            aria-pressed={preference === value}
            onClick={() => onPreferenceChange(value)}
          >
            <Icon />
          </button>
        ))}
      </div>

      <div className="auth-controls">
        <Show when="signed-out">
          <SignInButton mode="modal">
            <button className="button-primary auth-btn" type="button">
              Sign In
            </button>
          </SignInButton>
          <SignUpButton mode="modal">
            <button className="button-secondary auth-btn" type="button">
              Sign Up
            </button>
          </SignUpButton>
        </Show>
        <Show when="signed-in">
          <OrganizationSwitcher
            hidePersonal={true}
            afterCreateOrganizationUrl="/"
            afterSelectOrganizationUrl="/"
            afterLeaveOrganizationUrl="/"
          />
          <SignOutButton>
            <button className="button-secondary auth-btn" type="button">
              Sign Out
            </button>
          </SignOutButton>
          <UserButton
            afterSignOutUrl="/"
            userProfileProps={{ appearance: PROFILE_APPEARANCE }}
            customMenuItems={[
              {
                label: 'Delete account',
                onClick: openDeleteDialog,
              },
            ]}
          />
        </Show>
      </div>

      <DeleteAccountDialog
        open={deleteDialogOpen}
        busy={deleting}
        error={deleteError}
        onClose={closeDeleteDialog}
        onConfirm={handleDeleteAccount}
      />
    </header>
  )
}

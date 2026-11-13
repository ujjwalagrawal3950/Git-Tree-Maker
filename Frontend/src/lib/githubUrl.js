const GITHUB_REPOSITORY_URL =
  /^https?:\/\/(?:www\.)?github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/

export function isValidGithubRepositoryUrl(value) {
  return GITHUB_REPOSITORY_URL.test(value.trim())
}

import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const forbiddenVariables = new Set([
  'CLERK_SECRET_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'CLERK_WEBHOOK_SECRET',
  'NGROK_AUTHTOKEN',
  'SUPABASE_JWT_SECRET',
])

const ignoredDirectories = new Set(['.git', 'node_modules'])
const ignoredFiles = new Set(['.env.example', 'check-secrets.mjs'])
const textExtensions = new Set([
  '.css',
  '.html',
  '.js',
  '.jsx',
  '.json',
  '.mjs',
  '.cjs',
  '.txt',
  '.yml',
  '.yaml',
])

const findings = []

function report(filePath, reason) {
  findings.push(`${path.relative(root, filePath)}: ${reason}`)
}

async function scanFile(filePath) {
  const name = path.basename(filePath)
  if (ignoredFiles.has(name)) return

  const fileStat = await stat(filePath)
  if (!fileStat.isFile() || fileStat.size > 2_000_000) return

  const isEnv = name === '.env' || name.startsWith('.env.')
  const extension = path.extname(filePath).toLowerCase()
  if (!isEnv && !textExtensions.has(extension)) return

  const content = await readFile(filePath, 'utf8')

  if (isEnv) {
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)
      if (match && forbiddenVariables.has(match[1])) {
        report(filePath, `${match[1]} must not be present here`)
      }
    }
  }

  if (/sk_(test|live)_[A-Za-z0-9]/.test(content)) {
    report(filePath, 'Clerk secret key marker')
  }
  if (/whsec_[A-Za-z0-9]/.test(content)) {
    report(filePath, 'webhook secret marker')
  }
  for (const variable of forbiddenVariables) {
    if (content.includes(variable)) {
      report(filePath, `${variable} name found in a frontend file`)
    }
  }
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (ignoredDirectories.has(entry.name)) continue
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      await walk(fullPath)
    } else if (entry.isFile()) {
      await scanFile(fullPath)
    }
  }
}

await walk(root)

if (findings.length > 0) {
  console.error('Frontend secret scan failed:')
  for (const finding of findings) console.error(`- ${finding}`)
  console.error('Values were not printed. Remove or rotate the affected secret.')
  process.exit(1)
}

console.log('Frontend secret scan passed.')

import { randomUUID } from 'crypto'
import { promises as fs, existsSync } from 'fs'
import { basename, join } from 'path'
import { app } from 'electron'
import { HOME } from './collectors/util'
import type { AgentType, Vault, VaultConfig } from './types'

const DEFAULT_VAULT_ID = 'default'

/** Data subdirectories each agent stores its sessions under, relative to home. */
const AGENT_DATA_DIRS: Record<AgentType, string> = {
  claude: join('.claude', 'projects'),
  codex: join('.codex', 'sessions'),
  opencode: join('.local', 'share', 'opencode', 'storage'),
  amp: join('.local', 'share', 'amp', 'threads'),
  pi: join('.pi', 'agent', 'sessions')
}

function configPath(): string {
  return join(app.getPath('userData'), 'vaults.json')
}

function defaultVault(): Vault {
  return { id: DEFAULT_VAULT_ID, name: 'Home', home: HOME, removable: false }
}

let cache: VaultConfig | null = null

function normalize(raw: Partial<VaultConfig> | null): VaultConfig {
  const vaults = Array.isArray(raw?.vaults) ? raw!.vaults.filter((v) => v && v.id && v.home) : []
  // The built-in local vault is always present, always first, always up to date.
  const rest = vaults.filter((v) => v.id !== DEFAULT_VAULT_ID)
  const all = [defaultVault(), ...rest]
  let activeVaultId = raw?.activeVaultId ?? DEFAULT_VAULT_ID
  if (!all.some((v) => v.id === activeVaultId)) activeVaultId = DEFAULT_VAULT_ID
  return { vaults: all, activeVaultId }
}

async function load(): Promise<VaultConfig> {
  if (cache) return cache
  try {
    const raw = JSON.parse(await fs.readFile(configPath(), 'utf8'))
    cache = normalize(raw)
  } catch {
    cache = normalize(null)
  }
  return cache
}

async function persist(config: VaultConfig): Promise<void> {
  cache = config
  try {
    await fs.writeFile(configPath(), JSON.stringify(config, null, 2))
  } catch (err) {
    console.error('[vaults] failed to persist config:', err)
  }
}

export async function getConfig(): Promise<VaultConfig> {
  return load()
}

export async function getVaults(): Promise<Vault[]> {
  return (await load()).vaults
}

export async function getActiveVaultId(): Promise<string> {
  return (await load()).activeVaultId
}

/**
 * Which agents have data under `dir`. An empty result means the directory
 * doesn't look like an agent home and shouldn't be added as a vault.
 */
export function detectAgents(dir: string): AgentType[] {
  return (Object.keys(AGENT_DATA_DIRS) as AgentType[]).filter((a) =>
    existsSync(join(dir, AGENT_DATA_DIRS[a]))
  )
}

export async function setActiveVault(id: string): Promise<VaultConfig> {
  const config = await load()
  if (config.vaults.some((v) => v.id === id)) {
    await persist({ ...config, activeVaultId: id })
  }
  return cache!
}

export interface AddVaultResult {
  config?: VaultConfig
  vault?: Vault
  error?: string
}

export async function addVault(home: string): Promise<AddVaultResult> {
  const config = await load()
  if (config.vaults.some((v) => v.home === home)) {
    return { error: '该目录已经是一个 vault' }
  }
  const agents = detectAgents(home)
  if (agents.length === 0) {
    return { error: '该目录下未发现任何 agent 会话数据（.claude / .codex / .local/share/opencode 等）' }
  }
  const vault: Vault = { id: randomUUID(), name: basename(home) || home, home, removable: true }
  const next: VaultConfig = { vaults: [...config.vaults, vault], activeVaultId: config.activeVaultId }
  await persist(next)
  return { config: next, vault }
}

/**
 * Remove a vault. The built-in default can't be removed. If the removed vault
 * was active, the active selection falls back to the default vault.
 */
export async function removeVault(id: string): Promise<VaultConfig> {
  const config = await load()
  const vault = config.vaults.find((v) => v.id === id)
  if (!vault || !vault.removable) return config
  const vaults = config.vaults.filter((v) => v.id !== id)
  const activeVaultId = config.activeVaultId === id ? DEFAULT_VAULT_ID : config.activeVaultId
  const next: VaultConfig = { vaults, activeVaultId }
  await persist(next)
  return next
}

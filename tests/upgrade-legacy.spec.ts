import { describe, expect, it } from 'vitest'
import { renderCaddyfile, renderCaddyUnit } from '../src/installer/caddy.js'
import { ExitCode, type InstallState } from '../src/installer/types.js'
import { runCli } from '../src/cli.js'
import { FakeCliIo, FakeInstallerHost } from './installer-helpers.js'

const STATE = '/etc/dsh-auth/install-state.json'
const ENVIRONMENT = '/etc/dsh-auth/dsh-auth.env'
const CADDY = '/etc/dsh-auth/Caddyfile'

async function legacyHost(): Promise<FakeInstallerHost> {
  const host = new FakeInstallerHost()
  host.withSystemdService()
  host.installCliPackage('0.2.3')
  host.installBundledCaddy()
  const io = new FakeCliIo(false, [], [], 'synthetic-long-password')
  const rc = await runCli(['setup', '--json', '--non-interactive', '--mode', 'http',
    '--listen-address', '10.0.0.20', '--dsh-service', 'dsh-web.service',
    '--admin-bootstrap', 'password', '--admin-username', 'admin', '--login-token', 'disabled',
    '--package', 'dsh-auth@0.2.3', '--password-stdin'], io, host)
  expect(rc, io.outputs.join('')).toBe(0)
  // Seed the released template; this process runs the newer setup implementation.
  const state = JSON.parse(host.readFile(STATE)) as InstallState
  host.addFile(CADDY, renderCaddyfile(state.request, true, state.paths.caddyStateDirectory, '0.2.3'), 0o644)
  host.addFile(state.paths.caddyUnitFile, renderCaddyUnit(state.request, state.paths, '0.2.3'), 0o644)
  expect(host.readFile(ENVIRONMENT)).not.toContain('DSH_AUTH_NATIVE_AUTH_BRIDGE')
  expect(host.readFile(CADDY)).not.toContain('X-Dsh-Auth-Subject')
  return host
}

const UPGRADE = ['upgrade', '--json', '--non-interactive', '--authorize-upgrade']

describe('released 0.2.3 image configuration', () => {
  it('recognizes the exact old configuration and upgrades environment and edge together', async () => {
    const host = await legacyHost()
    host.promoteCliPackage('0.3.0')
    const io = new FakeCliIo(false)
    expect(await runCli(UPGRADE, io, host), io.outputs.join('')).toBe(0)
    expect(host.readFile(ENVIRONMENT)).toContain('DSH_AUTH_NATIVE_AUTH_BRIDGE=true')
    expect(host.readFile(CADDY)).toContain('X-Dsh-Auth-Subject')
    expect(await runCli(['doctor', '--json'], new FakeCliIo(false), host)).toBe(0)
  })

  it('restores both old files byte-for-byte when validating the new edge fails', async () => {
    const host = await legacyHost()
    const environment = host.readFile(ENVIRONMENT)
    const caddy = host.readFile(CADDY)
    const unitPath = (JSON.parse(host.readFile(STATE)) as InstallState).paths.caddyUnitFile
    const unit = host.readFile(unitPath)
    host.promoteCliPackage('0.3.0')
    const previous = host.commandHandler
    let failed = false
    host.commandHandler = command => {
      if (!failed && command.args[0] === 'validate' && (JSON.parse(host.readFile(STATE)) as InstallState).status === 'installing') {
        failed = true
        return { status: 1, stdout: '', stderr: 'synthetic validation failure' }
      }
      return previous(command)
    }
    const io = new FakeCliIo(false)
    expect(await runCli(UPGRADE, io, host), io.outputs.join('')).toBe(6)
    expect(host.readFile(ENVIRONMENT)).toBe(environment)
    expect(host.readFile(CADDY)).toBe(caddy)
    expect(host.readFile(unitPath)).toBe(unit)
    expect(await runCli(['doctor', '--json'], new FakeCliIo(false), host)).toBe(0)
  })

  it('still rejects actual operator drift before mutating the installation', async () => {
    const host = await legacyHost()
    host.addFile(CADDY, host.readFile(CADDY) + '\n# unexpected edit\n')
    const before = host.readFile(STATE)
    host.promoteCliPackage('0.3.0')
    const io = new FakeCliIo(false)
    expect(await runCli(UPGRADE, io, host)).toBe(ExitCode.unhealthy)
    expect(io.outputs.join('')).toContain('MANAGED_CONTENT_INVALID')
    expect(host.readFile(STATE)).toBe(before)
  })
})

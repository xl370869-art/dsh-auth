import { describe, expect, it } from 'vitest'
import { isOfflinePluginSpec, offlinePluginAddFlags, profilePluginArgs } from '../src/installer/profile-package.js'

describe('offline plugin specs', () => {
  it('keeps absolute tarball paths and pnpm file: specs offline', () => {
    expect(isOfflinePluginSpec('/artifacts/dsh-auth-0.2.2.tgz')).toBe(true)
    expect(isOfflinePluginSpec('file:/artifacts/dsh-auth-0.2.2.tgz')).toBe(true)
    expect(isOfflinePluginSpec('dsh-auth@0.2.2')).toBe(false)
    expect(offlinePluginAddFlags('file:/artifacts/dsh-auth-0.2.2.tgz')).toEqual([
      '--offline',
      '--config.auto-install-peers=false',
    ])
    expect(offlinePluginAddFlags('dsh-auth@0.2.2')).toEqual([])
  })
})


it('builds workspace-safe add and rollback remove commands without requiring an old profile to be a workspace', () => {
  expect(profilePluginArgs('web', 'add', 'dsh-auth@0.3.0')).toEqual([
    'plugin', '--profile', 'web', 'add', '--config.ignore-workspace-root-check=true', 'dsh-auth@0.3.0',
  ])
  expect(profilePluginArgs('web', 'remove', 'dsh-auth')).toEqual([
    'plugin', '--profile', 'web', 'remove', '--config.ignore-workspace-root-check=true', 'dsh-auth',
  ])
})

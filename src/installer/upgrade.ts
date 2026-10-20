import { join } from 'node:path'
import { computePackageIdentity, resolveCliPackageIdentity, type PackageIdentity } from './build-identity.js'
import { CADDY_VERSION, renderCaddyfile, renderCaddyUnit, resolveCaddyPackage, type CaddyPackage } from './caddy.js'
import { renderEnvironmentFile, serializeInstallState } from './config-files.js'
import { buildDoctorPlan, DEFAULT_STATE_FILE } from './doctor.js'
import { InstallerError } from './errors.js'
import { dshEnvironment, profileCommand, runChecked, systemctlPath } from './executor.js'
import { readInstallState } from './plan.js'
import { profilePluginArgs, profileBundleRoot } from './profile-package.js'
import { ExitCode, type Diagnostic, type InstallationPlan, type InstallState, type InstallerHost, type PlanAction } from './types.js'

/** Crash journal for one in-flight upgrade transaction; persisted inside the ownership record. */
export interface UpgradeJournal {
  readonly fromVersion: string
  readonly fromSpec: string
  readonly fromBuildIdentity: string
  readonly targetVersion: string
  readonly targetBuildIdentity: string
  readonly phase: 'bundle' | 'caddy' | 'quiescing' | 'services'
  readonly coordinatedRuntime?: true
}

type UpgradableState = InstallState & { readonly upgrade?: UpgradeJournal | undefined }

function authStateBackupPath(state: UpgradableState): string {
  return `${state.paths.stateFile}.auth-state-backup`
}

/** Validated upgrade context shared by the plan and the executor. */
export interface UpgradeContext {
  readonly state: UpgradableState
  readonly target: PackageIdentity
  readonly targetSpec: string
  readonly recovering: boolean
  readonly coordinatedRuntime?: boolean
}

/** Protocol supported by trusted runtime coordinators; older bundles must not be used. */
export const RUNTIME_UPGRADE_PROTOCOL = 1

/** Trusted embedding installer participant; operations must be idempotent for journal recovery. */
export interface RuntimeUpgradeParticipant {
  /** Activate the prepared runtime and migrate its plugins while DSH is stopped. */
  activate(): void
  /** Restore the prior runtime and profile before reinstalling the recorded auth bundle. */
  restore(): void
  /** Verify the running runtime before the authentication transaction commits. */
  verify(): void
}

interface VersionParts {
  readonly release: readonly number[]
  readonly prerelease: readonly string[]
}

function parseVersion(version: string, label: string): VersionParts {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u.exec(version)
  if (match === null) throw new InstallerError(`${label} is not a comparable release version: ${version}`, ExitCode.conflict)
  return {
    release: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

function compareVersionIdentifiers(left: string, right: string): number {
  const leftNumeric = /^[0-9]+$/u.test(left)
  const rightNumeric = /^[0-9]+$/u.test(right)
  if (leftNumeric && rightNumeric) return Math.sign(Number(left) - Number(right))
  if (leftNumeric) return -1
  if (rightNumeric) return 1
  return left < right ? -1 : left > right ? 1 : 0
}

/** Return positive when `version` is newer than `than`, negative when older, zero when equal. */
export function compareVersions(version: string, than: string, label = 'version'): number {
  const left = parseVersion(version, label)
  const right = parseVersion(than, label)
  for (let index = 0; index < 3; index += 1) {
    const compared = Math.sign((left.release[index] ?? 0) - (right.release[index] ?? 0))
    if (compared !== 0) return compared
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0
  if (left.prerelease.length === 0) return 1
  if (right.prerelease.length === 0) return -1
  const shared = Math.min(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < shared; index += 1) {
    const compared = compareVersionIdentifiers(left.prerelease[index] ?? '', right.prerelease[index] ?? '')
    if (compared !== 0) return compared
  }
  return Math.sign(left.prerelease.length - right.prerelease.length)
}

function action(id: string, description: string, extra: Partial<PlanAction> = {}): PlanAction {
  return { id, kind: 'check', description, ...extra }
}

function commandAction(id: string, description: string, executable: string, args: readonly string[]): PlanAction {
  return { id, kind: 'run-command', description, command: { executable, args } }
}

function upgradeBlocked(diagnostics: readonly Diagnostic[]): InstallationPlan {
  return { schemaVersion: 2, operation: 'upgrade', mode: 'system', status: 'blocked', actions: [], diagnostics }
}

function readUpgradeState(host: InstallerHost): UpgradableState | undefined {
  const state = readInstallState(host, DEFAULT_STATE_FILE)
  if (state === undefined) return undefined
  const journal = (state as { readonly upgrade?: unknown }).upgrade
  if (journal === undefined) return state
  if (typeof journal !== 'object' || journal === null) throw new InstallerError('upgrade journal is invalid', ExitCode.conflict)
  const record = journal as Record<string, unknown>
  const phase = record.phase
  if (
    typeof record.fromVersion !== 'string' || typeof record.fromSpec !== 'string' || typeof record.fromBuildIdentity !== 'string'
    || typeof record.targetVersion !== 'string' || typeof record.targetBuildIdentity !== 'string'
    || (record.coordinatedRuntime !== undefined && record.coordinatedRuntime !== true)
    || (phase !== 'bundle' && phase !== 'caddy' && phase !== 'quiescing' && phase !== 'services')
  ) {
    throw new InstallerError('upgrade journal is invalid', ExitCode.conflict, [{
      code: 'INVALID_INSTALL_STATE',
      severity: 'error',
      message: 'The ownership record contains an unreadable upgrade journal.',
      remediation: 'Inspect /etc/dsh-auth/install-state.json and recover manually before retrying.',
    }])
  }
  return state
}

/**
 * Validate that an upgrade may start: a healthy, schema v2, system-mode
 * installation with recorded bundle facts, and a strictly newer target that
 * is exactly this trusted CLI's build.
 */
export function prepareUpgrade(host: InstallerHost, options: { readonly packageSpec?: string; readonly coordinatedRuntime?: boolean }): { readonly plan: InstallationPlan; readonly context?: UpgradeContext } {
  const state = readUpgradeState(host)
  if (state === undefined) {
    return { plan: upgradeBlocked([{ code: 'INSTALLATION_NOT_FOUND', severity: 'error', message: 'No managed installation exists.', remediation: 'Run dsh-auth setup first; upgrade only maintains an existing v2 installation.' }]) }
  }
  if (state.request.outputDirectory !== undefined) {
    throw new InstallerError('system upgrade refuses an output-mode ownership record', ExitCode.conflict)
  }
  const recovering = state.upgrade !== undefined
  if (state.status === 'installing' && !recovering) {
    return { plan: upgradeBlocked([{ code: 'INSTALLATION_INTERRUPTED', severity: 'error', message: 'The ownership record shows an interrupted setup.', remediation: 'Rerun dsh-auth setup with the same options to perform recorded recovery before upgrading.' }]) }
  }
  if (!recovering) {
    const health = buildDoctorPlan(host).plan.diagnostics.filter(entry => entry.severity === 'error')
    if (health.length > 0) return { plan: upgradeBlocked(health) }
  }
  const target = resolveCliPackageIdentity(host)
  if (state.profilePackageVersion === undefined || state.profilePackageSpec === undefined || state.profilePackageBuildIdentity === undefined) {
    throw new InstallerError('the ownership record predates managed upgrades', ExitCode.conflict, [{
      code: 'UPGRADE_RECORD_INCOMPLETE',
      severity: 'error',
      message: 'The ownership record does not contain the installed bundle build identity.',
      remediation: 'Uninstall and rerun setup so the record captures the bundle build identity, then upgrade.',
    }])
  }
  const sameBuildRuntimeUpgrade = options.coordinatedRuntime === true
    && target.version === state.profilePackageVersion && target.buildIdentity === state.profilePackageBuildIdentity
  if (compareVersions(target.version, state.profilePackageVersion, 'target version') <= 0 && !sameBuildRuntimeUpgrade) {
    throw new InstallerError('upgrade requires a strictly newer target version', ExitCode.conflict, [{
      code: 'UPGRADE_VERSION_NOT_HIGHER',
      severity: 'error',
      message: `This CLI is dsh-auth ${target.version}; the installation already records ${state.profilePackageVersion}.`,
      remediation: 'Install the newer dsh-auth globally first; downgrades and same-version reinstalls are not supported.',
    }])
  }
  const targetSpec = options.packageSpec ?? `dsh-auth@${target.version}`
  const actions: PlanAction[] = [
    ...(recovering ? [action('recover-interrupted-upgrade', 'Roll back the recorded interrupted upgrade before retrying.')] : []),
    action('install-profile-package', `Update the profile bundle to dsh-auth ${target.version}, the build of this CLI.`, { kind: 'install-package' }),
    action('update-caddy-binary', "Replace the managed Caddy binary with this build's checksum-verified bundle.", { kind: 'write-file', target: state.paths.caddyBinary }),
    action('rewrite-environment', "Rewrite the environment file's expected-version marker.", { kind: 'write-file', target: state.paths.environmentFile }),
    commandAction('caddy-validate', 'Validate the managed Caddy configuration before service restart.', state.paths.caddyBinary, ['validate', '--config', state.paths.caddyfile]),
    commandAction('restart-dsh', 'Restart the DSH service to load the upgraded bundle.', '/usr/bin/systemctl', ['restart', state.dshService]),
    commandAction('restart-caddy', 'Restart the owned Caddy edge on the upgraded binary.', '/usr/bin/systemctl', ['restart', 'dsh-auth-caddy.service']),
  ]
  return {
    plan: { schemaVersion: 2, operation: 'upgrade', mode: 'system', status: 'ready', actions, diagnostics: [] },
    context: { state, target, targetSpec, recovering, coordinatedRuntime: options.coordinatedRuntime === true },
  }
}

function updateState(host: InstallerHost, state: UpgradableState, changes: Partial<UpgradableState>): UpgradableState {
  const updated = { ...state, ...changes }
  host.replaceFile(state.paths.stateFile, serializeInstallState(updated), 0o600)
  return updated
}

function profileManifestSpec(host: InstallerHost, state: UpgradableState): string {
  const manifestPath = join(state.dshHome, 'profiles', state.request.profile, 'package.json')
  const manifest = JSON.parse(host.readFile(manifestPath)) as { readonly dependencies?: Record<string, unknown> }
  const spec = manifest.dependencies?.['dsh-auth']
  if (typeof spec !== 'string' || spec.length === 0) throw new InstallerError('the profile manifest lost its dsh-auth dependency', ExitCode.execution)
  return spec
}

function bundleIdentity(host: InstallerHost, state: UpgradableState): { readonly identity: PackageIdentity; readonly path: string } {
  const root = host.realpath(profileBundleRoot(state.dshHome, state.request.profile))
  return { identity: computePackageIdentity(host, root, 'profile bundle'), path: root }
}

function pluginAddArgs(state: UpgradableState, spec: string): readonly string[] {
  return profilePluginArgs(state.request.profile, 'add', spec)
}

function replaceManagedBinary(host: InstallerHost, source: CaddyPackage, managedPath: string): void {
  const staged = `${managedPath}.upgrade`
  if (host.fileExists(staged)) host.removeFile(staged)
  host.writeNewFile(staged, host.readFileBytes(source.executable), 0o755)
  if (host.fileExists(managedPath)) host.removeFile(managedPath)
  host.renameFile(staged, managedPath)
}

function replaceConfiguration(host: InstallerHost, state: UpgradableState, version: string): void {
  host.replaceFile(state.paths.environmentFile, renderEnvironmentFile(state.request, state.paths, version), 0o640)
  // replaceFile uses a fresh root-owned inode; restore the service-group owner
  // required for the DSH unit to read its EnvironmentFile and for doctor to stay healthy.
  host.chown(state.paths.environmentFile, 0, state.dshGid)
  host.chmod(state.paths.environmentFile, 0o640)
  host.replaceFile(state.paths.caddyfile, renderCaddyfile(state.request, true, state.paths.caddyStateDirectory, version), 0o644)
  host.chown(state.paths.caddyfile, 0, 0)
  host.chmod(state.paths.caddyfile, 0o644)
  host.replaceFile(state.paths.caddyUnitFile, renderCaddyUnit(state.request, state.paths, version), 0o644)
  host.chown(state.paths.caddyUnitFile, 0, 0)
  host.chmod(state.paths.caddyUnitFile, 0o644)
}

function restartServices(host: InstallerHost, state: UpgradableState): void {
  const systemctl = systemctlPath(host)
  runChecked(host, { executable: systemctl, args: ['daemon-reload'] }, 'UPGRADE_DAEMON_RELOAD_FAILED')
  runChecked(host, { executable: systemctl, args: ['restart', state.dshService] }, 'UPGRADE_DSH_RESTART_FAILED')
  runChecked(host, { executable: systemctl, args: ['restart', 'dsh-auth-caddy.service'] }, 'UPGRADE_CADDY_RESTART_FAILED')
}

function snapshotAuthState(host: InstallerHost, state: UpgradableState): void {
  const source = state.paths.authStateFile
  const backup = authStateBackupPath(state)
  if (!host.regularFile(source) || host.realpath(source) !== source) {
    throw new InstallerError('managed authentication state cannot be snapshotted', ExitCode.conflict)
  }
  const stat = host.stat(source)
  if (stat.uid !== state.dshUid || stat.gid !== state.dshGid || (stat.mode & 0o777) !== 0o600) {
    throw new InstallerError('managed authentication state ownership or permissions have drifted', ExitCode.conflict)
  }
  if (host.fileExists(backup)) host.removeFile(backup)
  host.writeNewFile(backup, host.readFileBytes(source), 0o600)
  host.chown(backup, 0, 0)
  host.chmod(backup, 0o600)
  host.fsyncFile?.(backup)
  host.fsyncDirectory?.(state.paths.configDirectory)
}

function restoreAuthState(host: InstallerHost, state: UpgradableState): void {
  const backup = authStateBackupPath(state)
  if (!host.regularFile(backup) || host.realpath(backup) !== backup) {
    throw new InstallerError('upgrade authentication-state backup is missing', ExitCode.execution)
  }
  host.replaceFile(state.paths.authStateFile, host.readFile(backup), 0o600)
  host.chown(state.paths.authStateFile, state.dshUid, state.dshGid)
  host.chmod(state.paths.authStateFile, 0o600)
  host.fsyncFile?.(state.paths.authStateFile)
  host.fsyncDirectory?.(state.paths.authStateDirectory)
}

function removeAuthStateBackup(host: InstallerHost, state: UpgradableState): void {
  const backup = authStateBackupPath(state)
  if (host.fileExists(backup)) {
    host.removeFile(backup)
    host.fsyncDirectory?.(state.paths.configDirectory)
  }
}

/** Reinstall the recorded pre-upgrade bundle and verify its build identity. */
function restoreBundle(host: InstallerHost, state: UpgradableState, spec: string, expectedIdentity: string): CaddyPackage {
  runChecked(host, profileCommand(host, state, pluginAddArgs(state, spec)), 'UPGRADE_RESTORE_BUNDLE_FAILED', dshEnvironment(state))
  const { identity } = bundleIdentity(host, state)
  if (identity.buildIdentity !== expectedIdentity) {
    throw new InstallerError('the restored profile bundle does not match the recorded build', ExitCode.execution, [{
      code: 'UPGRADE_RESTORE_BUILD_MISMATCH',
      severity: 'error',
      message: `dsh plugin add ${spec} resolved to a different dsh-auth build than the ownership record.`,
      remediation: `Pin the recorded build manually, for example dsh plugin --profile ${state.request.profile} add dsh-auth@${state.profilePackageVersion ?? ''} from the original trusted source, rerun dsh-auth doctor until healthy, then rerun dsh-auth upgrade.`,
    }])
  }
  const vendorRoot = join(host.realpath(profileBundleRoot(state.dshHome, state.request.profile)), 'vendor', 'caddy')
  return resolveCaddyPackage(host, vendorRoot)
}

/** Restore the recorded pre-upgrade bundle, Caddy binary, environment, record, and services. */
function rollbackUpgrade(host: InstallerHost, state: UpgradableState, runtime?: RuntimeUpgradeParticipant): UpgradableState {
  const journal = state.upgrade
  if (journal === undefined) throw new InstallerError('rollback requires an upgrade journal', ExitCode.execution)
  if (journal.coordinatedRuntime && runtime === undefined) {
    throw new InstallerError('runtime upgrade recovery requires the original coordinating installer', ExitCode.conflict)
  }
  if (journal.phase === 'services' || journal.coordinatedRuntime) {
    runChecked(host, { executable: systemctlPath(host), args: ['stop', state.dshService] }, 'UPGRADE_ROLLBACK_DSH_STOP_FAILED')
  }
  if (journal.coordinatedRuntime) runtime?.restore()
  const restoredCaddy = restoreBundle(host, state, journal.fromSpec, journal.fromBuildIdentity)
  let caddyFields: Partial<UpgradableState> = {}
  if (journal.phase !== 'bundle') {
    replaceManagedBinary(host, restoredCaddy, state.paths.caddyBinary)
    caddyFields = { caddyVersion: CADDY_VERSION, caddyBinarySha256: restoredCaddy.binarySha256 }
  }
  if (journal.phase === 'quiescing' || journal.phase === 'services') {
    if (journal.phase === 'services') restoreAuthState(host, state)
    replaceConfiguration(host, state, journal.fromVersion)
  }
  if (journal.phase === 'quiescing' || journal.phase === 'services' || journal.coordinatedRuntime) {
    restartServices(host, state)
  }
  const restored = updateState(host, state, {
    status: 'installed',
    upgrade: undefined,
    profilePackageVersion: journal.fromVersion,
    profilePackageSpec: journal.fromSpec,
    profilePackageBuildIdentity: journal.fromBuildIdentity,
    ...caddyFields,
  })
  removeAuthStateBackup(host, state)
  return restored
}

/** Recover only an interrupted coordinated transaction, using its exact trusted CLI build. */
export function recoverCoordinatedUpgrade(host: InstallerHost, runtime: RuntimeUpgradeParticipant): void {
  const state = readUpgradeState(host)
  if (state?.upgrade?.coordinatedRuntime !== true) {
    throw new InstallerError('no interrupted coordinated runtime upgrade exists', ExitCode.conflict)
  }
  if (resolveCliPackageIdentity(host).buildIdentity !== state.upgrade.targetBuildIdentity) {
    throw new InstallerError('recovery requires the recorded target CLI build', ExitCode.conflict)
  }
  rollbackUpgrade(host, state, runtime)
}

/** Execute one validated upgrade transaction with full rollback on failure. */
export function executeUpgrade(host: InstallerHost, context: UpgradeContext, runtime?: RuntimeUpgradeParticipant): void {
  if (context.coordinatedRuntime && runtime === undefined) {
    throw new InstallerError('coordinated runtime upgrade requires a runtime participant', ExitCode.conflict)
  }
  let state = context.state
  if (context.recovering) state = rollbackUpgrade(host, state, runtime)
  const journal: UpgradeJournal = {
    fromVersion: state.profilePackageVersion ?? '',
    fromSpec: state.profilePackageSpec ?? '',
    fromBuildIdentity: state.profilePackageBuildIdentity ?? '',
    targetVersion: context.target.version,
    targetBuildIdentity: context.target.buildIdentity,
    phase: 'bundle',
    ...(runtime === undefined ? {} : { coordinatedRuntime: true }),
  }
  state = updateState(host, state, { status: 'installing', upgrade: journal })
  try {
    if (runtime !== undefined) {
      runChecked(host, { executable: systemctlPath(host), args: ['stop', state.dshService] }, 'UPGRADE_RUNTIME_QUIESCE_FAILED')
      runtime.activate()
    }
    runChecked(host, profileCommand(host, state, pluginAddArgs(state, context.targetSpec)), 'UPGRADE_BUNDLE_INSTALL_FAILED', dshEnvironment(state))
    const installed = bundleIdentity(host, state)
    if (installed.identity.version !== context.target.version || installed.identity.buildIdentity !== context.target.buildIdentity) {
      throw new InstallerError("the upgraded profile bundle is not this CLI's build", ExitCode.execution, [{
        code: 'UPGRADE_TARGET_BUILD_MISMATCH',
        severity: 'error',
        message: `dsh plugin add ${context.targetSpec} did not resolve to the dsh-auth ${context.target.version} build of this CLI.`,
        remediation: 'Upgrade reverts the profile bundle; pin a trusted source with --package or publish the matching build.',
      }])
    }
    state = updateState(host, state, { upgrade: { ...journal, phase: 'caddy' } })
    const caddy = resolveCaddyPackage(host)
    replaceManagedBinary(host, caddy, state.paths.caddyBinary)
    state = updateState(host, state, { upgrade: { ...journal, phase: 'quiescing' } })
    replaceConfiguration(host, state, context.target.version)
    runChecked(host, { executable: state.paths.caddyBinary, args: ['validate', '--config', state.paths.caddyfile] }, 'UPGRADE_CADDY_VALIDATE_FAILED')
    runChecked(host, { executable: systemctlPath(host), args: ['stop', state.dshService] }, 'UPGRADE_DSH_QUIESCE_FAILED')
    snapshotAuthState(host, state)
    state = updateState(host, state, { upgrade: { ...journal, phase: 'services' } })
    restartServices(host, state)
    runtime?.verify()
    state = updateState(host, state, {
      status: 'installed',
      upgrade: undefined,
      profilePackageVersion: context.target.version,
      profilePackageSpec: profileManifestSpec(host, state),
      profilePackageBuildIdentity: context.target.buildIdentity,
      profilePackagePath: installed.path,
      caddyVersion: CADDY_VERSION,
      caddyBinarySha256: caddy.binarySha256,
    })
  } catch (error) {
    try {
      rollbackUpgrade(host, readUpgradeState(host) ?? state, runtime)
    } catch (rollbackError) {
      throw new InstallerError('upgrade failed and rollback also failed', ExitCode.execution, [
        { code: 'UPGRADE_FAILED', severity: 'error', message: error instanceof Error ? error.message : String(error) },
        { code: 'ROLLBACK_FAILED', severity: 'error', message: rollbackError instanceof Error ? rollbackError.message : String(rollbackError), remediation: `Run dsh-auth doctor and inspect the ownership record at ${state.paths.stateFile}.` },
      ])
    }
    throw error
  }
  removeAuthStateBackup(host, state)
}

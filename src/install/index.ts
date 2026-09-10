/**
 * The install seam (barrel): the ONE executor, the ONE shell renderer and
 * the ONE tolerance resolver over the pack-declared install strategies
 * (`languages/capabilities/install-strategy.ts`).
 */
export {
  runInstall,
  classifyInstallFailure,
  describeInfrastructure,
  describeUnauthorizedFallback,
  type InstallAttempt,
  type FallbackTaken,
  type InstallFailureClass,
  type InstallRunResult,
} from './run';
export {
  resolveTolerances,
  defaultResolvedTolerances,
  describeTolerances,
  TOLERATE_POLICY_PATH,
  type ResolvedTolerances,
  type ToleranceSource,
} from './tolerances';
export {
  INSTALL_DEPS_PLACEHOLDER,
  INSTALL_OUTCOME_RECORD,
  INSTALL_OUTCOME_LOG,
  NO_MANIFEST_INSTALL,
  SHELL_FALLBACK_FN,
  ciInstallVariants,
  ciInstallStrategy,
  renderInstallLine,
  renderInstallDependenciesShell,
} from './shell';
export {
  classifyInstallLog,
  readInstallOutcome,
  writeInstallOutcome,
  renderInstallOutcomeComment,
  summarizeInstallOutcome,
  type InstallOutcomeRecord,
  type InstallOutcomeComment,
} from './outcome';

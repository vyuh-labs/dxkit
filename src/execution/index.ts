/**
 * The execution-environment platform (CLAUDE.md Rule 20) — barrel.
 *
 * Requirement (repo-intrinsic, pack-declared) vs environment (host-intrinsic),
 * compared by the ONE predicate `unmetRequirement`. The toolchain registry
 * declares per-host provisioning for the ambient SDKs requirements name.
 */

export {
  unmetRequirement,
  describeUnmetRequirement,
  type ExecutionHost,
  type HostRequirement,
  type ExecutionRequirement,
  type ExecutionRequirementFor,
  type ExecutionEnvironment,
  type UnmetRequirement,
} from './requirement';

export { currentEnvironment, hostOf } from './environment';

export {
  TOOLCHAIN_DEFS,
  toolchainPresent,
  toolchainInstallHint,
  toolchainHealthProblem,
  toolchainForBinary,
  classifyEnvironmentFailure,
  type ToolchainId,
  type ToolchainDef,
  type ToolchainHealth,
  type ToolchainProblem,
  type EnvironmentFailureSignature,
  type ProbeExec,
} from './toolchains';

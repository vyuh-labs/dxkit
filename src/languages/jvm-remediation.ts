/**
 * Shared JVM remediation declarations for the Java and Kotlin packs
 * (CLAUDE.md Rule 2, the jvm-build.ts sibling): both packs run on the same
 * two build systems (Maven, Gradle), so the dependency-shaped exemptions
 * are stated once and each pack contributes only its own lint-fix answer.
 *
 * Why these are EXEMPTIONS, not capabilities (each names the future
 * mechanism, per the declared-exemption discipline):
 *
 *   - resyncLockfile: Maven has no lockfile at all. Gradle dependency
 *     locking is a per-configuration OPT-IN whose semantics (which
 *     configurations are locked, the lock mode) live in the build script;
 *     a mechanical `--write-locks` run could silently widen or narrow the
 *     locked set. Until dxkit can read those semantics, a resync here
 *     cannot be both mechanical and honest.
 *   - pinTransitive: the JVM pin is a build-file edit
 *     (`dependencyManagement` in pom.xml, a `constraints` block in
 *     Gradle), and build files are executable configuration a mechanical
 *     edit can corrupt in ways the verify-and-discard cannot fully repair
 *     (the tree is recoverable; a customer's trust in their pom is not).
 *     The pin graduates if a provably pure build-file edit lands; until
 *     then the order ships to the agent tier with this reason disclosed.
 *   - declareDependency: an unresolved JVM import names a package
 *     namespace, and a namespace does not identify Maven coordinates (a
 *     groupId:artifactId cannot be derived from it mechanically); the
 *     compiler is also the resolution floor here (no resolutionCheck), so
 *     no unresolved-import orders are minted in the first place.
 */
import type { RemediationRider, RemediationSupport } from './capabilities/remediation';

export function jvmRemediation(lintFix: RemediationRider): RemediationSupport {
  return {
    resyncLockfile: {
      kind: 'exemption',
      reason:
        'maven has no lockfile, and gradle dependency locking is a per-configuration opt-in ' +
        'whose semantics live in the build script (a mechanical --write-locks run could ' +
        'silently change the locked set); these orders stay on the agent tier',
    },
    pinTransitive: {
      kind: 'exemption',
      reason:
        'a JVM transitive pin is a build-file edit (dependencyManagement in pom.xml, a ' +
        'gradle constraints block), and build files are executable configuration a ' +
        'mechanical edit can corrupt; the pin stays on the agent tier until a provably ' +
        'pure build-file edit exists',
    },
    declareDependency: {
      kind: 'exemption',
      reason:
        'an unresolved JVM import names a package namespace, which does not identify maven ' +
        'coordinates (groupId:artifactId cannot be derived from it mechanically), and the ' +
        'compiler is the resolution floor here; these orders stay on the agent tier',
    },
    lintFix,
  };
}

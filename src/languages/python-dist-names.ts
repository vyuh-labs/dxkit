/**
 * How a python IMPORT name relates to a PyPI DISTRIBUTION name: the ONE
 * home of the curated alias table (the `yaml` → `pyyaml`, `PIL` → `pillow`
 * class, where the module a file imports is not the distribution pip
 * installs) plus the PEP 503 name normalization. Consumed by BOTH the
 * import-resolution check (does a declared distribution answer this
 * import?) and the declare-dependency remediation capability (which
 * distribution would declaring this import install?): one table, two
 * consumers, per CLAUDE.md Rule 2.30.
 */

/** Known import-name → distribution-name divergences. Multiple candidates
 *  mean the import is served by genuinely DIFFERENT distributions (or by
 *  spelling variants that fold together under PEP 503). Curated, biased
 *  small: an absent entry means "the import name IS the distribution
 *  name", the ecosystem's dominant convention. */
export const PY_MODULE_DIST_ALIASES: Readonly<Record<string, readonly string[]>> = {
  yaml: ['pyyaml'],
  PIL: ['pillow'],
  sklearn: ['scikit-learn', 'scikit_learn'],
  bs4: ['beautifulsoup4'],
  cv2: ['opencv-python', 'opencv-python-headless', 'opencv_python'],
  dotenv: ['python-dotenv', 'python_dotenv'],
  dateutil: ['python-dateutil', 'python_dateutil'],
  jose: ['python-jose', 'python_jose'],
  jwt: ['pyjwt'],
  Crypto: ['pycryptodome', 'pycrypto'],
  magic: ['python-magic', 'python_magic'],
  git: ['gitpython'],
  github: ['pygithub'],
  docx: ['python-docx', 'python_docx'],
  pptx: ['python-pptx', 'python_pptx'],
  slugify: ['python-slugify', 'python_slugify'],
  MySQLdb: ['mysqlclient'],
  psycopg2: ['psycopg2-binary', 'psycopg2_binary'],
  attr: ['attrs'],
  serial: ['pyserial'],
  usb: ['pyusb'],
  OpenSSL: ['pyopenssl'],
  wx: ['wxpython'],
  fitz: ['pymupdf'],
  kafka: ['kafka-python', 'kafka_python'],
  snowflake: ['snowflake-connector-python', 'snowflake_connector_python'],
  google: ['protobuf', 'google-api-python-client', 'google-cloud-storage'],
};

/** PEP 503 name normalization: distribution names compare case-insensitively
 *  with runs of `-`, `_`, `.` folded to one `-`. */
export function normalizePyDistName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

/** A top-level python module name (the shape the resolution check reports
 *  as an unresolved specifier). Doubles as the Rule 11 argument-injection
 *  rail for the declare capability: no leading dash, no whitespace, no URL
 *  can pass this. */
export function isPyModuleName(specifier: string): boolean {
  return specifier.length > 0 && specifier.length <= 128 && /^[A-Za-z_]\w*$/.test(specifier);
}

/**
 * The ONE distribution declaring this import would install, PEP-503
 * normalized, or null when dxkit cannot name it: a malformed specifier, or
 * an alias whose candidates are genuinely different distributions (`cv2`,
 * `google`): those need judgment, so they stay on the agent tier
 * (false-negative bias: never guess which package to install).
 */
export function pyDistForImport(specifier: string): string | null {
  if (!isPyModuleName(specifier)) return null;
  const aliases = PY_MODULE_DIST_ALIASES[specifier];
  if (aliases !== undefined) {
    const normalized = [...new Set(aliases.map(normalizePyDistName))];
    return normalized.length === 1 ? normalized[0] : null;
  }
  return normalizePyDistName(specifier);
}

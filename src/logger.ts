const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

let jsonMode = false;
let quiet = false;

export function setJsonMode(enabled: boolean): void {
  jsonMode = enabled;
}

/**
 * Suppress the ordinary logger output (success / warn / info / dim / header)
 * while a higher-level surface owns the screen — e.g. the init finishing arc,
 * which drives its own spinner steps and doesn't want a reused analyzer's
 * progress chatter bleeding through. The {@link Spinner} deliberately bypasses
 * this, so step lines always render. Returns the prior value so a caller can
 * restore it (use try/finally).
 */
export function setQuiet(enabled: boolean): boolean {
  const prev = quiet;
  quiet = enabled;
  return prev;
}

/** Whether ordinary output is currently muted. Read by low-level progress
 *  printers (e.g. the analyzer timing lines) so they honor the same scope. */
export function isQuiet(): boolean {
  return quiet;
}

/** The actual sink — respects JSON mode (stderr) but NOT quiet. Spinner-only. */
function rawWrite(line: string): void {
  if (jsonMode) {
    process.stderr.write(line + '\n');
  } else {
    console.log(line); // slop-ok: logger's non-json stdout path
  }
}

function write(line: string): void {
  if (quiet) return;
  rawWrite(line);
}

export function header(text: string): void {
  write('');
  write(`${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
  write(`${CYAN}  ${text}${RESET}`);
  write(`${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
  write('');
}

export function success(text: string): void {
  write(`  ${GREEN}✓${RESET} ${text}`);
}

export function warn(text: string): void {
  write(`  ${YELLOW}!${RESET} ${text}`);
}

export function fail(text: string): void {
  write(`  ${RED}✗${RESET} ${text}`);
}

export function info(text: string): void {
  write(`  ${CYAN}→${RESET} ${text}`);
}

export function dim(text: string): void {
  write(`  ${DIM}${text}${RESET}`);
}

export function bold(text: string): string {
  return `${BOLD}${text}${RESET}`;
}

export function detected(label: string, value: string | boolean): void {
  if (typeof value === 'boolean') {
    write(`  ${value ? GREEN + '✓' : DIM + '·'}${RESET} ${label}`);
  } else {
    write(`  ${GREEN}✓${RESET} ${label}: ${CYAN}${value}${RESET}`);
  }
}

/**
 * A live progress step. On a real TTY it animates a spinner on one line and
 * can print interesting FACTS underneath it as they're discovered; on CI /
 * a piped stdout / JSON mode it degrades to clean, static outcome lines (no
 * animation, no cursor control) so logs stay readable and screenshot-stable.
 *
 * The label is padded to a fixed column so a stack of finalized steps reads as
 * a table — the "world-class init" surface leans on this alignment.
 */
export interface Spinner {
  /** Print an interesting fact under the step (dim, indented). Safe while spinning. */
  note(text: string): void;
  /** Update the live label (no effect once finalized). */
  setLabel(text: string): void;
  /** Finalize as success (✓). Optional dim summary shown in the fact column. */
  succeed(summary?: string): void;
  /** Finalize as a non-fatal warning (!). */
  warn(summary?: string): void;
  /** Finalize as failure (✗). */
  fail(summary?: string): void;
}

const SPIN_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const LABEL_COL = 22; // fact column start — keep finalized steps aligned as a table

/** Visible width of a label once ANSI codes are stripped (padding math). */
function padLabel(label: string): string {
  // eslint-disable-next-line no-control-regex
  const bare = label.replace(/\x1b\[[0-9;]*m/g, '');
  return bare.length >= LABEL_COL ? label : label + ' '.repeat(LABEL_COL - bare.length);
}

/**
 * Start a live progress step. Returns a {@link Spinner} the caller finalizes
 * with `succeed` / `warn` / `fail`. Animation runs only when stdout is an
 * interactive TTY and we're not in JSON mode — otherwise this is a quiet
 * primitive that prints one outcome line on finalize.
 */
export function startSpinner(label: string): Spinner {
  const started = Date.now();
  const animate = !jsonMode && !!process.stdout.isTTY;
  let current = label;
  let frame = 0;
  let done = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const clearLine = (): void => {
    if (animate) process.stdout.write('\r\x1b[K');
  };
  const draw = (): void => {
    if (!animate || done) return;
    process.stdout.write(`\r\x1b[K  ${CYAN}${SPIN_FRAMES[frame]}${RESET} ${current}`);
    frame = (frame + 1) % SPIN_FRAMES.length;
  };

  if (animate) {
    draw();
    timer = setInterval(draw, 80);
    if (typeof timer.unref === 'function') timer.unref();
  }

  const finalize = (mark: string, color: string, summary?: string): void => {
    if (done) return;
    done = true;
    if (timer) clearInterval(timer);
    clearLine();
    const secs = (Date.now() - started) / 1000;
    // Auto-append elapsed for genuinely slow steps so the "ready in Ns" story
    // is visible per-step, but stay quiet on instant ones.
    const timing = secs >= 0.8 ? `${DIM}(${secs.toFixed(1)}s)${RESET}` : '';
    const tail = [summary ? `${DIM}${summary}${RESET}` : '', timing].filter(Boolean).join('  ');
    // rawWrite: a step line renders even when the surface has muted ordinary
    // logger output (the init arc mutes reused analyzers but keeps its steps).
    rawWrite(`  ${color}${mark}${RESET} ${padLabel(current)}${tail ? ' ' + tail : ''}`);
  };

  return {
    note(text: string): void {
      clearLine();
      rawWrite(`      ${DIM}${text}${RESET}`);
      draw();
    },
    setLabel(text: string): void {
      current = text;
      draw();
    },
    succeed(summary?: string): void {
      finalize('✓', GREEN, summary);
    },
    warn(summary?: string): void {
      finalize('!', YELLOW, summary);
    },
    fail(summary?: string): void {
      finalize('✗', RED, summary);
    },
  };
}

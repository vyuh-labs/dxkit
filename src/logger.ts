const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

let jsonMode = false;

export function setJsonMode(enabled: boolean): void {
  jsonMode = enabled;
}

function write(line: string): void {
  if (jsonMode) {
    process.stderr.write(line + '\n');
  } else {
    console.log(line); // slop-ok: logger's non-json stdout path
  }
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

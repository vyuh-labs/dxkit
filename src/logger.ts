const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

export function header(text: string): void {
  console.log('');
  console.log(`${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
  console.log(`${CYAN}  ${text}${RESET}`);
  console.log(`${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
  console.log('');
}

export function success(text: string): void {
  console.log(`  ${GREEN}✓${RESET} ${text}`);
}

export function warn(text: string): void {
  console.log(`  ${YELLOW}!${RESET} ${text}`);
}

export function fail(text: string): void {
  console.log(`  ${RED}✗${RESET} ${text}`);
}

export function info(text: string): void {
  console.log(`  ${CYAN}→${RESET} ${text}`);
}

export function dim(text: string): void {
  console.log(`  ${DIM}${text}${RESET}`);
}

export function bold(text: string): string {
  return `${BOLD}${text}${RESET}`;
}

export function detected(label: string, value: string | boolean): void {
  if (typeof value === 'boolean') {
    console.log(`  ${value ? GREEN + '✓' : DIM + '·'}${RESET} ${label}`);
  } else {
    console.log(`  ${GREEN}✓${RESET} ${label}: ${CYAN}${value}${RESET}`);
  }
}

export interface ParsedArgs {
  command: string | null;
  positionals: string[];
  options: Record<string, string | string[] | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const options: Record<string, string | string[] | boolean> = {};
  const positionals: string[] = [];

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = rest[i + 1];
    const hasValue = next !== undefined && !next.startsWith('--');

    let value: string | boolean = true;
    if (hasValue) {
      value = next;
      i += 1;
    }

    const current = options[key];
    if (current === undefined) {
      options[key] = value;
      continue;
    }

    if (Array.isArray(current)) {
      current.push(String(value));
      options[key] = current;
      continue;
    }

    options[key] = [String(current), String(value)];
  }

  return {
    command: command ?? null,
    positionals,
    options,
  };
}

export function readStringOption(
  options: Record<string, string | string[] | boolean>,
  key: string,
): string | undefined {
  const value = options[key];
  if (value === undefined || typeof value === 'boolean') {
    return undefined;
  }
  return Array.isArray(value) ? value[value.length - 1] : value;
}

export function readStringArrayOption(
  options: Record<string, string | string[] | boolean>,
  key: string,
): string[] {
  const value = options[key];
  if (value === undefined || typeof value === 'boolean') {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

export function readBooleanOption(
  options: Record<string, string | string[] | boolean>,
  key: string,
): boolean {
  const value = options[key];
  if (value === undefined) {
    return false;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  const last = Array.isArray(value) ? value[value.length - 1] : value;
  return ['1', 'true', 'yes', 'on'].includes(last.toLowerCase());
}

export function readIntOption(
  options: Record<string, string | string[] | boolean>,
  key: string,
  fallback: number,
): number {
  const value = readStringOption(options, key);
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

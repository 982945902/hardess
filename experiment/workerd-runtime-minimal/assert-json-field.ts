interface CliArgs {
  path: string;
  equals?: string;
  equalsJson?: string;
  includes?: string;
  notIncludes?: string;
}

function readArgs(argv: string[]): CliArgs {
  let path: string | undefined;
  let equals: string | undefined;
  let equalsJson: string | undefined;
  let includes: string | undefined;
  let notIncludes: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (!arg.startsWith("--")) {
      throw new Error(`unexpected positional argument: ${arg}`);
    }
    if (!value || value.startsWith("--")) {
      throw new Error(`missing value for ${arg}`);
    }

    if (arg === "--path") {
      path = value;
    } else if (arg === "--equals") {
      equals = value;
    } else if (arg === "--equals-json") {
      equalsJson = value;
    } else if (arg === "--includes") {
      includes = value;
    } else if (arg === "--not-includes") {
      notIncludes = value;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }

    index += 1;
  }

  if (!path) {
    throw new Error("missing required --path");
  }

  const operationCount = [equals, equalsJson, includes, notIncludes].filter((value) => value !== undefined).length;
  if (operationCount !== 1) {
    throw new Error("exactly one of --equals, --equals-json, --includes, or --not-includes is required");
  }

  return { path, equals, equalsJson, includes, notIncludes };
}

function getPathSegments(path: string): string[] {
  return path.split(".").filter((segment) => segment.length > 0);
}

function readPath(root: unknown, path: string): unknown {
  let current = root;

  for (const segment of getPathSegments(path)) {
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      const index = Number(segment);
      if (!(index in current)) {
        throw new Error(`path not found: ${path}`);
      }
      current = current[index];
      continue;
    }

    if (current === null || typeof current !== "object" || !(segment in current)) {
      throw new Error(`path not found: ${path}`);
    }

    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

function assertEquals(actual: unknown, expected: string, path: string): void {
  if (actual !== expected) {
    throw new Error(`expected ${path} to equal ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertEqualsJson(actual: unknown, expectedJson: string, path: string): void {
  const expected = JSON.parse(expectedJson) as unknown;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${path} to equal ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(actual: unknown, expected: string, path: string): void {
  if (!Array.isArray(actual)) {
    throw new Error(`expected ${path} to be an array, got ${JSON.stringify(actual)}`);
  }
  if (!actual.includes(expected)) {
    throw new Error(`expected ${path} to include ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertNotIncludes(actual: unknown, expected: string, path: string): void {
  if (!Array.isArray(actual)) {
    throw new Error(`expected ${path} to be an array, got ${JSON.stringify(actual)}`);
  }
  if (actual.includes(expected)) {
    throw new Error(`expected ${path} to exclude ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const args = readArgs(process.argv.slice(2));
const input = await new Response(Bun.stdin.stream()).text();
const data = JSON.parse(input) as unknown;
const value = readPath(data, args.path);

if (args.equals !== undefined) {
  assertEquals(value, args.equals, args.path);
} else if (args.equalsJson !== undefined) {
  assertEqualsJson(value, args.equalsJson, args.path);
} else if (args.includes !== undefined) {
  assertIncludes(value, args.includes, args.path);
} else if (args.notIncludes !== undefined) {
  assertNotIncludes(value, args.notIncludes, args.path);
}

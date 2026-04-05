import { filterUITree } from "./filter";
import type { RawUITree } from "./types";

async function main(): Promise<void> {
  // Read all stdin as UTF-8
  const chunks: Buffer[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf-8");

  if (!raw.trim()) {
    process.stderr.write("Error: empty input\n");
    process.exit(1);
  }

  let parsed: RawUITree;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(
      `Error: invalid JSON — ${e instanceof Error ? e.message : e}\n`,
    );
    process.exit(1);
  }

  let elements;
  try {
    elements = filterUITree(parsed);
  } catch (e) {
    process.stderr.write(
      `Error: ${e instanceof Error ? e.message : e}\n`,
    );
    process.exit(1);
  }

  for (const el of elements) {
    process.stdout.write(JSON.stringify(el) + "\n");
  }
}

main();

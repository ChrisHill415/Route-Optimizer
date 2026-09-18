#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!options.input) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const jsonText = await fs.readFile(path.resolve(options.input), "utf8");
  const payload = JSON.parse(jsonText);
  const addresses = extractAddresses(payload, options.unique);

  if (options.output) {
    await fs.writeFile(path.resolve(options.output), `${addresses.join("\n")}\n`, "utf8");
    console.log(`Wrote ${addresses.length} address(es) to ${options.output}`);
  } else {
    console.log(addresses.join("\n"));
  }
}

function parseArgs(argv) {
  const options = {
    input: "",
    output: "",
    unique: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const nextValue = argv[i + 1];

    if (token === "--input") {
      options.input = nextValue ?? "";
      i += 1;
    } else if (token === "--output") {
      options.output = nextValue ?? "";
      i += 1;
    } else if (token === "--unique") {
      options.unique = true;
    } else if (token === "--help" || token === "-h") {
      printUsage();
      process.exit(0);
    }
  }

  return options;
}

function extractAddresses(payload, unique) {
  const routes = payload?.routes;
  if (!Array.isArray(routes)) {
    throw new Error('Invalid optimized routes JSON: missing "routes" array.');
  }

  const list = [];
  for (const route of routes) {
    const stops = route?.stops;
    if (!Array.isArray(stops)) continue;
    for (const stop of stops) {
      const address = typeof stop?.address === "string" ? stop.address.trim() : "";
      if (address.length > 0) {
        list.push(address);
      }
    }
  }

  if (!unique) {
    return list;
  }

  const seen = new Set();
  const uniqueList = [];
  for (const address of list) {
    if (seen.has(address)) continue;
    seen.add(address);
    uniqueList.push(address);
  }
  return uniqueList;
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node src/extractRouteAddresses.js --input optimized-routes.json [options]",
      "",
      "Options:",
      "  --output <file>     Write plain address list to file (one per line)",
      "  --unique            Remove duplicate addresses while preserving order",
    ].join("\n"),
  );
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});

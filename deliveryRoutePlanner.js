#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const EARTH_RADIUS_KM = 6371.0088;

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!options.input || !options.routes) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const rawStops = await loadInputStops(options.input);
  if (rawStops.length === 0) {
    throw new Error("Input file has no stops.");
  }

  const geocodeCache = await loadGeocodeCache(options.cacheFile);
  const { stops, unresolved } = await normalizeStops(rawStops, {
    userAgent: options.userAgent,
    geocodeDelayMs: options.geocodeDelayMs,
    geocodeCache,
    failOnUnresolved: options.failOnUnresolved,
  });

  if (options.cacheFile) {
    await saveGeocodeCache(options.cacheFile, geocodeCache);
  }

  if (stops.length === 0) {
    throw new Error("No valid/geocoded stops were found.");
  }

  if (options.routes > stops.length) {
    throw new Error(
      `Requested ${options.routes} routes, but only ${stops.length} geocoded stops are available.`,
    );
  }

  const clusters = clusterStopsByRouteCount(stops, options.routes, 25);
  const depot = options.depot
    ? await geocodeAddress(options.depot, {
        userAgent: options.userAgent,
        geocodeDelayMs: options.geocodeDelayMs,
      })
    : null;

  const routes = clusters.map((cluster, routeIndex) => {
    const orderedIndices = optimizeStopOrder(cluster, {
      depot,
      returnToDepot: options.returnToDepot,
    });
    const orderedStops = orderedIndices.map((index) => cluster[index]);
    const distanceKm = routeDistanceKm(orderedStops, depot, options.returnToDepot);

    return {
      routeId: routeIndex + 1,
      stopCount: orderedStops.length,
      distanceKm: Number(distanceKm.toFixed(2)),
      stops: orderedStops.map((stop, stopOrder) => ({
        order: stopOrder + 1,
        address: stop.address,
        latitude: stop.lat,
        longitude: stop.lon,
      })),
    };
  });

  const summary = {
    generatedAt: new Date().toISOString(),
    inputStopCount: rawStops.length,
    geocodedStopCount: stops.length,
    unresolvedCount: unresolved.length,
    unresolvedAddresses: unresolved,
    routeCount: options.routes,
    totalDistanceKm: Number(
      routes.reduce((sum, route) => sum + route.distanceKm, 0).toFixed(2),
    ),
    depot: depot
      ? {
          address: options.depot,
          latitude: depot.lat,
          longitude: depot.lon,
          returnToDepot: options.returnToDepot,
        }
      : null,
    routes,
  };

  const outputText = JSON.stringify(summary, null, 2);
  if (options.output) {
    await fs.writeFile(options.output, outputText, "utf8");
    console.log(`Wrote optimized routes to ${options.output}`);
    if (unresolved.length > 0) {
      console.warn(
        `Warning: skipped ${unresolved.length} unresolved address(es). Check "unresolvedAddresses" in output JSON.`,
      );
    }
  } else {
    console.log(outputText);
  }
}

function parseArgs(argv) {
  const options = {
    input: "",
    output: "",
    routes: 0,
    depot: "",
    returnToDepot: false,
    cacheFile: "",
    userAgent: "delivery-route-planner/1.0 (replace-with-your-email@example.com)",
    geocodeDelayMs: 1100,
    failOnUnresolved: false,
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
    } else if (token === "--routes") {
      options.routes = Number(nextValue);
      i += 1;
    } else if (token === "--depot") {
      options.depot = nextValue ?? "";
      i += 1;
    } else if (token === "--return-to-depot") {
      options.returnToDepot = true;
    } else if (token === "--cache") {
      options.cacheFile = nextValue ?? "";
      i += 1;
    } else if (token === "--user-agent") {
      options.userAgent = nextValue ?? options.userAgent;
      i += 1;
    } else if (token === "--geocode-delay-ms") {
      options.geocodeDelayMs = Number(nextValue);
      i += 1;
    } else if (token === "--fail-on-unresolved") {
      options.failOnUnresolved = true;
    } else if (token === "--help" || token === "-h") {
      printUsage();
      process.exit(0);
    }
  }

  if (!Number.isInteger(options.routes) || options.routes <= 0) {
    options.routes = 0;
  }

  return options;
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node src/deliveryRoutePlanner.js --input addresses.json --routes 15 [options]",
      "",
      "Required:",
      "  --input <file>               JSON or CSV file with addresses",
      "  --routes <count>             Number of routes to create",
      "",
      "Options:",
      "  --output <file>              Output file (JSON). If omitted, prints to stdout",
      "  --depot <address>            Depot/start address",
      "  --return-to-depot            Include return leg to depot in route distance/ordering",
      "  --cache <file>               Cache geocoded addresses",
      "  --user-agent <string>        User-Agent header for geocoding requests",
      "  --geocode-delay-ms <ms>      Delay between geocoding calls (default 1100)",
      "  --fail-on-unresolved         Stop run if any address cannot be geocoded",
      "",
      "JSON input formats:",
      "  [\"123 Main St, City, ST\", \"456 Oak St, City, ST\"]",
      "  [{\"address\":\"123 Main St\"}, {\"address\":\"456 Oak St\", \"lat\":40.0, \"lon\":-74.0}]",
      "",
      "CSV input format:",
      "  address,lat,lon",
      "  123 Main St,40.123,-73.987",
      "  456 Oak St,,",
    ].join("\n"),
  );
}

async function loadInputStops(inputFile) {
  const resolved = path.resolve(inputFile);
  const text = await fs.readFile(resolved, "utf8");
  const extension = path.extname(inputFile).toLowerCase();

  if (extension === ".csv") {
    return parseCsvStops(text);
  }

  const data = JSON.parse(text);
  if (!Array.isArray(data)) {
    throw new Error("Input JSON must be an array.");
  }
  return data;
}

function parseCsvStops(csvText) {
  const lines = csvText
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    return [];
  }

  const [header, ...rows] = lines;
  const headers = parseCsvLine(header).map((column) => column.trim().toLowerCase());
  const addressIndex = headers.findIndex((name) => name === "address");
  const latIndex = headers.findIndex((name) => name === "lat" || name === "latitude");
  const lonIndex = headers.findIndex((name) => name === "lon" || name === "lng" || name === "longitude");

  if (addressIndex === -1) {
    throw new Error('CSV must include an "address" column.');
  }

  return rows.map((row) => {
    const cols = parseCsvLine(row).map((value) => value.trim());
    const address = cols[addressIndex] ?? "";
    const lat = latIndex >= 0 ? parseCoordinateValue(cols[latIndex]) : NaN;
    const lon = lonIndex >= 0 ? parseCoordinateValue(cols[lonIndex]) : NaN;

    return {
      address,
      lat: Number.isFinite(lat) ? lat : undefined,
      lon: Number.isFinite(lon) ? lon : undefined,
    };
  });
}

function parseCoordinateValue(raw) {
  if (raw == null) return NaN;
  const cleaned = String(raw).trim();
  if (cleaned.length === 0) return NaN;
  const numeric = Number(cleaned);
  return Number.isFinite(numeric) ? numeric : NaN;
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let insideQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"' && insideQuotes && nextChar === '"') {
      current += '"';
      i += 1;
      continue;
    }

    if (char === '"') {
      insideQuotes = !insideQuotes;
      continue;
    }

    if (char === "," && !insideQuotes) {
      values.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current);
  return values;
}

async function normalizeStops(rawStops, options) {
  const normalized = [];
  const unresolved = [];

  for (const rawStop of rawStops) {
    const stop =
      typeof rawStop === "string"
        ? { address: rawStop }
        : {
            address:
              rawStop.address ??
              rawStop.fullAddress ??
              rawStop.name ??
              "",
            lat:
              rawStop.lat ??
              rawStop.latitude ??
              undefined,
            lon:
              rawStop.lon ??
              rawStop.lng ??
              rawStop.longitude ??
              undefined,
          };
    const cleanedAddress = cleanAddress(stop.address);

    if (!cleanedAddress) {
      throw new Error("Each stop needs an address string.");
    }

    const lat = Number(stop.lat);
    const lon = Number(stop.lon);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      normalized.push({ address: cleanedAddress, lat, lon });
      continue;
    }

    const cached = options.geocodeCache.get(cleanedAddress);
    if (cached) {
      normalized.push({ address: cleanedAddress, lat: cached.lat, lon: cached.lon });
      continue;
    }

    try {
      const geocoded = await geocodeAddress(cleanedAddress, options);
      options.geocodeCache.set(cleanedAddress, geocoded);
      normalized.push({ address: cleanedAddress, lat: geocoded.lat, lon: geocoded.lon });
    } catch (error) {
      unresolved.push(cleanedAddress);
      if (options.failOnUnresolved) {
        throw error;
      }
    }
  }

  return { stops: normalized, unresolved };
}

function cleanAddress(rawAddress) {
  if (typeof rawAddress !== "string") {
    return "";
  }

  let address = rawAddress.trim().replace(/\uFEFF/g, "");

  // Some CSV exports double-wrap address fields with extra quote pairs.
  // Repeatedly strip matching outer quotes so values like ""123 Main St"" normalize.
  while (address.length >= 2 && address.startsWith('"') && address.endsWith('"')) {
    address = address.slice(1, -1).trim();
  }

  return address;
}

async function geocodeAddress(address, options) {
  const attempts = buildGeocodeQueryVariants(address);

  for (const query of attempts) {
    const nominatimPoint = await geocodeWithNominatim(query, options);
    if (nominatimPoint) {
      return nominatimPoint;
    }

    const censusPoint = await geocodeWithUsCensus(query, options);
    if (censusPoint) {
      return censusPoint;
    }
  }

  throw new Error(`Could not geocode address: "${address}"`);
}

function buildGeocodeQueryVariants(address) {
  const variants = new Set([address.trim()]);

  // Expand common street suffix abbreviations.
  variants.add(address.replace(/\bPl\b\.?/gi, "Place").trim());
  variants.add(address.replace(/\bRd\b\.?/gi, "Road").trim());
  variants.add(address.replace(/\bAve\b\.?/gi, "Avenue").trim());
  variants.add(address.replace(/\bSt\b\.?/gi, "Street").trim());

  // If needed, retry without house number.
  variants.add(address.replace(/^\s*\d+[A-Za-z0-9-]*\s+/, "").trim());

  return [...variants].filter((v) => v.length > 0);
}

async function geocodeWithNominatim(address, options) {
  const params = new URLSearchParams({
    q: address,
    format: "jsonv2",
    limit: "1",
    addressdetails: "0",
  });

  const response = await fetch(
    `https://nominatim.openstreetmap.org/search?${params.toString()}`,
    {
      headers: {
        "User-Agent": options.userAgent,
        Accept: "application/json",
      },
    },
  );

  if (!response.ok) {
    if (response.status === 429) {
      await sleep(Math.max(options.geocodeDelayMs, 1500));
      return null;
    }
    return null;
  }

  const results = await response.json();
  if (!Array.isArray(results) || results.length === 0) {
    await sleep(options.geocodeDelayMs);
    return null;
  }

  const first = results[0];
  const lat = Number(first.lat);
  const lon = Number(first.lon);

  await sleep(options.geocodeDelayMs);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }

  return { lat, lon };
}

async function geocodeWithUsCensus(address) {
  const params = new URLSearchParams({
    address,
    benchmark: "Public_AR_Current",
    format: "json",
  });

  const response = await fetch(
    `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?${params.toString()}`,
    {
      headers: {
        Accept: "application/json",
      },
    },
  );

  if (!response.ok) {
    return null;
  }

  const payload = await response.json();
  const matches = payload?.result?.addressMatches;
  if (!Array.isArray(matches) || matches.length === 0) {
    return null;
  }

  const best = matches[0]?.coordinates;
  const lon = Number(best?.x);
  const lat = Number(best?.y);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }

  return { lat, lon };
}

async function loadGeocodeCache(cacheFile) {
  if (!cacheFile) {
    return new Map();
  }

  try {
    const text = await fs.readFile(path.resolve(cacheFile), "utf8");
    const parsed = JSON.parse(text);
    const pairs = Object.entries(parsed).filter(([, value]) => {
      return (
        value &&
        Number.isFinite(Number(value.lat)) &&
        Number.isFinite(Number(value.lon))
      );
    });
    return new Map(
      pairs.map(([address, value]) => [
        address,
        { lat: Number(value.lat), lon: Number(value.lon) },
      ]),
    );
  } catch {
    return new Map();
  }
}

async function saveGeocodeCache(cacheFile, cacheMap) {
  if (!cacheFile) {
    return;
  }

  const record = {};
  for (const [address, point] of cacheMap.entries()) {
    record[address] = point;
  }

  await fs.writeFile(path.resolve(cacheFile), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

function clusterStopsByRouteCount(stops, routeCount, maxIterations) {
  const capacities = buildRouteCapacities(stops.length, routeCount);
  let centroids = initializeCentroids(stops, routeCount);
  let assignments = [];

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    assignments = assignStopsWithCapacities(stops, centroids, capacities);
    const nextCentroids = recomputeCentroids(stops, assignments, centroids);

    let totalCentroidShift = 0;
    for (let c = 0; c < centroids.length; c += 1) {
      totalCentroidShift += haversineKm(centroids[c], nextCentroids[c]);
    }

    centroids = nextCentroids;
    if (totalCentroidShift < 0.01) {
      break;
    }
  }

  return assignments.map((routeIndices) => routeIndices.map((idx) => stops[idx]));
}

function buildRouteCapacities(stopCount, routeCount) {
  const base = Math.floor(stopCount / routeCount);
  const remainder = stopCount % routeCount;
  const capacities = new Array(routeCount).fill(base);

  for (let i = 0; i < remainder; i += 1) {
    capacities[i] += 1;
  }
  return capacities;
}

function initializeCentroids(stops, routeCount) {
  const centroids = [];
  const firstIndex = Math.floor(Math.random() * stops.length);
  centroids.push({ lat: stops[firstIndex].lat, lon: stops[firstIndex].lon });

  while (centroids.length < routeCount) {
    const distanceSquares = stops.map((stop) => {
      let minDist = Number.POSITIVE_INFINITY;
      for (const centroid of centroids) {
        const dist = haversineKm(stop, centroid);
        if (dist < minDist) minDist = dist;
      }
      return minDist ** 2;
    });

    const sum = distanceSquares.reduce((a, b) => a + b, 0);
    let draw = Math.random() * sum;
    let selectedIndex = 0;

    for (let i = 0; i < distanceSquares.length; i += 1) {
      draw -= distanceSquares[i];
      if (draw <= 0) {
        selectedIndex = i;
        break;
      }
    }

    centroids.push({ lat: stops[selectedIndex].lat, lon: stops[selectedIndex].lon });
  }

  return centroids;
}

function assignStopsWithCapacities(stops, centroids, capacities) {
  const remaining = capacities.slice();
  const unassigned = new Set(stops.map((_, idx) => idx));
  const assignments = centroids.map(() => []);

  while (unassigned.size > 0) {
    let chosenStop = -1;
    let chosenCluster = -1;
    let chosenRegret = Number.NEGATIVE_INFINITY;

    for (const stopIdx of unassigned) {
      const candidates = [];
      for (let clusterIdx = 0; clusterIdx < centroids.length; clusterIdx += 1) {
        if (remaining[clusterIdx] <= 0) continue;
        const dist = haversineKm(stops[stopIdx], centroids[clusterIdx]);
        candidates.push({ clusterIdx, dist });
      }

      candidates.sort((a, b) => a.dist - b.dist);
      const best = candidates[0];
      const secondBest = candidates[1] ?? { dist: best.dist + 1 };
      const regret = secondBest.dist - best.dist;

      if (regret > chosenRegret) {
        chosenRegret = regret;
        chosenStop = stopIdx;
        chosenCluster = best.clusterIdx;
      }
    }

    assignments[chosenCluster].push(chosenStop);
    remaining[chosenCluster] -= 1;
    unassigned.delete(chosenStop);
  }

  return assignments;
}

function recomputeCentroids(stops, assignments, previousCentroids) {
  return assignments.map((route, idx) => {
    if (route.length === 0) return previousCentroids[idx];

    const sum = route.reduce(
      (acc, stopIndex) => {
        acc.lat += stops[stopIndex].lat;
        acc.lon += stops[stopIndex].lon;
        return acc;
      },
      { lat: 0, lon: 0 },
    );

    return {
      lat: sum.lat / route.length,
      lon: sum.lon / route.length,
    };
  });
}

function optimizeStopOrder(routeStops, options) {
  if (routeStops.length <= 2) {
    return routeStops.map((_, idx) => idx);
  }

  const initialOrder = buildInitialRouteOrder(routeStops, options.depot);
  return twoOptOpenPath(routeStops, initialOrder, options.depot, options.returnToDepot);
}

function buildInitialRouteOrder(stops, depot) {
  const order = [];
  const unvisited = new Set(stops.map((_, idx) => idx));

  let currentIndex;
  if (depot) {
    currentIndex = findNearestStopIndex(depot, stops, unvisited);
  } else {
    currentIndex = findWesternMostIndex(stops);
  }

  while (unvisited.size > 0) {
    order.push(currentIndex);
    unvisited.delete(currentIndex);
    if (unvisited.size === 0) break;
    currentIndex = findNearestStopIndex(stops[currentIndex], stops, unvisited);
  }

  return order;
}

function twoOptOpenPath(stops, order, depot, returnToDepot) {
  let improved = true;
  const bestOrder = order.slice();
  let loopGuard = 0;

  while (improved && loopGuard < 2000) {
    improved = false;
    loopGuard += 1;

    for (let i = 0; i < bestOrder.length - 2; i += 1) {
      for (let k = i + 1; k < bestOrder.length - 1; k += 1) {
        const currentDistance = routeDistanceForOrder(stops, bestOrder, depot, returnToDepot);
        const candidate = twoOptSwap(bestOrder, i, k);
        const candidateDistance = routeDistanceForOrder(stops, candidate, depot, returnToDepot);

        if (candidateDistance + 1e-9 < currentDistance) {
          bestOrder.splice(0, bestOrder.length, ...candidate);
          improved = true;
        }
      }
    }
  }

  return bestOrder;
}

function twoOptSwap(order, i, k) {
  const start = order.slice(0, i);
  const middle = order.slice(i, k + 1).reverse();
  const end = order.slice(k + 1);
  return start.concat(middle, end);
}

function routeDistanceForOrder(stops, order, depot, returnToDepot) {
  const orderedStops = order.map((index) => stops[index]);
  return routeDistanceKm(orderedStops, depot, returnToDepot);
}

function routeDistanceKm(orderedStops, depot, returnToDepot) {
  if (orderedStops.length === 0) return 0;

  let total = 0;
  if (depot) {
    total += haversineKm(depot, orderedStops[0]);
  }

  for (let i = 1; i < orderedStops.length; i += 1) {
    total += haversineKm(orderedStops[i - 1], orderedStops[i]);
  }

  if (depot && returnToDepot) {
    total += haversineKm(orderedStops[orderedStops.length - 1], depot);
  }

  return total;
}

function findNearestStopIndex(origin, stops, candidateIndices) {
  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const idx of candidateIndices) {
    const dist = haversineKm(origin, stops[idx]);
    if (dist < bestDistance) {
      bestDistance = dist;
      bestIndex = idx;
    }
  }
  return bestIndex;
}

function findWesternMostIndex(stops) {
  let bestIdx = 0;
  for (let i = 1; i < stops.length; i += 1) {
    if (stops[i].lon < stops[bestIdx].lon) {
      bestIdx = i;
    }
  }
  return bestIdx;
}

function haversineKm(a, b) {
  const lat1 = toRadians(a.lat);
  const lon1 = toRadians(a.lon);
  const lat2 = toRadians(b.lat);
  const lon2 = toRadians(b.lon);
  const dLat = lat2 - lat1;
  const dLon = lon2 - lon1;

  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h =
    sinLat * sinLat +
    Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});

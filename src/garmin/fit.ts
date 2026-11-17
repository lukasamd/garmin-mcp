/**
 * Activity file decoding. Garmin's download endpoint returns a ZIP archive with
 * the original file, usually a single FIT file. Decoding uses Garmin's official
 * FIT JavaScript SDK.
 */
import { Decoder, Stream } from "@garmin/fitsdk";
import { unzipSync } from "fflate";

const SEMICIRCLES_TO_DEGREES = 180 / 2 ** 31;
const MAX_ARCHIVE_BYTES = 12 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 32 * 1024 * 1024;

export interface FitDecodeOptions {
  /** Include the record timeline, evenly downsampled to at most `maxRecords` points. */
  includeRecords: boolean;
  maxRecords: number;
  /** Length of the computed distance splits, in metres. */
  splitDistance: number;
  startSeconds?: number;
  endSeconds?: number;
  includeLocations?: boolean;
  targetHeartRate?: number;
}

export interface DecodedFitFile {
  fileName: string;
  errors?: string[];
  fileId?: unknown;
  activity?: unknown;
  sessions?: unknown[];
  laps?: unknown[];
  distanceSplits?: DistanceSplit[];
  splits?: unknown[];
  splitSummaries?: unknown[];
  timeInZone?: unknown[];
  devices?: unknown[];
  events?: unknown[];
  recordCount: number;
  records?: RecordTable;
  recordBuckets?: unknown[];
  heartRateChanges?: unknown[];
  sampling?: unknown;
  splitTimeMethod?: string;
  lapAnalysis?: unknown[];
  heartRateTarget?: unknown;
}

export interface DistanceSplit {
  split: number;
  distanceMeters: number;
  seconds: number;
  pacePerKm: string;
  avgHeartRate?: number;
  ascentMeters?: number;
}

/** Records as columns + rows: a fraction of the size of one object per record. */
export interface RecordTable {
  columns: string[];
  rows: unknown[][];
}

type Message = Record<string, unknown>;

export function unzipActivity(bytes: Uint8Array): Array<{ name: string; data: Uint8Array }> {
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw new Error("Activity archive exceeds the safety limit.");
  // Some activities are served as a bare FIT file rather than a ZIP archive.
  if (!isZip(bytes)) return [{ name: "activity.fit", data: bytes }];
  let total = 0;
  let count = 0;
  return Object.entries(unzipSync(bytes, { filter: (file) => {
    if (!/\.fit$/i.test(file.name)) return false;
    if (!Number.isSafeInteger(file.originalSize) || file.originalSize < 0) throw new Error("Invalid activity archive entry size.");
    total += file.originalSize;
    count++;
    if (count > 10 || total > MAX_UNPACKED_BYTES) throw new Error("Activity archive exceeds the unpacked safety limit.");
    return true;
  } })).map(([name, data]) => ({ name, data }));
}

export function decodeFit(fileName: string, data: Uint8Array, options: FitDecodeOptions): DecodedFitFile {
  const stream = Stream.fromByteArray(data);
  if (!Decoder.isFIT(stream)) {
    return { fileName, errors: ["Not a FIT file; only FIT activity files can be decoded."], recordCount: 0 };
  }

  const { messages, errors } = new Decoder(stream).read({ includeUnknownData: false });
  const all = <T extends object>(list: T[] | undefined) => list?.map((message) => withDegrees(message as Message, !!options.includeLocations));
  const records = (all(messages.recordMesgs) ?? []) as Message[];
  const start = seconds(records[0]?.timestamp) ?? 0;
  const window = records.filter((record) => {
    const timestamp = seconds(record.timestamp);
    const elapsed = timestamp === undefined ? undefined : timestamp - start;
    return elapsed !== undefined && elapsed >= (options.startSeconds ?? 0) && elapsed <= (options.endSeconds ?? Infinity);
  });
  const timerEvents = (messages.eventMesgs ?? []).filter((event) => event.event === "timer" && event.timestamp instanceof Date && (event.eventType === "start" || String(event.eventType).startsWith("stop")));

  const decoded: DecodedFitFile = {
    fileName,
    ...(errors.length > 0 && { errors: errors.map((error) => error.message) }),
    fileId: messages.fileIdMesgs?.[0],
    activity: messages.activityMesgs?.[0],
    sessions: all(messages.sessionMesgs),
    laps: all(messages.lapMesgs),
    distanceSplits: distanceSplits(records, options.splitDistance, timerEvents as Message[]),
    splitTimeMethod: timerEvents.length ? "timer events where available; interpolated between samples" : "elapsed time between samples; pauses may be included (no timer events)",
    ...(options.includeRecords && { lapAnalysis: summarizeLaps(records, (messages.lapMesgs ?? []) as Message[], start) }),
    splits: all(messages.splitMesgs),
    splitSummaries: all(messages.splitSummaryMesgs),
    timeInZone: messages.timeInZoneMesgs,
    devices: uniqueDevices(messages.deviceInfoMesgs ?? []),
    events: messages.eventMesgs?.filter((event) => event.event !== "timer" || event.eventType !== "start"),
    recordCount: records.length,
    ...(options.includeRecords && {
      records: recordTable(downsample(window, options.maxRecords), start),
      recordBuckets: summarizeBuckets(window, options.maxRecords, start),
      heartRateChanges: heartRateChanges(window, start),
      ...(options.targetHeartRate !== undefined && { heartRateTarget: targetHeartRate(window, start, options.startSeconds ?? 0, options.targetHeartRate) }),
      sampling: { totalRecords: records.length, windowRecords: window.length, returnedRecords: Math.min(window.length, options.maxRecords), startSeconds: options.startSeconds ?? 0, endSeconds: options.endSeconds ?? null, note: "Rows are sampled; bucket extrema and changes use all records in the requested window. Up to 50 adjacent changes >=20 bpm within 30 seconds are shown; these are observations, not diagnoses." },
    }),
  };
  return options.includeLocations ? decoded : stripLocations(decoded) as DecodedFitFile;
}

/** Remove coordinate fields at any nesting level; preserve Date instances. */
function stripLocations(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripLocations);
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(lat|lon|latitude|longitude)$|(?:Lat|Long|Latitude|Longitude)$/i.test(key)).map(([key, item]) => [key, stripLocations(item)]));
}

function isZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** FIT stores coordinates as semicircles; convert every `*Lat` / `*Long` field to degrees. */
function withDegrees(message: Message, includeLocations: boolean): Message {
  const converted: Message = {};
  for (const [key, value] of Object.entries(message)) {
    if (!includeLocations && /(Lat|Long)$/.test(key)) continue;
    converted[key] = typeof value === "number" && /(Lat|Long)$/.test(key) ? value * SEMICIRCLES_TO_DEGREES : value;
  }
  return converted;
}

/** Devices are logged repeatedly during an activity; keep one merged entry per device. */
function uniqueDevices(devices: readonly object[]): unknown[] {
  const seen = new Map<string, Message>();
  for (const { timestamp: _timestamp, ...device } of devices as Message[]) {
    const key = String(device.deviceIndex ?? device.serialNumber ?? seen.size);
    seen.set(key, { ...seen.get(key), ...device });
  }
  return [...seen.values()];
}

const seconds = (value: unknown) => (value instanceof Date ? value.getTime() / 1000 : undefined);
const num = (value: unknown) => (typeof value === "number" ? value : undefined);

/** The record fields worth a timeline, in column order. */
const RECORD_COLUMNS: Array<[string, (record: Message, start: number) => unknown]> = [
  ["elapsedSeconds", (record, start) => Math.round((seconds(record.timestamp) ?? start) - start)],
  ["distance", (record) => record.distance],
  ["speed", (record) => record.enhancedSpeed ?? record.speed],
  ["heartRate", (record) => record.heartRate],
  ["cadence", (record) => record.cadence],
  ["power", (record) => record.power],
  ["altitude", (record) => record.enhancedAltitude ?? record.altitude],
  ["lat", (record) => record.positionLat],
  ["lon", (record) => record.positionLong],
  ["temperature", (record) => record.temperature],
];

function recordTable(records: Message[], start: number): RecordTable {
  const values = RECORD_COLUMNS.map(([, read]) => records.map((record) => read(record, start) ?? null));
  // Keep only the columns this activity actually recorded.
  const used = RECORD_COLUMNS.map((_, index) => index).filter((index) => values[index]!.some((value) => value !== null));
  return {
    columns: used.map((index) => RECORD_COLUMNS[index]![0]),
    rows: records.map((_, row) => used.map((index) => values[index]![row])),
  };
}

/**
 * Splits of `splitMeters` computed from the full-resolution records, like the
 * per-kilometre splits in Garmin Connect. Time is interpolated at each
 * boundary. Timer events exclude recorded pauses; without them elapsed time is
 * an approximation and may include pauses. Sparse records can only be interpolated.
 */
export function distanceSplits(records: Message[], splitMeters: number, events: Message[] = []): DistanceSplit[] {
  const points: Array<{ t: number; d: number; hr?: number; alt?: number }> = [];
  for (const record of records) {
    const t = seconds(record.timestamp);
    const d = num(record.distance);
    if (t === undefined || d === undefined) continue;
    points.push({ t, d, hr: num(record.heartRate), alt: num(record.enhancedAltitude ?? record.altitude) });
  }

  const splits: DistanceSplit[] = [];
  const firstDistance = points[0]?.d ?? 0;
  let boundary = firstDistance + splitMeters;
  const orderedEvents = events.filter((event) => event.event === "timer" && seconds(event.timestamp) !== undefined).sort((a,b) => seconds(a.timestamp)! - seconds(b.timestamp)!);
  const activeSeconds = (from: number, to: number) => {
    if (!orderedEvents.length) return Math.max(0, to - from);
    let active = true, cursor = from, total = 0;
    for (const event of orderedEvents) {
      const time = seconds(event.timestamp)!;
      if (time > to) break;
      if (time > cursor && active) total += time - cursor;
      if (time > cursor) cursor = time;
      const type = String(event.eventType);
      if (type === "start") active = true;
      else if (type.startsWith("stop")) active = false;
    }
    return total + (active ? to - cursor : 0);
  };
  let acc = { seconds: 0, hrSeconds: 0, hrSum: 0, ascent: 0 };
  const add = (time: number, hr: number | undefined) => {
    acc.seconds += time;
    if (hr !== undefined) {
      acc.hrSum += hr * time;
      acc.hrSeconds += time;
    }
  };
  const close = (distance: number) => {
    if (distance <= 0 || acc.seconds <= 0) return;
    splits.push({
      split: splits.length + 1,
      distanceMeters: Math.round(distance),
      seconds: Math.round(acc.seconds),
      pacePerKm: formatPace((acc.seconds / distance) * 1000),
      ...(acc.hrSeconds > 0 && { avgHeartRate: Math.round(acc.hrSum / acc.hrSeconds) }),
      ...(acc.ascent > 0 && { ascentMeters: Math.round(acc.ascent) }),
    });
    acc = { seconds: 0, hrSeconds: 0, hrSum: 0, ascent: 0 };
  };

  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1]!;
    const b = points[index]!;
    const dt = b.t - a.t;
    const counted = dt > 0 ? activeSeconds(a.t, b.t) : 0;
    const dd = b.d - a.d;
    const hr = b.hr ?? a.hr;
    const gain = a.alt !== undefined && b.alt !== undefined ? Math.max(0, b.alt - a.alt) : 0;
    let from = a.d;
    while (dd > 0 && b.d >= boundary) {
      add((counted * (boundary - from)) / dd, hr);
      acc.ascent += gain * (boundary - from) / dd;
      close(splitMeters);
      from = boundary;
      boundary += splitMeters;
    }
    add(dd > 0 ? (counted * (b.d - from)) / dd : counted, hr);
    acc.ascent += dd > 0 ? gain * (b.d - from) / dd : gain;
  }
  const last = points.at(-1);
  if (last) close(last.d - (boundary - splitMeters));
  return splits;
}

/** Fixed buckets include min/max over all records, rather than sampled rows. */
export function summarizeBuckets(records: Message[], max: number, start: number): unknown[] {
  if (!records.length) return [];
  const size = Math.ceil(records.length / max);
  const result = [];
  for (let i = 0; i < records.length; i += size) {
    const group = records.slice(i, i + size);
    const row: Record<string, unknown> = { startSeconds: (seconds(group[0]?.timestamp) ?? start) - start, endSeconds: (seconds(group.at(-1)?.timestamp) ?? start) - start, samples: group.length };
    for (const key of ["heartRate", "power", "speed", "cadence"]) {
      const values = group.map(r => num(key === "speed" ? r.enhancedSpeed ?? r.speed : r[key])).filter((v): v is number => v !== undefined && Number.isFinite(v));
      if (values.length) {
        const stats = values.reduce((acc, value) => ({ min: Math.min(acc.min, value), max: Math.max(acc.max, value), sum: acc.sum + value }), { min: Infinity, max: -Infinity, sum: 0 });
        row[key] = { min: stats.min, max: stats.max, avg: Math.round(stats.sum / values.length * 100) / 100, samples: values.length };
      }
    }
    result.push(row);
  }
  return result;
}

export function heartRateChanges(records: Message[], start: number): unknown[] {
  const changes: unknown[] = [];
  for (let i = 1; i < records.length && changes.length < 50; i++) {
    const a = records[i-1]!, b = records[i]!;
    const t0 = seconds(a.timestamp), t1 = seconds(b.timestamp), h0 = num(a.heartRate), h1 = num(b.heartRate);
    if (t0 === undefined || t1 === undefined || h0 === undefined || h1 === undefined) continue;
    if (t1 > t0 && t1 - t0 <= 30 && Math.abs(h1 - h0) >= 20) changes.push({ fromSeconds: t0-start, toSeconds: t1-start, fromBpm: h0, toBpm: h1, deltaBpm: h1-h0 });
  }
  return changes;
}

export function targetHeartRate(records: Message[], start: number, windowStart: number, target: number): unknown {
  const found = records.find(r => typeof r.heartRate === "number" && r.heartRate >= target && seconds(r.timestamp) !== undefined);
  const firstSample = records.find(r => typeof r.heartRate === "number" && seconds(r.timestamp) !== undefined);
  const elapsed = found ? seconds(found.timestamp)! - start : undefined;
  return { targetBpm: target, referenceWindowStartSeconds: windowStart, firstSampleSeconds: firstSample ? seconds(firstSample.timestamp)! - start : null, firstReachedSeconds: elapsed ?? null, secondsAfterWindowStart: elapsed === undefined ? null : elapsed - windowStart, note: "First recorded sample at or above target; not a physiological response-time measurement. Sparse samples or an already-elevated starting HR affect the result." };
}

export function summarizeLaps(records: Message[], laps: Message[], start: number): unknown[] {
  return laps.map((lap, index) => {
    const from = seconds(lap.startTime), to = seconds(lap.timestamp);
    if (from === undefined || to === undefined || to < from) return { lap: index + 1, available: false };
    const samples = records.filter(record => { const time = seconds(record.timestamp); return time !== undefined && time >= from && time <= to; });
    const bucket = summarizeBuckets(samples, 1, start)[0] as Record<string, unknown> | undefined;
    return { lap: index + 1, startSeconds: from - start, endSeconds: to - start, ...(bucket ?? { samples: 0 }), note: "Sample averages are unweighted; lap boundaries may share a sample." };
  });
}

function formatPace(secondsPerKm: number): string {
  const rounded = Math.round(secondsPerKm);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
}

/** Evenly spaced sample that always keeps the first and last items. */
export function downsample<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  if (max <= 1) return items.slice(0, max);
  const step = (items.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, index) => items[Math.round(index * step)] as T);
}

/**
 * Compact projections of Garmin's daily records, for trend questions where the
 * full payload (~2.5 KB per day) would not fit a year into one tool result.
 */
import { z } from "zod";
import { addDays, daysBetween } from "../garmin/dates";

type Row = Record<string, unknown>;

export function coverageNote(rows: Row[], start: string, end: string): string {
  const days = new Set(rows.map(row => row.calendarDate).filter((date): date is string => typeof date === "string" && date >= start && date <= end));
  return `Requested ${start} through ${end} (${daysBetween(start, end)} days); ${days.size} distinct dates were returned. Missing dates and fields are not zero; averages only include available measurements.`;
}

export const detail = z
  .enum(["summary", "full"])
  .default("summary")
  .describe("summary: one flat row of key metrics per day. full: Garmin's complete records (much larger).");

export const period = z
  .enum(["day", "week", "month"])
  .default("day")
  .describe("day: one row each. week or month: average the rows per ISO week (Monday start) or calendar month (summary rows only).");

const path = (row: unknown, ...keys: string[]): unknown =>
  keys.reduce<unknown>((value, key) => (value && typeof value === "object" ? (value as Row)[key] : undefined), row);

export function summarizeDay(day: Row): Row {
  return {
    calendarDate: day.calendarDate,
    steps: path(day, "movement", "steps", "value"),
    stepGoal: path(day, "movement", "steps", "goal"),
    distanceMeters: path(day, "movement", "steps", "distanceInMeters"),
    floorsAscended: path(day, "movement", "floorsAscended", "value"),
    totalCalories: path(day, "calories", "burnedTotal"),
    activeCalories: path(day, "calories", "burnedActive"),
    restingHeartRate: path(day, "heartRate", "restingValue"),
    minHeartRate: path(day, "heartRate", "minValue"),
    maxHeartRate: path(day, "heartRate", "maxValue"),
    moderateIntensityMinutes: path(day, "intensityMinutes", "moderate"),
    vigorousIntensityMinutes: path(day, "intensityMinutes", "vigorous"),
    avgStress: path(day, "stress", "avgLevel"),
    maxStress: path(day, "stress", "maxLevel"),
    bodyBatteryMin: path(day, "bodyBattery", "minValue"),
    bodyBatteryMax: path(day, "bodyBattery", "maxValue"),
    bodyBatteryCharged: path(day, "bodyBattery", "chargedValue"),
    bodyBatteryDrained: path(day, "bodyBattery", "drainedValue"),
    avgRespiration: path(day, "respiration", "avgValue"),
    avgSpO2: path(day, "pulseOx", "avgValue"),
    minSpO2: path(day, "pulseOx", "minValue"),
  };
}

export function summarizeSleep(night: Row): Row {
  return {
    calendarDate: night.calendarDate,
    sleepStartLocal: night.sleepStartTimestampLocal,
    sleepEndLocal: night.sleepEndTimestampLocal,
    sleepTimeSeconds: night.sleepTimeSeconds,
    deepSleepSeconds: night.deepSleepSeconds,
    lightSleepSeconds: night.lightSleepSeconds,
    remSleepSeconds: night.remSleepSeconds,
    awakeSleepSeconds: night.awakeSleepSeconds,
    awakeCount: night.awakeCount,
    napTimeSeconds: night.napTimeSeconds,
    sleepScore: path(night, "sleepScores", "overall", "value"),
    sleepScoreQualifier: path(night, "sleepScores", "overall", "qualifierKey"),
    sleepScoreFeedback: night.sleepScoreFeedback,
    sleepNeedMinutes: path(night, "sleepNeed", "actual"),
    avgHeartRate: night.avgHeartRate,
    avgSleepStress: night.avgSleepStress,
    avgRespiration: night.averageRespirationValue,
    avgSpO2: night.averageSpO2Value,
    lowestSpO2: night.lowestSpO2Value,
  };
}

/**
 * Average flat rows per week or month. Numeric fields become the mean over the
 * rows that have a value; timestamps and other fields are dropped. `countKey`
 * (default `days`) counts the rows, and each `extremes` field also gets its
 * `…Min` and `…Max`.
 */
export function aggregate(
  rows: Row[],
  by: "day" | "week" | "month",
  { countKey = "days", extremes = [] as string[] } = {},
): Row[] {
  if (by === "day") return rows;
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const date = String(row.calendarDate ?? "");
    if (!date) continue;
    const key = by === "month" ? date.slice(0, 7) : isoWeekStart(date);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups].map(([key, group]) => {
    const averaged: Row = { [by === "month" ? "month" : "weekStarting"]: key, [countKey]: group.length };
    const fields = new Set(group.flatMap((row) => Object.keys(row)));
    const coverage: Record<string, number> = {};
    for (const field of fields) {
      const values = group.map((row) => row[field]).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
      // An average of epoch timestamps (bedtimes, wake times) means nothing.
      if (values.length === 0 || values.some((value) => value >= 1e12)) continue;
      averaged[field] = Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100;
      if (values.length < group.length) coverage[field] = values.length;
      if (extremes.includes(field)) {
        averaged[`${field}Min`] = Math.min(...values);
        averaged[`${field}Max`] = Math.max(...values);
      }
    }
    if (Object.keys(coverage).length) averaged.samplesPerField = coverage;
    return averaged;
  });
}

function isoWeekStart(date: string): string {
  const day = new Date(`${date}T00:00:00Z`);
  const offset = (day.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(day.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
}

export type TotalsPeriod = "week" | "month" | "total";

/**
 * The sport family of an activity type key, so street_running, trail_running
 * and treadmill_running count as running. Unknown keys stay as they are.
 */
export function sportOf(typeKey: string): string {
  const key = typeKey.replace(/_v\d+$/, "");
  if (/running$/.test(key)) return "running";
  if (/(cycling|biking|_ride|^ride)/.test(key)) return "cycling";
  if (/swimming$/.test(key)) return "swimming";
  if (/walking$/.test(key)) return "walking";
  if (/hiking$/.test(key)) return "hiking";
  if (/skiing$/.test(key) && key !== "skiing") return key.includes("cross_country") ? "cross_country_skiing" : "skiing";
  return key;
}

/**
 * Activity totals per period and sport, plus an `all` row per period. Each
 * sport row lists the activity types it merges. Units are in the field names
 * because these rows are read without the original records.
 */
export function activityTotals(activities: Row[], by: TotalsPeriod): Row[] {
  type Totals = {
    types: Set<string>;
    count: number;
    meters: number;
    seconds: number;
    moving: number;
    ascent: number;
    calories: number;
    load: number;
    hrSum: number;
    hrSeconds: number;
    available: Record<string, number>;
  };
  const empty = (): Totals => ({
    types: new Set(),
    count: 0,
    meters: 0,
    seconds: 0,
    moving: 0,
    ascent: 0,
    calories: 0,
    load: 0,
    hrSum: 0,
    hrSeconds: 0,
    available: {},
  });
  const groups = new Map<string, Map<string, Totals>>();
  const add = (totals: Totals, activity: Row, type: string) => {
    const number = (key: string) => (typeof activity[key] === "number" ? (activity[key] as number) : 0);
    totals.types.add(type);
    totals.count += 1;
    for (const key of ["distance", "duration", "movingDuration", "elevationGain", "calories", "activityTrainingLoad", "averageHR"]) {
      if (typeof activity[key] === "number" && Number.isFinite(activity[key]) && (key !== "averageHR" || (activity[key] as number) > 0)) totals.available[key] = (totals.available[key] ?? 0) + 1;
    }
    totals.meters += number("distance");
    totals.seconds += number("duration");
    totals.moving += number("movingDuration");
    totals.ascent += number("elevationGain");
    totals.calories += number("calories");
    totals.load += number("activityTrainingLoad");
    if (number("averageHR") > 0) {
      totals.hrSum += number("averageHR") * number("duration");
      totals.hrSeconds += number("duration");
    }
  };

  for (const activity of activities) {
    const date = String(activity.startTimeLocal ?? "").slice(0, 10);
    const period = by === "total" ? "total" : by === "month" ? date.slice(0, 7) : isoWeekStart(date);
    const type = String(activity.activityType ?? "unknown");
    const sports = groups.get(period) ?? new Map<string, Totals>();
    groups.set(period, sports);
    for (const key of new Set([sportOf(type), "all"])) {
      const totals = sports.get(key) ?? empty();
      sports.set(key, totals);
      add(totals, activity, type);
    }
  }

  const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;
  const periodFields = (period: string) =>
    by === "total" ? {} : by === "month" ? { month: period } : { weekStarting: period, weekEnding: addDays(period, 6) };
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([period, sports]) =>
      [...sports]
        .sort(([a], [b]) => (a === "all" ? 1 : b === "all" ? -1 : a.localeCompare(b)))
        .map(([sport, totals]) => ({
          ...periodFields(period),
          sport,
          // Name the merged types unless the row is exactly one type of the same name.
          ...(sport !== "all" && !(totals.types.size === 1 && totals.types.has(sport)) && {
            activityTypes: [...totals.types].sort(),
          }),
          count: totals.count,
          ...(totals.available.distance && { distanceKm: round(totals.meters / 1000, 2) }),
          ...(totals.available.duration && { durationHours: round(totals.seconds / 3600, 2) }),
          ...(totals.available.movingDuration && { movingHours: round(totals.moving / 3600, 2) }),
          ...(totals.available.elevationGain && { elevationGainMeters: Math.round(totals.ascent) }),
          ...(totals.available.calories && { calories: Math.round(totals.calories) }),
          ...(totals.available.activityTrainingLoad && { trainingLoad: Math.round(totals.load) }),
          samplesPerField: Object.fromEntries(["distance", "duration", "movingDuration", "elevationGain", "calories", "activityTrainingLoad", "averageHR"].map(key => [key, totals.available[key] ?? 0])),
          ...(totals.hrSeconds > 0 && { avgHeartRate: Math.round(totals.hrSum / totals.hrSeconds) }),
        })),
    );
}

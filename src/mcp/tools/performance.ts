import { z } from "zod";
import { dateRange, fetchInWindows, READ_ONLY, resolveRange, type ToolContext } from "../context";
import { aggregate } from "../summaries";
import { error, jsonResult, safely } from "../result";

/** Read-only endpoints in Garmin's official Personal API client. */
export function registerPerformanceTools({ server, garmin, today }: ToolContext) {
  server.registerTool(
    "garmin_get_vo2_max",
    {
      description: "Garmin's daily VO2 max estimates for a date range. Data and sport availability depend on Garmin and the device. This returns Garmin's response; missing days do not imply zero.",
      inputSchema: {
        ...dateRange,
        sport: z.string().min(1).max(40).optional().describe("Optional Garmin sport filter; omit to request all available sports."),
        period: z.enum(["day", "week", "month"]).default("day").describe("Aggregate VO2 max by sport per week or month, or return Garmin's daily records."),
      },
      annotations: READ_ONLY,
    },
    ({ startDate, endDate, sport, period }) => safely(async () => {
      const range = resolveRange(today, { startDate, endDate }, { defaultDays: 28 });
      if ("error" in range) return error(range.error);
      const records = await fetchInWindows<Record<string, unknown>>(range.start, range.end, 28, (from, to) =>
        garmin.getJson<Record<string, unknown>[]>(`/metrics-service/metrics/maxmet/daily/${from}/${to}`, { sport }));
      if (period === "day") return jsonResult(records, { note: `Requested ${range.start} to ${range.end}; missing days do not imply zero.` });
      const bySport = new Map<string, Record<string, unknown>[]>();
      for (const record of records) for (const [key, value] of Object.entries(record)) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const entry = value as Record<string, unknown>;
        const measurement = entry.vo2MaxPreciseValue ?? entry.vo2MaxValue;
        if (typeof measurement !== "number" || typeof entry.calendarDate !== "string") continue;
        const name = typeof entry.sport === "string" ? entry.sport : key;
        const rows = bySport.get(name) ?? [];
        rows.push({ calendarDate: entry.calendarDate, vo2Max: measurement });
        bySport.set(name, rows);
      }
      const rows = [...bySport].flatMap(([name, values]) => aggregate(values, period, { countKey: "measurements", extremes: ["vo2Max"] }).map(row => ({ ...row, sport: name })));
      return jsonResult(rows, { note: `Requested ${range.start} to ${range.end}; only returned measurements are averaged. Missing days do not imply zero.` });
    }),
  );

  server.registerTool(
    "garmin_get_activity_types",
    {
      description: "List Garmin activity types and their identifiers, useful for selecting an activity search filter.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    () => safely(async () => jsonResult(await garmin.getJson("/activity-service/activity/activityTypes/simple"))),
  );
}

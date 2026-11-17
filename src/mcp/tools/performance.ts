import { z } from "zod";
import { dateRange, READ_ONLY, resolveRange, type ToolContext } from "../context";
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
      },
      annotations: READ_ONLY,
    },
    ({ startDate, endDate, sport }) => safely(async () => {
      const range = resolveRange(today, { startDate, endDate }, { defaultDays: 28, maxDays: 28 });
      if ("error" in range) return error(range.error);
      return jsonResult(await garmin.getJson(`/metrics-service/metrics/maxmet/daily/${range.start}/${range.end}`, { sport }));
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

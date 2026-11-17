import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { GarminApiError, GarminClient } from "../src/garmin/client";
import { GARMIN, fakeJwt } from "./helpers";

function clientWith(handler: (url: URL, init?: RequestInit) => Response) {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const client = new GarminClient({
    // A fresh key per client keeps the token caches of different tests apart.
    apiKey: `key-${crypto.randomUUID()}`,
    region: "global",
    kv: env.OAUTH_KV,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      return handler(url, init);
    }) as typeof fetch,
  });
  return { client, calls };
}

const isTokenRequest = (url: URL) => url.pathname.endsWith("/personal-api-key/token");

describe("GarminClient", () => {
  it("exchanges the key once and reuses the token", async () => {
    const { client, calls } = clientWith((url) =>
      isTokenRequest(url) ? new Response(fakeJwt()) : Response.json({ ok: true }),
    );
    await client.getJson("/userprofile-service/userprofile/settings");
    await client.getJson("/userprofile-service/userprofile/settings");

    const tokenCalls = calls.filter(({ url }) => isTokenRequest(url));
    expect(tokenCalls).toHaveLength(1);
    const tokenHeaders = new Headers(tokenCalls[0]!.init?.headers);
    expect(tokenHeaders.get("Authorization")).toMatch(/^ApiKey key-/);
    // Garmin answers 406 to `Accept: application/json` on the token endpoint.
    expect(tokenHeaders.get("Accept")).toBe("*/*");
    expect(new Headers(calls[1]!.init?.headers).get("Authorization")).toMatch(/^Bearer /);
    expect(calls[1]!.url.origin).toBe(GARMIN);
  });

  it("shares token refresh between concurrent calls in one isolate", async () => {
    const { client, calls } = clientWith((url) => isTokenRequest(url) ? new Response(fakeJwt()) : Response.json({ ok: true }));
    await Promise.all([client.getJson("/a"), client.getJson("/b"), client.getJson("/c")]);
    expect(calls.filter(({ url }) => isTokenRequest(url))).toHaveLength(1);
  });

  it("does not expose upstream error bodies or send a token to another origin", async () => {
    const { client } = clientWith((url) => isTokenRequest(url) ? new Response(fakeJwt()) : new Response("sensitive-response", { status: 500 }));
    await expect(client.getJson("/a")).rejects.not.toThrow(/sensitive-response/);
    await expect(client.getJson("https://example.com/steal")).rejects.toThrow(/Invalid Garmin endpoint/);
  });

  it("constructs requests in Workers with manual redirects and does not follow them", async () => {
    const { client, calls } = clientWith((url, init) => {
      const request = new Request(url, init);
      expect(request.redirect).toBe("manual");
      return isTokenRequest(url) ? new Response(fakeJwt()) : Response.redirect("https://example.com/steal", 302);
    });
    await expect(client.getJson("/a")).rejects.toThrow(/HTTP 302/);
    expect(calls.every(({ url }) => url.origin === GARMIN)).toBe(true);
  });

  it("renews a revoked token once and retries", async () => {
    let dataCalls = 0;
    const { client, calls } = clientWith((url) => {
      if (isTokenRequest(url)) return new Response(fakeJwt());
      dataCalls += 1;
      return dataCalls === 1 ? new Response(null, { status: 401 }) : Response.json([1]);
    });
    expect(await client.getJson("/sleep-service/sleep/dailySleep")).toEqual([1]);
    expect(calls.filter(({ url }) => isTokenRequest(url))).toHaveLength(2);
  });

  it("encodes repeated query parameters and skips undefined ones", async () => {
    const { client, calls } = clientWith((url) => (isTokenRequest(url) ? new Response(fakeJwt()) : Response.json([])));
    await client.getJson("/activitylist-service/activities/search/activities", {
      requiredField: ["avgPower", "avgHr"],
      search: undefined,
      limit: 5,
    });
    const url = calls.at(-1)!.url;
    expect(url.searchParams.getAll("requiredField")).toEqual(["avgPower", "avgHr"]);
    expect(url.searchParams.has("search")).toBe(false);
    expect(url.searchParams.get("limit")).toBe("5");
  });

  it("returns null for 204 No Content", async () => {
    const { client } = clientWith((url) =>
      isTokenRequest(url) ? new Response(fakeJwt()) : new Response(null, { status: 204 }),
    );
    expect(await client.getJson("/hrv-service/hrv/2026-11-01")).toBeNull();
  });

  it("explains a rejected API key", async () => {
    const { client } = clientWith(() => new Response("expired", { status: 401 }));
    const failure = client.getJson("/userprofile-service/userprofile/settings");
    await expect(failure).rejects.toBeInstanceOf(GarminApiError);
    await expect(failure).rejects.toThrow(/Personal API key/);
  });

  it("maps rate limiting to an actionable message", async () => {
    const { client } = clientWith((url) =>
      isTokenRequest(url) ? new Response(fakeJwt()) : new Response("slow down", { status: 429 }),
    );
    await expect(client.getJson("/usersummary-service/usersummary/daily")).rejects.toThrow(/rate limiting/);
  });

  it("uses the China endpoint for the cn region", () => {
    const client = new GarminClient({ apiKey: "k", region: "cn", kv: env.OAUTH_KV });
    expect(client.baseUrl).toBe("https://personal.connectapi.garmin.cn");
  });
});

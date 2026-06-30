/**
 * Reddit adapter — free tier, **non-commercial/research only**, pull-based
 * (poll, no webhooks). Uses app-only OAuth (client_credentials) then the search
 * endpoint. Read-only; never posts.
 *
 * If credentials aren't configured, `fetch` throws a clear error so the
 * orchestrator can record Reddit as a coverage gap (P1) rather than crash.
 */

import type { Item, SourcePort, TopicDefinition } from "../ports.ts";
import { buildTopicQuery } from "./topic.ts";
import { stableId } from "./normalize.ts";

/** Shape of a Reddit listing child's `data` (subset we use). */
export interface RedditPostData {
  id: string;
  name?: string; // fullname, e.g. t3_abc
  author?: string;
  title?: string;
  selftext?: string;
  permalink?: string;
  created_utc?: number; // seconds
  subreddit?: string;
  score?: number;
  num_comments?: number;
  ups?: number;
}

export function normalizeRedditPost(d: RedditPostData): Item | null {
  if (!d.id) return null;
  const text = [d.title, d.selftext].filter(Boolean).join("\n\n").trim();
  const permalink = d.permalink
    ? `https://www.reddit.com${d.permalink}`
    : `https://redd.it/${d.id}`;
  return {
    id: stableId("reddit", d.id),
    source: "reddit",
    source_id: d.id,
    author: d.author ?? null,
    text,
    url: permalink,
    created_at: new Date((d.created_utc ?? 0) * 1000),
    fetched_at: new Date(),
    engagement: {
      score: d.score ?? d.ups ?? 0,
      comments: d.num_comments ?? 0,
    },
    parent_ref: null,
    embedding: null,
    raw: d as unknown as Record<string, unknown>,
  };
}

export interface RedditCredentials {
  clientId: string;
  clientSecret: string;
  userAgent?: string;
}

/** Pull credentials from the environment, or null if unset. */
export function redditCredentialsFromEnv(): RedditCredentials | null {
  const clientId = Deno.env.get("REDDIT_CLIENT_ID");
  const clientSecret = Deno.env.get("REDDIT_CLIENT_SECRET");
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    userAgent: Deno.env.get("REDDIT_USER_AGENT") ?? "hand-terminal/0.1 (research)",
  };
}

export interface RedditOptions {
  credentials?: RedditCredentials | null;
  limit?: number;
}

export class RedditAdapter implements SourcePort {
  readonly name = "reddit" as const;
  readonly #creds: RedditCredentials | null;
  readonly #limit: number;

  constructor(opts: RedditOptions = {}) {
    this.#creds = opts.credentials ?? redditCredentialsFromEnv();
    this.#limit = opts.limit ?? 50;
  }

  async #token(creds: RedditCredentials): Promise<string> {
    const basic = btoa(`${creds.clientId}:${creds.clientSecret}`);
    const res = await fetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        "authorization": `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": creds.userAgent!,
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new Error(`Reddit auth ${res.status} ${res.statusText}`);
    const json = await res.json() as { access_token?: string };
    if (!json.access_token) throw new Error("Reddit auth returned no access_token");
    return json.access_token;
  }

  async *fetch(topic: TopicDefinition): AsyncIterable<Item> {
    if (!this.#creds) {
      throw new Error("REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET not configured");
    }
    const token = await this.#token(this.#creds);
    const params = new URLSearchParams({
      q: buildTopicQuery(topic),
      limit: String(this.#limit),
      sort: "new",
      type: "link",
    });
    const res = await fetch(`https://oauth.reddit.com/search?${params}`, {
      headers: {
        "authorization": `Bearer ${token}`,
        "user-agent": this.#creds.userAgent!,
      },
    });
    if (!res.ok) throw new Error(`Reddit search ${res.status} ${res.statusText}`);

    const json = await res.json() as { data?: { children?: { data: RedditPostData }[] } };
    for (const child of json.data?.children ?? []) {
      const item = normalizeRedditPost(child.data);
      if (item) yield item;
    }
  }
}

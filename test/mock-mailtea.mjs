/**
 * A tiny stand-in for the Mailtea API, so this example's tests run with no
 * credentials and no network. It records every request it receives, which is
 * what the assertions read.
 *
 * Point the SDK (or fetch) at `server.url` to use it.
 */
import { createServer } from "node:http";

const EMAIL_ID = "txemail_00000000000000000000000000000000";

export async function startMockMailtea() {
  /** @type {Array<{method: string, path: string, authorization: string | null, body: any}>} */
  const requests = [];

  // The audience routes are stateful, because the behaviour worth testing IS
  // the state: a topic name collides on a second run, an upserted contact does
  // not duplicate, and a contact listing pages. A stateless stub would let the
  // example's re-run handling and pagination loop rot untested.
  /** @type {Array<{object: "topic", id: string, name: string}>} */
  const topics = [];
  /** @type {Map<string, {object: "contact", id: string, email: string, status: string}>} */
  const contacts = new Map();
  let sequence = 0;
  const nextId = (prefix) => `${prefix}_${String(++sequence).padStart(32, "0")}`;

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }

      const url = new URL(req.url ?? "/", "http://mock");
      requests.push({
        method: req.method ?? "GET",
        path: url.pathname,
        authorization: req.headers.authorization ?? null,
        body
      });

      const send = (status, payload) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      // Auth is checked first, the same way the real API does it — an example
      // that forgets the key should fail its test, not silently "send".
      if (!String(req.headers.authorization ?? "").startsWith("Bearer ")) {
        return send(401, { error: "Unauthorized" });
      }

      const route = `${req.method} ${url.pathname}`;

      if (route === "POST /v1/emails") return send(200, { id: EMAIL_ID });
      if (route === "POST /v1/emails/batch") {
        const items = Array.isArray(body) ? body : [];
        return send(200, {
          data: items.map((_, index) => ({
            id: `txemail_${String(index).padStart(32, "0")}`
          }))
        });
      }
      if (req.method === "GET" && /^\/v1\/emails\/[^/]+$/.test(url.pathname)) {
        return send(200, {
          object: "email",
          id: url.pathname.split("/").pop(),
          last_event: "delivered",
          subject: "Mock email",
          created_at: "2026-01-01T00:00:00.000Z"
        });
      }
      if (route === "GET /v1/emails") {
        return send(200, {
          object: "list",
          data: [],
          total: 0,
          limit: 20,
          offset: 0,
          has_more: false
        });
      }
      if (req.method === "PATCH" && /^\/v1\/emails\/[^/]+$/.test(url.pathname)) {
        return send(200, { object: "email", id: url.pathname.split("/").pop() });
      }
      // Cancel is POST /v1/emails/:id/cancel. There is no DELETE on emails —
      // the real API does not define one (apps/api/src/email-rest.ts).
      if (req.method === "POST" && /^\/v1\/emails\/[^/]+\/cancel$/.test(url.pathname)) {
        return send(200, { object: "email", id: url.pathname.split("/")[3] });
      }
      // POST /v1/contacts is an upsert: same address, same contact, new status.
      if (route === "POST /v1/contacts") {
        const existing = contacts.get(body?.email);
        const contact = {
          object: "contact",
          id: existing?.id ?? nextId("con"),
          email: body?.email,
          status: body?.status ?? existing?.status ?? "active"
        };
        contacts.set(contact.email, contact);
        return send(200, contact);
      }
      if (route === "GET /v1/contacts") {
        const status = url.searchParams.get("status");
        const matching = [...contacts.values()].filter((c) => !status || c.status === status);
        // Cursor pagination, and deliberately smaller pages than asked for: a
        // real API may return fewer than `limit`, and a client that treats one
        // short page as the end silently undercounts. Two per page keeps the
        // example's `has_more` loop honest.
        const start = Number(url.searchParams.get("after") ?? 0);
        const page = matching.slice(start, start + 2);
        const hasMore = start + page.length < matching.length;
        return send(200, {
          object: "list",
          data: page,
          has_more: hasMore,
          ...(hasMore ? { next_cursor: String(start + page.length) } : {})
        });
      }
      // Topic names are unique per publication; the real API answers 409.
      if (route === "POST /v1/topics") {
        if (topics.some((topic) => topic.name === body?.name)) {
          return send(409, { error: `Topic with name "${body?.name}" already exists` });
        }
        const topic = { object: "topic", id: nextId("top"), name: body?.name ?? "Topic" };
        topics.push(topic);
        return send(200, topic);
      }
      if (route === "GET /v1/topics") {
        return send(200, { object: "list", data: topics, has_more: false });
      }
      if (route === "POST /v1/segments") {
        return send(200, {
          object: "segment",
          id: nextId("seg"),
          name: body?.name,
          status_filter: body?.status_filter ?? null,
          query_filter: body?.query_filter ?? null
        });
      }
      if (route === "POST /v1/posts") {
        return send(200, { id: nextId("post") });
      }
      // A test copy goes only to the addresses named in the request.
      if (req.method === "POST" && /^\/v1\/posts\/[^/]+\/test$/.test(url.pathname)) {
        return send(200, {
          object: "test_send",
          id: url.pathname.split("/")[3],
          sent_at: "2026-01-01T00:00:00.000Z",
          from: body?.from,
          sent_to: body?.recipients ?? [],
          failed_to: []
        });
      }
      if (req.method === "POST" && /^\/v1\/posts\/[^/]+\/send$/.test(url.pathname)) {
        return send(200, { object: "post", id: url.pathname.split("/")[3] });
      }

      return send(404, { error: "Not Found", path: url.pathname });
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    /** The most recent request, which is what most assertions want. */
    get last() {
      return requests.at(-1);
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

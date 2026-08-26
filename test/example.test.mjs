/**
 * Runs the real example against the bundled mock API and checks what it put on
 * the wire. Spawning `index.mjs` rather than importing pieces of it means the
 * test covers the same code path a reader would run.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { startMockMailtea } from "./mock-mailtea.mjs";

const execFileAsync = promisify(execFile);
const EXAMPLE = fileURLToPath(new URL("../index.mjs", import.meta.url));
const PUBLICATION = "pub_test";
const FROM = "Example <hello@example.test>";
const TO = "editor@example.test";

/**
 * Run the example with only the environment the test supplies. The working
 * directory is an empty temp dir so a developer's real `.env` cannot leak in
 * and point a test run at the live API.
 */
function runExample(env) {
  return execFileAsync(process.execPath, [EXAMPLE], {
    cwd: mkdtempSync(join(tmpdir(), "mailtea-example-")),
    env: { PATH: process.env.PATH, ...env }
  });
}

function baseEnv(url) {
  return {
    MAILTEA_API_KEY: "mt_pat_test",
    MAILTEA_API_BASE_URL: url,
    MAILTEA_PUBLICATION_ID: PUBLICATION,
    MAILTEA_FROM: FROM,
    MAILTEA_TO: TO
  };
}

test("the example builds an audience and sends a post to it", async (t) => {
  const server = await startMockMailtea();
  t.after(() => server.close());

  const { stdout } = await runExample(baseEnv(server.url));

  // Every request must carry the key, or the example only appears to work.
  for (const request of server.requests) {
    assert.match(request.authorization ?? "", /^Bearer mt_pat_test$/);
  }

  // --- topics -------------------------------------------------------------
  const topics = server.requests.filter((r) => r.method === "POST" && r.path === "/v1/topics");
  assert.equal(topics.length, 2, "two topics created");
  assert.deepEqual(
    topics.map((r) => r.body.default_subscription),
    ["opt_out", "opt_in"],
    "one topic everyone gets, one they must ask for"
  );
  for (const request of topics) {
    assert.equal(request.body.publication_id, PUBLICATION);
    assert.equal(request.body.visibility, "public");
  }
  assert.deepEqual(
    topics.map((r) => r.body.name),
    ["Product updates", "Weekly digest"],
    "topic names are stable, so a second run reuses them"
  );

  // --- contacts -----------------------------------------------------------
  const created = server.requests.filter((r) => r.method === "POST" && r.path === "/v1/contacts");
  assert.equal(created.length, 5, "one direct contact plus the four CSV rows");
  for (const request of created) {
    assert.equal(request.body.publication_id, PUBLICATION);
    assert.match(request.body.email, /@example\.test$/);
  }
  // The CSV's statuses have to survive the import, or it re-subscribes people
  // who had already left.
  assert.deepEqual(
    created.map((r) => [r.body.email, r.body.status]),
    [
      ["reader@example.test", "active"],
      ["ada@example.test", "active"],
      ["grace@example.test", "active"],
      ["alan@example.test", "active"],
      ["katherine@example.test", "unsubscribed"]
    ]
  );

  // --- segment ------------------------------------------------------------
  const segment = server.requests.find((r) => r.method === "POST" && r.path === "/v1/segments");
  assert.ok(segment, "the segment request was made");
  assert.equal(segment.body.publication_id, PUBLICATION);
  assert.equal(segment.body.status_filter, "active");
  assert.equal(segment.body.query_filter, "@example.test");

  // --- post ---------------------------------------------------------------
  const posts = server.requests.filter((r) => r.method === "POST" && r.path === "/v1/posts");
  assert.equal(posts.length, 2, "the issue that goes out now, and the scheduled one");
  assert.equal(posts[0].body.publication_id, PUBLICATION);
  assert.match(posts[0].body.subject, /^Mailtea newsletter example \w+: issue one$/);
  assert.match(posts[0].body.html, /<h1>Issue one<\/h1>/);
  // Merge tags must reach the API unexpanded — the server substitutes them per
  // recipient, so an example that interpolated them locally would teach a bug.
  assert.match(posts[0].body.html, /\{\{contact\.email\}\}/);
  assert.match(posts[0].body.html, /href="\{\{unsubscribe\}\}"/);
  // Both issues reach subscribers, so both carry the in-body unsubscribe link —
  // a marketing example that ships one without it teaches the omission.
  assert.match(
    posts[1].body.html,
    /href="\{\{unsubscribe\}\}"/,
    "the scheduled issue carries an unsubscribe link too"
  );

  // --- test copy ----------------------------------------------------------
  const testSend = server.requests.find((r) => /^\/v1\/posts\/[^/]+\/test$/.test(r.path));
  assert.ok(testSend, "the test-send request was made");
  assert.equal(testSend.body.from, FROM);
  assert.deepEqual(testSend.body.recipients, [TO], "the test copy goes to you, not the audience");

  // --- audience send ------------------------------------------------------
  const sends = server.requests.filter((r) => /^\/v1\/posts\/[^/]+\/send$/.test(r.path));
  assert.equal(sends.length, 2, "one immediate send, one scheduled");
  // An audience send names no recipients. That is the whole point: the API
  // resolves who receives it from the publication's contacts.
  assert.equal(sends[0].body, null, "the immediate send carries no body");
  assert.ok(sends[0].path !== sends[1].path, "the two sends are different posts");
  // You test the post you then send, not some other draft.
  assert.equal(testSend.path.replace(/\/test$/, ""), sends[0].path.replace(/\/send$/, ""));
  assert.match(sends[1].body.scheduled_at, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  assert.ok(new Date(sends[1].body.scheduled_at) > new Date(), "scheduled in the future");
  assert.ok(
    !sends.some((r) => r.body && ("to" in r.body || "recipients" in r.body)),
    "no recipient list is ever sent with an audience send"
  );

  // --- read-back ----------------------------------------------------------
  const listings = server.requests.filter((r) => r.method === "GET" && r.path === "/v1/contacts");
  assert.ok(
    listings.some((r) => r.body === null),
    "listing is a GET with no body"
  );
  // The mock pages two at a time, so counting four actives means the example
  // actually followed `has_more` instead of trusting one page.
  assert.ok(
    listings.filter((r) => r.path === "/v1/contacts").length > 3,
    "the example paged rather than reading a single page per status"
  );

  // The ids and counts the API returned have to reach the operator.
  assert.match(stdout, /1\. ensured 2 topics\s+top_\S+, top_\S+/);
  assert.match(stdout, /4\. created a draft post\s+post_\S+/);
  assert.match(stdout, new RegExp(`5\\. sent a test copy to\\s+${TO}`));
  assert.match(stdout, /7\. audience\s+4 active, 1 unsubscribed, 0 suppressed/);
});

test("a second run reuses the topics it already created", async (t) => {
  const server = await startMockMailtea();
  t.after(() => server.close());

  await runExample(baseEnv(server.url));
  const before = server.requests.length;
  const { stdout } = await runExample(baseEnv(server.url));
  const second = server.requests.slice(before);

  const attempts = second.filter((r) => r.method === "POST" && r.path === "/v1/topics");
  assert.equal(attempts.length, 2, "the second run still tries to create both topics");
  // Both creates 409'd, so the run must have fallen back to a lookup by name
  // rather than dying — re-running an example should be boring.
  const lookups = second.filter((r) => r.method === "GET" && r.path === "/v1/topics");
  assert.ok(lookups.length >= 2, "the 409 fell back to listing topics by name");
  assert.match(stdout, /1\. ensured 2 topics\s+top_\S+, top_\S+/);

  // And the audience did not double: upserting the same addresses is a no-op.
  assert.match(stdout, /7\. audience\s+4 active, 1 unsubscribed, 0 suppressed/);
});

test("a missing API key fails with a readable message, not a stack trace", async () => {
  const failure = await runExample({
    MAILTEA_PUBLICATION_ID: PUBLICATION,
    MAILTEA_FROM: FROM,
    MAILTEA_TO: TO
  }).catch((error) => error);

  assert.equal(failure.code, 1, "exits non-zero");
  assert.match(failure.stderr, /status 0/);
  assert.match(failure.stderr, /missing_api_key/);
  assert.doesNotMatch(failure.stderr, /at .*index\.mjs/, "no raw stack trace");
});

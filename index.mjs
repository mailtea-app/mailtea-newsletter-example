import { readFileSync } from "node:fs";
import { Mailtea, MailteaError } from "mailtea-sdk";

// Node 20.6+ can read a .env file on its own, so the example runs with a plain
// `node index.mjs` and no dotenv dependency. On older runtimes, export the
// variables yourself before running.
if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile();
  } catch {
    // No .env file — the variables may already be in the environment.
  }
}

/** Fail loudly on missing configuration instead of sending to `undefined`. */
function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
  return value;
}

// A short per-run tag, so repeated runs stay distinguishable in the dashboard.
const runId = Math.random().toString(36).slice(2, 8);

/**
 * Topic names are unique per publication, so a second run gets a 409 rather
 * than a duplicate. Re-running an example should be boring, so fall back to
 * looking the existing topic up by name.
 */
async function ensureTopic(mailtea, publicationId, input) {
  try {
    return await mailtea.topics.create({ publication_id: publicationId, ...input });
  } catch (error) {
    if (!(error instanceof MailteaError) || error.status !== 409) throw error;
    const { data } = await mailtea.topics.list({ publication_id: publicationId, limit: 100 });
    const existing = data.find((topic) => topic.name === input.name);
    if (!existing) throw error;
    return existing;
  }
}

/**
 * Contacts are cursor-paginated: `has_more` plus the `next_cursor` you feed
 * back as `after`. Counting means walking the pages — there is no total.
 */
async function countContacts(mailtea, publicationId, status) {
  let count = 0;
  let after;
  do {
    const page = await mailtea.contacts.list({
      publication_id: publicationId,
      status,
      limit: 100,
      after
    });
    count += page.data.length;
    after = page.has_more ? page.next_cursor : undefined;
  } while (after);
  return count;
}

/**
 * Deliberately naive: `email,status` with no quoting. A real import wants a CSV
 * parser — the point here is the upsert loop, not the parsing.
 */
function readContactsCsv(path) {
  const [header, ...rows] = readFileSync(new URL(path, import.meta.url), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const columns = header.split(",");
  return rows.map((row) => Object.fromEntries(row.split(",").map((cell, i) => [columns[i], cell])));
}

async function main() {
  const publicationId = required("MAILTEA_PUBLICATION_ID");
  const from = required("MAILTEA_FROM");
  const testRecipient = required("MAILTEA_TO");

  // Built here, not at module scope, so a missing key surfaces through the
  // handler below as a message rather than as a stack trace.
  const mailtea = new Mailtea(process.env.MAILTEA_API_KEY, {
    // Optional override of the API host. Unset, the SDK uses https://api.mailtea.app.
    baseUrl: process.env.MAILTEA_API_BASE_URL
  });

  console.log(`Mailtea newsletter example, run ${runId}`);

  // 1. Topics are the subscription groups a reader can leave individually.
  //    `default_subscription` decides who a post tagged with the topic reaches:
  //    `opt_out` means everyone until they unsubscribe from it, `opt_in` means
  //    nobody until they ask for it. `public` puts the topic on the reader's
  //    preference page; a `private` topic is an internal label only.
  const productUpdates = await ensureTopic(mailtea, publicationId, {
    name: "Product updates",
    description: "Release notes and changelog highlights.",
    default_subscription: "opt_out",
    visibility: "public"
  });
  const weeklyDigest = await ensureTopic(mailtea, publicationId, {
    name: "Weekly digest",
    description: "Saturday roundup. Ask for it, or you will not get it.",
    default_subscription: "opt_in",
    visibility: "public"
  });
  console.log(`1. ensured 2 topics           ${productUpdates.id}, ${weeklyDigest.id}`);

  // 2. `contacts.upsert` is `POST /v1/contacts` under its real name: it creates
  //    the contact or returns the existing one, so an import can re-run.
  const direct = await mailtea.contacts.upsert({
    publication_id: publicationId,
    email: "reader@example.test",
    status: "active"
  });
  console.log(`2. upserted one contact       ${direct.email} (${direct.status})`);

  // ...and the same call in a loop is the whole of a CSV import. `status`
  //    carries over from the file, so an export from another provider keeps its
  //    unsubscribes instead of silently re-subscribing people.
  //
  //    These rows are `@example.test` addresses, and step 6 below really sends
  //    to them: `.test` is a reserved TLD with no MX, so each one hard bounces
  //    against your sending domain. Swap in addresses you control before
  //    running this against a publication whose reputation you care about.
  const imported = [];
  for (const row of readContactsCsv("./contacts.csv")) {
    imported.push(
      await mailtea.contacts.upsert({
        publication_id: publicationId,
        email: row.email,
        status: row.status
      })
    );
  }
  console.log(`   imported contacts.csv      ${imported.length} rows`);

  // 3. A segment is a saved audience definition. Give it a filter and it means
  //    "whoever matches, right now"; leave the filter off and it is instead a
  //    hand-picked member list. It is never both — a segment carrying a filter
  //    AND members has no answerable audience, so the API refuses that mix.
  //    `query_filter` is a case-insensitive substring match on the address.
  //
  //    Creating it is all the API does: `posts.send` below takes no segment, so
  //    a segment made here is one you then pick in the post's To: field in
  //    Mailtea Studio. An SDK send always goes to the whole active audience.
  //
  //    Segment names are not unique, and `create` really does create — there is
  //    no upsert — so the run id keeps repeat runs apart instead of piling up
  //    four segments with the same name.
  const segment = await mailtea.segments.create({
    publication_id: publicationId,
    name: `Active example.test readers ${runId}`,
    description: "Everyone still subscribed on the example.test domain.",
    status_filter: "active",
    query_filter: "@example.test"
  });
  console.log(`3. created a segment          ${segment.id}`);

  // 4. A post is one issue of the newsletter. It starts as a draft, so you can
  //    test it before anyone else sees it. `{{unsubscribe}}` and the
  //    `{{contact.*}}` tags are substituted per recipient at send time.
  const subject = `Mailtea newsletter example ${runId}: issue one`;
  const post = await mailtea.posts.create({
    publication_id: publicationId,
    subject,
    html: [
      "<h1>Issue one</h1>",
      "<p>Hello {{contact.email}} — this went to the audience of a Mailtea",
      "publication, not to a list of addresses in your code.</p>",
      '<p><a href="{{unsubscribe}}">Unsubscribe</a></p>'
    ].join("\n")
  });
  console.log(`4. created a draft post       ${post.id}`);

  // 5. A test copy renders the post exactly as a subscriber would receive it and
  //    delivers it to the addresses you name, subject prefixed `[TEST]`. It does
  //    not touch the audience and does not spend the draft.
  const test = await mailtea.posts.sendTest(post.id, {
    from,
    recipients: [testRecipient]
  });
  console.log(`5. sent a test copy to        ${test.sent_to.join(", ")}`);

  // 6. The real send. No recipient list: the audience is the publication's
  //    active contacts. Unsubscribed and suppressed contacts are excluded by
  //    the API, not by you. This post carries no topics — `posts.create` has no
  //    field for them — so no topic rule narrows it further; tag a post with a
  //    topic in Studio and the rules from step 1 apply on top.
  const sent = await mailtea.posts.send(post.id);
  console.log(`6. sent to the audience       ${sent.id}`);

  //    Same call with `scheduled_at` (ISO 8601, UTC) queues it instead. The
  //    audience is resolved when it goes out, so contacts added between now and
  //    then receive it too.
  //
  //    One way, over the API: `posts.delete` refuses anything that is no longer
  //    a draft and there is no unschedule endpoint, so once this line runs the
  //    only way to stop tomorrow's send is to unschedule it in Mailtea Studio.
  const scheduledAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const forLater = await mailtea.posts.create({
    publication_id: publicationId,
    subject: `Mailtea newsletter example ${runId}: issue two`,
    html: [
      "<h1>Issue two</h1>",
      "<p>Queued for tomorrow.</p>",
      // Every issue carries a List-Unsubscribe header, but give people the
      // in-body link too — it is the one most readers actually look for.
      '<p><a href="{{unsubscribe}}">Unsubscribe</a></p>'
    ].join("")
  });
  await mailtea.posts.send(forLater.id, { scheduled_at: scheduledAt });
  console.log(`   scheduled the next issue   ${forLater.id} for ${scheduledAt}`);

  // 7. Read the audience back. `active` is who a send can reach; the other two
  //    are the people the API will keep excluding for you.
  const [active, unsubscribed, suppressed] = await Promise.all([
    countContacts(mailtea, publicationId, "active"),
    countContacts(mailtea, publicationId, "unsubscribed"),
    countContacts(mailtea, publicationId, "suppressed")
  ]);
  console.log(
    `7. audience                   ${active} active, ${unsubscribed} unsubscribed, ${suppressed} suppressed`
  );

  const topics = await mailtea.topics.list({ publication_id: publicationId, limit: 100 });
  console.log(`   topics on the publication  ${topics.data.length}`);
}

try {
  await main();
} catch (error) {
  if (error instanceof MailteaError) {
    // `status` is 0 when the SDK gave up before making a request — a missing
    // API key, say. Otherwise it is the HTTP status the API returned. A send
    // with no one to deliver to is a 422, which is worth handling on its own:
    // it usually means the post's topic is opt-in and nobody has opted in.
    console.error(`Mailtea request failed (status ${error.status}): ${error.message}`);
    if (error.code) console.error(`  code:       ${error.code}`);
    // Quote the request id when you contact support about a failed send.
    if (error.requestId) console.error(`  request id: ${error.requestId}`);
    if (error.details) console.error(`  details:    ${JSON.stringify(error.details)}`);
  } else {
    console.error(error instanceof Error ? error.message : error);
  }
  process.exitCode = 1;
}

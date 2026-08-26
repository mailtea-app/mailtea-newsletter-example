# Mailtea + Newsletter (audience + posts) Example

This example shows how to use [Mailtea](https://mailtea.app) to run a newsletter
end to end: create topics, import contacts, save a segment, write a post, test
it on yourself, and send it to the audience.

## Prerequisites

To get the most out of this guide, you'll need to:

- [Create an API key](https://studio.mailtea.app/api-keys)
- [Verify your domain](https://docs.mailtea.app/docs/documentation/domains)

The key needs `contacts:read`, `contacts:write`, `issues:write` and
`issues:send`. Of the three presets in the key dialog only **Full access**
carries all four — "Sending access" is the `issues:*` scopes alone, so it `403`s
on the first call.

Newsletter endpoints belong to the marketing feature set, so the team needs the
Transactional + Marketing plan. On a transactional-only plan they answer `402`
with `code: "marketing_plan_required"`.

## Before you run this

This is not a dry run. Against a real publication it creates real contacts and
really sends, twice. Point `MAILTEA_PUBLICATION_ID` at a publication you are
happy to experiment on.

- **Step 6 sends to the whole active audience** — every `active` contact on the
  publication, not only the ones this example just added.
- **The rows in [`contacts.csv`](./contacts.csv) are `@example.test`
  addresses.** `.test` is a reserved TLD with no MX record, so each one hard
  bounces, and hard bounces count against your sending domain's reputation.
  Replace them with addresses you control before running this anywhere real.
- **The second issue is scheduled 24 hours out, and the API cannot take it
  back.** `DELETE /v1/posts/:id` accepts drafts only and there is no unschedule
  endpoint — a scheduled post is unscheduled in Mailtea Studio or not at all.

## Instructions

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy `.env.example` to `.env` and add your API key:
   ```bash
   cp .env.example .env
   ```
3. Run it:
   ```bash
   npm start
   ```

Everything lives in [`index.mjs`](./index.mjs), in seven numbered steps, and the
contacts it imports are in [`contacts.csv`](./contacts.csv).

## Transactional vs. marketing

Mailtea sends two different kinds of email, and they are not the same call.

**Transactional — `emails.send`.** You name the recipients. A receipt, a
password reset, a one-off notice. The address is an argument, and the email goes
out because your code said so.

```js
await mailtea.emails.send({ from, to: "reader@example.com", subject, html });
```

**Marketing — `posts.send`.** You name no recipients at all. You create a post
and send it *to the publication*, and Mailtea resolves who that is:

```js
const post = await mailtea.posts.create({ publication_id, subject, html });
await mailtea.posts.send(post.id);            // now
await mailtea.posts.send(post.id, { scheduled_at });  // or later
```

That resolution is the reason marketing sends exist as their own call. Before
anything reaches the wire, Mailtea narrows the publication's contacts by:

- **status** — only `active` contacts receive it. Anyone who unsubscribed is
  excluded, permanently, without you tracking it.
- **suppressions** — hard bounces and complaints stay off the send even if the
  contact still looks active in your list.
- **topics** — a post tagged with a public topic obeys that topic's
  `default_subscription`. `opt_out` means everyone except the people who left
  that topic; `opt_in` means only the people who joined it. A post tagged with
  an opt-in topic nobody has joined fails with a `422` naming the topic, rather
  than silently sending to nobody. (You create topics over the API, as this
  example does, but tag a post with one in Mailtea Studio — `posts.create` has
  no field for it, so a post made over the API starts untagged.)

Every recipient also gets a working `{{unsubscribe}}` link, and using it feeds
straight back into the status rule above.

None of that applies to `emails.send`. If you build a marketing send out of
transactional calls, you own consent, suppression, and unsubscribes yourself —
and getting one of them wrong is how a domain's reputation dies.

## What this example covers

- Creating topics with `topics.create`, and handling the `409` a repeat run gets
- Upserting contacts with `contacts.upsert`, including a CSV import loop
- Preserving each contact's `status` on import, so unsubscribes survive it
- Saving an audience filter with `segments.create`
- Writing an issue with `posts.create`, merge tags left for the server to expand
- Checking it on yourself with `posts.sendTest` before anyone else sees it
- Sending to the audience with `posts.send`, now and with `scheduled_at`
- Walking `has_more` / `next_cursor` to count contacts by status
- Catching `MailteaError` and printing the status, code, and request id

Two boundaries worth knowing before you copy this:

- **Segments are created over the API, but not targeted over it.** `posts.send`
  takes no segment, so an SDK send always goes to the whole active audience. To
  send to one segment, pick it in the post's To: field in Mailtea Studio.
- **Contacts carry an address and a status, and that is all.** There is no
  `first_name` on the contact endpoints; per-contact values behind merge tags
  like `{{contact.first_name}}` are set in Studio. `{{contact.email}}` and
  `{{unsubscribe}}` always resolve.

## Tests

```bash
npm test
```

The tests run against a bundled mock Mailtea server, so they need no API key
and make no network calls.

## Learn more

- [Documentation](https://docs.mailtea.app)
- [API reference](https://docs.mailtea.app/docs/api-reference)
- [Node.js SDK](https://github.com/mailtea-app/mailtea-node) ·
  [Python SDK](https://github.com/mailtea-app/mailtea-python) ·
  [MCP server](https://github.com/mailtea-app/mailtea-mcp)

# Quadem WhatsApp intake

A WhatsApp webhook that turns an inbound message into a qualified lead row, and
measures how long that took.

Built for [Quadem Digital](https://quademdigital.com), a small studio in Accra.
Enquiries arrived on WhatsApp at whatever hour they arrived and were answered
whenever the phone was next picked up. Nobody knew what that delay actually was,
because nothing recorded it.

Now it is a column: `minutes_to_qualify`.

## What it does

Three questions, then it stops.

| | |
|---|---|
| First message | Greeting, asks what they need |
| Their answer | Asks which city |
| Their answer | Asks whether they have a website, and for the address |
| Their answer | Captures it, marks the lead qualified, stamps `qualified_at` |

`qualified_at` minus `first_seen_at` is speed to lead. On the first live run it
was **64 seconds**, with each individual reply going out 2–3 seconds after the
message that triggered it.

## What it deliberately does not do

**It does not guess.** If the city is not in the known list it stores what the
person typed and flags it for a human rather than inventing a match. If the
website answer cannot be classified, the lead moves to `needs_human` and the bot
stops talking.

**It does not interrupt.** Once a lead is `qualified` or `needs_human`, no
further auto-replies are sent — ever. A bot talking over a real conversation is
worse than silence. This is the branch most flows get wrong.

**It does not start conversations.** Every message it sends is a reply inside the
24-hour service window the customer opened, so no message templates need
approval and Meta does not charge for the traffic.

## The three problems worth reading the code for

**Signature verification runs on the raw bytes.** Meta signs the exact body it
sent. `req.text()` is captured first and the HMAC computed over that string;
the JSON is parsed only after the signature checks out. Re-serialising the
parsed object produces a different digest and every legitimate request then
looks forged.

**The 200 comes before the work.** Meta disables a webhook after five
consecutive failures to respond within five seconds. The function writes the
raw message to Postgres, returns `200`, and only then does the Graph API call
inside `EdgeRuntime.waitUntil`. A send in front of the response is a webhook
that eventually switches itself off.

**Retries cannot create duplicate leads.** `wa_messages.wa_message_id` is
unique, and inserts use `onConflict: ignoreDuplicates`. A retried delivery hits
the conflict, returns no row, and is skipped — so a message is processed once
no matter how many times Meta sends it.

## Everything is written down

Three tables, and the reason each exists:

- `wa_messages` — every inbound message, raw payload included. The idempotency
  guard, and the thing that lets a failure be replayed instead of lost.
- `wa_leads` — one row per person, with the stage machine.
- `wa_outbound` — every message sent, with the Meta message id or the error.

That last table earns its keep. The first live send failed, and the reason was
sitting in `wa_outbound.error` as `(#131030) Recipient phone number not in
allowed list` — a one-query diagnosis instead of an evening of guessing why the
bot "doesn't reply".

RLS is enabled on all three with no policies, so nothing but the service role
can read customer conversations. The `wa_inbox` view is declared
`security_invoker` — without it a view runs with its creator's permissions and
hands out the rows the table's RLS was protecting.

## Stack

Supabase Edge Function (Deno) · Postgres · WhatsApp Cloud API

## Setup

[`SETUP.md`](SETUP.md) covers the database, the Meta app, the four secrets, the
deploy, and the two subscription steps that decide whether messages arrive at
all.

## Scope

This is a small system doing one job for one business. It runs on a Meta test
number, handles text messages only, and has no admin UI — the morning read is a
`select * from wa_inbox`. It is not a product.

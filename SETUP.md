# Quadem WhatsApp intake — setup

Two files:

- `migrations/0001_whatsapp.sql` — tables, enum, view
- `functions/whatsapp/index.ts` — the Supabase Edge Function

Budget about 90 minutes for a first run, most of it inside Meta's dashboard rather than in code.

A click-by-click walkthrough of section 2, with the four values laid out and tickable:
https://claude.ai/code/artifact/524d310a-3b57-4529-aee7-4f5510204ec2

---

## 1. Database, 5 minutes

Open the Supabase SQL editor and run `0001_whatsapp.sql`.

It creates `wa_messages` (raw inbound log, the idempotency guard), `wa_leads` (one row per person), `wa_outbound` (everything you send), and a `wa_inbox` view that is the thing you will actually read each morning.

RLS is on for all three tables with **no policies**, which means nothing but the service role can read them. That is deliberate. These rows are customer conversations. Add a policy later if you build an inbox screen.

---

## 2. Meta app, 30 to 45 minutes

1. Create a Meta Business account at business.facebook.com if you do not have one.
2. At developers.facebook.com, click **Create app**. Meta now asks for a **use case**, not an app type: choose **Connect with customers through WhatsApp**. Choosing "Other" and then "Business" lands you in a dashboard where the WhatsApp quickstart never appears and you start over.
3. On WhatsApp → API Setup you get a free **test number** and a temporary token. Note the **Phone number ID** — that is `WA_PHONE_ID`, not the phone number itself.
4. Add your own number as a test recipient so you can message it.
5. **Generate a permanent token before you build anything real.** Business Settings → Users → System users → **Add** → name it, role **Admin**.

   Then **Assign assets**, and make *two* assignments, not one:

   - **Apps** → your app → **Full control**
   - **WhatsApp accounts** → your WhatsApp Business account → **Full control**

   Then **Generate new token**, expiration **Never**, with `whatsapp_business_messaging`, `whatsapp_business_management` and `business_management`.

   Two traps here. The temporary token on the API Setup page expires in 24 hours, so everything works today and is broken tomorrow. And a token with all three permissions but no asset assignment returns `(#200) Requires permission`, which reads exactly like a missing scope — so you re-tick permissions that were never the problem. If a send fails on permissions, check the asset assignment first. Meta shows the token once.
6. Copy the **App Secret** from App Settings → Basic. That is `WA_APP_SECRET`.

Limits while you are unverified: **250 unique customers per 24 hours** — and that ceiling governs conversations *you* start, which this system never does. Every message it sends is a reply inside the 24-hour window a customer opened by messaging you first. Meta classes those as service conversations and does not charge for them, so at Quadem's volume this is free to run. Business verification takes 2 to 10 business days and only matters when you move to a real number or start sending outbound templates.

---

## 3. Secrets and deploy, 10 minutes

```bash
supabase secrets set \
  WA_VERIFY_TOKEN="pick-any-random-string" \
  WA_APP_SECRET="from-app-settings-basic" \
  WA_TOKEN="the-permanent-system-user-token" \
  WA_PHONE_ID="from-whatsapp-api-setup"

supabase functions deploy whatsapp --no-verify-jwt
```

**`--no-verify-jwt` is not optional.** Meta cannot send a Supabase JWT, so without it every delivery is rejected before your code runs. The signature check in the function is what replaces that authentication.

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected by the platform. Do not set them yourself.

---

## 4. Point Meta at it, 5 minutes

In the app: WhatsApp → Configuration → Webhook → Edit.

- Callback URL: `https://<project-ref>.supabase.co/functions/v1/whatsapp`
- Verify token: whatever you set as `WA_VERIFY_TOKEN`

Then **Manage** and subscribe to the `messages` field. Missing this step is why a correctly-deployed webhook receives nothing.

Two more links have to exist, and neither is obvious:

- **The WABA must be subscribed to the app.** Check in the Graph API Explorer with `GET /v21.0/<WABA_ID>/subscribed_apps`. If the list comes back empty, `POST` to the same path. The dashboard does not always create this for you.
- **The app must be in Live mode.** Meta's own docs: "some webhooks will not be sent if your app is in Dev mode." It is a toggle at the top of the app dashboard — not an App Review submission, and unrelated to Business verification.

**Meta's Test button bypasses both checks.** It posts a synthetic payload straight at your URL, so it can pass while real messages from a real phone go nowhere. Only a message from your own phone proves the system works.

If verification fails, it is almost always one of two things: the token does not match, or something is returning JSON instead of the raw challenge string. This function returns `text/plain`.

---

## 5. Test

Message the test number from your phone. You should get the greeting back within a couple of seconds.

Then check:

```sql
select * from wa_inbox;
select wa_message_id, from_wa_id, body, processed_at, process_error
  from wa_messages order by received_at desc limit 10;
select wa_id, body, wa_message_id, error from wa_outbound order by sent_at desc limit 10;
```

`process_error` and `wa_outbound.error` are where failures surface. If a reply never arrives but `wa_messages` has the row, the send failed and the reason is in `wa_outbound.error` — usually an expired token or the wrong phone ID.

Send the same message twice quickly. You should see one row in `wa_messages` and one reply, not two. That is the idempotency guard working.

---

## What it does

Three questions, then it stops.

1. First message → greeting, asks what they need
2. Their answer → asks which city
3. Their answer → asks whether they have a website, and for the address
4. Their answer → captures it, marks the lead qualified, stamps `qualified_at`

`qualified_at` minus `first_seen_at` is your speed to lead, exposed as `minutes_to_qualify` in the view. You currently have no idea what that number is. In a week you will.

**What it deliberately does not do:**

- It does not guess. If the city is not in the known list, it stores what they typed and flags it for you to check rather than inventing a match. If the website answer cannot be classified, the lead goes to `needs_human` and the bot stops talking.
- It never auto-replies to someone already `qualified` or `needs_human`. Once you are in a real conversation, a bot interrupting is worse than silence.
- It only replies to inbound messages, so everything stays inside WhatsApp's 24-hour service window. No message templates to get approved.

---

## Two things worth knowing

**The 5-second rule.** Meta disables a webhook after five consecutive failures to respond within five seconds. The function writes the raw message to Postgres, returns 200, then does the sending afterwards via `EdgeRuntime.waitUntil`. Never put a Graph API call in front of the response.

**Signature verification uses the raw body.** The HMAC is computed over the exact bytes Meta sent. Parse the JSON after verifying, never before, or a re-serialised body will produce a different digest and every request will look forged.

---

## Next, once it has run for a week

Add the HubSpot layer: on `qualified`, upsert a contact keyed on `wa_id` and create a deal at New enquiry carrying `city`, `need`, `headline_fault` and `recommended_tier`. Then point the daily prospecting briefing at the same portal, and inbound and outbound finally share one record.

That is the identity spine described in the earlier build spec, and this is the half that has to exist first.

# Live-chat integrations

Hitrapost ingests leads from any chat platform that can fire a webhook. The
shape is always the same: POST JSON to your intake URL, each request becomes
a new (or deduplicated) lead in the Leads kanban.

**Your intake URL** lives in Hitrapost → **Settings → Intake webhook**. Copy
it once and paste it into each provider below. If a URL ever leaks, rotate
it from the same screen and update every integration.

---

## Universal payload contract

The intake endpoint is forgiving. As long as one of `name`, `email`, or
`phone` is present, the lead is created.

```json
{
  "source":   "tidio",
  "name":     "Jane Doe",
  "email":    "jane@example.com",
  "phone":    "+44 7700 900123",
  "message":  "Asked about pricing on the homepage chat.",
  "source_ref": "tidio_msg_8a4b…",
  "extra_field": "preserved on the activity log"
}
```

The `source` string is normalized to a chip in the UI. Aliases are mapped in
`src/services/intake.service.js` → `SOURCE_ALIASES`. Currently recognised
chip ids: `tidio_livechat`, `tawk`, `crisp`, `smartsupp`, `livechat`,
`wordpress_form`, `email`. Anything we don't recognise renders as the
generic Webhook chip.

---

## Tidio

Tidio's "Send Webhook" automation node fires whenever a chat condition you
choose is met (visitor leaves email, conversation ends, agent tags lead, etc).

1. **Tidio → Automation → New automation**.
2. Trigger: pick whichever event represents a qualified lead — usually
   *"Visitor sends a message"* or *"Visitor provides email"*.
3. Add a node → **Send Webhook**.
4. URL: paste your Hitrapost intake URL.
5. Method: `POST`. Content-Type: `application/json`.
6. Body — paste this template and substitute Tidio variables (`{{visitor.…}}`):
   ```json
   {
     "source":     "tidio",
     "name":       "{{visitor.name}}",
     "email":      "{{visitor.email}}",
     "phone":      "{{visitor.phone}}",
     "message":    "{{visitor.last_message}}",
     "source_ref": "tidio_{{visitor.id}}"
   }
   ```
7. Save & enable. Test by chatting on your live site.

The `source_ref` is the dedup key — repeat events from the same visitor
land on a single lead with new activities, not five duplicates.

---

## Tawk.to

Tawk fires webhooks per chat event from **Administration → Property settings
→ Webhooks**.

1. **Add webhook** → Name it "Hitrapost".
2. URL: your Hitrapost intake URL.
3. Events: tick at least *"Chat ended"* and *"Offline message"*. Tick *"Chat
   transcript"* if you want every message logged.
4. Save.

Tawk sends its own JSON shape:

```json
{
  "event": "chatended",
  "visitor": { "name": "Jane", "email": "jane@example.com", "city": "London" },
  "message": { "text": "Looking for pricing" }
}
```

The intake's normalization picks up `visitor.name` / `visitor.email` /
`message.text` automatically. Set `source` server-side: in **Settings →
Intake webhook**, no per-channel toggle is needed — Tawk's default User-Agent
is detected and the lead is chipped as Tawk.

> **Tip:** If you want stricter dedup (one lead per visitor, not per chat),
> add a custom field "External ID" in Tawk and POST it as `source_ref`.

---

## Crisp

Crisp's webhook integration lives under **Settings → Plugins → Custom
plugin** (free Hub plan or above).

1. Create a new plugin → "Webhook receiver".
2. Configure outgoing webhooks → add Hitrapost URL.
3. Subscribe to:
   - `message:send`     (visitor sent a message)
   - `session:set_email` (visitor identified themselves)
4. Crisp sends:
   ```json
   {
     "event": "message:send",
     "data": {
       "session_id": "session_abc",
       "user": { "user_id": "u_123", "nickname": "Jane", "email": "jane@example.com" },
       "content": "Hi, do you offer custom plans?"
     }
   }
   ```
5. Use Crisp's payload-mapping to flatten `data.user.email` / `data.user.nickname`
   to top-level `email` / `name` fields, plus add:
   ```json
   { "source": "crisp", "source_ref": "crisp_{{data.session_id}}" }
   ```

---

## Smartsupp

Smartsupp exposes webhooks via **Settings → Integrations → Webhooks** (Pro+).

1. Add webhook → URL: your intake URL.
2. Trigger: *"Conversation finished"*.
3. Headers: `Content-Type: application/json`.
4. Body:
   ```json
   {
     "source":     "smartsupp",
     "name":       "{name}",
     "email":      "{email}",
     "phone":      "{phone}",
     "message":    "{lastMessage}",
     "source_ref": "smartsupp_{conversationId}"
   }
   ```

---

## LiveChat / JivoChat

LiveChat (livechatinc.com) and JivoChat both ship a Zapier-friendly webhook
integration; the cleanest path for both is **Zapier → Webhooks by Zapier →
POST → your intake URL**.

If you'd rather skip Zapier:

* **LiveChat:** **Settings → Integrations → Webhooks → Add**, subscribe to
  `chat_ended`, target your intake URL. LiveChat's payload nests visitor info
  under `chat.users[0]` — flatten in the webhook configurator UI.
* **JivoChat:** **Settings → Integrations → API/Webhooks**, paste intake URL,
  enable "Offline messages" and "Chat ended" events.

Set `source: "livechat"` or `source: "jivochat"` in the payload (we alias
`jivochat` to the LiveChat chip).

---

## Quick verification

After wiring any provider:

```bash
# Curl your intake URL directly to confirm it accepts your shape:
curl -X POST https://hitrapost.co.uk/api/intake/<YOUR_TOKEN> \
  -H "Content-Type: application/json" \
  -d '{"source":"tidio","name":"Test","email":"test@example.com","message":"smoke"}'
```

You should see `{"ok":true,"leadId":"…"}`. The lead lands in the Leads
kanban under "New" with the right source chip.

If you see `404 Invalid intake token` — your URL is stale (rotated). Grab a
fresh one from Settings → Intake webhook.

If you see `422 Payload must include at least one of: name, email, phone` —
your provider isn't sending any of the three, so add a mapping step in their
webhook configurator.

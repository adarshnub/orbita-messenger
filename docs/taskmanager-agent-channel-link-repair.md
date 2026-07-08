# Task Manager Agent Channel Link Repair

## Issue

A user can create an Orbita Messenger account and still see an empty Chats screen after being added as an employee in the WTM Task Manager admin panel.

Observed case:

- Phone: `+919946090967`
- Orbita profile: created successfully
- Task Manager agent link: created successfully later
- Agent conversation: existed and contained both the Task Manager agent and the user
- Conversation messages: none at diagnosis time

## Cause

The link lifecycle had two gaps:

1. If Task Manager tried to link an Orbita-channel employee before the Orbita profile existed for that phone number, Orbita returned `No Orbita user found for that phone number.` Task Manager preserved the employee for retry, but Orbita did not store a pending link request.
2. The Chats bootstrap loaded conversations only from `conversation_participants`. If a `taskmanager_agent_links` row existed but a participant row was missing because of a partial setup or older flow, the user had no membership row to load from, so the agent channel could be invisible.

## Fix

The backend now self-heals both cases:

- Added `taskmanager_pending_agent_links` to store Task Manager link attempts by normalized phone when the Orbita account does not exist yet.
- On every authenticated messenger action, `ensureProfile` runs and then materializes any pending Task Manager links for the profile phone.
- `loadConversations` now repairs active Task Manager agent links for the user before reading memberships, ensuring the agent and user participant rows exist.
- The `link_taskmanager_user` service action now reuses the same idempotent link helper for new, existing, and repaired links.

## Deployment Notes

Apply migration:

```sql
supabase/migrations/015_taskmanager_pending_agent_links.sql
```

Then deploy/restart the Orbita backend. Existing users with valid `taskmanager_agent_links` will be repaired on next bootstrap. Users added in Task Manager before creating Orbita accounts will be linked automatically the first time they sign in to Orbita Messenger.

## Verification Query

For a linked user, verify:

- `profiles.phone` matches the normalized phone.
- `taskmanager_agent_links.enabled = true`.
- `conversation_participants` contains both `orbita_user_id` and `agent_profile_id` for the linked `conversation_id`.
- `bootstrap` returns that conversation under `conversations`.

# Story Notes

A small book of facts for one chat. You write short notes by hand — passwords, gifts, agreements, names — and they go into the prompt with every request. The model cannot lose them to a context trim or to a thousand messages of history.

Not a summarizer and not a lorebook: no keywords, no triggers, no activation logic. A note is either enabled and always in the prompt, or disabled and sitting quietly in the panel.

```
The password to the fourth-floor hideout: "Spiders do not enter twice."
Alice named their little company the Order of the Soft Pillows.
```

## Using it

The feather button opens and closes the panel. Drag it anywhere — the position is remembered. The panel drags by its header; its height changes with the strip between the list and the footer (double-click the strip to reset).

| Control | What it does |
| --- | --- |
| `+` | new note |
| eye | enables and disables a note; a disabled note stays in the panel and never reaches the prompt |
| pencil | edit |
| trash on a card | delete the note |
| search | filter by text |
| gear | settings |
| Export / Import | JSON file with every note in this chat |
| trash in the footer | wipe the whole book for this chat |

The header counter reads `enabled/total · tokens`. Tokens come from your active tokenizer; when it is unavailable, a rough estimate is shown with a `~`.

Notes are multi-line. A single note holds its own list without complaint:

```
First year, Christmas gifts:
- Alice's mother sent Law rare potion ingredients
- Alice gave Law charcoal pencils and a black leather notebook
- Kid gave Alice a clockwork toad he built himself. She named it Madame Frou-Frou
```

In the editor `Ctrl+Enter` saves, `Escape` cancels, plain `Enter` is a newline.

## What reaches the model

Enabled notes are assembled into one block:

```
<story_notes>
Established facts of this story, recorded by the user...
Reference material only...
Use a fact only when the scene naturally reaches it...

note 1

note 2
</story_notes>
```

The block is rebuilt on every change and again right before each generation, so a deleted or disabled note leaves the prompt immediately. With no enabled notes the injection is cleared to an empty string and no block is sent at all.

## Settings

Settings are global — they describe how the block is delivered, not what is in it.

**Position in the prompt.** Default is before the chat history, where lorebooks usually live. Static facts do not need to be fresh, they need to be present.

`Depth 4` and `depth 0` place the block inside the history instead, closer to the end. Depth 0 means the list is the last thing the model reads before answering, and it will start performing it: the toad gets petted every other post and the password is said out loud for no reason. Keep that option for the case where facts are being ignored, not as a default.

**Block preamble.** The instruction above the list: it forbids restating the notes, rendering them as an info block, and steering the scene toward them. Edit it per model; the button beside it restores the original text.

## Where notes live

Chat metadata is the source of truth — it lives in the chat file on the server, travels with backups, and follows a branched chat. localStorage is a warm local mirror and the fallback when metadata is unreachable. The key is per chat, so a new chat starts with an empty book.

Same scheme as Relationship Memory Tracker, so both extensions behave identically when chats are switched or branched.

Notes do **not** migrate on their own into a fresh chat for the same AU — that is what export and import are for.

## When something is off

**The model recites facts unprompted.** Do not touch the depth first; tighten the preamble instead — strengthen the ban on mentioning facts to show it remembers them.

**Facts are ignored.** Check that the note is enabled (the eye) and that the block actually appears in the prompt. Only then try depth 4.

**Notes vanish after a reload.** Open the console: a `Chat metadata unavailable` warning means the extension is running on localStorage, so notes survive but only in this browser. Usually it means this SillyTavern version does not expose the metadata API.

**The button is gone.** Most likely dragged past an edge. Clear `story_notes_button_pos` in localStorage and reload.

## localStorage keys

| Key | Contents |
| --- | --- |
| `story_notes_v1::<chatId>` | mirror of the chat's notes |
| `story_notes_settings_v1` | prompt position and preamble |
| `story_notes_panel_pos`, `story_notes_panel_size` | panel geometry |
| `story_notes_button_pos` | button position |

## Planned

- v0.2 — dates pulled from info blocks (`DATE`, `LOCATION`), sections, drag to reorder
- v0.3 — an "ask the AI" button: the extension reads the last few messages and offers draft notes for you to edit or throw away before saving

## Version

0.1.0

// Story Notes v0.1.2
// A small always-on fact book for one chat.
//
// v0.1.2: anti-slop pass. Three changes, all aimed at one failure: a note that
//   names a physical object ("she writes on a tablet with a shark case") gets
//   performed in every other reply, while an abstract note about the same
//   character's parents sits quiet. An object is trivially insertable into any
//   scene, so a model looking for a way to show it remembers reaches for the
//   object first.
//   1. The default preamble now says explicitly that a reply using none of the
//      facts is a correct reply, and that objects listed here exist in the
//      background without having to be visible. Pure prohibition ("do not
//      restate") left the facts marked as important with no instruction about
//      what to actually do with them.
//   2. The block tag is <established_facts>, not <story_notes>. "Notes" reads
//      as something the author wants read out; "established" reads as settled
//      background.
//   3. RECENCY GUARD (new, on by default): before every generation the last few
//      chat messages are scanned, and any note whose keywords already appear
//      there gets a one-line "already established" marker appended inside the
//      block. A note that has just been used stops asking to be used again,
//      and un-marks itself once the scene has moved on. The panel shows a
//      marker icon on those cards so the guard is visible instead of magic.
//   Existing installs keep their saved preamble, EXCEPT when it is still the
//   untouched v0.1.1 default — that one is migrated to the new text, otherwise
//   the fix would silently not apply to anyone who already ran the extension.
//
// v0.1.1: UI language switch (Русский / English) and a neutral editor
//   placeholder. Every visible string, tooltip and confirm dialog goes through
//   t(); the language applies the moment it is picked, without the Save button,
//   because a language you cannot read is a bad place to hunt for a button.
//   The block preamble is NOT translated — it is prompt text aimed at the
//   model, not at the reader, and English instructions are the safer default
//   across models. It stays editable, so writing it in Russian is one paste.
//
// WHAT IT IS: notes you write by hand ("the password is X", "Kid gave her a
// mechanical toad") that are injected into every request, so the model cannot
// forget them no matter how the context is trimmed. Not a summarizer, not a
// lorebook: no keywords, no triggers, no activation logic. A note is either
// enabled (always in the prompt) or disabled (kept in the panel, never sent).
//
// STORAGE: chat metadata is the source of truth (it lives in the chat file on
// the server, travels with backups and chat branches), localStorage is a warm
// local mirror and the fallback when metadata is unreachable. Keyed per chat —
// a new chat starts with an empty book. Same scheme as Relationship Memory
// Tracker, so the two behave identically when chats are switched or branched.
//
// INJECTION DEPTH: default is IN_PROMPT (before the chat history, where
// lorebooks sit), NOT depth 0. Static facts do not need to be fresh, they need
// to be present. At depth 0 with the SYSTEM role the list becomes the last
// thing the model reads before answering, and it starts performing the facts:
// the toad gets petted every other post and the password is said out loud for
// no reason. The same failure the relationship tracker hit in its v2.3.0.
// The position is a setting in case a stubborn model needs it closer.
//
// DELETION: the injection is rebuilt from storage on every change and again
// before every generation. A deleted or disabled note is gone from the prompt
// immediately; an empty book clears the injection to an empty string instead of
// leaving a stale block behind.

import {
    eventSource,
    event_types,
    setExtensionPrompt,
    extension_prompt_types,
    extension_prompt_roles,
} from '../../../../script.js';
import { isRoleplayDocked, registerRoleplayPanel } from './roleplay-tools-adapter.js';

const LS_NOTES_KEY = 'story_notes_v1';
const LS_SETTINGS_KEY = 'story_notes_settings_v1';
const LS_PANEL_POS_KEY = 'story_notes_panel_pos';
const LS_PANEL_SIZE_KEY = 'story_notes_panel_size';
const LS_BUTTON_POS_KEY = 'story_notes_button_pos';

const METADATA_KEY = 'story_notes';
const INJECTION_KEY = 'story_notes_injection';

// The tag the model sees. Deliberately not "notes": a block called notes reads
// as authored material that wants to be acknowledged.
const BLOCK_TAG = 'established_facts';

const DEBUG = false;

function log(...args) {
    if (!DEBUG) return;
    console.log('[Story Notes]', ...args);
}

/* ----------------------------- localization ----------------------------- */

const STRINGS = {
    ru: {
        panelTitle: 'Story Notes',
        buttonTitle: 'Story Notes',

        addNote: 'Новая запись',
        settings: 'Настройки',
        close: 'Закрыть',
        searchPlaceholder: 'Поиск по записям',

        toggleOn: 'В промпте — выключить',
        toggleOff: 'Выключена — включить',
        edit: 'Изменить',
        delete: 'Удалить',

        editorPlaceholder: 'Факт, который должен остаться до конца истории',
        add: 'Добавить',
        save: 'Сохранить',
        cancel: 'Отмена',

        emptyBook: 'Записей пока нет. Нажми «+» и впиши то, что сюжет не должен потерять.',
        emptySearch: 'По запросу ничего не найдено.',

        language: 'Язык интерфейса',
        position: 'Место в промпте',
        positionHint: 'Глубина 0 ставит записи последними перед ответом. Модель начинает их отыгрывать: держи этот вариант на случай, когда факты игнорируются.',
        positionInPrompt: 'Перед историей чата (рекомендуется)',
        positionDepth4: 'В истории, глубина 4',
        positionDepth0: 'В истории, глубина 0 (макс. приоритет)',
        guard: 'Гасить уже прозвучавшие факты',
        guardHint: 'Перед генерацией просматриваются последние сообщения. Если ключевые слова записи там уже есть, к ней в промпте дописывается пометка «уже установлено, не называй снова». Когда сцена уходит дальше, пометка сама снимается.',
        hotBadge: 'Уже прозвучало в последних сообщениях — в промпте помечено как установленное',
        preamble: 'Преамбула блока',
        preambleHint: 'Инструкция перед списком: запрещает пересказывать записи и тянуть сцену к ним. Уходит в промпт, поэтому написана для модели, а не для чтения.',
        resetPreamble: 'Сбросить преамбулу',

        export: 'Экспорт',
        import: 'Импорт',
        clearAll: 'Удалить все записи этого чата',
        resizeHint: 'Потяни, чтобы изменить высоту; двойной клик — сброс',

        confirmDelete: (preview) => `Удалить запись?\n\n${preview}`,
        confirmClear: 'Удалить все записи этого чата?',
        exportEmpty: 'Нечего экспортировать: записей нет.',
        importUnreadable: 'Не удалось прочитать файл: это не похоже на экспорт Story Notes.',
        importEmpty: 'В файле нет записей.',
        importReplace: (incoming, existing) => `В файле ${incoming} записей, в этом чате уже ${existing}.\n\nOK — заменить всё, Отмена — добавить к существующим.`,
    },
    en: {
        panelTitle: 'Story Notes',
        buttonTitle: 'Story Notes',

        addNote: 'New note',
        settings: 'Settings',
        close: 'Close',
        searchPlaceholder: 'Search notes',

        toggleOn: 'In the prompt — disable',
        toggleOff: 'Disabled — enable',
        edit: 'Edit',
        delete: 'Delete',

        editorPlaceholder: 'A fact that has to survive to the end of the story',
        add: 'Add',
        save: 'Save',
        cancel: 'Cancel',

        emptyBook: 'No notes yet. Press "+" and write down what the story must not lose.',
        emptySearch: 'Nothing matches that search.',

        language: 'Interface language',
        position: 'Position in the prompt',
        positionHint: 'Depth 0 puts the notes last, right before the reply. The model starts performing them: keep this for the case where facts are being ignored.',
        positionInPrompt: 'Before the chat history (recommended)',
        positionDepth4: 'In the history, depth 4',
        positionDepth0: 'In the history, depth 0 (highest priority)',
        guard: 'Mute facts that just came up',
        guardHint: 'The last few messages are scanned before every generation. If a note\'s keywords are already there, the prompt gets an "already established, do not name it again" marker under that note. The marker clears itself once the scene moves on.',
        hotBadge: 'Already present in the recent messages — marked as established in the prompt',
        preamble: 'Block preamble',
        preambleHint: 'The instruction above the list: it forbids restating the notes and steering the scene toward them. This goes into the prompt, so it is written for the model rather than for reading.',
        resetPreamble: 'Reset preamble',

        export: 'Export',
        import: 'Import',
        clearAll: 'Delete every note in this chat',
        resizeHint: 'Drag to change the height, double-click to reset',

        confirmDelete: (preview) => `Delete this note?\n\n${preview}`,
        confirmClear: 'Delete every note in this chat?',
        exportEmpty: 'Nothing to export: there are no notes.',
        importUnreadable: 'Could not read the file: it does not look like a Story Notes export.',
        importEmpty: 'The file contains no notes.',
        importReplace: (incoming, existing) => `The file has ${incoming} notes, this chat already has ${existing}.\n\nOK — replace everything, Cancel — add to the existing ones.`,
    },
};

function t(key, ...args) {
    const lang = getSettings().lang;
    const value = STRINGS[lang]?.[key] ?? STRINGS.en[key] ?? key;
    return typeof value === 'function' ? value(...args) : value;
}

/* ------------------------------- settings ------------------------------- */

// The preamble is the anti-slop layer. A bare list of facts reads as a to-do
// list and the model starts reporting on it. Prohibition alone is not enough:
// "do not restate this" still leaves the facts flagged as important with no
// guidance on what to do instead, so the model finds a way to use them that is
// technically not a restatement — it puts the object in the scene. Hence the
// two positive permissions: a reply may use none of this, and an object listed
// here may stay off-screen. Editable, because prompt wording is model-specific.
const DEFAULT_PREAMBLE = [
    'Background knowledge about this story, recorded by the user. Everything here is true and current unless the scene clearly changes it.',
    '',
    'This block answers questions the scene may raise. It is not a list of things to include, and a reply that uses none of it is normal and correct.',
    '',
    'Use a fact only when the scene has already arrived at it on its own. Never introduce an object, person or detail from this block in order to show that you remember it, and never quote, list, summarize or restate the block itself.',
    '',
    'Objects named here exist in the background. They do not have to be visible, carried, named or handled in a reply.',
    '',
    'If something from this block has already appeared in the recent conversation, treat it as established and do not name it again.',
].join('\n');

// Preambles shipped as defaults by earlier versions. A saved preamble that
// still matches one of these verbatim was never edited by the user, so it is
// safe to upgrade — without this, the new wording would only ever reach fresh
// installs and the change would look like it did nothing.
const LEGACY_PREAMBLES = [
    [
        'Established facts of this story, recorded by the user. Everything here is true and current unless the scene clearly changes it.',
        'Reference material only. Never quote, list, summarize or restate this block in your reply, and never render it as an info block.',
        'Use a fact only when the scene naturally reaches it. Do not steer the scene toward these facts and do not mention them to prove you remember them.',
    ].join('\n'),
];

const DEFAULT_SETTINGS = {
    lang: 'ru',
    position: 'in_prompt',
    guard: true,
    preamble: DEFAULT_PREAMBLE,
};

// Settings are global (not per chat): they describe how the block is delivered
// and how the panel is labelled, not what is in the book.
function getSettings() {
    try {
        const raw = localStorage.getItem(LS_SETTINGS_KEY);
        if (!raw) return { ...DEFAULT_SETTINGS };

        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_SETTINGS };

        const savedPreamble = typeof parsed.preamble === 'string' ? parsed.preamble : DEFAULT_SETTINGS.preamble;

        return {
            lang: STRINGS[parsed.lang] ? parsed.lang : DEFAULT_SETTINGS.lang,
            position: typeof parsed.position === 'string' ? parsed.position : DEFAULT_SETTINGS.position,
            guard: parsed.guard !== false,
            preamble: LEGACY_PREAMBLES.includes(savedPreamble.trim()) ? DEFAULT_PREAMBLE : savedPreamble,
        };
    } catch (error) {
        console.error('[Story Notes] Failed to read settings:', error);
        return { ...DEFAULT_SETTINGS };
    }
}

function saveSettings(settings) {
    try {
        localStorage.setItem(LS_SETTINGS_KEY, JSON.stringify(settings));
    } catch (error) {
        console.error('[Story Notes] Failed to save settings:', error);
    }
}

/* ------------------------------ storage layer ------------------------------ */

function getContextSafe() {
    return window.SillyTavern?.getContext?.() || null;
}

function getCurrentChatId() {
    try {
        const context = getContextSafe();
        return context?.getCurrentChatId?.() ?? context?.chatId ?? null;
    } catch (error) {
        console.error('[Story Notes] Failed to read chat id:', error);
        return null;
    }
}

// Per-chat localStorage key, with a global fallback when no chat is open yet.
function getStorageKey() {
    const chatId = getCurrentChatId();
    return chatId ? `${LS_NOTES_KEY}::${chatId}` : LS_NOTES_KEY;
}

let warnedMetadataUnavailable = false;

function getChatMetadataSafe() {
    const context = getContextSafe();

    // API name differs between SillyTavern versions.
    const meta = context?.chatMetadata ?? context?.chat_metadata ?? null;
    return (meta && typeof meta === 'object') ? meta : null;
}

function persistChatMetadata() {
    const context = getContextSafe();

    try {
        if (typeof context?.saveMetadata === 'function') {
            context.saveMetadata();
            return true;
        }

        if (typeof context?.saveMetadataDebounced === 'function') {
            context.saveMetadataDebounced();
            return true;
        }
    } catch (error) {
        console.error('[Story Notes] Failed to persist chat metadata:', error);
    }

    return false;
}

function makeId() {
    return `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

// Tolerant of hand-edited or older files: anything unusable is dropped rather
// than allowed to break rendering or injection.
function normalizeNotes(value) {
    if (!Array.isArray(value)) return [];

    return value
        .filter((item) => item && typeof item === 'object')
        .map((item) => ({
            id: typeof item.id === 'string' && item.id ? item.id : makeId(),
            text: typeof item.text === 'string' ? item.text : '',
            enabled: item.enabled !== false,
        }))
        .filter((item) => item.text.trim().length > 0);
}

function readLocalStorageNotes() {
    try {
        const raw = localStorage.getItem(getStorageKey());
        if (!raw) return null;

        const parsed = JSON.parse(raw);
        const notes = normalizeNotes(parsed);
        return notes.length ? notes : null;
    } catch (error) {
        console.error('[Story Notes] Failed to read notes from localStorage:', error);
        return null;
    }
}

function getNotes() {
    const meta = getChatMetadataSafe();

    if (meta) {
        const stored = meta[METADATA_KEY];

        if (Array.isArray(stored) && stored.length > 0) {
            return normalizeNotes(stored);
        }

        // Empty metadata slot: seed it ONCE from the local mirror. Only ever
        // writes into an empty slot, so a stale local copy cannot roll back
        // real notes.
        const local = readLocalStorageNotes();

        if (local) {
            meta[METADATA_KEY] = local;
            persistChatMetadata();
            log('Seeded chat metadata from localStorage mirror.');
            return local;
        }

        return [];
    }

    // Metadata unavailable: normal during boot and chat switching, suspicious
    // when a chat is actually open — warn once so it is visible.
    if (getCurrentChatId() && !warnedMetadataUnavailable) {
        console.warn('[Story Notes] Chat metadata unavailable; running on localStorage fallback.');
        warnedMetadataUnavailable = true;
    }

    return readLocalStorageNotes() || [];
}

function saveNotes(notes) {
    const clean = normalizeNotes(notes);
    const meta = getChatMetadataSafe();

    if (meta) {
        meta[METADATA_KEY] = clean;
        persistChatMetadata();
    }

    try {
        localStorage.setItem(getStorageKey(), JSON.stringify(clean, null, 2));
    } catch (error) {
        console.error('[Story Notes] Failed to save notes to localStorage:', error);
    }
}

// Both stores at once, so a cleared book cannot resurrect from the mirror.
function clearNotes() {
    const meta = getChatMetadataSafe();

    if (meta && METADATA_KEY in meta) {
        delete meta[METADATA_KEY];
        persistChatMetadata();
    }

    try {
        localStorage.removeItem(getStorageKey());
    } catch (error) {
        console.error('[Story Notes] Failed to clear localStorage notes:', error);
    }
}

/* --------------------------------- helpers --------------------------------- */

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

// Rough fallback only. Cyrillic costs roughly 2-3 characters per token on the
// tokenizers in play here; the real count replaces this as soon as
// SillyTavern's tokenizer answers.
function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 2.8);
}

async function countTokens(text) {
    if (!text) return 0;

    const context = getContextSafe();

    try {
        if (typeof context?.getTokenCountAsync === 'function') {
            const value = await context.getTokenCountAsync(text);
            if (Number.isFinite(value)) return value;
        }

        if (typeof context?.getTokenCount === 'function') {
            const value = context.getTokenCount(text);
            if (Number.isFinite(value)) return value;
        }
    } catch (error) {
        log('Tokenizer unavailable, falling back to estimate:', error);
    }

    return estimateTokens(text);
}

/* ----------------------------- recency guard ----------------------------- */

// A note that has just been used does not need to be advertised again. The
// guard scans the tail of the chat and marks such notes inside the block, so
// the model sees "already established" instead of a standing invitation.
//
// Matching is prefix-based rather than exact: Russian inflects heavily, and
// планшет / планшета / планшетом have to count as the same word. Five shared
// characters is the sweet spot — it catches those three, and does not fuse
// планшет with планы (four shared characters) or акула with акварель.

const GUARD_LOOKBACK = 6;      // messages scanned, newest first
const GUARD_MIN_HITS = 2;      // occurrences before a note is considered hot
const GUARD_PREFIX = 5;        // shared leading characters that count as a match
const GUARD_MIN_WORD = 5;      // shorter note words are too generic to key on

const GUARD_MARKER = '(Already established in the recent scene. Do not name it again unless the scene itself requires it.)';

// Long enough to pass the length filter, common enough to match everything.
const GUARD_STOPWORDS = new Set([
    'который', 'которая', 'которые', 'которого', 'которой',
    'потому', 'поэтому', 'всегда', 'никогда', 'иногда', 'обычно',
    'очень', 'может', 'можно', 'нужно', 'должен', 'должна', 'должно',
    'когда', 'после', 'перед', 'через', 'около', 'между', 'вместе',
    'своей', 'своих', 'своего', 'своему', 'этого', 'этому', 'этой',
    'также', 'просто', 'будет', 'была', 'были', 'быть', 'себя',
    'ничего', 'что-то', 'кто-то', 'сейчас', 'потом', 'обычная',
    'always', 'never', 'sometimes', 'usually', 'should', 'would',
    'their', 'there', 'which', 'about', 'because', 'these', 'those',
    'every', 'still', 'after', 'before', 'during', 'while', 'using',
    'thing', 'things', 'something', 'anything', 'really',
]);

function tokenize(text) {
    return String(text ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
}

// Character and persona names are in almost every message, so a note that
// names its own subject ("Alisa writes her notes on a tablet") would match on
// the name alone and sit permanently marked as established. Collected per chat
// instead of guessed: whatever this chat calls its participants.
function chatNameWords() {
    const context = getContextSafe();
    const names = new Set();

    const add = (value) => {
        for (const word of tokenize(value)) names.add(word);
    };

    add(context?.name1);
    add(context?.name2);

    // Group chats and swapped personas leave older names on the messages.
    const chat = context?.chat;

    if (Array.isArray(chat)) {
        for (let i = chat.length - 1, scanned = 0; i >= 0 && scanned < 40; i--, scanned++) {
            add(chat[i]?.name);
        }
    }

    return names;
}

function noteKeywords(text, exclude) {
    const words = new Set();

    for (const word of tokenize(text)) {
        if (word.length < GUARD_MIN_WORD) continue;
        if (GUARD_STOPWORDS.has(word)) continue;
        if (exclude?.has(word)) continue;
        words.add(word);
    }

    return [...words];
}

// Word -> occurrences across the scanned tail. Returns null when the chat is
// not readable (boot, chat switch), which disables the guard for that pass
// rather than guessing.
function recentWordCounts() {
    const chat = getContextSafe()?.chat;
    if (!Array.isArray(chat) || chat.length === 0) return null;

    const counts = new Map();
    let scanned = 0;

    for (let i = chat.length - 1; i >= 0 && scanned < GUARD_LOOKBACK; i--) {
        const message = chat[i];
        if (!message || message.is_system) continue;

        scanned++;

        for (const word of tokenize(message.mes)) {
            if (word.length < GUARD_PREFIX) continue;
            counts.set(word, (counts.get(word) || 0) + 1);
        }
    }

    return counts;
}

function sharedPrefixLength(a, b) {
    const limit = Math.min(a.length, b.length);
    let i = 0;
    while (i < limit && a[i] === b[i]) i++;
    return i;
}

function getHotNoteIds(notes) {
    const hot = new Set();
    if (!getSettings().guard) return hot;

    const counts = recentWordCounts();
    if (!counts || counts.size === 0) return hot;

    const names = chatNameWords();

    for (const note of notes) {
        // A note made only of names has nothing distinctive left to key on, so
        // it is never marked rather than always marked.
        const keywords = noteKeywords(note.text, names);
        if (keywords.length === 0) continue;

        let hits = 0;

        for (const [word, count] of counts) {
            if (keywords.some((keyword) => sharedPrefixLength(keyword, word) >= GUARD_PREFIX)) {
                hits += count;
                if (hits >= GUARD_MIN_HITS) break;
            }
        }

        if (hits >= GUARD_MIN_HITS) hot.add(note.id);
    }

    return hot;
}

/* ------------------------------- injection ------------------------------- */

function buildNotesText() {
    const notes = getNotes().filter((note) => note.enabled && note.text.trim());

    if (notes.length === 0) {
        return '';
    }

    const settings = getSettings();
    const hot = getHotNoteIds(notes);
    const parts = [];

    parts.push(`<${BLOCK_TAG}>`);

    if (settings.preamble.trim()) {
        parts.push(settings.preamble.trim());
        parts.push('');
    }

    // Notes are blocks, not lines (a single note can hold its own bullet list),
    // so they are separated by blank lines instead of being prefixed with "-".
    notes.forEach((note, index) => {
        parts.push(note.text.trim());
        if (hot.has(note.id)) parts.push(GUARD_MARKER);
        if (index < notes.length - 1) parts.push('');
    });

    parts.push(`</${BLOCK_TAG}>`);

    return parts.join('\n');
}

function resolveInjectionTarget(position) {
    switch (position) {
        case 'depth_0':
            return { type: extension_prompt_types.IN_CHAT, depth: 0 };
        case 'depth_4':
            return { type: extension_prompt_types.IN_CHAT, depth: 4 };
        case 'in_prompt':
        default:
            return { type: extension_prompt_types.IN_PROMPT, depth: 0 };
    }
}

function updatePromptInjection() {
    const text = buildNotesText();
    const { type, depth } = resolveInjectionTarget(getSettings().position);

    setExtensionPrompt(
        INJECTION_KEY,
        text,
        type,
        depth,
        false,
        extension_prompt_roles.SYSTEM
    );

    log(text ? 'Injection updated.' : 'Injection cleared: no enabled notes.');
}

/* --------------------------------- state --------------------------------- */

let searchQuery = '';
let editingId = null;      // note being edited
let creating = false;      // new-note editor is open
let showSettings = false;

/* ------------------------------- rendering ------------------------------- */

function editorHtml(value, saveLabel) {
    return `
        <div class="sn-editor">
            <textarea class="sn-editor-input" rows="4" placeholder="${escapeHtml(t('editorPlaceholder'))}">${escapeHtml(value)}</textarea>
            <div class="sn-editor-actions">
                <button type="button" class="sn-primary" data-sn-save><i class="fa-solid fa-check"></i> ${escapeHtml(saveLabel)}</button>
                <button type="button" class="sn-secondary" data-sn-cancel>${escapeHtml(t('cancel'))}</button>
            </div>
        </div>
    `;
}

function noteCardHtml(note, isHot) {
    const off = note.enabled ? '' : ' sn-off';
    const toggleIcon = note.enabled ? 'fa-eye' : 'fa-eye-slash';
    const toggleTitle = escapeHtml(note.enabled ? t('toggleOn') : t('toggleOff'));

    // Inline style rather than a class: style.css is shared with the rest of
    // the set and this badge is not worth a stylesheet bump.
    const hotBadge = isHot
        ? `<i class="fa-solid fa-volume-xmark sn-hot" style="opacity:.5;font-size:.85em;margin-right:auto;" title="${escapeHtml(t('hotBadge'))}"></i>`
        : '';

    return `
        <div class="sn-card${off}" data-sn-id="${escapeHtml(note.id)}">
            <div class="sn-card-text">${escapeHtml(note.text)}</div>
            <div class="sn-card-actions">
                ${hotBadge}
                <button type="button" class="sn-icon" data-sn-toggle title="${toggleTitle}"><i class="fa-solid ${toggleIcon}"></i></button>
                <button type="button" class="sn-icon" data-sn-edit title="${escapeHtml(t('edit'))}"><i class="fa-solid fa-pen"></i></button>
                <button type="button" class="sn-icon sn-icon-danger" data-sn-delete title="${escapeHtml(t('delete'))}"><i class="fa-solid fa-trash"></i></button>
            </div>
        </div>
    `;
}

function settingsHtml() {
    const settings = getSettings();

    const langOptions = [
        ['ru', 'Русский'],
        ['en', 'English'],
    ].map(([value, label]) => {
        const selected = settings.lang === value ? ' selected' : '';
        return `<option value="${value}"${selected}>${label}</option>`;
    }).join('');

    const positionOptions = [
        ['in_prompt', t('positionInPrompt')],
        ['depth_4', t('positionDepth4')],
        ['depth_0', t('positionDepth0')],
    ].map(([value, label]) => {
        const selected = settings.position === value ? ' selected' : '';
        return `<option value="${value}"${selected}>${escapeHtml(label)}</option>`;
    }).join('');

    return `
        <div class="sn-settings">
            <div class="sn-set-row">
                <label class="sn-set-label" for="sn-lang">${escapeHtml(t('language'))}</label>
                <select id="sn-lang">${langOptions}</select>
            </div>
            <div class="sn-set-row">
                <label class="sn-set-label" for="sn-position">${escapeHtml(t('position'))}</label>
                <select id="sn-position">${positionOptions}</select>
                <div class="sn-hint">${escapeHtml(t('positionHint'))}</div>
            </div>
            <div class="sn-set-row">
                <label class="sn-set-label" for="sn-guard">
                    <input type="checkbox" id="sn-guard"${settings.guard ? ' checked' : ''}>
                    ${escapeHtml(t('guard'))}
                </label>
                <div class="sn-hint">${escapeHtml(t('guardHint'))}</div>
            </div>
            <div class="sn-set-row">
                <label class="sn-set-label" for="sn-preamble">${escapeHtml(t('preamble'))}</label>
                <textarea id="sn-preamble" rows="7">${escapeHtml(settings.preamble)}</textarea>
                <div class="sn-hint">${escapeHtml(t('preambleHint'))}</div>
            </div>
            <div class="sn-set-actions">
                <button type="button" class="sn-primary" id="sn-settings-save"><i class="fa-solid fa-check"></i> ${escapeHtml(t('save'))}</button>
                <button type="button" class="sn-secondary" id="sn-settings-reset">${escapeHtml(t('resetPreamble'))}</button>
            </div>
        </div>
    `;
}

// Labels built once in createUi() have to follow the language too.
function applyStaticLabels() {
    const panel = document.querySelector('#sn-panel');
    if (!panel) return;

    const setTitle = (selector, key) => {
        const el = panel.querySelector(selector);
        if (el) el.title = t(key);
    };

    const button = document.querySelector('#sn-button');
    if (button) button.title = t('buttonTitle');

    const title = panel.querySelector('#sn-title');
    if (title) title.textContent = t('panelTitle');

    setTitle('#sn-add', 'addNote');
    setTitle('#sn-settings-toggle', 'settings');
    setTitle('#sn-close', 'close');
    setTitle('#sn-resize', 'resizeHint');
    setTitle('#sn-clear', 'clearAll');

    const search = panel.querySelector('#sn-search');
    if (search) search.placeholder = t('searchPlaceholder');

    const exportLabel = panel.querySelector('#sn-export .sn-label');
    if (exportLabel) exportLabel.textContent = t('export');

    const importLabel = panel.querySelector('#sn-import .sn-label');
    if (importLabel) importLabel.textContent = t('import');
}

async function updateHeader() {
    const titleEl = document.querySelector('#sn-title-count');
    if (!titleEl) return;

    const notes = getNotes();
    const active = notes.filter((note) => note.enabled).length;
    const text = buildNotesText();

    // Estimate first so the number never blinks empty, then correct it.
    titleEl.textContent = `${active}/${notes.length} · ~${estimateTokens(text)} tok`;

    const tokens = await countTokens(text);
    if (document.querySelector('#sn-title-count') === titleEl) {
        titleEl.textContent = `${active}/${notes.length} · ${tokens} tok`;
    }
}

function renderPanel() {
    const body = document.querySelector('#sn-body');
    if (!body) return;

    applyStaticLabels();

    const searchBar = document.querySelector('#sn-searchbar');

    if (showSettings) {
        if (searchBar) searchBar.style.display = 'none';
        body.innerHTML = settingsHtml();
        wireSettings(body);
        updateHeader();
        return;
    }

    if (searchBar) searchBar.style.display = '';

    const notes = getNotes();
    const query = searchQuery.trim().toLowerCase();
    const visible = query
        ? notes.filter((note) => note.text.toLowerCase().includes(query))
        : notes;

    // Computed once per render over the enabled notes, so the badges match what
    // the next generation will actually be told.
    const hot = getHotNoteIds(notes.filter((note) => note.enabled));

    const chunks = [];

    if (creating) {
        chunks.push(editorHtml('', t('add')));
    }

    if (visible.length === 0 && !creating) {
        const icon = notes.length === 0 ? 'fa-feather' : 'fa-magnifying-glass';
        const message = notes.length === 0 ? t('emptyBook') : t('emptySearch');
        chunks.push(`<div class="sn-empty"><i class="fa-solid ${icon}"></i><p>${escapeHtml(message)}</p></div>`);
    }

    for (const note of visible) {
        chunks.push(note.id === editingId
            ? editorHtml(note.text, t('save'))
            : noteCardHtml(note, hot.has(note.id)));
    }

    body.innerHTML = chunks.join('');
    wireList(body);
    updateHeader();
}

/* ------------------------------ note actions ------------------------------ */

function addNote(text) {
    if (!text.trim()) return;

    const notes = getNotes();
    notes.unshift({ id: makeId(), text: text.trim(), enabled: true });
    saveNotes(notes);
    updatePromptInjection();
}

function updateNote(id, text) {
    const notes = getNotes();
    const note = notes.find((item) => item.id === id);
    if (!note) return;

    // An emptied note is a deleted note — normalizeNotes would drop it anyway.
    if (!text.trim()) {
        deleteNote(id, true);
        return;
    }

    note.text = text.trim();
    saveNotes(notes);
    updatePromptInjection();
}

function toggleNote(id) {
    const notes = getNotes();
    const note = notes.find((item) => item.id === id);
    if (!note) return;

    note.enabled = !note.enabled;
    saveNotes(notes);
    updatePromptInjection();
}

function deleteNote(id, silent = false) {
    const notes = getNotes();
    const index = notes.findIndex((item) => item.id === id);
    if (index === -1) return;

    if (!silent) {
        const text = notes[index].text;
        const preview = text.length > 80 ? `${text.slice(0, 80)}…` : text;
        if (!confirm(t('confirmDelete', preview))) return;
    }

    notes.splice(index, 1);
    saveNotes(notes);
    updatePromptInjection();
}

/* -------------------------------- wiring -------------------------------- */

function wireList(body) {
    const editor = body.querySelector('.sn-editor');

    if (editor) {
        const input = editor.querySelector('.sn-editor-input');

        editor.querySelector('[data-sn-save]').addEventListener('click', () => {
            const value = input.value;

            if (creating) {
                addNote(value);
                creating = false;
            } else if (editingId) {
                updateNote(editingId, value);
                editingId = null;
            }

            renderPanel();
        });

        editor.querySelector('[data-sn-cancel]').addEventListener('click', () => {
            creating = false;
            editingId = null;
            renderPanel();
        });

        // Ctrl+Enter saves, Escape cancels. Plain Enter has to stay a newline:
        // notes are multi-line by design.
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                editor.querySelector('[data-sn-save]').click();
            } else if (event.key === 'Escape') {
                event.preventDefault();
                editor.querySelector('[data-sn-cancel]').click();
            }
        });

        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
    }

    body.querySelectorAll('.sn-card').forEach((card) => {
        const id = card.getAttribute('data-sn-id');

        card.querySelector('[data-sn-toggle]').addEventListener('click', () => {
            toggleNote(id);
            renderPanel();
        });

        card.querySelector('[data-sn-edit]').addEventListener('click', () => {
            creating = false;
            editingId = id;
            renderPanel();
        });

        card.querySelector('[data-sn-delete]').addEventListener('click', () => {
            deleteNote(id);
            renderPanel();
        });
    });
}

function wireSettings(body) {
    // Language applies immediately, without the Save button: a panel you cannot
    // read is a bad place to go looking for one. Position, guard and preamble
    // still wait for Save, so a half-typed preamble is never injected.
    body.querySelector('#sn-lang').addEventListener('change', (event) => {
        const settings = getSettings();
        settings.lang = event.target.value;

        // Keep whatever is currently set in the other fields, so switching
        // language mid-edit does not throw the edits away.
        settings.position = body.querySelector('#sn-position').value;
        settings.guard = body.querySelector('#sn-guard').checked;
        settings.preamble = body.querySelector('#sn-preamble').value;

        saveSettings(settings);
        updatePromptInjection();
        renderPanel();
    });

    body.querySelector('#sn-settings-save').addEventListener('click', () => {
        const settings = getSettings();
        settings.position = body.querySelector('#sn-position').value;
        settings.guard = body.querySelector('#sn-guard').checked;
        settings.preamble = body.querySelector('#sn-preamble').value;
        saveSettings(settings);
        updatePromptInjection();
        showSettings = false;
        renderPanel();
    });

    body.querySelector('#sn-settings-reset').addEventListener('click', () => {
        body.querySelector('#sn-preamble').value = DEFAULT_PREAMBLE;
    });
}

/* ------------------------------ export/import ------------------------------ */

function exportNotes() {
    const notes = getNotes();

    if (notes.length === 0) {
        alert(t('exportEmpty'));
        return;
    }

    const payload = {
        type: 'story_notes',
        version: 1,
        exported: new Date().toISOString(),
        notes,
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');

    const chatId = getCurrentChatId() || 'chat';
    link.href = url;
    link.download = `story-notes-${String(chatId).replace(/[^\w.-]+/g, '_')}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

function importNotes(file) {
    const reader = new FileReader();

    reader.onload = () => {
        let incoming = [];

        try {
            const parsed = JSON.parse(String(reader.result));
            incoming = normalizeNotes(Array.isArray(parsed) ? parsed : parsed?.notes);
        } catch (error) {
            console.error('[Story Notes] Import failed:', error);
            alert(t('importUnreadable'));
            return;
        }

        if (incoming.length === 0) {
            alert(t('importEmpty'));
            return;
        }

        const existing = getNotes();
        const replace = existing.length > 0 && confirm(t('importReplace', incoming.length, existing.length));

        // Fresh ids on import: two files exported from the same chat would
        // otherwise collide and edits would hit the wrong note.
        const stamped = incoming.map((note) => ({ ...note, id: makeId() }));

        saveNotes(replace ? stamped : [...stamped, ...existing]);
        updatePromptInjection();
        renderPanel();
    };

    reader.readAsText(file);
}

/* ------------------------------- geometry ------------------------------- */

const DRAG_EDGE = 8;
const DRAG_TOP_MARGIN = 50;
const PANEL_MIN_H = 240;
const COMPACT_WIDTH = 600;   // must match the media query in style.css

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

// visualViewport is more honest than innerHeight on tablets, where browser
// chrome expands and collapses.
function viewportSize() {
    const vv = window.visualViewport;
    if (vv && vv.width && vv.height) return { w: vv.width, h: vv.height };
    return { w: window.innerWidth, h: window.innerHeight };
}

function isCompactViewport() {
    return viewportSize().w <= COMPACT_WIDTH;
}

function clampToViewport(el, left, top) {
    const w = el.offsetWidth || 0;
    const h = el.offsetHeight || 0;
    const vp = viewportSize();
    const maxLeft = Math.max(DRAG_EDGE, vp.w - w - DRAG_EDGE);
    const maxTop = Math.max(DRAG_TOP_MARGIN, vp.h - h - DRAG_EDGE);

    return {
        left: clamp(left, DRAG_EDGE, maxLeft),
        top: clamp(top, DRAG_TOP_MARGIN, maxTop),
    };
}

function applyPosition(el, left, top) {
    if (isRoleplayDocked(el)) return;
    // Inline !important beats the fixed-position rules (and the mobile media
    // query) in style.css, so a dragged element actually moves.
    el.style.setProperty('left', `${left}px`, 'important');
    el.style.setProperty('top', `${top}px`, 'important');
    el.style.setProperty('right', 'auto', 'important');
    el.style.setProperty('bottom', 'auto', 'important');
}

function restorePosition(el, storageKey) {
    if (isRoleplayDocked(el)) return;
    try {
        const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
        if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
            const p = clampToViewport(el, saved.left, saved.top);
            applyPosition(el, p.left, p.top);
        }
    } catch (error) {
        console.error('[Story Notes] Failed to restore position:', error);
    }
}

// Drag `el` by `handle`, remembering the position. Sets el.__snDragMoved so a
// click handler on the same element can tell a drag from a tap.
function makeDraggable(el, { storageKey, handle = el } = {}) {
    restorePosition(el, storageKey);
    handle.style.touchAction = 'none';

    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let baseLeft = 0;
    let baseTop = 0;

    handle.addEventListener('pointerdown', (event) => {
        if (isRoleplayDocked(el)) return;
        const innerButton = event.target.closest('button');
        if (innerButton && innerButton !== el) return;
        if (event.button != null && event.button !== 0) return;

        dragging = true;
        moved = false;
        el.__snDragMoved = false;

        const rect = el.getBoundingClientRect();
        baseLeft = rect.left;
        baseTop = rect.top;
        startX = event.clientX;
        startY = event.clientY;

        try { handle.setPointerCapture(event.pointerId); } catch (e) { /* ignore */ }
    });

    handle.addEventListener('pointermove', (event) => {
        if (!dragging) return;

        const dx = event.clientX - startX;
        const dy = event.clientY - startY;
        if (!moved && Math.hypot(dx, dy) < 5) return;

        moved = true;
        el.__snDragMoved = true;

        const p = clampToViewport(el, baseLeft + dx, baseTop + dy);
        applyPosition(el, p.left, p.top);
    });

    function finish(event) {
        if (!dragging) return;
        dragging = false;

        try { handle.releasePointerCapture(event.pointerId); } catch (e) { /* ignore */ }

        if (moved) {
            const rect = el.getBoundingClientRect();
            try {
                localStorage.setItem(storageKey, JSON.stringify({ left: rect.left, top: rect.top }));
            } catch (e) { /* ignore */ }
        }
    }

    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
}

/* ------------------------------- resizing ------------------------------- */

// Height only. The width is style.css's business — it is shared with the rest
// of the set, and a two-axis corner grip invites mis-taps on a tablet.
function clampHeight(el, height) {
    const vp = viewportSize();
    const rect = el.getBoundingClientRect();

    // An untouched panel is pinned to the bottom by CSS, so growing it moves
    // its top edge up; a dragged one is pinned by top and grows downward.
    const room = el.style.top
        ? vp.h - rect.top - DRAG_EDGE
        : rect.bottom - DRAG_TOP_MARGIN;

    return clamp(height, PANEL_MIN_H, Math.max(PANEL_MIN_H, room));
}

function applyHeight(el, height) {
    if (isRoleplayDocked(el)) return;
    el.style.setProperty('height', `${height}px`, 'important');
}

function restoreHeight(el) {
    if (isRoleplayDocked(el)) return;
    if (isCompactViewport()) {
        el.style.removeProperty('height');
        return;
    }

    try {
        const saved = JSON.parse(localStorage.getItem(LS_PANEL_SIZE_KEY) || 'null');
        if (!saved || !Number.isFinite(saved.h)) return;
        applyHeight(el, clampHeight(el, saved.h));
    } catch (error) {
        console.error('[Story Notes] Failed to restore height:', error);
    }
}

function makeResizable(el, grip) {
    if (!grip) return;
    grip.style.touchAction = 'none';

    let resizing = false;
    let startY = 0;
    let baseH = 0;

    grip.addEventListener('pointerdown', (event) => {
        if (isRoleplayDocked(el)) return;
        if (event.button != null && event.button !== 0) return;
        if (isCompactViewport()) return;

        resizing = true;
        baseH = el.getBoundingClientRect().height;
        startY = event.clientY;
        el.classList.add('sn-resizing');

        try { grip.setPointerCapture(event.pointerId); } catch (e) { /* ignore */ }
        event.preventDefault();
    });

    grip.addEventListener('pointermove', (event) => {
        if (!resizing) return;
        applyHeight(el, clampHeight(el, baseH + (event.clientY - startY)));
    });

    function finish(event) {
        if (!resizing) return;
        resizing = false;
        el.classList.remove('sn-resizing');

        try { grip.releasePointerCapture(event.pointerId); } catch (e) { /* ignore */ }

        const rect = el.getBoundingClientRect();
        try {
            localStorage.setItem(LS_PANEL_SIZE_KEY, JSON.stringify({ h: rect.height }));
            if (el.style.top) {
                localStorage.setItem(LS_PANEL_POS_KEY, JSON.stringify({ left: rect.left, top: rect.top }));
            }
        } catch (e) { /* ignore */ }
    }

    grip.addEventListener('pointerup', finish);
    grip.addEventListener('pointercancel', finish);

    grip.addEventListener('dblclick', () => {
        try { localStorage.removeItem(LS_PANEL_SIZE_KEY); } catch (e) { /* ignore */ }
        el.style.removeProperty('height');
    });
}

/* ---------------------------------- UI ---------------------------------- */

function createUi() {
    if (document.querySelector('#sn-panel')) return;

    const button = document.createElement('button');
    button.id = 'sn-button';
    button.type = 'button';
    button.innerHTML = '<i class="fa-solid fa-feather"></i>';
    document.body.appendChild(button);

    const panel = document.createElement('div');
    panel.id = 'sn-panel';
    panel.style.display = 'none';
    panel.innerHTML = `
        <div id="sn-header">
            <div id="sn-brand">
                <i class="fa-solid fa-feather"></i>
                <div id="sn-title">Story Notes</div>
                <div id="sn-title-count">0/0</div>
            </div>
            <div id="sn-header-actions">
                <button type="button" id="sn-add"><i class="fa-solid fa-plus"></i></button>
                <button type="button" id="sn-settings-toggle"><i class="fa-solid fa-gear"></i></button>
                <button type="button" id="sn-close">×</button>
            </div>
        </div>
        <div id="sn-searchbar">
            <i class="fa-solid fa-magnifying-glass"></i>
            <input type="search" id="sn-search" autocomplete="off">
        </div>
        <div id="sn-body"></div>
        <div id="sn-resize"></div>
        <div id="sn-actions">
            <button type="button" id="sn-export" class="sn-secondary"><i class="fa-solid fa-download"></i> <span class="sn-label"></span></button>
            <button type="button" id="sn-import" class="sn-secondary"><i class="fa-solid fa-upload"></i> <span class="sn-label"></span></button>
            <button type="button" id="sn-clear" class="sn-secondary sn-danger-text"><i class="fa-solid fa-trash"></i></button>
        </div>
        <input type="file" id="sn-import-file" accept="application/json,.json" hidden>
    `;
    document.body.appendChild(panel);

    makeDraggable(panel, {
        storageKey: LS_PANEL_POS_KEY,
        handle: panel.querySelector('#sn-header'),
    });
    makeDraggable(button, { storageKey: LS_BUTTON_POS_KEY });
    makeResizable(panel, panel.querySelector('#sn-resize'));

    // Height first: the position clamp depends on the panel's dimensions.
    restoreHeight(panel);
    applyStaticLabels();

    button.addEventListener('click', () => {
        // A drag that ends over the button also fires a click.
        if (button.__snDragMoved) {
            button.__snDragMoved = false;
            return;
        }

        const opening = panel.style.display === 'none';
        panel.style.display = opening ? 'flex' : 'none';

        if (opening) {
            // A hidden panel measures 0x0, so both clamps only mean something
            // once it is actually on screen.
            restoreHeight(panel);
            restorePosition(panel, LS_PANEL_POS_KEY);
            renderPanel();
        }
    });

    panel.querySelector('#sn-close').addEventListener('click', () => {
        panel.style.display = 'none';
        creating = false;
        editingId = null;
        showSettings = false;
    });

    panel.querySelector('#sn-add').addEventListener('click', () => {
        showSettings = false;
        editingId = null;
        creating = true;
        renderPanel();
    });

    panel.querySelector('#sn-settings-toggle').addEventListener('click', () => {
        showSettings = !showSettings;
        creating = false;
        editingId = null;
        renderPanel();
    });

    const search = panel.querySelector('#sn-search');
    search.addEventListener('input', () => {
        searchQuery = search.value;
        renderPanel();
    });

    panel.querySelector('#sn-export').addEventListener('click', exportNotes);

    const fileInput = panel.querySelector('#sn-import-file');
    panel.querySelector('#sn-import').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
        const file = fileInput.files?.[0];
        if (file) importNotes(file);
        fileInput.value = '';
    });

    panel.querySelector('#sn-clear').addEventListener('click', () => {
        if (!confirm(t('confirmClear'))) return;

        clearNotes();
        updatePromptInjection();
        renderPanel();
    });

    // Rotating a tablet or resizing the window changes what "on-screen" means.
    window.addEventListener('resize', () => {
        if (panel.style.display !== 'none') {
            restoreHeight(panel);
            restorePosition(panel, LS_PANEL_POS_KEY);
        }
        restorePosition(button, LS_BUTTON_POS_KEY);
    });

    registerRoleplayPanel({
        id: 'notes', title: 'Story Notes', minHeight: 210,
        defaultPage: { id: 'story', name: 'Сюжет' },
        element: panel, launcher: button,
        controls: panel.querySelector('#sn-header-actions'),
        onShow: () => {
            if (!panel.querySelector('#sn-body').childElementCount) renderPanel();
        },
        // Existing handlers update content; re-rendering on activation loses drafts.
        onRelease: () => {
            if (panel.style.display !== 'none') {
                restoreHeight(panel);
                restorePosition(panel, LS_PANEL_POS_KEY);
            }
        },
    });
}

/* --------------------------------- events --------------------------------- */

function handleChatChanged() {
    // New chat, new book: reset the transient UI state so an editor left open
    // in the old chat cannot save into the new one.
    creating = false;
    editingId = null;
    showSettings = false;
    searchQuery = '';

    const search = document.querySelector('#sn-search');
    if (search) search.value = '';

    renderPanel();
    updatePromptInjection();
}

// The guard reads the chat tail, so a rendered badge goes stale as soon as a
// message lands. Cheap enough to just re-render when the panel is open.
function refreshHotBadges() {
    const panel = document.querySelector('#sn-panel');
    if (!panel || panel.style.display === 'none') return;
    if (showSettings || creating || editingId) return;   // never interrupt an editor

    renderPanel();
}

// Event names differ between SillyTavern versions, and eventSource.on(undefined)
// throws, which would abort the rest of init().
function onEvent(label, handler) {
    const name = event_types?.[label];

    if (!name) {
        console.warn(`[Story Notes] Event ${label} is not available in this SillyTavern version; skipping.`);
        return;
    }

    eventSource.on(name, handler);
}

function init() {
    createUi();
    updatePromptInjection();

    onEvent('CHAT_CHANGED', handleChatChanged);

    // Rebuilt right before the prompt is assembled, so what goes out is always
    // the current book — never a stale copy of a deleted note, and with the
    // recency guard measured against the newest messages.
    onEvent('GENERATE_BEFORE_COMBINE_PROMPTS', updatePromptInjection);
    onEvent('GENERATION_STARTED', updatePromptInjection);

    onEvent('MESSAGE_RECEIVED', refreshHotBadges);
    onEvent('MESSAGE_SWIPED', refreshHotBadges);
    onEvent('MESSAGE_DELETED', refreshHotBadges);

    log('Extension loaded.');
}

setTimeout(init, 1000);

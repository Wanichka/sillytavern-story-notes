// Story Notes v0.1.0
// A small always-on fact book for one chat.
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

const LS_NOTES_KEY = 'story_notes_v1';
const LS_SETTINGS_KEY = 'story_notes_settings_v1';
const LS_PANEL_POS_KEY = 'story_notes_panel_pos';
const LS_PANEL_SIZE_KEY = 'story_notes_panel_size';
const LS_BUTTON_POS_KEY = 'story_notes_button_pos';

const METADATA_KEY = 'story_notes';
const INJECTION_KEY = 'story_notes_injection';

const DEBUG = false;

function log(...args) {
    if (!DEBUG) return;
    console.log('[Story Notes]', ...args);
}

/* ------------------------------- settings ------------------------------- */

// The preamble is the anti-slop layer. A bare list of facts reads as a to-do
// list and the model starts reporting on it, so three things have to be said
// explicitly: this is reference, it is never displayed, and it must not steer
// the scene. Editable, because prompt wording is model-specific.
const DEFAULT_PREAMBLE = [
    'Established facts of this story, recorded by the user. Everything here is true and current unless the scene clearly changes it.',
    'Reference material only. Never quote, list, summarize or restate this block in your reply, and never render it as an info block.',
    'Use a fact only when the scene naturally reaches it. Do not steer the scene toward these facts and do not mention them to prove you remember them.',
].join('\n');

const DEFAULT_SETTINGS = {
    position: 'in_prompt',
    preamble: DEFAULT_PREAMBLE,
};

// Settings are global (not per chat): they describe how the block is delivered,
// not what is in it.
function getSettings() {
    try {
        const raw = localStorage.getItem(LS_SETTINGS_KEY);
        if (!raw) return { ...DEFAULT_SETTINGS };

        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_SETTINGS };

        return {
            position: typeof parsed.position === 'string' ? parsed.position : DEFAULT_SETTINGS.position,
            preamble: typeof parsed.preamble === 'string' ? parsed.preamble : DEFAULT_SETTINGS.preamble,
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

/* ------------------------------- injection ------------------------------- */

function buildNotesText() {
    const notes = getNotes().filter((note) => note.enabled && note.text.trim());

    if (notes.length === 0) {
        return '';
    }

    const settings = getSettings();
    const parts = [];

    parts.push('<story_notes>');

    if (settings.preamble.trim()) {
        parts.push(settings.preamble.trim());
        parts.push('');
    }

    // Notes are blocks, not lines (a single note can hold its own bullet list),
    // so they are separated by blank lines instead of being prefixed with "-".
    notes.forEach((note, index) => {
        parts.push(note.text.trim());
        if (index < notes.length - 1) parts.push('');
    });

    parts.push('</story_notes>');

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
            <textarea class="sn-editor-input" rows="4" placeholder="Пароль от секретной комнаты: «Пауки не входят дважды»">${escapeHtml(value)}</textarea>
            <div class="sn-editor-actions">
                <button type="button" class="sn-primary" data-sn-save><i class="fa-solid fa-check"></i> ${saveLabel}</button>
                <button type="button" class="sn-secondary" data-sn-cancel>Отмена</button>
            </div>
        </div>
    `;
}

function noteCardHtml(note) {
    const off = note.enabled ? '' : ' sn-off';
    const toggleIcon = note.enabled ? 'fa-eye' : 'fa-eye-slash';
    const toggleTitle = note.enabled ? 'В промпте — выключить' : 'Выключена — включить';

    return `
        <div class="sn-card${off}" data-sn-id="${escapeHtml(note.id)}">
            <div class="sn-card-text">${escapeHtml(note.text)}</div>
            <div class="sn-card-actions">
                <button type="button" class="sn-icon" data-sn-toggle title="${toggleTitle}"><i class="fa-solid ${toggleIcon}"></i></button>
                <button type="button" class="sn-icon" data-sn-edit title="Изменить"><i class="fa-solid fa-pen"></i></button>
                <button type="button" class="sn-icon sn-icon-danger" data-sn-delete title="Удалить"><i class="fa-solid fa-trash"></i></button>
            </div>
        </div>
    `;
}

function settingsHtml() {
    const settings = getSettings();

    const options = [
        ['in_prompt', 'Перед историей чата (рекомендуется)'],
        ['depth_4', 'В истории, глубина 4'],
        ['depth_0', 'В истории, глубина 0 (макс. приоритет)'],
    ].map(([value, label]) => {
        const selected = settings.position === value ? ' selected' : '';
        return `<option value="${value}"${selected}>${label}</option>`;
    }).join('');

    return `
        <div class="sn-settings">
            <div class="sn-set-row">
                <label class="sn-set-label" for="sn-position">Место в промпте</label>
                <select id="sn-position">${options}</select>
                <div class="sn-hint">Глубина 0 ставит записи последними перед ответом. Модель начинает их отыгрывать: держи этот вариант на случай, когда факты игнорируются.</div>
            </div>
            <div class="sn-set-row">
                <label class="sn-set-label" for="sn-preamble">Преамбула блока</label>
                <textarea id="sn-preamble" rows="7">${escapeHtml(settings.preamble)}</textarea>
                <div class="sn-hint">Инструкция перед списком: запрещает пересказывать записи и тянуть сцену к ним.</div>
            </div>
            <div class="sn-set-actions">
                <button type="button" class="sn-primary" id="sn-settings-save"><i class="fa-solid fa-check"></i> Сохранить</button>
                <button type="button" class="sn-secondary" id="sn-settings-reset">Сбросить преамбулу</button>
            </div>
        </div>
    `;
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

    const chunks = [];

    if (creating) {
        chunks.push(editorHtml('', 'Добавить'));
    }

    if (visible.length === 0 && !creating) {
        chunks.push(notes.length === 0
            ? `<div class="sn-empty"><i class="fa-solid fa-feather"></i><p>Записей пока нет. Нажми «+» и впиши то, что сюжет не должен потерять.</p></div>`
            : `<div class="sn-empty"><i class="fa-solid fa-magnifying-glass"></i><p>По запросу ничего не найдено.</p></div>`);
    }

    for (const note of visible) {
        chunks.push(note.id === editingId
            ? editorHtml(note.text, 'Сохранить')
            : noteCardHtml(note));
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
        const preview = notes[index].text.slice(0, 80);
        if (!confirm(`Удалить запись?\n\n${preview}${notes[index].text.length > 80 ? '…' : ''}`)) return;
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
    body.querySelector('#sn-settings-save').addEventListener('click', () => {
        const settings = getSettings();
        settings.position = body.querySelector('#sn-position').value;
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
        alert('Нечего экспортировать: записей нет.');
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
            alert('Не удалось прочитать файл: это не похоже на экспорт Story Notes.');
            return;
        }

        if (incoming.length === 0) {
            alert('В файле нет записей.');
            return;
        }

        const existing = getNotes();
        const replace = existing.length > 0 && confirm(
            `В файле ${incoming.length} записей, в этом чате уже ${existing.length}.\n\nOK — заменить всё, Отмена — добавить к существующим.`
        );

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
    // Inline !important beats the fixed-position rules (and the mobile media
    // query) in style.css, so a dragged element actually moves.
    el.style.setProperty('left', `${left}px`, 'important');
    el.style.setProperty('top', `${top}px`, 'important');
    el.style.setProperty('right', 'auto', 'important');
    el.style.setProperty('bottom', 'auto', 'important');
}

function restorePosition(el, storageKey) {
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
    el.style.setProperty('height', `${height}px`, 'important');
}

function restoreHeight(el) {
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
    button.title = 'Story Notes';
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
                <button type="button" id="sn-add" title="Новая запись"><i class="fa-solid fa-plus"></i></button>
                <button type="button" id="sn-settings-toggle" title="Настройки"><i class="fa-solid fa-gear"></i></button>
                <button type="button" id="sn-close" title="Закрыть">×</button>
            </div>
        </div>
        <div id="sn-searchbar">
            <i class="fa-solid fa-magnifying-glass"></i>
            <input type="search" id="sn-search" placeholder="Поиск по записям" autocomplete="off">
        </div>
        <div id="sn-body"></div>
        <div id="sn-resize" title="Потяни, чтобы изменить высоту; двойной клик — сброс"></div>
        <div id="sn-actions">
            <button type="button" id="sn-export" class="sn-secondary"><i class="fa-solid fa-download"></i> Экспорт</button>
            <button type="button" id="sn-import" class="sn-secondary"><i class="fa-solid fa-upload"></i> Импорт</button>
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
        if (!confirm('Удалить все записи этого чата?')) return;

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
    // the current book — never a stale copy of a deleted note.
    onEvent('GENERATE_BEFORE_COMBINE_PROMPTS', updatePromptInjection);
    onEvent('GENERATION_STARTED', updatePromptInjection);

    log('Extension loaded.');
}

setTimeout(init, 1000);

class Notifier {
    constructor(statusElement, toastStack) {
        this.statusElement = statusElement;
        this.toastStack = toastStack;
    }

    setStatus(message, type = 'info') {
        // There is deliberately no persistent status panel in the sidebar.
        // Keep transient notifications for file/save errors and other actions.
        if (this.statusElement) {
            this.statusElement.textContent = message;
            this.statusElement.dataset.type = type;
        }
    }

    toast(message, type = 'info', duration = 2800) {
        const el = document.createElement('div');
        el.className = `toast ${type}`;
        el.textContent = message;
        this.toastStack.appendChild(el);
        window.setTimeout(() => {
            el.remove();
        }, duration);
    }

    info(message) {
        this.setStatus(message, 'info');
        this.toast(message, 'info');
    }

    success(message) {
        this.setStatus(message, 'success');
        this.toast(message, 'success');
    }

    error(message) {
        this.setStatus(message, 'error');
        this.toast(message, 'error', 3600);
    }
}

class ExerciseParser {
    parse(rawInput) {
        const input = (rawInput || '').trim();
        if (!input) {
            return { valid: false, error: 'The exercise input is empty.' };
        }

        if (input.startsWith('{')) {
            return this.parseJson(input);
        }

        return this.parseTextExercise(input);
    }

    parseJson(jsonString) {
        try {
            const parsed = JSON.parse(jsonString);
            const exercise = parsed.exercise || parsed;
            if (!exercise.passage || !Array.isArray(exercise.vocabulary)) {
                throw new Error('JSON must contain a passage string and a vocabulary array.');
            }
            const vocabulary = exercise.vocabulary.map(item => ({
                id: Number(item.id),
                word: String(item.word || '').trim(),
                pinyin: String(item.pinyin || '').trim(),
                translation: String(item.translation || '').trim()
            }));
            this.validateVocabulary(vocabulary);
            return {
                valid: true,
                exercise: {
                    passage: String(exercise.passage).trim(),
                    vocabulary
                }
            };
        } catch (error) {
            return { valid: false, error: `Could not read JSON: ${error.message}` };
        }
    }

    parseTextExercise(input) {
        const lines = input.split(/\r?\n/);
        const vocabStartIndex = lines.findIndex(line => line.trim().toUpperCase().startsWith('VOCAB:'));
        if (vocabStartIndex === -1) {
            return { valid: false, error: 'Could not find a VOCAB: section.' };
        }

        const passage = lines.slice(0, vocabStartIndex).join('\n').trim();
        const vocabLines = lines.slice(vocabStartIndex + 1);
        if (!passage) {
            return { valid: false, error: 'The reading passage is empty.' };
        }

        try {
            const vocabulary = this.parseVocabularyLines(vocabLines);
            return {
                valid: true,
                exercise: { passage, vocabulary }
            };
        } catch (error) {
            return { valid: false, error: error.message };
        }
    }

    parseVocabularyLines(lines) {
        const vocabulary = [];
        const seenIds = new Set();
        const pattern = /^(\d+)\s+(.+?)(?:\s*\|\s*(.+?))?\s*-\s*(.+)$/;

        lines.forEach(line => {
            const trimmed = line.trim();
            if (!trimmed) return;
            const match = trimmed.match(pattern);
            if (!match) return;
            const [, rawId, rawWord, rawPinyin, rawTranslation] = match;
            const id = Number(rawId);
            if (seenIds.has(id)) {
                throw new Error(`Vocabulary ID ${id} is duplicated.`);
            }
            seenIds.add(id);
            vocabulary.push({
                id,
                word: rawWord.trim(),
                pinyin: (rawPinyin || '').trim(),
                translation: rawTranslation.trim()
            });
        });

        this.validateVocabulary(vocabulary);
        return vocabulary;
    }

    validateVocabulary(vocabulary) {
        if (!vocabulary.length) {
            throw new Error('No vocabulary entries were found.');
        }
        vocabulary.forEach(item => {
            if (!item.id || !item.word || !item.translation) {
                throw new Error('Each vocabulary entry needs an ID, a word, and a translation.');
            }
        });
    }
}

class ExerciseSession {
    constructor(exercise, options = {}) {
        this.exercise = exercise;
        this.wordLookup = new Map(exercise.vocabulary.map(item => [item.id, item]));
        // Genuine reading order: first appearance of each annotated word,
        // not merely the order of the VOCAB: entries.
        const seen = new Set();
        this.textOrderIds = [];
        for (const match of exercise.passage.matchAll(/\[([^\]]*?)(\d+)\]/g)) {
            const id = Number(match[2]);
            if (!seen.has(id) && this.wordLookup.has(id)) {
                seen.add(id);
                this.textOrderIds.push(id);
            }
        }
        for (const item of exercise.vocabulary) {
            if (!seen.has(item.id)) this.textOrderIds.push(item.id);
        }
        this.setSize = Number(options.setSize ?? 5);
        this.sets = this.buildSets(exercise.vocabulary.map(item => item.id));
        this.setStates = this.sets.map(ids => this.createSetState(ids));
        this.currentSetIndex = 0;
        this.retryContext = null;
        this.shuffleDefinitionsForAllStates();
    }

    buildSets(ids) {
        if (!this.setSize || this.setSize <= 0 || this.setSize >= ids.length) {
            return [ids.slice()];
        }
        const sets = [];
        for (let i = 0; i < ids.length; i += this.setSize) {
            sets.push(ids.slice(i, i + this.setSize));
        }
        return sets;
    }

    createSetState(wordIds) {
        return {
            wordIds: wordIds.slice(),
            matches: new Map(),
            matchOrder: [],
            checked: false,
            results: null,
            definitionOrder: []
        };
    }

    shuffleDefinitionsForAllStates() {
        this.setStates.forEach(state => {
            state.definitionOrder = this.shuffle(state.wordIds);
        });
    }

    shuffle(array) {
        const arr = array.slice();
        for (let i = arr.length - 1; i > 0; i -= 1) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }

    // Serialize Maps explicitly so manual saving also works during a retry set.
    serializeSetState(state) {
        return {
            wordIds: state.wordIds.slice(),
            matches: Array.from(state.matches.entries()),
            matchOrder: state.matchOrder.slice(),
            checked: state.checked,
            results: state.results,
            definitionOrder: state.definitionOrder.slice()
        };
    }

    serialize() {
        return {
            exercise: this.exercise,
            setSize: this.setSize,
            currentSetIndex: this.currentSetIndex,
            retryContext: this.retryContext ? {
                sourceSetIndex: this.retryContext.sourceSetIndex,
                state: this.serializeSetState(this.retryContext.state)
            } : null,
            setStates: this.setStates.map(state => this.serializeSetState(state))
        };
    }

    static restore(serialized) {
        const session = new ExerciseSession(serialized.exercise, { setSize: serialized.setSize });
        const restoreSetState = saved => ({
            wordIds: saved.wordIds.slice(),
            matches: new Map(saved.matches),
            matchOrder: saved.matchOrder.slice(),
            checked: saved.checked,
            results: saved.results,
            definitionOrder: saved.definitionOrder.slice()
        });
        session.currentSetIndex = serialized.currentSetIndex;
        session.setStates = serialized.setStates.map(restoreSetState);
        session.retryContext = serialized.retryContext ? {
            sourceSetIndex: serialized.retryContext.sourceSetIndex,
            state: restoreSetState(serialized.retryContext.state)
        } : null;
        return session;
    }

    get activeState() {
        if (this.retryContext) {
            return this.retryContext.state;
        }
        return this.setStates[this.currentSetIndex];
    }

    get activeWordIds() {
        return this.activeState.wordIds;
    }

    getSetCounterText() {
        if (this.retryContext) {
            return `Retry ${this.currentSetIndex + 1}/${this.sets.length}`;
        }
        return `Set ${this.currentSetIndex + 1}/${this.sets.length}`;
    }

    getActiveItems() {
        return this.activeWordIds.map(id => this.wordLookup.get(id)).filter(Boolean);
    }

    getUnmatchedWordIds() {
        return this.activeWordIds.filter(id => !this.activeState.matches.has(id));
    }

    getUnusedDefinitionIds() {
        const used = new Set(this.activeState.matches.values());
        return this.activeState.definitionOrder.filter(id => this.activeWordIds.includes(id) && !used.has(id));
    }

    addMatch(wordId, definitionId) {
        if (this.activeState.checked) {
            return { ok: false, error: 'This set has already been checked.' };
        }
        if (this.activeState.matches.has(wordId)) {
            return { ok: false, error: 'That word is already matched.' };
        }
        const usedDefinitions = new Set(this.activeState.matches.values());
        if (usedDefinitions.has(definitionId)) {
            return { ok: false, error: 'That definition is already in use.' };
        }
        this.activeState.matches.set(wordId, definitionId);
        this.activeState.matchOrder.push(wordId);
        return { ok: true };
    }

    removeMatch(wordId) {
        const definitionId = this.activeState.matches.get(wordId);
        this.activeState.matches.delete(wordId);
        this.activeState.matchOrder = this.activeState.matchOrder.filter(id => id !== wordId);
        return definitionId;
    }

    checkCurrentSet() {
        const correct = [];
        const incorrect = [];
        const missing = [];
        this.activeWordIds.forEach(wordId => {
            if (!this.activeState.matches.has(wordId)) {
                missing.push(wordId);
            } else if (this.activeState.matches.get(wordId) === wordId) {
                correct.push(wordId);
            } else {
                incorrect.push({ wordId, chosenId: this.activeState.matches.get(wordId) });
            }
        });
        const results = { correct, incorrect, missing, total: this.activeWordIds.length };
        this.activeState.checked = true;
        this.activeState.results = results;
        return results;
    }

    getMistakeIdsForActiveState() {
        if (!this.activeState.results) return [];
        return [
            ...this.activeState.results.incorrect.map(item => item.wordId),
            ...this.activeState.results.missing
        ];
    }

    startRetryMode() {
        const mistakeIds = this.getMistakeIdsForActiveState();
        if (!mistakeIds.length) return false;
        this.retryContext = {
            sourceSetIndex: this.currentSetIndex,
            state: this.createSetState(mistakeIds)
        };
        this.retryContext.state.definitionOrder = this.shuffle(mistakeIds);
        return true;
    }

    endRetryMode() {
        this.retryContext = null;
    }

    moveSet(direction) {
        if (this.retryContext) return;
        const nextIndex = this.currentSetIndex + direction;
        if (nextIndex < 0 || nextIndex >= this.setStates.length) return;
        this.currentSetIndex = nextIndex;
    }

    resetCurrentExercise() {
        this.setStates = this.sets.map(ids => this.createSetState(ids));
        this.shuffleDefinitionsForAllStates();
        this.retryContext = null;
        this.currentSetIndex = 0;
    }

    getOverallSummary() {
        const checkedCount = this.setStates.filter(state => state.checked).length;
        const correctFirstPass = this.setStates.reduce((sum, state) => sum + (state.results ? state.results.correct.length : 0), 0);
        const totalWords = this.exercise.vocabulary.length;
        return { checkedCount, totalSets: this.setStates.length, correctFirstPass, totalWords };
    }
}

class StorageManager {
    constructor(key = 'panda_vocab_matchup_v3') {
        this.key = key;
    }

    save(payload) {
        try {
            localStorage.setItem(this.key, JSON.stringify(payload));
            return true;
        } catch {
            return false;
        }
    }

    load() {
        try {
            const raw = localStorage.getItem(this.key);
            return raw ? JSON.parse(raw) : null;
        } catch {
            return null;
        }
    }

    clear() {
        try {
            localStorage.removeItem(this.key);
            return true;
        } catch {
            return false;
        }
    }
}

// ============================================================
// LAYOUT MANAGER — independent of vocabulary or matching state
// Sidebar contents stay at their full width while the page reflows.
// ============================================================
class LayoutManager {
    constructor(elements) {
        this.els = elements;
        this.sidebar = elements.sidebar;
        this.appBody = elements.appBody;
        this.workspace = elements.workspaceTop;
        this.sidebarWidth = 292;
        this.workspaceSplit = 52;
        this.topHeight = 560;
        this.builderHeight = 430;
        this.promptHeight = 315;
        this.stackedTextHeight = 380;
        this.stackedMatchHeight = 500;
        this.sidebarOpen = true;
        this.sidebarAnimating = false;
        this.animationTimeout = null;
    }

    init() {
        this.applySidebarWidth(this.sidebarWidth);
        this.applyWorkspaceSplit(this.workspaceSplit);
        this.applyTopHeight(this.topHeight);
        this.applyBuilderHeights(this.builderHeight, this.promptHeight);
        this.toggleSidebar(true);
        this.enableSidebarResizer();
        this.enableWorkspaceSplitter();
        this.enableHeightResizer();
        this.enableBuilderResizer();
        this.enablePromptBottomResizer();
        this.enableBuilderPaneSplitters();
        this.syncHeaderHeight();
        new ResizeObserver(() => this.syncHeaderHeight()).observe(this.els.appHeader);
        window.addEventListener('resize', () => this.applyWorkspaceSplit(this.workspaceSplit));
    }

    syncHeaderHeight() {
        document.documentElement.style.setProperty('--header-height',
            `${Math.ceil(this.els.appHeader.getBoundingClientRect().height)}px`);
    }

    // The sidebar remains a full-width box. Only the grid track animates.
    // Its *content* doesn't squash or rewrap during opening/closing.
    toggleSidebar(forceOpen = null) {
        const open = forceOpen === null ? !this.sidebarOpen : Boolean(forceOpen);
        if (open === this.sidebarOpen && !this.sidebarAnimating) return;
        this.sidebarOpen = open;
        this.sidebarAnimating = true;
        this.sidebar.classList.add('is-transitioning');
        this.appBody.classList.toggle('sidebar-collapsed', !open);
        this.sidebar.classList.toggle('is-open', open);
        this.sidebar.inert = !open;
        this.els.sidebarToggleBtn.setAttribute('aria-expanded', String(open));
        clearTimeout(this.animationTimeout);
        this.animationTimeout = setTimeout(() => {
            this.sidebarAnimating = false;
            this.sidebar.classList.remove('is-transitioning');
            this.applyWorkspaceSplit(this.workspaceSplit);
        }, 270);
        if (!open) this.els.sidebarToggleBtn.focus({preventScroll:true});
    }

    applySidebarWidth(px) {
        this.sidebarWidth = Math.min(550, Math.max(220, Math.round(px)));
        document.documentElement.style.setProperty('--sidebar-width', `${this.sidebarWidth}px`);
    }

    applyWorkspaceSplit(pct) {
        if (this.workspace.classList.contains('layout-stacked')) return;
        const width = this.workspace.clientWidth || 1200;
        const minText = 175;
        const minMatching = 250;
        const min = 100 * minText / width;
        const max = 100 * (width - minMatching - 30) / width;
        const low = Math.max(12, min);
        const high = Math.max(low, Math.min(86, max));
        this.workspaceSplit = Math.min(high, Math.max(low, pct));
        document.documentElement.style.setProperty('--workspace-split', `${this.workspaceSplit}%`);
    }

    setStacked(enabled) {
        this.workspace.classList.toggle('layout-stacked', enabled);
        this.els.layoutToggleBtn.classList.toggle('is-active', enabled);
        this.els.layoutToggleBtn.setAttribute('aria-pressed', String(enabled));
        this.els.layoutToggleBtn.textContent = enabled ? '↔ Side by side' : '↕ Stack panels';
        this.els.mainSplitter.setAttribute('aria-orientation', enabled ? 'horizontal' : 'vertical');
        this.els.mainSplitter.setAttribute('aria-label', enabled
            ? 'Resize the height of the text panel'
            : 'Resize text and matching panel widths');
        if (enabled) {
            // Establish useful content-based heights once when stacked mode opens.
            // Further drag operations are intentionally independent.
            requestAnimationFrame(() => {
                this.applyStackTextHeight(Math.min(this.stackedTextHeight, this.stackedContentCap('text')));
                this.applyStackMatchHeight(Math.min(this.stackedMatchHeight, this.stackedContentCap('matching')));
            });
        } else {
            this.applyWorkspaceSplit(this.workspaceSplit);
        }
    }

    // Limit stacked panels to content height + roughly 90px of breathing room,
    // and never allow either panel to exceed one viewport in height.
    stackedContentCap(which) {
        const panel = which === 'text' ? this.els.textPanel : this.els.matchingPanel;
        const header = panel.querySelector('.panel-header');
        const body = panel.querySelector('.panel-body');
        const reader = this.els.readingText;
        const contentHeight = which === 'text'
            ? reader.scrollHeight + 155 // landscape artwork and comfortable bottom gap
            : body.scrollHeight;
        return Math.max(255, Math.min(this.maxPanelHeight(),
            Math.ceil(contentHeight + header.getBoundingClientRect().height + 90)));
    }

    applyStackTextHeight(px) {
        this.stackedTextHeight = Math.round(Math.max(240, Math.min(px, this.stackedContentCap('text'))));
        document.documentElement.style.setProperty('--stack-text-height', `${this.stackedTextHeight}px`);
    }

    applyStackMatchHeight(px) {
        this.stackedMatchHeight = Math.round(Math.max(240, Math.min(px, this.stackedContentCap('matching'))));
        document.documentElement.style.setProperty('--stack-match-height', `${this.stackedMatchHeight}px`);
    }

    // Horizontal split: text can be much narrower, but neither side disappears.
    enableWorkspaceSplitter() {
        const rail = this.els.mainSplitter;
        rail.addEventListener('pointerdown', event => {
            event.preventDefault();
            const stacked = this.workspace.classList.contains('layout-stacked');
            const startY = event.clientY;
            const startHeight = this.stackedTextHeight;
            const bounds = this.workspace.getBoundingClientRect();
            const move = e => {
                if (stacked) this.applyStackTextHeight(startHeight + e.clientY - startY);
                else this.applyWorkspaceSplit(100 * (e.clientX - bounds.left) / bounds.width);
            };
            const stop = () => {window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop);};
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', stop);
        });
        rail.addEventListener('keydown', event => {
            const stacked = this.workspace.classList.contains('layout-stacked');
            const keys = stacked ? ['ArrowUp','ArrowDown','Home'] : ['ArrowLeft','ArrowRight','Home'];
            if (!keys.includes(event.key)) return;
            event.preventDefault();
            if (stacked) this.applyStackTextHeight(event.key === 'Home' ? 380 :
                this.stackedTextHeight + (event.key === 'ArrowDown' ? 25 : -25));
            else this.applyWorkspaceSplit(event.key === 'Home' ? 52 :
                this.workspaceSplit + (event.key === 'ArrowRight' ? 3 : -3));
        });
        rail.addEventListener('dblclick', () => {
            if (this.workspace.classList.contains('layout-stacked')) this.applyStackTextHeight(380);
            else this.applyWorkspaceSplit(52);
        });
    }

    enableSidebarResizer() {
        const rail = this.els.sidebarResizer;
        rail.addEventListener('pointerdown', event => {
            if (!this.sidebarOpen || this.sidebarAnimating) return;
            event.preventDefault();
            const startX = event.clientX, startWidth = this.sidebarWidth;
            this.appBody.classList.add('is-resizing-sidebar');
            const move = e => this.applySidebarWidth(startWidth + e.clientX - startX);
            const stop = () => {
                this.appBody.classList.remove('is-resizing-sidebar');
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', stop);
            };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', stop);
        });
        rail.addEventListener('keydown', event => {
            if (!this.sidebarOpen || this.sidebarAnimating) return;
            if (!['ArrowLeft','ArrowRight'].includes(event.key)) return;
            event.preventDefault();
            this.applySidebarWidth(this.sidebarWidth + (event.key === 'ArrowRight' ? 18 : -18));
        });
    }

    applyTopHeight(px) {
        this.topHeight = Math.min(this.maxPanelHeight(), Math.max(240, Math.round(px)));
        document.documentElement.style.setProperty('--top-panels-height', `${this.topHeight}px`);
        this.els.topHeightResizer.setAttribute('aria-valuenow', String(this.topHeight));
    }

    enableHeightResizer() {
        const rail = this.els.topHeightResizer;
        rail.addEventListener('pointerdown', event => {
            event.preventDefault();
            const stacked = this.workspace.classList.contains('layout-stacked');
            const startY = event.clientY, startHeight = stacked ? this.stackedMatchHeight : this.topHeight;
            const move = e => {
                if (stacked) this.applyStackMatchHeight(startHeight + e.clientY - startY);
                else this.applyTopHeight(startHeight + e.clientY - startY);
            };
            const stop = () => {window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop);};
            window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop);
        });
        rail.addEventListener('keydown', event => {
            if (!['ArrowUp','ArrowDown','Home'].includes(event.key)) return;
            event.preventDefault();
            const stacked = this.workspace.classList.contains('layout-stacked');
            const current = stacked ? this.stackedMatchHeight : this.topHeight;
            const next = event.key === 'Home' ? (stacked ? 500 : 560) : current + (event.key === 'ArrowDown' ? 30 : -30);
            if (stacked) this.applyStackMatchHeight(next);
            else this.applyTopHeight(next);
        });
        rail.addEventListener('dblclick', () => {
            if (this.workspace.classList.contains('layout-stacked')) this.applyStackMatchHeight(500);
            else this.applyTopHeight(560);
        });
    }

    // A sensible cap: a panel cannot become taller than the visible screen.
    // Individual panel heights are independent: no dragging steals height
    // from a different panel above or below it.
    maxPanelHeight() {
        return Math.max(290, Math.min(1200, window.innerHeight));
    }

    applyBuilderHeights(builder, prompt) {
        this.builderHeight = Math.min(this.maxPanelHeight(), Math.max(230, Math.round(builder)));
        this.promptHeight = Math.min(this.maxPanelHeight(), Math.max(200, Math.round(prompt)));
        document.documentElement.style.setProperty('--builder-height', `${this.builderHeight}px`);
        document.documentElement.style.setProperty('--prompt-height', `${this.promptHeight}px`);
        this.els.builderHeightResizer.setAttribute('aria-valuenow', String(this.builderHeight));
        this.els.promptBottomResizer.setAttribute('aria-valuenow', String(this.promptHeight));
    }

    // Between builder and prompt: change BUILDER ONLY.
    enableBuilderResizer() {
        const rail = this.els.builderHeightResizer;
        rail.addEventListener('pointerdown', event => {
            event.preventDefault();
            const startY = event.clientY, original = this.builderHeight;
            const move = e => this.applyBuilderHeights(original + e.clientY - startY, this.promptHeight);
            const stop = () => {
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', stop);
            };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', stop);
        });
        rail.addEventListener('keydown', event => {
            if (!['ArrowUp','ArrowDown','Home'].includes(event.key)) return;
            event.preventDefault();
            this.applyBuilderHeights(event.key === 'Home' ? 430 : this.builderHeight + (event.key === 'ArrowDown' ? 25 : -25), this.promptHeight);
        });
        rail.addEventListener('dblclick', () => this.applyBuilderHeights(430, this.promptHeight));
    }

    // Below prompt: change PROMPT ONLY, independently of everything above it.
    enablePromptBottomResizer() {
        const rail = this.els.promptBottomResizer;
        rail.addEventListener('pointerdown', event => {
            event.preventDefault();
            const startY = event.clientY, original = this.promptHeight;
            const move = e => this.applyBuilderHeights(this.builderHeight, original + e.clientY - startY);
            const stop = () => {
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', stop);
            };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', stop);
        });
        rail.addEventListener('keydown', event => {
            if (!['ArrowUp','ArrowDown','Home'].includes(event.key)) return;
            event.preventDefault();
            this.applyBuilderHeights(this.builderHeight, event.key === 'Home' ? 315 : this.promptHeight + (event.key === 'ArrowDown' ? 25 : -25));
        });
        rail.addEventListener('dblclick', () => this.applyBuilderHeights(this.builderHeight,315));
    }

    // Two narrow VERTICAL splitters inside Exercise Input & Preview.
    // Percentages survive resizing of the browser or opening the sidebar.
    enableBuilderPaneSplitters() {
        const grid = this.els.builderGrid;
        let first = 40, second = 32;
        const set = (a, b) => {
            first = Math.max(16, Math.min(68, a));
            second = Math.max(16, Math.min(84 - first, b));
            if (first + second > 84) first = 84 - second;
            grid.style.setProperty('--pane-first', `${first}%`);
            grid.style.setProperty('--pane-second', `${second}%`);
        };
        set(first, second);
        [this.els.inputSplitOne, this.els.inputSplitTwo].forEach((rail, i) => {
            rail.addEventListener('pointerdown', event => {
                if (getComputedStyle(rail).display === 'none') return;
                event.preventDefault();
                const bounds = grid.getBoundingClientRect();
                const move = e => {
                    const pct = 100 * (e.clientX - bounds.left) / bounds.width;
                    if (i === 0) set(Math.min(pct, 84 - second), second);
                    else set(first, Math.min(pct - first, 84 - first));
                };
                const stop = () => {
                    window.removeEventListener('pointermove', move);
                    window.removeEventListener('pointerup', stop);
                };
                window.addEventListener('pointermove', move);
                window.addEventListener('pointerup', stop);
            });
            rail.addEventListener('keydown', event => {
                if (!['ArrowLeft','ArrowRight','Home'].includes(event.key)) return;
                event.preventDefault();
                if (event.key === 'Home') return set(40,32);
                const dir = event.key === 'ArrowRight' ? 2 : -2;
                if (i === 0) set(first + dir, second);
                else set(first, second + dir);
            });
            rail.addEventListener('dblclick', () => set(40,32));
        });
    }

}

class PandaUI {
    constructor(elements, notifier) {
        this.elements = elements;
        this.notifier = notifier;
    }

    setTheme(theme) {
        document.body.dataset.theme = theme;
        this.elements.themeBambooBtn.classList.toggle('is-active', theme === 'bamboo');
        this.elements.themeDarkBtn.classList.toggle('is-active', theme === 'dark');
    }

    setReadingMode(enabled) {
        this.elements.workspaceTop.classList.toggle('reading-mode', enabled);
        this.elements.readingModeToggle.checked = enabled;
    }

    setTextSize(size) {
        document.documentElement.style.setProperty('--reader-font-size', `${size}px`);
        this.elements.textSizeIndicator.textContent = `${size}px`;
    }

    renderPreview(exercise, hoverHints = false) {
        this.renderPassage(this.elements.textPreview, exercise.passage, exercise.vocabulary, new Set(exercise.vocabulary.map(item => item.id)), hoverHints);
        this.elements.vocabPreview.innerHTML = '';
        const frag = document.createDocumentFragment();
        exercise.vocabulary.forEach(item => {
            const row = document.createElement('div');
            row.textContent = `${item.id}. ${item.word}${item.pinyin ? ` (${item.pinyin})` : ''} — ${item.translation}`;
            frag.appendChild(row);
        });
        this.elements.vocabPreview.appendChild(frag);
    }

    renderPassage(container, passage, vocabulary, currentSetIds, hoverHints, clickHandler = null, highlightWords = false, matchedIds = new Set()) {
        container.innerHTML = '';
        const lookup = new Map(vocabulary.map(item => [item.id, item]));
        const regex = /\[([^\]]*?)(\d+)\]/g;
        let lastIndex = 0;
        let match;
        const appendPlainText = text => {
            const parts = text.split('\n');
            parts.forEach((part, index) => {
                if (part) container.appendChild(document.createTextNode(part));
                if (index < parts.length - 1) container.appendChild(document.createElement('br'));
            });
        };

        while ((match = regex.exec(passage)) !== null) {
            appendPlainText(passage.slice(lastIndex, match.index));
            const [, displayWord, rawId] = match;
            const id = Number(rawId);
            const wordData = lookup.get(id);
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'text-word';
            if (highlightWords && wordData) {
                btn.classList.add(!currentSetIds.has(id) ? 'outside-set-in-text' : matchedIds.has(id) ? 'matched-in-text' : 'unmatched-in-text');
            }
            btn.dataset.id = String(id);
            btn.textContent = displayWord;
            if (wordData && hoverHints) {
                btn.title = `${wordData.word}${wordData.pinyin ? ` (${wordData.pinyin})` : ''} — ${wordData.translation}`;
            } else {
                btn.removeAttribute('title');
            }
            if (clickHandler) {
                btn.addEventListener('click', () => clickHandler(id));
            }
            container.appendChild(btn);
            lastIndex = regex.lastIndex;
        }
        appendPlainText(passage.slice(lastIndex));
    }

    // Arrange 2–6 columns according to available width and list lengths.
    // Both sides are usually balanced; long definitions can earn an extra
    // column (e.g. 2 vocab / 4 definitions) when the imbalance is worthwhile.
    chooseColumnLayout(session, boardWidth) {
        const words = session.getUnmatchedWordIds().map(id => session.wordLookup.get(id));
        const defs = session.getUnusedDefinitionIds().map(id => session.wordLookup.get(id));
        const longestDefinition = Math.max(0, ...defs.map(item => item.translation.length));
        const meanDefinition = defs.length
            ? defs.reduce((sum, item) => sum + item.translation.length, 0) / defs.length : 0;
        const longestWord = Math.max(0, ...words.map(item => item.word.length));
        // Long translations need wider cards, so they can justify fewer total
        // columns instead of forcing unreadable narrow definition bubbles.
        const minWidth = longestDefinition > 44 ? 188
            : longestDefinition > 28 ? 163 : longestDefinition > 18 ? 146 : 126;
        const columns = Math.max(2, Math.min(6, Math.floor((Math.max(boardWidth, 255) + 6) / (minWidth + 6))));
        let vocab = Math.floor(columns / 2);
        let definitions = columns - vocab;
        // In a five-column layout, definitions normally receive the third column.
        // In a six-column layout use 3:3 unless the unequal lengths clearly
        // warrant 2 vocab + 4 definition columns, or vice versa.
        const defDemand = meanDefinition + longestDefinition * .35;
        const wordDemand = 11 + longestWord * .7;
        if (columns === 6 && defDemand > wordDemand * 2.8 && defs.length > words.length * .6) {
            vocab = 2; definitions = 4;
        } else if (columns === 6 && wordDemand > defDemand * 2.8) {
            vocab = 4; definitions = 2;
        }
        return {vocab, definitions};
    }

    buildMatchBoard(session, options, handlers) {
        const board = this.elements.matchBoard;
        const width = board.getBoundingClientRect().width || board.parentElement.clientWidth || 780;
        const layout = this.chooseColumnLayout(session, width);
        const vocabCols = Array.from({length: layout.vocab}, () => this.createMatchColumn('Vocab'));
        const definitionCols = Array.from({length: layout.definitions}, () => this.createMatchColumn('Definitions'));
        board.replaceChildren(...vocabCols, ...definitionCols);
        board.style.gridTemplateColumns = `repeat(${vocabCols.length + definitionCols.length}, minmax(0,1fr))`;
        board.dataset.vocabColumns = String(vocabCols.length);
        board.dataset.definitionColumns = String(definitionCols.length);

        const words = session.getUnmatchedWordIds().map(id => session.wordLookup.get(id));
        const defs = session.getUnusedDefinitionIds().map(id => session.wordLookup.get(id));
        const distribute = (items, columns, factory) => {
            const perCol = Math.ceil(items.length / columns.length);
            columns.forEach((column, colIndex) => {
                const portion = items.slice(colIndex * perCol, (colIndex + 1) * perCol);
                portion.forEach(item => column.appendChild(factory(item)));
                if (!portion.length) column.appendChild(this.emptyColumnMessage());
            });
        };
        distribute(words, vocabCols, item => this.makeMatchableWord(item, options, handlers.onWordClick));
        distribute(defs, definitionCols, item => this.makeDefinitionButton(item, options, handlers.onDefinitionClick));

        this.highlightSelections(options.selectedWordId, options.selectedDefinitionId);
        if (session.activeState.checked) {
            this.applyCheckStylesToBoard(session.activeState.results || {correct:[], incorrect:[], missing:[]});
        }
    }

    createMatchColumn(title) {
        const section = document.createElement('section');
        section.className = 'match-column';
        const heading = document.createElement('h4');
        heading.textContent = title;
        section.appendChild(heading);
        return section;
    }

    emptyColumnMessage() {
        const div = document.createElement('div');
        div.className = 'empty-column';
        div.textContent = 'Nothing left in this column.';
        return div;
    }

    makeMatchableWord(item, options, clickHandler) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'matchable-item vocab-item';
        button.dataset.id = String(item.id);
        const word = document.createElement('span');
        word.className = 'vocab-word';
        word.textContent = item.word;
        button.appendChild(word);
        if (item.pinyin) {
            const pinyin = document.createElement('span');
            pinyin.className = 'pinyin';
            pinyin.textContent = item.pinyin;
            button.appendChild(pinyin);
        }
        if (options.hoverHints) {
            button.title = item.translation;
        }
        button.addEventListener('click', () => clickHandler(item.id));
        return button;
    }

    makeDefinitionButton(item, options, clickHandler) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'matchable-item definition-item';
        button.dataset.id = String(item.id);
        const def = document.createElement('span');
        def.className = 'def-text';
        def.textContent = item.translation;
        button.appendChild(def);
        if (options.hoverHints) {
            button.title = `${item.word}${item.pinyin ? ` (${item.pinyin})` : ''}`;
        }
        button.addEventListener('click', () => clickHandler(item.id));
        return button;
    }

    highlightSelections(wordId, definitionId) {
        // IMPORTANT: IDs are the answers. Never highlight a definition merely because
        // it has the same ID as the selected vocabulary word.
        this.elements.matchBoard.querySelectorAll('.vocab-item').forEach(el => {
            el.classList.toggle('selected', Number(el.dataset.id) === wordId && wordId !== null);
        });
        this.elements.matchBoard.querySelectorAll('.definition-item').forEach(el => {
            el.classList.toggle('selected', Number(el.dataset.id) === definitionId && definitionId !== null);
        });
    }

    applyCheckStylesToBoard(results) {
        results.correct.forEach(id => {
            this.findAllDataId(id).forEach(el => el.classList.add('correct'));
        });
        results.incorrect.forEach(item => {
            this.findAllDataId(item.wordId).forEach(el => el.classList.add('incorrect'));
        });
        results.missing.forEach(id => {
            this.findAllDataId(id).forEach(el => el.classList.add('missing'));
        });
    }

    findAllDataId(id) {
        return Array.from(this.elements.matchBoard.querySelectorAll(`[data-id="${id}"]`));
    }

    renderCompletedLists(session, onUndo, onHighlight) {
        const top = this.elements.completedTop;
        const bottom = this.elements.completedBottom;
        top.innerHTML = '';
        bottom.innerHTML = '';

        const renderList = (container, ids) => {
            ids.forEach(wordId => {
                const listItem = this.createCompletedItem(session, wordId, onUndo, onHighlight);
                container.appendChild(listItem);
            });
        };

        const currentIds = new Set(session.activeWordIds);
        const textOrder = session.textOrderIds.filter(id => currentIds.has(id));
        if (session.activeState.checked && session.activeState.results) {
            const answerOrder = [...session.activeState.matchOrder,
                ...session.activeWordIds.filter(id => !session.activeState.matchOrder.includes(id))];
            renderList(top, answerOrder);
            renderList(bottom, textOrder);
        } else {
            renderList(top, session.activeState.matchOrder);
            renderList(bottom, textOrder.filter(id => session.activeState.matches.has(id)));
        }
    }

    createCompletedItem(session, wordId, onUndo, onHighlight) {
        const li = document.createElement('li');
        li.className = 'completed-item';
        li.dataset.id = String(wordId);
        const wordData = session.wordLookup.get(wordId);
        const definitionId = session.activeState.matches.get(wordId);
        const defData = definitionId ? session.wordLookup.get(definitionId) : null;
        const textWrap = document.createElement('div');
        const label = document.createElement('span');
        label.className = 'completed-word';
        label.textContent = wordData.word;
        textWrap.appendChild(label);

        const line = document.createElement('span');
        line.className = 'completed-translation';
        line.style.display = 'block';
        line.style.marginTop = '2px';

        if (!session.activeState.checked) {
            line.textContent = defData ? `${defData.translation}` : '';
        } else {
            const results = session.activeState.results;
            const isCorrect = results.correct.includes(wordId);
            const missing = results.missing.includes(wordId);
            if (isCorrect) {
                line.textContent = wordData.translation;
            } else if (missing) {
                const wrong = document.createElement('span');
                wrong.className = 'wrong-answer';
                wrong.textContent = '[Not answered] ';
                const correction = document.createElement('span');
                correction.className = 'correction';
                correction.textContent = `Correct: ${wordData.translation}`;
                line.append(wrong, correction);
            } else {
                const wrong = document.createElement('span');
                wrong.className = 'wrong-answer';
                wrong.textContent = `${defData ? defData.translation : 'Unknown'} `;
                const correction = document.createElement('span');
                correction.className = 'correction';
                correction.textContent = `Correct: ${wordData.translation}`;
                line.append(wrong, correction);
            }
        }
        textWrap.appendChild(line);
        li.appendChild(textWrap);

        const action = document.createElement('button');
        action.type = 'button';
        action.className = 'undo-btn';
        action.textContent = session.activeState.checked ? '•' : '↶';
        action.title = session.activeState.checked ? 'Checked result' : 'Undo this match';
        action.disabled = session.activeState.checked;
        action.addEventListener('click', event => {
            event.stopPropagation();
            if (!session.activeState.checked) onUndo(wordId);
        });
        li.addEventListener('click', () => onHighlight(wordId));
        li.appendChild(action);
        return li;
    }

    updateProgress(session) {
        const activeState = session.activeState;
        const matchedCount = activeState.matches.size;
        const total = activeState.wordIds.length;
        this.elements.setCounter.textContent = session.getSetCounterText();
        this.elements.setDescription.textContent = session.retryContext ? 'Retry only the words that were missed or matched incorrectly.' : 'Match each word with its definition.';
        this.elements.setProgressLabel.textContent = `${matchedCount} of ${total} words matched`;
        const summary = session.getOverallSummary();
        this.elements.overallProgress.textContent = `${summary.checkedCount}/${summary.totalSets} sets checked · ${summary.correctFirstPass}/${summary.totalWords} correct on original attempts`;
        const fill = total ? Math.round((matchedCount / total) * 100) : 0;
        this.elements.progressFill.style.width = `${fill}%`;
        this.elements.previousSetBtn.disabled = !!session.retryContext || session.currentSetIndex === 0;
        this.elements.nextSetBtn.disabled = !!session.retryContext || session.currentSetIndex >= session.sets.length - 1;
        this.elements.answerBtn.disabled = total === 0 || activeState.checked;
        this.elements.retryBtn.classList.toggle('hidden', !(activeState.checked && session.getMistakeIdsForActiveState().length));
        this.elements.returnSetBtn.classList.toggle('hidden', !session.retryContext);
        const completedScore = activeState.checked && activeState.results
            ? `${activeState.results.correct.length}/${activeState.results.total}` : '';
        this.elements.completedTextScore.textContent = completedScore;
        this.elements.completedAnswerScore.textContent = completedScore;
        // Never display in-progress scores or status in the matching workspace.
        this.elements.scoreResult.textContent = completedScore;
    }

    showCheckResult(results) {
        this.elements.scoreResult.textContent = `${results.correct.length}/${results.total}`;
    }

    toggleCompletedTopVisibility() {
        const isHidden = this.elements.completedTopWrap.hidden;
        this.elements.completedTopWrap.hidden = !isHidden;
        this.elements.toggleCompletedTop.textContent = isHidden ? 'Hide' : 'Show';
    }
}

class PandaApp {
    constructor() {
        this.elements = this.captureElements();
        this.notifier = new Notifier(this.elements.sidebarStatus, this.elements.toastStack);
        this.parser = new ExerciseParser();
        this.storage = new StorageManager();
        this.ui = new PandaUI(this.elements, this.notifier);
        this.layout = new LayoutManager(this.elements);
        this.session = null;
        this.currentExercise = null;
        this.selectedWordId = null;
        this.selectedDefinitionId = null;
        this.highlightedWordId = null;
        this.customSetDirty = false;
        this.settings = {
            theme: 'bamboo',
            hoverHints: false,
            highlightWords: true,
            stackedLayout: false,
            readingMode: false,
            autosave: false,
            textSize: 23,
            setSize: 5
        };
    }

    captureElements() {
        const get = id => document.getElementById(id);
        return {
            appShell: get('appShell'),
            appBody: get('appBody'),
            builderHeightResizer: get('builderHeightResizer'),
            promptBottomResizer: get('promptBottomResizer'),
            builderGrid: document.querySelector('.builder-grid'),
            inputSplitOne: get('inputSplitOne'),
            inputSplitTwo: get('inputSplitTwo'),
            exerciseBuilderSection: get('exerciseBuilderSection'),
            editorPanel: get('editorPanel'),
            toggleInputPanelBtn: get('toggleInputPanelBtn'),
            togglePromptPanelBtn: get('togglePromptPanelBtn'),
            showInputPanelBtn: get('showInputPanelBtn'),
            showPromptPanelBtn: get('showPromptPanelBtn'),
            footerShowInputBtn: get('footerShowInputBtn'),
            footerShowPromptBtn: get('footerShowPromptBtn'),
            layoutToggleBtn: get('layoutToggleBtn'),
            helpBtn: get('helpBtn'),
            helpPanel: get('helpPanel'),
            appHeader: document.querySelector('.app-header'),
            topHeightResizer: get('topHeightResizer'),
            highlightWordsToggle: get('highlightWordsToggle'),
            jumpToPromptBtn: get('jumpToPromptBtn'),
            promptPanel: get('promptPanel'),
            sidebar: get('sidebar'),
            sidebarResizer: get('sidebarResizer'),
            sidebarToggleBtn: get('sidebarToggleBtn'),
            themeBambooBtn: get('themeBambooBtn'),
            themeDarkBtn: get('themeDarkBtn'),
            answerBtn: get('answerBtn'),
            setSizeSelect: get('setSizeSelect'),
            readingModeToggle: get('readingModeToggle'),
            hoverHintsToggle: get('hoverHintsToggle'),
            autosaveToggle: get('autosaveToggle'),
            saveStateBtn: get('saveStateBtn'),
            restoreStateBtn: get('restoreStateBtn'),
            clearSavedBtn: get('clearSavedBtn'),
            sampleChineseBtn: get('sampleChineseBtn'),
            sampleEnglishBtn: get('sampleEnglishBtn'),
            importFileBtn: get('importFileBtn'),
            exportJsonBtn: get('exportJsonBtn'),
            importExerciseFile: get('importExerciseFile'),
            resetProgressBtn: get('resetProgressBtn'),
            sidebarStatus: null,
            customSetSize: get('customSetSize'),
            applyCustomSetBtn: get('applyCustomSetBtn'),
            sampleChineseQuickBtn: get('sampleChineseQuickBtn'),
            sampleEnglishQuickBtn: get('sampleEnglishQuickBtn'),
            importQuickBtn: get('importQuickBtn'),
            exportQuickBtn: get('exportQuickBtn'),
            completedTextScore: get('completedTextScore'),
            completedAnswerScore: get('completedAnswerScore'),
            textPanel: get('textPanel'),
            matchingPanel: get('matchingPanel'),
            workspaceTop: get('workspaceTop'),
            mainSplitter: get('mainSplitter'),
            textSmallerBtn: get('textSmallerBtn'),
            textLargerBtn: get('textLargerBtn'),
            textSizeIndicator: get('textSizeIndicator'),
            readingText: get('readingText'),
            textPreview: get('textPreview'),
            vocabPreview: get('vocabPreview'),
            matchBoard: get('matchBoard'),
            completedTop: get('completedTop'),
            completedBottom: get('completedBottom'),
            completedTopWrap: get('completedTopWrap'),
            toggleCompletedTop: get('toggleCompletedTop'),
            previousSetBtn: get('previousSetBtn'),
            nextSetBtn: get('nextSetBtn'),
            retryBtn: get('retryBtn'),
            returnSetBtn: get('returnSetBtn'),
            setCounter: get('setCounter'),
            setDescription: get('setDescription'),
            setProgressLabel: get('setProgressLabel'),
            overallProgress: get('overallProgress'),
            progressFill: get('progressFill'),
            scoreResult: get('scoreResult'),
            loadExerciseBtn: get('loadExerciseBtn'),
            exerciseInput: get('exerciseInput'),
            copyPromptBtn: get('copyPromptBtn'),
            aiPrompt: get('aiPrompt'),
            toastStack: get('toastStack')
        };
    }

    init() {
        this.layout.init();
        this.bindEvents();
        this.layout.setStacked(this.settings.stackedLayout);
        this.elements.highlightWordsToggle.checked = this.settings.highlightWords;
        // Only redraw for width changes, not height changes caused by wrapping.
        let previousBoardWidth = 0;
        new ResizeObserver(entries => {
            const width = entries[0].contentRect.width;
            if (Math.abs(width - previousBoardWidth) < 8) return;
            previousBoardWidth = width;
            if (this.session) this.renderAll();
        }).observe(this.elements.matchBoard);
        this.ui.setTheme(this.settings.theme);
        this.ui.setTextSize(this.settings.textSize);
        this.ui.setReadingMode(this.settings.readingMode);
        this.syncSetSizeControls();
    }

    bindEvents() {
        this.elements.sidebarToggleBtn.addEventListener('click', () => this.layout.toggleSidebar());
        this.elements.layoutToggleBtn.addEventListener('click', () => this.toggleLayout());
        this.elements.helpBtn.addEventListener('click', () => this.elements.helpPanel.classList.toggle('hidden'));
        this.elements.jumpToPromptBtn.addEventListener('click', () => this.revealBottomPanel('prompt'));
        this.elements.showInputPanelBtn.addEventListener('click', () => this.revealBottomPanel('input'));
        this.elements.showPromptPanelBtn.addEventListener('click', () => this.revealBottomPanel('prompt'));
        this.elements.footerShowInputBtn.addEventListener('click', () => this.revealBottomPanel('input'));
        this.elements.footerShowPromptBtn.addEventListener('click', () => this.revealBottomPanel('prompt'));
        this.elements.toggleInputPanelBtn.addEventListener('click', () => this.setBottomPanelVisible('input', false));
        this.elements.togglePromptPanelBtn.addEventListener('click', () => this.setBottomPanelVisible('prompt', false));
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape') this.layout.toggleSidebar(false);
        });
        this.elements.themeBambooBtn.addEventListener('click', () => this.changeTheme('bamboo'));
        this.elements.themeDarkBtn.addEventListener('click', () => this.changeTheme('dark'));
        this.elements.hoverHintsToggle.addEventListener('change', () => {
            this.settings.hoverHints = this.elements.hoverHintsToggle.checked;
            this.renderAll();
            this.maybeAutosave();
        });
        this.elements.highlightWordsToggle.addEventListener('change', () => {
            this.settings.highlightWords = this.elements.highlightWordsToggle.checked;
            this.renderAll();
            this.maybeAutosave();
        });
        this.elements.readingModeToggle.addEventListener('change', () => {
            this.settings.readingMode = this.elements.readingModeToggle.checked;
            this.ui.setReadingMode(this.settings.readingMode);
            this.maybeAutosave();
        });
        this.elements.autosaveToggle.addEventListener('change', () => {
            this.settings.autosave = this.elements.autosaveToggle.checked;
            this.notifier.success(this.settings.autosave ? 'Autosave enabled.' : 'Autosave disabled.');
            this.maybeAutosave();
        });
        this.elements.setSizeSelect.addEventListener('change', () => {
            if (this.elements.setSizeSelect.value === 'custom') return;
            this.setWordsPerSet(Number(this.elements.setSizeSelect.value));
        });
        this.elements.customSetSize.addEventListener('input', () => { this.customSetDirty = true; });
        this.elements.applyCustomSetBtn.addEventListener('click', () => this.applyCustomWordsPerSet());
        this.elements.customSetSize.addEventListener('keydown', event => {
            if (event.key === 'Enter') this.applyCustomWordsPerSet();
        });
        this.elements.sampleChineseQuickBtn.addEventListener('click', () => this.loadSampleExercise(this.sampleChineseExercise()));
        this.elements.sampleEnglishQuickBtn.addEventListener('click', () => this.loadSampleExercise(this.sampleEnglishExercise()));
        this.elements.importQuickBtn.addEventListener('click', () => this.elements.importExerciseFile.click());
        this.elements.exportQuickBtn.addEventListener('click', () => this.exportJson());
        this.elements.textSmallerBtn.addEventListener('click', () => this.changeTextSize(-2));
        this.elements.textLargerBtn.addEventListener('click', () => this.changeTextSize(2));
        this.elements.loadExerciseBtn.addEventListener('click', () => this.loadExerciseFromInput());
        this.elements.exerciseInput.addEventListener('input', () => this.handlePreviewUpdate());
        this.elements.answerBtn.addEventListener('click', () => this.checkCurrentSet());
        this.elements.previousSetBtn.addEventListener('click', () => this.changeSet(-1));
        this.elements.nextSetBtn.addEventListener('click', () => this.changeSet(1));
        this.elements.retryBtn.addEventListener('click', () => this.startRetryMode());
        this.elements.returnSetBtn.addEventListener('click', () => this.endRetryMode());
        this.elements.toggleCompletedTop.addEventListener('click', () => this.ui.toggleCompletedTopVisibility());
        this.elements.sampleChineseBtn.addEventListener('click', () => this.loadSampleExercise(this.sampleChineseExercise()));
        this.elements.sampleEnglishBtn.addEventListener('click', () => this.loadSampleExercise(this.sampleEnglishExercise()));
        this.elements.importFileBtn.addEventListener('click', () => this.elements.importExerciseFile.click());
        this.elements.importExerciseFile.addEventListener('change', event => this.importFile(event));
        this.elements.exportJsonBtn.addEventListener('click', () => this.exportJson());
        this.elements.saveStateBtn.addEventListener('click', () => this.saveState());
        this.elements.restoreStateBtn.addEventListener('click', () => this.restoreState());
        this.elements.clearSavedBtn.addEventListener('click', () => this.clearSavedState());
        this.elements.resetProgressBtn.addEventListener('click', () => this.resetProgress());
        this.elements.copyPromptBtn.addEventListener('click', async () => {
            try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    await navigator.clipboard.writeText(this.elements.aiPrompt.value);
                } else {
                    // Fallback for browsers that restrict Clipboard API on local HTML files.
                    this.elements.aiPrompt.select();
                    if (!document.execCommand('copy')) throw new Error('Copy command unavailable');
                }
                this.notifier.success('Prompt copied to the clipboard.');
            } catch {
                this.notifier.error('Copy was blocked. Select the prompt and use Ctrl+C.');
            }
        });
    }

    handlePreviewUpdate() {
        const parsed = this.parser.parse(this.elements.exerciseInput.value);
        if (!parsed.valid) {
            this.elements.textPreview.textContent = 'Invalid or incomplete exercise format.';
            this.elements.vocabPreview.textContent = 'Waiting for a valid VOCAB section.';
            return;
        }
        this.ui.renderPreview(parsed.exercise, this.settings.hoverHints);
    }

    loadExerciseFromInput() {
        if (this.customSetDirty && !this.applyCustomWordsPerSet(false)) return;
        const parsed = this.parser.parse(this.elements.exerciseInput.value);
        if (!parsed.valid) {
            this.notifier.error(parsed.error);
            return;
        }
        this.currentExercise = parsed.exercise;
        this.startSession(parsed.exercise);
        // The newly displayed exercise is the confirmation; no toast needed.
    }

    loadSampleExercise(rawText, showToast = true) {
        this.elements.exerciseInput.value = rawText;
        this.handlePreviewUpdate();
        const parsed = this.parser.parse(rawText);
        if (parsed.valid) {
            this.currentExercise = parsed.exercise;
            this.startSession(parsed.exercise);
            // Sample loading is self-evident, so leave the workspace unobstructed.
        }
    }

    startSession(exercise) {
        this.session = new ExerciseSession(exercise, { setSize: this.settings.setSize });
        this.elements.readingText.classList.remove('empty-reader');
        this.selectedWordId = null;
        this.selectedDefinitionId = null;
        this.highlightedWordId = null;
        this.elements.resetProgressBtn.disabled = false;
        this.renderAll();
        this.maybeAutosave();
    }

    renderAll() {
        if (!this.session || !this.currentExercise) return;
        const currentSetIds = new Set(this.session.activeWordIds);
        const matchedIds = new Set();
        this.session.setStates.forEach(state => state.matches.forEach((_value, id) => matchedIds.add(id)));
        if (this.session.retryContext) {
            // A retry is a fresh attempt: words not yet matched in the retry
            // should be sage rather than grey from the original attempt.
            this.session.activeWordIds.forEach(id => matchedIds.delete(id));
            this.session.retryContext.state.matches.forEach((_value, id) => matchedIds.add(id));
        }
        this.ui.renderPassage(
            this.elements.readingText,
            this.currentExercise.passage,
            this.currentExercise.vocabulary,
            currentSetIds,
            this.settings.hoverHints,
            id => this.handleReadingWordClick(id),
            this.settings.highlightWords,
            matchedIds
        );
        this.ui.renderPreview(this.currentExercise, this.settings.hoverHints);
        this.ui.buildMatchBoard(this.session, {
            hoverHints: this.settings.hoverHints,
            selectedWordId: this.selectedWordId,
            selectedDefinitionId: this.selectedDefinitionId
        }, {
            onWordClick: id => this.handleWordSelection(id),
            onDefinitionClick: id => this.handleDefinitionSelection(id)
        });
        this.ui.renderCompletedLists(
            this.session,
            id => this.undoMatch(id),
            id => this.highlightWordAcrossUI(id)
        );
        this.ui.updateProgress(this.session);
        if (this.highlightedWordId !== null) {
            this.highlightWordAcrossUI(this.highlightedWordId);
        }
    }

    // A linked highlight never identifies the correct translation.
    // All occurrences of the same word in the passage get the same focus.
    handleReadingWordClick(id) {
        if (!this.session) return;
        const active = this.session.activeWordIds.includes(id);
        const unmatched = active && !this.session.activeState.matches.has(id) && !this.session.activeState.checked;
        if (unmatched) {
            this.handleWordSelection(id);
            return;
        }
        this.selectedWordId = null;
        this.highlightedWordId = this.highlightedWordId === id ? null : id;
        this.renderAll();
    }

    handleWordSelection(id) {
        if (!this.session || this.session.activeState.checked) return;
        if (!this.session.activeWordIds.includes(id) || this.session.activeState.matches.has(id)) return;
        this.selectedWordId = this.selectedWordId === id ? null : id;
        this.highlightedWordId = this.selectedWordId;
        if (this.selectedWordId !== null && this.selectedDefinitionId !== null) {
            this.createMatch();
        } else {
            this.renderAll();
        }
    }

    handleDefinitionSelection(id) {
        if (!this.session || this.session.activeState.checked) return;
        const used = new Set(this.session.activeState.matches.values());
        if (used.has(id)) return;
        this.selectedDefinitionId = this.selectedDefinitionId === id ? null : id;
        if (this.selectedWordId === null) this.highlightedWordId = null;
        if (this.selectedWordId !== null && this.selectedDefinitionId !== null) {
            this.createMatch();
        } else {
            this.renderAll();
        }
    }

    createMatch() {
        const response = this.session.addMatch(this.selectedWordId, this.selectedDefinitionId);
        if (!response.ok) {
            this.notifier.error(response.error);
        }
        this.selectedWordId = null;
        this.selectedDefinitionId = null;
        this.highlightedWordId = null;
        this.renderAll();
        this.maybeAutosave();
    }

    undoMatch(wordId) {
        this.session.removeMatch(wordId);
        this.renderAll();
        this.maybeAutosave();
    }

    highlightWordAcrossUI(id) {
        this.highlightedWordId = id;
        // Only highlight vocabulary, text, and completed items. Never expose
        // the matching definition by using its answer ID.
        document.querySelectorAll('.text-word, .vocab-item, .completed-item').forEach(el => el.classList.remove('highlighted'));
        document.querySelectorAll(`.text-word[data-id="${id}"], .vocab-item[data-id="${id}"], .completed-item[data-id="${id}"]`).forEach(el => el.classList.add('highlighted'));
    }

    checkCurrentSet() {
        if (!this.session) return;
        const results = this.session.checkCurrentSet();
        this.renderAll();
        this.ui.showCheckResult(results);
        // The two completed-section headers display the score; no pop-up needed.
        this.maybeAutosave();
    }

    changeSet(direction) {
        if (!this.session) return;
        this.session.moveSet(direction);
        this.selectedWordId = null;
        this.selectedDefinitionId = null;
        this.highlightedWordId = null;
        this.renderAll();
        this.maybeAutosave();
    }

    startRetryMode() {
        if (this.session.startRetryMode()) {
            this.selectedWordId = null;
            this.selectedDefinitionId = null;
            this.highlightedWordId = null;
            this.renderAll();
            // Retry mode is labelled in the set counter; no toast required.
        }
    }

    endRetryMode() {
        this.session.endRetryMode();
        this.selectedWordId = null;
        this.selectedDefinitionId = null;
        this.highlightedWordId = null;
        this.renderAll();
    }

    // Visibility is deliberately UI-only: hide an entire lower panel and its
    // own resizing rail, but never lose the editor contents or exercise state.
    setBottomPanelVisible(name, visible) {
        if (name === 'input') {
            this.elements.exerciseBuilderSection.hidden = !visible;
            this.elements.builderHeightResizer.hidden = !visible;
            this.elements.toggleInputPanelBtn.setAttribute('aria-expanded', String(visible));
        } else {
            this.elements.promptPanel.hidden = !visible;
            this.elements.promptBottomResizer.hidden = !visible;
            this.elements.togglePromptPanelBtn.setAttribute('aria-expanded', String(visible));
        }
        // Pane heights are NEVER modified by hiding or showing a neighbour.
    }

    revealBottomPanel(name) {
        this.setBottomPanelVisible(name, true);
        const target = name === 'input' ? this.elements.editorPanel : this.elements.promptPanel;
        this.layout.toggleSidebar(false);
        requestAnimationFrame(() => target.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    }

    toggleLayout() {
        this.settings.stackedLayout = !this.settings.stackedLayout;
        this.layout.setStacked(this.settings.stackedLayout);
        this.renderAll();
        this.maybeAutosave();
    }

    // A reusable set-size API for sidebar presets and custom editor settings.
    // 0 means Unlimited. Every positive integer is accepted by the editor.
    syncSetSizeControls() {
        const value = this.settings.setSize;
        const preset = [0, 5, 10, 15, 20, 25, 30].includes(value);
        this.elements.setSizeSelect.value = preset ? String(value) : 'custom';
        this.elements.customSetSize.value = value === 0 ? '' : String(value);
        this.elements.customSetSize.placeholder = value === 0 ? 'All' : '';
        this.customSetDirty = false;
    }

    setWordsPerSet(value) {
        this.settings.setSize = value;
        this.syncSetSizeControls();
        if (this.currentExercise) this.startSession(this.currentExercise);
        this.maybeAutosave();
    }

    applyCustomWordsPerSet(announce = true) {
        const raw = this.elements.customSetSize.value.trim();
        const number = Number(raw);
        if (!raw || !Number.isSafeInteger(number) || number < 1) {
            this.notifier.error('Words per set must be a positive whole number.');
            return false;
        }
        if (number !== this.settings.setSize) this.setWordsPerSet(number);
        // The updated set counter reflects the change without a notification.
        return true;
    }

    changeTheme(theme) {
        this.settings.theme = theme;
        this.ui.setTheme(theme);
        this.maybeAutosave();
    }

    changeTextSize(delta) {
        this.settings.textSize = Math.max(14, Math.min(46, this.settings.textSize + delta));
        this.ui.setTextSize(this.settings.textSize);
        this.maybeAutosave();
    }

    exportJson() {
        const parsed = this.parser.parse(this.elements.exerciseInput.value);
        if (!parsed.valid) {
            this.notifier.error('Load or enter a valid exercise before exporting JSON.');
            return;
        }
        const payload = {
            type: 'panda-vocab-matchup',
            version: 3,
            exercise: parsed.exercise
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        this.downloadBlob(blob, 'panda-vocab-matchup-exercise.json');
        this.notifier.success('Exercise exported as JSON.');
    }

    importFile(event) {
        const file = event.target.files && event.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            this.elements.exerciseInput.value = String(reader.result || '');
            this.handlePreviewUpdate();
            this.notifier.success(`Imported ${file.name}.`);
        };
        reader.onerror = () => this.notifier.error('Could not read the file.');
        reader.readAsText(file);
        event.target.value = '';
    }

    saveState() {
        const payload = this.buildSavePayload();
        if (this.storage.save(payload)) {
            this.notifier.success('Current state saved.');
        } else {
            this.notifier.error('This browser has blocked local storage. Try exporting the exercise as JSON instead.');
        }
    }

    restoreState() {
        const payload = this.storage.load();
        if (!payload) {
            this.notifier.error('No saved state was found.');
            return;
        }
        this.applySavePayload(payload);
        this.notifier.success('Saved state restored.');
    }

    clearSavedState() {
        if (this.storage.clear()) {
            this.notifier.success('Saved state cleared.');
        } else {
            this.notifier.error('This browser has blocked access to saved state.');
        }
    }

    maybeAutosave() {
        if (!this.settings.autosave) return;
        this.storage.save(this.buildSavePayload());
    }

    buildSavePayload() {
        return {
            settings: this.settings,
            exerciseInput: this.elements.exerciseInput.value,
            currentExercise: this.currentExercise,
            session: this.session ? this.session.serialize() : null
        };
    }

    applySavePayload(payload) {
        this.settings = { ...this.settings, ...payload.settings };
        this.elements.exerciseInput.value = payload.exerciseInput || '';
        this.elements.hoverHintsToggle.checked = this.settings.hoverHints;
        this.elements.highlightWordsToggle.checked = this.settings.highlightWords;
        this.layout.setStacked(Boolean(this.settings.stackedLayout));
        this.elements.readingModeToggle.checked = this.settings.readingMode;
        this.elements.autosaveToggle.checked = this.settings.autosave;
        this.syncSetSizeControls();
        this.ui.setTheme(this.settings.theme);
        this.ui.setTextSize(this.settings.textSize);
        this.ui.setReadingMode(this.settings.readingMode);
        this.handlePreviewUpdate();
        this.currentExercise = payload.currentExercise || null;
        this.session = payload.session ? ExerciseSession.restore(payload.session) : null;
        this.selectedWordId = null;
        this.selectedDefinitionId = null;
        this.highlightedWordId = null;
        this.elements.resetProgressBtn.disabled = !this.session;
        if (this.session) this.renderAll();
    }

    resetProgress() {
        if (!this.session) return;
        this.session.resetCurrentExercise();
        this.selectedWordId = null;
        this.selectedDefinitionId = null;
        this.highlightedWordId = null;
        this.renderAll();
        this.maybeAutosave();
        this.notifier.success('Exercise progress reset.');
    }

    downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
    }

    sampleChineseExercise() {
        return `今天我和[朋友1]去了[学校2]附近的[公园3]。天气很[温暖4]，我们决定[散步5]。
[公园3]里有很多[树6]，还有一条[河7]。我们坐在[椅子8]上，一边[聊天9]，一边喝[茶10]。
后来，我们去[商店11]买[水果12]，然后[回家13]。回家的路上，我又见到了那位[朋友1]。

VOCAB:
1 朋友 | péngyou - friend
2 学校 | xuéxiào - school
3 公园 | gōngyuán - park
4 温暖 | wēnnuǎn - warm
5 散步 | sànbù - to take a walk
6 树 | shù - tree
7 河 | hé - river
8 椅子 | yǐzi - chair
9 聊天 | liáotiān - to chat
10 茶 | chá - tea
11 商店 | shāngdiàn - shop / store
12 水果 | shuǐguǒ - fruit
13 回家 | huíjiā - to go home`;
    }

    sampleEnglishExercise() {
        return `Last winter, [Mia1] travelled to a small [village2] near the mountains. Every morning she walked to the [market3] to buy fresh bread.
At night, she wrote in her [journal4] by the fire and listened to the [wind5] outside. On her final day, a friendly [artist6] gave her a painted postcard.

VOCAB:
1 Mia - a person's name
2 village - a small country town
3 market - a place where goods are sold
4 journal - a personal notebook or diary
5 wind - moving air
6 artist - a person who creates art`;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const app = new PandaApp();
    app.init();
    window.pandaVocabApp = app;
});

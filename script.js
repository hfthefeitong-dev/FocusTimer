let timer;
let seconds = 0;
let isFocusing = false;
let isPaused = false;
let mode = 'countdown'; // 'countdown' or 'stopwatch'
let dailyTotalSeconds = 0; // Will be loaded from DB on start

let focusStartTimestamp = 0;
let sessionDuration = 0; // Cumulative duration for current session
let currentSessionId = null;
let isFinishing = false;
let sessionStartTimestamp = 0;
let sessionActiveTotalSeconds = 0;
let pauseCount = 0;

// --- ROUTINE Runtime ---
// Keep the same on-screen summary duration as the normal (non-ROUTINE) flow.
// Note: finishTimer() currently reverts after ~5s; we mirror that here.
const ROUTINE_FOCUS_SUMMARY_MS = 5000;
const ROUTINE_REVERT_FADE_MS = 600;
const ROUTINE_BAR_SHOW_DELAY_MS = 2000;
let routineTransitionTimeout = null;
let routineFadeTimeout = null;
let routineBarAutoHideTimeout = null;
let routineBarDelayTimeout = null;
let routineBarPauseToggleTimeout = null;
let routineIntroTimeout = null;

const routine = {
    active: false,
    items: [],
    index: 0,
    isTransitioning: false,
    segments: [],
};

function generateSessionId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `sid_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

// Stats DOM
const openStatsBtn = document.getElementById('open-stats');
const closeStatsBtn = document.getElementById('close-stats');
const statsOverlay = document.getElementById('stats-overlay');
const statTotalTime = document.getElementById('stat-total-time');
const statFocusScore = document.getElementById('stat-focus-score');
const statFocusDetails = document.getElementById('stat-focus-details');
let focusChart = null;
let focusPieChart = null;
let distributionChart = null;
let selectedStatsRange = 'today'; // default
let statsDrill = null; // only used when selectedStatsRange === 'all'
let distFadeTimeout = null;
let focusScoreRequestId = 0;

function getStatsDrillPayload() {
    if (selectedStatsRange !== 'all') return null;
    if (!statsDrill || typeof statsDrill !== 'object') return null;
    if (!statsDrill.level || !statsDrill.key) return null;
    return { level: statsDrill.level, key: statsDrill.key };
}

function setStatsDrill(next) {
    statsDrill = next;
    renderStatsDrillBreadcrumb();
}

function getMonthFromDayKey(dayKey) {
    if (typeof dayKey !== 'string') return null;
    const m = dayKey.match(/^(\d{4}-\d{2})-\d{2}$/);
    return m ? m[1] : null;
}

function renderStatsDrillBreadcrumb() {
    const el = document.getElementById('stats-drill-breadcrumb');
    if (!el) return;

    if (selectedStatsRange !== 'all') {
        el.style.display = 'none';
        el.innerHTML = '';
        return;
    }

    const drill = getStatsDrillPayload();
    el.style.display = 'flex';

    const infoIcon = `<svg class="hint-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`;

    if (!drill) {
        el.innerHTML = `
            <div class="breadcrumb-path">
                <span class="crumb"><span class="crumb-link" data-action="root">全部</span></span>
            </div>
            <div class="crumb-hint">${infoIcon} 点击月份数据点查看当月每日</div>
        `;
        return;
    }

    if (drill.level === 'month') {
        el.innerHTML = `
            <div class="breadcrumb-path">
                <span class="crumb"><span class="crumb-link" data-action="root">全部</span></span>
                <span class="crumb-sep">/</span>
                <span class="crumb"><span>${drill.key}</span></span>
            </div>
            <div class="crumb-hint">${infoIcon} 点击日期数据点查看当日小时</div>
        `;
        return;
    }

    if (drill.level === 'day') {
        const monthKey = getMonthFromDayKey(drill.key);
        el.innerHTML = `
            <div class="breadcrumb-path">
                <span class="crumb"><span class="crumb-link" data-action="root">全部</span></span>
                <span class="crumb-sep">/</span>
                <span class="crumb">${monthKey ? `<span class="crumb-link" data-action="to-month" data-month="${monthKey}">${monthKey}</span>` : `<span>月份</span>`}</span>
                <span class="crumb-sep">/</span>
                <span class="crumb"><span>${drill.key}</span></span>
            </div>
            <div class="crumb-hint">${infoIcon} 已进入小时明细</div>
        `;
        return;
    }

    el.innerHTML = `<span class="crumb"><span class="crumb-link" data-action="root">全部</span></span>`;
}

/**
 * Universal Custom Dropdown Setup
 */
function setupCustomDropdown(id, onChange = null) {
    const dropdown = document.getElementById(id + '-dropdown');
    const trigger = document.getElementById(id + '-trigger');
    const valueDisplay = document.getElementById(id + '-value');
    const menu = document.getElementById(id + '-menu');

    if (!dropdown || !trigger) return null;

    const state = {
        _value: "",
        get value() { return this._value; },
        set value(v) {
            this._value = v;
            this.syncUI();
            if (onChange) onChange(v);
        },
        syncUI() {
            const item = menu.querySelector(`.dropdown-item[data-value="${this._value}"]`);
            if (item) {
                if (valueDisplay) valueDisplay.textContent = item.textContent;
                menu.querySelectorAll('.dropdown-item').forEach(i => i.classList.toggle('active', i === item));
            }
        },
        refreshOptions(optionsHtml) {
            if (!menu) return;
            menu.innerHTML = optionsHtml;
            this.bindItems();
            this.syncUI();
        },
        bindItems() {
            if (!menu) return;
            menu.querySelectorAll('.dropdown-item').forEach(item => {
                item.onclick = (e) => {
                    e.stopPropagation();
                    this.value = item.dataset.value;
                    dropdown.classList.remove('open');
                };
            });
        },
        set disabled(v) {
            trigger.style.opacity = v ? '0.5' : '1';
            trigger.parentElement.style.pointerEvents = v ? 'none' : 'all';
        }
    };

    trigger.onclick = (e) => {
        e.stopPropagation();
        const isOpen = dropdown.classList.contains('open');
        document.querySelectorAll('.custom-dropdown').forEach(d => d.classList.remove('open'));
        if (!isOpen) dropdown.classList.add('open');
    };

    state.bindItems();
    return state;
}

// Global click to close all dropdowns
document.addEventListener('click', () => {
    document.querySelectorAll('.custom-dropdown').forEach(d => d.classList.remove('open'));
});

// Settings DOM
const openSettingsBtn = document.getElementById('open-settings');
const closeSettingsBtn = document.getElementById('close-settings');
const settingsOverlay = document.getElementById('settings-overlay');
const hotkeyInput = document.getElementById('hotkey-input');
const saveHotkeyBtn = document.getElementById('save-hotkey');
const clearDbBtn = document.getElementById('clear-db-btn');

const glassBlurSlider = document.getElementById('glass-blur-slider');
const blurValueDisplay = document.getElementById('blur-value-display');

// Routine DOM
const openRoutineBtn = document.getElementById('open-routine');
const closeRoutineBtn = document.getElementById('close-routine');
const routineOverlay = document.getElementById('routine-overlay');
const addRoutineItemBtn = document.getElementById('add-routine-item-btn');
const routineItemsList = document.getElementById('routine-items-list');

openRoutineBtn.onclick = () => {
    routineOverlay.classList.add('active');
    // Initialize with one item if empty
    if (routineItemsList.children.length === 0) {
        addRoutineItem();
    }
};

closeRoutineBtn.onclick = () => {
    routineOverlay.classList.remove('active');
};

function addRoutineItem(main = null, sub = null, duration = 25, rest = 5) {
    const div = document.createElement('div');
    div.className = 'routine-item-row';

    // Create Selects
    const mainSelect = document.createElement('select');
    mainSelect.className = 'routine-select';

    const subSelect = document.createElement('select');
    subSelect.className = 'routine-select';

    // Populate Main
    const mainKeys = Object.keys(categoryConfig).filter(k => !categoryConfig[k].hidden);
    if (mainKeys.length === 0) {
        mainKeys.push("默认");
    }

    mainKeys.forEach(k => {
        const opt = document.createElement('option');
        opt.value = k;
        opt.textContent = k;
        mainSelect.appendChild(opt);
    });

    // Initial Selection
    if (main && mainKeys.includes(main)) {
        mainSelect.value = main;
    } else {
        mainSelect.value = mainKeys[0];
    }

    // Function to update Sub options
    const updateSubs = () => {
        const selectedMain = mainSelect.value;
        subSelect.innerHTML = '';
        const config = categoryConfig[selectedMain] || { subs: ["默认"] };
        const subs = config.subs || ["默认"];

        subs.forEach(s => {
            // Optional: Filter hidden subs if you want to strictly match settings logic
            // const isHidden = config.hiddenSubs && config.hiddenSubs.includes(s);
            // if(!isHidden) ...
            const opt = document.createElement('option');
            opt.value = s;
            opt.textContent = s;
            subSelect.appendChild(opt);
        });

        // Restore sub selection if valid for this main category
        if (sub && subs.includes(sub)) {
            subSelect.value = sub;
        } else if (subs.length > 0) {
            subSelect.value = subs[0];
        }
    };

    // Initialize Subs
    updateSubs();

    // Keep sub options in sync with the selected main category.
    mainSelect.onchange = () => {
        sub = null; // Clear preferred sub once main changes
        updateSubs();
    };

    // Inputs for Time
    const durationInput = document.createElement('input');
    durationInput.type = 'number';
    durationInput.className = 'routine-input num';
    durationInput.min = '5';
    durationInput.step = '5';
    durationInput.value = duration;
    durationInput.placeholder = '分';

    const restInput = document.createElement('input');
    restInput.type = 'number';
    restInput.className = 'routine-input num';
    restInput.min = '0';
    restInput.step = '5';
    restInput.value = rest;
    restInput.placeholder = '分';

    // Delete Button
    const delBtn = document.createElement('button');
    delBtn.className = 'icon-btn danger';
    delBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
    delBtn.onclick = () => div.remove();

    div.appendChild(mainSelect);
    div.appendChild(subSelect);
    div.appendChild(durationInput);
    div.appendChild(restInput);
    div.appendChild(delBtn);

    routineItemsList.appendChild(div);
}

addRoutineItemBtn.onclick = () => {
    addRoutineItem();
};

const startRoutineBtn = document.getElementById('start-routine-btn');
const routineStatusBar = document.getElementById('routine-status-bar');
const routineProgressTrack = document.getElementById('routine-progress-track');
const routineTitleEl = routineStatusBar ? routineStatusBar.querySelector('.routine-title') : null;
const routineCurrentItemEl = document.getElementById('routine-current-item');
const routineStateEl = routineStatusBar ? routineStatusBar.querySelector('.routine-state') : null;
const ROUTINE_TITLE_DEFAULT = 'ROUTINE™';

function routineSetTitle(text) {
    if (!routineTitleEl) return;
    routineTitleEl.textContent = text || '';
}

function routineCurrentItem() {
    if (!routine.active) return null;
    if (!Array.isArray(routine.items) || routine.items.length === 0) return null;
    return routine.items[routine.index] || null;
}

function routineIsRest() {
    const item = routineCurrentItem();
    return !!(item && item.type === 'rest');
}

function routineShowRestUI() {
    if (!countdownPicker || !finishSummary) return;
    countdownPicker.classList.remove('hidden');
    countdownPicker.classList.add('finish-mode');
    countdownPicker.classList.add('resting');
    finishSummary.textContent = '休息中';
    finishSummary.classList.remove('hidden');
}

function routineHideRestUI() {
    if (!countdownPicker) return;
    countdownPicker.classList.remove('resting');
    if (finishSummary) {
        finishSummary.classList.add('hidden');
        if (finishSummary.textContent === '休息中') finishSummary.textContent = '';
    }
    if (countdownPicker) countdownPicker.classList.remove('finish-mode');
}

function routineClearTransitionTimers() {
    if (routineTransitionTimeout) clearTimeout(routineTransitionTimeout);
    if (routineFadeTimeout) clearTimeout(routineFadeTimeout);
    if (routineBarDelayTimeout) clearTimeout(routineBarDelayTimeout);
    if (routineIntroTimeout) clearTimeout(routineIntroTimeout);
    if (routineBarPauseToggleTimeout) clearTimeout(routineBarPauseToggleTimeout);
    routineTransitionTimeout = null;
    routineFadeTimeout = null;
    routineBarDelayTimeout = null;
    routineIntroTimeout = null;
    routineBarPauseToggleTimeout = null;
}

function routineClearBarTimer() {
    if (routineBarAutoHideTimeout) clearTimeout(routineBarAutoHideTimeout);
    routineBarAutoHideTimeout = null;
}

function routineShowStatusBar(autoHideMs = null) {
    if (!routineStatusBar) return;
    routineClearBarTimer();
    routineStatusBar.classList.add('active');
    if (autoHideMs && autoHideMs > 0) {
        routineBarAutoHideTimeout = setTimeout(() => {
            routineStatusBar.classList.remove('active');
            routineBarAutoHideTimeout = null;
        }, autoHideMs);
    }
}

function routineHideStatusBar() {
    if (!routineStatusBar) return;
    routineClearBarTimer();
    routineStatusBar.classList.remove('active');
}

function routineScheduleStatusBarForFocusPause(shouldShow, expectedPaused) {
    if (!routine.active || !routineStatusBar) return;
    const item = routineCurrentItem();
    if (!item || item.type !== 'focus') return;
    if (routine.isTransitioning) return;

    if (routineBarPauseToggleTimeout) clearTimeout(routineBarPauseToggleTimeout);
    routineBarPauseToggleTimeout = setTimeout(() => {
        routineBarPauseToggleTimeout = null;
        if (!routine.active || !routineStatusBar) return;
        const cur = routineCurrentItem();
        if (!cur || cur.type !== 'focus') return;
        if (routine.isTransitioning) return;
        if (isPaused !== expectedPaused) return;

        if (shouldShow) routineShowStatusBar(null);
        else routineHideStatusBar();
    }, ROUTINE_BAR_SHOW_DELAY_MS);
}

function routineApplyMainVisualState(kind) {
    // This controls ONLY main-window visual state classes.
    // ROUTINE keeps the timer running internally even when we exit "focus" visuals during rest.
    const isFocus = kind === 'focus';
    document.body.classList.toggle('is-focusing', isFocus);
    document.body.classList.toggle('timer-active', isFocus);
    if (!isFocus) {
        document.body.classList.remove('is-paused');
    }
    mainBtn.classList.toggle('active', isFocus);
}

function routineUpdateStatusBar() {
    const item = routineCurrentItem();
    if (!item || !routineStatusBar) return;

    const formatFocusLabel = (main, sub) => {
        const m = (main || '未分类').toString().trim() || '未分类';
        const s = (sub || '默认').toString().trim() || '默认';
        if (!s || s === '默认') return m;
        return `${m} - ${s}`;
    };

    if (routineStateEl) {
        routineStateEl.textContent = item.type === 'rest' ? '休息中' : '专注中';
    }
    if (routineCurrentItemEl) {
        if (item.type === 'rest') {
            const nextFocus = routine.items.slice(routine.index + 1).find((it) => it && it.type === 'focus') || null;
            const nextLabel = nextFocus ? formatFocusLabel(nextFocus.main, nextFocus.sub) : '--';
            routineCurrentItemEl.textContent = `下一个：${nextLabel}`;
        } else {
            routineCurrentItemEl.textContent = formatFocusLabel(item.main, item.sub);
        }
    }
}

function routineUpdateProgressActive() {
    if (!Array.isArray(routine.segments) || routine.segments.length === 0) return;
    routine.segments.forEach((seg, idx) => {
        if (!seg) return;
        seg.classList.toggle('active', idx === routine.index);
        seg.classList.toggle('done', idx < routine.index);
    });
}

function routineMarkAllSegmentsDone() {
    const segs = routineProgressTrack
        ? Array.from(routineProgressTrack.querySelectorAll('.routine-progress-segment'))
        : (Array.isArray(routine.segments) ? routine.segments : []);

    segs.forEach((seg) => {
        if (!seg) return;
        seg.classList.remove('active');
        seg.classList.add('done');
    });
}

function routineSetStatusText(stateText, subtitleText) {
    if (routineStateEl) routineStateEl.textContent = stateText || '';
    if (routineCurrentItemEl) routineCurrentItemEl.textContent = subtitleText || '';
}

function routineShowCompletionBar() {
    if (routineStatusBar) routineStatusBar.classList.add('completed');

    const segs = routineProgressTrack
        ? Array.from(routineProgressTrack.querySelectorAll('.routine-progress-segment'))
        : (Array.isArray(routine.segments) ? routine.segments : []);

    if (Array.isArray(routine.segments) && routine.segments.length > 0) {
        routine.segments.forEach((seg) => {
            if (!seg) return;
            seg.classList.remove('active');
            seg.classList.add('done');
        });
    }

    // Extra safety: ensure the DOM doesn't keep any lingering `.active` segment.
    segs.forEach((seg) => {
        if (!seg) return;
        seg.classList.remove('active');
        seg.classList.add('done');
    });

    routineSetStatusText('ROUTINE已完成', '');
    routineShowStatusBar(null);
}

function routineBuildItemsFromUI() {
    const rows = routineItemsList.querySelectorAll('.routine-item-row');
    const items = [];

    rows.forEach((row) => {
        const selects = row.querySelectorAll('select');
        const main = selects[0]?.value || '未分类';
        const sub = selects[1]?.value || '默认';

        const durationInput = row.querySelector('input:nth-of-type(1)');
        const restInput = row.querySelector('input:nth-of-type(2)');

        const duration = parseInt(durationInput?.value, 10) || 0;
        const rest = parseInt(restInput?.value, 10) || 0;

        if (duration > 0) {
            items.push({ type: 'focus', durationMin: duration, main, sub });
            if (rest > 0) items.push({ type: 'rest', durationMin: rest });
        }
    });

    // No final rest after the last focus segment.
    while (items.length > 0 && items[items.length - 1]?.type === 'rest') {
        items.pop();
    }

    return items;
}

function routineRenderProgress(items) {
    if (!routineProgressTrack) return;
    routineProgressTrack.innerHTML = '';
    routine.segments = [];

    const total = items.reduce((sum, it) => sum + (it.durationMin || 0), 0) || 1;
    items.forEach((item) => {
        const seg = document.createElement('div');
        seg.className = `routine-progress-segment ${item.type}`;
        const pct = ((item.durationMin || 0) / total) * 100;
        seg.style.width = `${pct}%`;
        const titleBase = item.type === 'rest' ? '休息' : `${item.main} - ${item.sub}`;
        seg.title = `${titleBase} (${item.durationMin}分)`;
        routineProgressTrack.appendChild(seg);
        routine.segments.push(seg);
    });
}

function routineResetSegmentCounters() {
    sessionActiveTotalSeconds = 0;
    pauseCount = 0;
    sessionDuration = 0;
    lastSavedSessionDuration = 0;
    isPaused = false;
    isFinishing = false;
}

function routineEnterSegment(index) {
    routine.index = index;
    const item = routineCurrentItem();
    if (!item) return;

    // Cancel any pause/resume-driven visibility toggles when switching segments.
    if (routineBarPauseToggleTimeout) {
        clearTimeout(routineBarPauseToggleTimeout);
        routineBarPauseToggleTimeout = null;
    }

    document.body.classList.add('routine-running');
    syncResetBtnForRoutine();
    if (routineStatusBar) routineStatusBar.classList.remove('completed');
    routineSetTitle(ROUTINE_TITLE_DEFAULT);

    routineUpdateStatusBar();
    routineUpdateProgressActive();

    routineResetSegmentCounters();
    focusStartTimestamp = Date.now();
    sessionStartTimestamp = focusStartTimestamp;

    seconds = Math.max(0, (item.durationMin || 0) * 60);
    updateTimerDisplay();

    if (item.type === 'rest') {
        routineShowStatusBar(null); // Rest: keep visible
        routineApplyMainVisualState('rest');
        currentSessionId = null;
        routineShowRestUI();
        // Refresh goal progress immediately: during ROUTINE rest we stop adding live session time,
        // so we must re-fetch today's persisted stats to avoid showing a lower "done" time.
        goalBaseStats.lastFetch = 0;
        void updateGoalsDisplay(true);
        // Rest countdown entry animation (no typography overrides).
        timerBox.classList.remove('rest-entry');
        void timerBox.offsetWidth;
        timerBox.classList.add('rest-entry');
        setTimeout(() => timerBox.classList.remove('rest-entry'), 700);
        btnText.textContent = '暂停休息';
        mainBtn.classList.remove('paused');
    } else {
        // When entering a focus segment from rest, bring main window to the front.
        try {
            if (
                window.pywebview &&
                window.pywebview.api &&
                typeof window.pywebview.api.bring_main_to_front === 'function'
            ) {
                window.pywebview.api.bring_main_to_front();
            }
        } catch { }

        routineShowStatusBar(5000); // Focus: show briefly, then hide
        routineApplyMainVisualState('focus');
        routineHideRestUI();
        timerBox.classList.remove('rest-entry');
        // Keep the picker hidden during focus (even though we're still in countdown mode)
        if (countdownPicker) countdownPicker.classList.add('hidden');
        // Apply category for this segment
        try {
            mainCat.value = item.main || '未分类';
            subCat.value = item.sub || '默认';
        } catch { }
        goalBaseStats.lastFetch = 0;
        goalBaseStats.scopeMain = '';
        goalBaseStats.scopeSub = '';
        void updateGoalsDisplay(true);

        currentSessionId = generateSessionId();
        btnText.textContent = '暂停专注';
        mainBtn.classList.remove('paused');
        document.body.classList.remove('is-paused');
    }

    pushDataToMini();
}

function routinePlayFocusSummaryThen(nextFn) {
    if (routine.isTransitioning) return;
    routine.isTransitioning = true;
    routineClearTransitionTimers();

    // Match the normal auto-finish behavior: bring main window to front when a focus segment ends.
    try {
        if (
            window.pywebview &&
            window.pywebview.api &&
            typeof window.pywebview.api.bring_main_to_front === 'function'
        ) {
            window.pywebview.api.bring_main_to_front();
        }
    } catch { }

    // Once focus ends, immediately exit focus visuals (summary and rest should not look like focusing).
    routineApplyMainVisualState('rest');

    // Delay showing the ROUTINE floating status bar after "专注完成".
    // (Applies both for mid-ROUTINE transitions and final completion.)
    routineHideStatusBar();
    routineBarDelayTimeout = setTimeout(() => {
        routineBarDelayTimeout = null;
        routineShowStatusBar(null);
    }, ROUTINE_BAR_SHOW_DELAY_MS);

    const nextItem = routine.items[routine.index + 1] || null;
    const willFinishRoutine = !nextItem;
    if (willFinishRoutine && routineStatusBar) routineStatusBar.classList.add('completed');
    if (nextItem && nextItem.type === 'rest') {
        routineSetStatusText('专注完成', `即将进入休息（${nextItem.durationMin || 0}分）`);
    } else if (nextItem && nextItem.type === 'focus') {
        const m = (nextItem.main || '未分类').toString().trim() || '未分类';
        const s = (nextItem.sub || '默认').toString().trim() || '默认';
        const label = (!s || s === '默认') ? m : `${m} - ${s}`;
        routineSetStatusText('专注完成', `即将进入：${label}`);
    } else {
        // Last item: mark the progress as completed (no lingering active state).
        routineMarkAllSegmentsDone();
        // Last item: show completion on the left title, keep right side blank.
        routineSetTitle('ROUTINE™已完成');
        routineSetStatusText('', '');
    }

    // Match non-ROUTINE: fade out numerical timer first, then show "专注完成" and play entry animation.
    timerBox.style.opacity = '0';
    timerBox.style.transform = 'scale(0.95)';
    timerBox.style.filter = 'blur(10px)';
    timerBox.style.transition = 'all 0.5s cubic-bezier(0.4, 0, 0.2, 1)';

    routineIntroTimeout = setTimeout(() => {
        routineIntroTimeout = null;

        timerBox.textContent = '专注完成';
        timerBox.classList.remove('finished');
        timerBox.style.opacity = '';
        timerBox.style.transform = '';
        timerBox.style.filter = '';

        // Hide mode switch icon during the finish summary (consistent with normal finish flow).
        try {
            if (modeIconTrigger) modeIconTrigger.classList.add('force-hidden');
        } catch { }

        // Restart the CSS keyframe animation if we just finished a previous segment.
        void timerBox.offsetWidth;
        timerBox.classList.add('finished');
        showFinishSummary();

        if (willFinishRoutine) {
            // Match non-ROUTINE completion: stop loops and reset to idle immediately,
            // while preserving the "专注完成" text until we revert it after the summary.
            try {
                routine.active = false;
                document.body.classList.remove('routine-running');
                syncResetBtnForRoutine();
                if (resetBtn) resetBtn.classList.remove('confirming');
                if (resetConfirmTimeout) clearTimeout(resetConfirmTimeout);
                routineHideRestUI();
                routine.items = [];
                routine.index = 0;
                routine.segments = [];
            } catch { }

            resetEverything(false, true);

            // Best-effort resync today's total from DB (avoid rollback if DB is slightly behind).
            safeResyncTodayTotalFromDB(dailyTotalSeconds);
        }

        routineTransitionTimeout = setTimeout(() => {
            // Match non-ROUTINE: fade out then revert to timer smoothly.
            timerBox.style.opacity = '0';
            timerBox.style.filter = 'blur(10px)';
            timerBox.style.transform = 'scale(0.95)';
            timerBox.style.transition = 'all 0.5s cubic-bezier(0.4, 0, 0.2, 1)';

            routineFadeTimeout = setTimeout(() => {
                hideFinishSummary();
                timerBox.classList.remove('finished');
                try {
                    if (modeIconTrigger) modeIconTrigger.classList.remove('force-hidden');
                } catch { }
                if (willFinishRoutine) {
                    // End together with the focus summary.
                    routineHideStatusBar();
                }

                if (willFinishRoutine) {
                    // Mirror finishTimer(): revert back to default timer text after the fade.
                    resetTimerDisplay();
                    isFinishing = false;
                    routine.isTransitioning = false;
                } else {
                    routine.isTransitioning = false;
                    if (typeof nextFn === 'function') nextFn();
                }

                // Fade back in (new timer content will already be set by resetTimerDisplay()/nextFn()).
                try {
                    const transition = timerBox.style.transition || 'all 0.5s cubic-bezier(0.4, 0, 0.2, 1)';
                    timerBox.style.transition = 'none';
                    timerBox.style.opacity = '0';
                    timerBox.style.filter = 'blur(10px)';
                    timerBox.style.transform = 'scale(0.95)';
                    void timerBox.offsetWidth;
                    timerBox.style.transition = transition;
                    timerBox.style.opacity = '';
                    timerBox.style.filter = '';
                    timerBox.style.transform = '';
                } catch { }
            }, ROUTINE_REVERT_FADE_MS);
        }, ROUTINE_FOCUS_SUMMARY_MS);
    }, 500);
}

function routineAdvanceToNextSegment() {
    routine.index += 1;
    if (!routine.items[routine.index]) {
        routineStop('done');
        return;
    }
    routineEnterSegment(routine.index);
}

function routineEndEarlyWithTransition() {
    if (!routine.active) return;
    if (isFinishing) return;
    if (routine.isTransitioning) return;

    // Stop any pending ROUTINE UI transitions first.
    routineClearTransitionTimers();

    // Best-effort flush + save if we are in a focus segment.
    const wasRest = routineIsRest();
    try {
        if (isFocusing && !isPaused && !wasRest) {
            // Flush time without triggering ROUTINE segment transitions.
            const prevRoutineActive = routine.active;
            routine.active = false;
            try {
                updateTimerLogic(false);
            } finally {
                routine.active = prevRoutineActive;
            }
        }
    } catch { }

    const item = routineCurrentItem();
    if (item && item.type === 'focus' && !wasRest) {
        try { saveSessionToDB('end'); } catch { }
    }

    routine.isTransitioning = true;

    // Stop timer loops immediately to avoid extra ticks during the finish animation.
    isFinishing = true;
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
    if (window.pywebview && window.pywebview.api) {
        try { window.pywebview.api.stop_heartbeat(); } catch { }
    }

    // Tear down ROUTINE state (but keep the main timer visuals for the transition).
    routine.active = false;
    document.body.classList.remove('routine-running');
    syncResetBtnForRoutine();
    if (resetBtn) resetBtn.classList.remove('confirming');
    if (resetConfirmTimeout) clearTimeout(resetConfirmTimeout);
    if (routineStatusBar) routineStatusBar.classList.remove('completed');
    routineSetTitle(ROUTINE_TITLE_DEFAULT);
    routineHideStatusBar();
    routineHideRestUI();
    routine.items = [];
    routine.index = 0;
    routine.segments = [];

    // Resync today's total from DB (avoid rollback if DB is slightly behind).
    safeResyncTodayTotalFromDB(dailyTotalSeconds);

    // Match non-ROUTINE finish animation (except the ROUTINE status bar).
    timerBox.style.opacity = '0';
    timerBox.style.transform = 'scale(0.95)';
    timerBox.style.filter = 'blur(10px)';
    timerBox.style.transition = 'all 0.5s cubic-bezier(0.4, 0, 0.2, 1)';

    setTimeout(() => {
        timerBox.textContent = '专注完成';
        timerBox.classList.add('finished');
        try {
            if (modeIconTrigger) modeIconTrigger.classList.add('force-hidden');
        } catch { }
        timerBox.style.opacity = '';
        timerBox.style.transform = '';
        timerBox.style.filter = '';

        // Reset the app back to idle while keeping the "专注完成" text on screen.
        resetEverything(false, true);
        showFinishSummary();

        // Revert back to time after the same duration as non-ROUTINE.
        if (finishRevertTimeout) clearTimeout(finishRevertTimeout);
        finishRevertTimeout = setTimeout(() => {
            // Remove finished animation fill before fading out to avoid it overriding transitions.
            timerBox.classList.remove('finished');

            timerBox.style.opacity = '0';
            timerBox.style.filter = 'blur(10px)';
            timerBox.style.transform = 'scale(0.95)';

            setTimeout(() => {
                hideFinishSummary();
                try {
                    if (modeIconTrigger) modeIconTrigger.classList.remove('force-hidden');
                } catch { }
                resetTimerDisplay();
                isFinishing = false;
                routine.isTransitioning = false;
                timerBox.style.opacity = '';
                timerBox.style.filter = '';
                timerBox.style.transform = '';
            }, 600);
        }, ROUTINE_FOCUS_SUMMARY_MS);
    }, 500);
}

function routineStop(reason = 'manual') {
    // Stop any pending UI transitions first.
    routineClearTransitionTimers();
    routine.isTransitioning = false;

    // Avoid double-counting: for natural completion, the focus segment has already been saved
    // at the exact moment the countdown reached 0 inside updateTimerLogic().
    const shouldFlushAndSave = reason !== 'done';
    if (shouldFlushAndSave) {
        // Best-effort flush + save if we are in a focus segment.
        const wasRest = routineIsRest();
        try {
            if (isFocusing && !isPaused && !wasRest) updateTimerLogic(false);
        } catch { }

        const item = routineCurrentItem();
        if (item && item.type === 'focus' && !wasRest) {
            try {
                saveSessionToDB('end');
            } catch { }
        }
    }

    const shouldShowCompletion = reason === 'done';

    // Ensure downstream UI (mini window, tick logic) treats ROUTINE as inactive immediately.
    // (resetEverything() calls pushDataToMini() internally)
    routine.active = false;
    document.body.classList.remove('routine-running');
    syncResetBtnForRoutine();
    if (resetBtn) resetBtn.classList.remove('confirming');
    if (resetConfirmTimeout) clearTimeout(resetConfirmTimeout);
    if (routineStatusBar) routineStatusBar.classList.remove('completed');
    routineSetTitle(ROUTINE_TITLE_DEFAULT);

    // Stop loops and reset the main UI to idle without double-saving.
    resetEverything(false);
    routineHideRestUI();
    pushDataToMini();

    // Update / hide status bar after reset.
    if (shouldShowCompletion) {
        // Completion message already shown during the focus summary; end together with it.
        routineHideStatusBar();
    } else {
        routineHideStatusBar();
    }

    // Resync today's total from DB (avoid rollback if DB is slightly behind).
    safeResyncTodayTotalFromDB(dailyTotalSeconds);

    routine.items = [];
    routine.index = 0;
    routine.segments = [];
}

startRoutineBtn.onclick = () => {
    if (isFocusing && !routine.active) {
        alert('请先结束当前计时，再开始 ROUTINE。');
        return;
    }

    if (routine.active) {
        routineStop('manual');
    }

    const items = routineBuildItemsFromUI();
    if (items.length === 0) {
        alert('请添加至少一个有效的专注步骤');
        return;
    }

    // Force countdown mode for ROUTINE
    modeControl.value = 'countdown';

    // Render Progress Bar
    routineRenderProgress(items);

    // Show Status Bar & Close Overlay
    routineOverlay.classList.remove('active');

    routine.active = true;
    routine.items = items;
    routine.index = 0;
    routine.isTransitioning = false;
    document.body.classList.add('routine-running');
    syncResetBtnForRoutine();
    routineSetTitle(ROUTINE_TITLE_DEFAULT);

    // Initialize first segment and start timer loops.
    routineEnterSegment(0);
    startTimer({ seedSessionId: currentSessionId });
};

// Initialize all dropdowns
const miniEffect = setupCustomDropdown('mini-effect', async (v) => {
    if (window.pywebview) {
        const settings = await window.pywebview.api.get_settings();
        settings.miniEffect = v;
        await window.pywebview.api.save_settings(settings);
    }
    pushDataToMini();
});

const timezone = setupCustomDropdown('timezone', async (v) => {
    if (!window.pywebview) return;
    const settings = await window.pywebview.api.get_settings();
    settings.timezone = v;
    await window.pywebview.api.save_settings(settings);
    localStorage.setItem(LOCAL_TZ_KEY, v);
    const todaySecs = await window.pywebview.api.get_today_total();
    dailyTotalSeconds = todaySecs;
    updateDailyDisplay();
    if (statsOverlay.classList.contains('active')) updateChart();
});

const appFont = setupCustomDropdown('app-font', async (v) => {
    document.documentElement.style.setProperty('--body-font', v);
    document.documentElement.style.setProperty('--timer-font', v);
    if (window.pywebview) {
        const settings = await window.pywebview.api.get_settings();
        settings.appFont = v;
        await window.pywebview.api.save_settings(settings);
    }
});

const statMainFilter = setupCustomDropdown('stat-filter-main', async (v) => {
    if (v && categoryConfig[v]) {
        document.getElementById('stat-filter-sub-dropdown').style.display = 'block';
        const subs = categoryConfig[v].subs || [];
        const optionsHtml = '<div class="dropdown-item" data-value="">全部小类</div>' +
            subs.map(s => `<div class="dropdown-item" data-value="${s}">${s}</div>`).join('');
        statSubFilter.refreshOptions(optionsHtml);
        statSubFilter.value = "";
    } else {
        document.getElementById('stat-filter-sub-dropdown').style.display = 'none';
        statSubFilter.value = '';
    }
    await updateChart();
});

const statSubFilter = setupCustomDropdown('stat-filter-sub', async (v) => {
    await updateChart();
});

let currentHotkey = 'ctrl+alt+s'; // Default, will be loaded from file
const LOCAL_TZ_KEY = 'timezone';

const timerBox = document.getElementById('timer-box');
const mainBtn = document.getElementById('main-focus-btn');
const resetBtn = document.getElementById('reset-btn');
const resetConfirmTextEl = resetBtn ? resetBtn.querySelector('.confirm-text') : null;
const btnText = mainBtn.querySelector('.btn-text');
const dailyTimeDisplay = document.getElementById('daily-time');
const minsInput = document.getElementById('minutes-input');
const countdownPicker = document.getElementById('countdown-picker');
const finishSummary = document.getElementById('finish-summary');
const glassContainer = document.querySelector('.glass-container');
const toggleMiniBtn = document.getElementById('toggle-mini');
const bgImg = document.querySelector('.bg-img');
const focusQuote = document.getElementById('focus-quote');

const quotes = [
    "“专注是你最大的力量。”",
    "“心不偏。志必坚。”",
    "“静下来，深呼吸，做对的事。”",
    "“不要等待机会，而要创造机会。”",
    "“你的自律，终将成就你的自由。”",
    "“把每一件平凡的事情做好就是不平凡。”",
    "“成功的秘诀在于永不改变的目标。”",
    "“书山有路勤为径，学海无涯苦作舟。”",
    "“不积跬步，无以至千里。”",
    "“锲而不舍，金石可镂。”",
    "“此时此刻，全力以赴。”",
    "“时间留给有准备的人。”",
    "“自律是解决人生问题的主要工具。”",
    "“所谓天才，不过是长久的忍耐。”",
    "“与其焦虑，不如行动。”",
    "“你现在的努力，是为了以后有选择的权利。”",
    "“专注当下，结果自然会发生。”",
    "“每一次努力，都在拉开你与平庸的距离。”",
    "“慢就是快，稳就是准。”",
    "“心之所向，无所不能。”"
];

function updateQuote(immediate = false) {
    if (!focusQuote) return;
    const randomIndex = Math.floor(Math.random() * quotes.length);
    if (immediate) {
        focusQuote.textContent = quotes[randomIndex];
        focusQuote.style.opacity = '0.8';
    } else {
        focusQuote.style.opacity = '0';
        setTimeout(() => {
            focusQuote.textContent = quotes[randomIndex];
            focusQuote.style.opacity = '0.8';
        }, 500);
    }
}

// Background Logic
async function applyBackground(path, save = true) {
    if (!path) return;
    bgImg.src = path;

    // Update UI selection
    document.querySelectorAll('.bg-preset').forEach(el => {
        el.classList.toggle('active', el.dataset.path === path);
    });

    if (save && window.pywebview) {
        const settings = await window.pywebview.api.get_settings();
        settings.background = path;
        await window.pywebview.api.save_settings(settings);
    }
}

async function removeCustomBg(e, path) {
    e.stopPropagation();
    if (!confirm('确定删除此自定义背景吗？')) return;

    if (window.pywebview) {
        const settings = await window.pywebview.api.get_settings();
        if (settings.customBackgrounds) {
            settings.customBackgrounds = settings.customBackgrounds.filter(bg => bg !== path);
            if (settings.background === path) {
                settings.background = 'background/bg.png'; // Fallback to default in subfolder
                applyBackground('background/bg.png', false);
            }
            await window.pywebview.api.save_settings(settings);

            // Delete the physical file
            await window.pywebview.api.delete_custom_background(path);

            renderBackgroundSelection();
        }
    }
}

function initBackgroundSelection() {
    // This is now handled by renderBackgroundSelection to support dynamic items
}
async function renderBackgroundSelection() {
    if (!window.pywebview) return;
    const settings = await window.pywebview.api.get_settings();
    const currentBg = settings.background || 'bg.png';
    const customBgs = settings.customBackgrounds || [];

    const grid = document.querySelector('.bg-selection-grid');
    if (!grid) return;

    // Static presets (moved to background/ folder)
    const staticPresets = [
        { path: 'background/bg.png', title: '默认' },
        { path: 'background/bg_forest.png', title: '森林' },
        { path: 'background/bg_workspace.png', title: '深夜书桌' },
        { path: 'background/bg_galaxy.png', title: '星系' },
        { path: 'background/bg_rain.png', title: '雨夜' },
        { path: 'background/bg_library.png', title: '图书馆' },
        { path: 'background/bg_sunrise.png', title: '日出' }
    ];

    let html = staticPresets.map(p => `
        <div class="bg-preset ${p.path === currentBg ? 'active' : ''}" data-path="${p.path}" title="${p.title}" onclick="applyBackground('${p.path}')">
            <img src="${p.path}" alt="${p.title}">
        </div>
    `).join('');

    // Custom presets
    html += customBgs.map(path => `
        <div class="bg-preset ${path === currentBg ? 'active' : ''} custom-item" data-path="${path}" onclick="applyBackground('${path}')">
            <img src="${path}" alt="自定义">
            <button class="delete-bg-btn" onclick="removeCustomBg(event, '${path}')">×</button>
        </div>
    `).join('');

    // Add button
    html += `
        <div id="custom-bg-trigger" class="bg-preset custom" title="从文件选择背景">
            <span>+</span>
        </div>
    `;

    grid.innerHTML = html;

    // Re-bind custom trigger
    const customTrigger = document.getElementById('custom-bg-trigger');
    if (customTrigger) {
        customTrigger.onclick = async () => {
            const path = await window.pywebview.api.pick_background();
            if (path) {
                const updatedSettings = await window.pywebview.api.get_settings();
                if (!updatedSettings.customBackgrounds) updatedSettings.customBackgrounds = [];
                if (!updatedSettings.customBackgrounds.includes(path)) {
                    updatedSettings.customBackgrounds.push(path);
                }
                updatedSettings.background = path;
                await window.pywebview.api.save_settings(updatedSettings);
                applyBackground(path, false);
                renderBackgroundSelection();
            }
        };
    }
}


// Categories Logic
let categoryConfig = {}; // Will be loaded from file
let selectedMainCat = "";

async function saveCategoryConfig() {
    if (window.pywebview && window.pywebview.api) {
        await window.pywebview.api.save_categories(categoryConfig);
    }
}

const mainCatSelector = document.getElementById('main-cat-selector');


const mainCat = {
    get value() {
        return selectedMainCat;
    },
    set value(v) {
        selectedMainCat = v;
        renderMainCategories();
        updateSubCatUI(true);
    },
    set disabled(v) {
        mainCatSelector.classList.toggle('disabled', v);
        mainCatSelector.style.opacity = v ? '0.5' : '1';
        mainCatSelector.style.pointerEvents = v ? 'none' : 'all';
    }
};

const subCat = setupCustomDropdown('sub-category', (v) => {
    updateGoalsDisplay();
    pushDataToMini();
});

function updateSubCatUI(resetToTop = false) {
    const data = categoryConfig[selectedMainCat] || { subs: ["默认"], hiddenSubs: [] };
    const allSubs = data.subs || ["默认"];
    const hiddenSubs = data.hiddenSubs || [];

    // Filter out hidden subs for the main dropdown
    const displaySubs = allSubs.filter(s => !hiddenSubs.includes(s));

    // Fallback if all subs are hidden
    const subs = displaySubs.length > 0 ? displaySubs : (allSubs.includes("默认") ? ["默认"] : [allSubs[0]]);

    if (resetToTop) {
        subCat.value = subs[0];
    }

    // Populate custom menu
    const optionsHtml = subs.map(s => `
        <div class="dropdown-item ${s === subCat.value ? 'active' : ''}" data-value="${s}">
            ${s}
        </div>
    `).join('');
    subCat.refreshOptions(optionsHtml);

    document.getElementById('sub-category-container').style.display = 'flex';
    updateGoalsDisplay(true);
    pushDataToMini();
}

// Custom dropdown logic handled by setupCustomDropdown


const goalsDisplay = document.getElementById('goals-display');

goalsDisplay.onclick = (e) => {
    if (isFocusing) return;
    const item = e.target.closest('.goal-item');
    if (!item || item.classList.contains('completed')) return;

    const mins = item.getAttribute('data-rem');
    if (mins) {
        minsInput.value = mins;
        // Always apply countdown mode when clicking "Goal Remaining"
        modeControl.value = 'countdown';

        // Visual feedback on the input
        minsInput.classList.add('mode-change-pop');
        setTimeout(() => minsInput.classList.remove('mode-change-pop'), 400);
    }
};

let goalBaseStats = {
    main: 0,
    sub: 0,
    allTodayDetailed: [],
    lastFetch: 0,
    allLastFetch: 0,
    scopeMain: '',
    scopeSub: ''
};

function getSubGoalNamesInOrder(config) {
    const subGoals = (config && config.subGoals) ? config.subGoals : {};
    const ordered = [];
    const seen = new Set();

    const subs = (config && Array.isArray(config.subs)) ? config.subs : [];
    subs.forEach((name) => {
        if (Object.prototype.hasOwnProperty.call(subGoals, name)) {
            ordered.push(name);
            seen.add(name);
        }
    });

    Object.keys(subGoals).forEach((name) => {
        if (!seen.has(name)) ordered.push(name);
    });

    return ordered;
}

async function updateTodayGoalsView(forceFetch = false) {
    const container = document.getElementById('today-goals-view');
    const cardsContainer = document.getElementById('goals-cards-container');
    if (!container || !cardsContainer || !window.pywebview) return;

    // Collect all goals (main and sub)
    const goalsList = [];
    Object.keys(categoryConfig).forEach(mainCatName => {
        const config = categoryConfig[mainCatName];
        if (config.hidden) return;

        // Add main goal if exists
        if (config.goal > 0) {
            goalsList.push({
                type: 'main',
                name: mainCatName,
                goalMins: config.goal,
                mainCat: mainCatName
            });
        }

        // Add sub goals if exist
        if (config.subGoals) {
            getSubGoalNamesInOrder(config).forEach(subCatName => {
                const subGoalMins = config.subGoals[subCatName];
                const isHiddenSub = config.hiddenSubs && config.hiddenSubs.includes(subCatName);
                if (subGoalMins > 0 && !isHiddenSub && subCatName !== '默认') {
                    goalsList.push({
                        type: 'sub',
                        name: subCatName,
                        goalMins: subGoalMins,
                        mainCat: mainCatName
                    });
                }
            });
        }
    });

    if (goalsList.length === 0) {
        container.style.display = 'none';
        return;
    }

    container.style.display = 'block';

    const now = Date.now();
    if (now - goalBaseStats.allLastFetch > 30000 || forceFetch || !isFocusing) {
        const allStats = await window.pywebview.api.get_all_today_stats();
        goalBaseStats.allTodayDetailed = allStats;
        goalBaseStats.allLastFetch = now;
    }

    // 1. Calculate stats for all goals first
    const shouldCountLiveSession = isFocusing && !(routine.active && routineIsRest());
    const enrichedGoals = goalsList.map(goal => {
        const goalSecs = goal.goalMins * 60;
        const internalMap = { "学业": "study", "价格行为学": "pa", "看书": "reading" };
        const mainInternalKey = internalMap[goal.mainCat] || goal.mainCat;

        let doneSecs = 0;
        if (goal.type === 'main') {
            goalBaseStats.allTodayDetailed.forEach(row => {
                if (row.main === goal.mainCat || row.main === mainInternalKey) {
                    doneSecs += row.total;
                }
            });
        } else {
            goalBaseStats.allTodayDetailed.forEach(row => {
                const sameMain = (row.main === goal.mainCat || row.main === mainInternalKey);
                if (sameMain && row.sub === goal.name) {
                    doneSecs += row.total;
                }
            });
        }

        let isActive = false;
        if (shouldCountLiveSession && goal.mainCat === selectedMainCat) {
            if (goal.type === 'main') {
                isActive = true;
                doneSecs += sessionDuration;
            } else if (goal.name === subCat.value) {
                isActive = true;
                doneSecs += sessionDuration;
            }
        }

        const rawPercentage = (doneSecs / (goalSecs || 1)) * 100;
        const percentage = rawPercentage.toFixed(1);
        const barWidth = Math.min(100, rawPercentage).toFixed(1);

        const isCompleted = doneSecs >= goalSecs && goalSecs > 0;
        const remMins = Math.ceil((goalSecs - doneSecs) / 60);

        return { ...goal, doneSecs, goalSecs, isCompleted, percentage, barWidth, remMins, isActive };
    });

    // 2. Sort: Unfinished first, Completed last
    enrichedGoals.sort((a, b) => {
        if (a.isCompleted !== b.isCompleted) {
            return a.isCompleted ? 1 : -1;
        }
        return 0; // Keep relative order (categoryConfig order)
    });

    // 3. Render sorted list
    let html = '';
    enrichedGoals.forEach(goal => {
        html += `
            <div class="goal-card ${goal.isCompleted ? 'completed' : ''} ${goal.isActive ? 'active' : ''} ${goal.type}" 
                 style="cursor: pointer;"
                 data-main="${goal.mainCat}" 
                 data-sub="${goal.type === 'sub' ? goal.name : ''}"
                 data-rem="${goal.remMins > 0 ? goal.remMins : ''}">
                <div class="goal-card-header">
                    <span class="goal-card-title">${goal.type === 'sub' ? `<span class="sub-label">(${goal.mainCat})</span> ` : ''}${goal.name}</span>
                    <span class="goal-card-time">${formatSeconds(goal.doneSecs)} / ${formatSeconds(goal.goalSecs)}</span>
                </div>
                <div class="goal-progress-container">
                    <div class="goal-progress-bar" style="width: ${goal.barWidth}%"></div>
                </div>
                <div class="goal-percentage">${goal.percentage}% ${goal.isCompleted ? '✓' : ''}</div>
            </div>
        `;
    });

    cardsContainer.innerHTML = html;
}

// Add click listener for the new goals cards
document.getElementById('goals-cards-container').onclick = (e) => {
    if (isFocusing) return;
    const card = e.target.closest('.goal-card');
    if (!card) return;

    const main = card.dataset.main;
    const sub = card.dataset.sub;
    const rem = card.dataset.rem;

    // 1. Switch category
    if (main && categoryConfig[main]) {
        selectedMainCat = main;
        renderMainCategories();

        if (sub) {
            subCat.value = sub;
            updateSubCatUI(false);
        } else {
            updateSubCatUI(true);
        }
    }

    // 点击卡片：滚动到顶部
    window.scrollTo({ top: 0, behavior: 'smooth' });
    updateGoalsDisplay();
};

// 为今日目标标题添加点击返回顶部
const goalsHeader = document.querySelector('.goals-view-header');
if (goalsHeader) {
    goalsHeader.style.cursor = 'pointer';
    goalsHeader.onclick = () => {
        // 点击标题：滚动到底部
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    };
}

async function updateGoalsDisplay(forceFetch = false) {
    if (!goalsDisplay || !window.pywebview) return;

    const mCat = selectedMainCat;
    const sCat = subCat.value;

    const mainGoalMins = categoryConfig[mCat]?.goal || 0;
    const subGoalMins = categoryConfig[mCat]?.subGoals?.[sCat] || 0;

    if (mainGoalMins === 0 && (subGoalMins === 0 || sCat === '默认')) {
        goalsDisplay.innerHTML = '';
        goalBaseStats.lastFetch = 0;
        goalBaseStats.scopeMain = '';
        goalBaseStats.scopeSub = '';
        // Even if the current category has no goal, the global "今日目标进度" section
        // should still reflect goals from other categories.
        await updateTodayGoalsView(forceFetch);
        return;
    }

    const now = Date.now();
    const scopeChanged = goalBaseStats.scopeMain !== mCat || goalBaseStats.scopeSub !== sCat;
    if (now - goalBaseStats.lastFetch > 30000 || forceFetch || !isFocusing || scopeChanged) {
        const todayStats = await window.pywebview.api.get_pie_stats(null, 'today');
        const todaySubStats = await window.pywebview.api.get_pie_stats(mCat, 'today');
        let mDone = 0;
        todayStats.forEach(d => {
            if (d.label === mCat || d.label === { "study": "学业", "pa": "价格行为学", "reading": "看书" }[mCat]) mDone += d.total;
        });
        let sDone = 0;
        todaySubStats.forEach(d => {
            if (d.label === sCat) sDone += d.total;
        });
        goalBaseStats.main = mDone;
        goalBaseStats.sub = sDone;
        goalBaseStats.lastFetch = now;
        goalBaseStats.scopeMain = mCat;
        goalBaseStats.scopeSub = sCat;
    }

    const shouldCountLiveSession = isFocusing && !(routine.active && routineIsRest());
    const mTotal = goalBaseStats.main + (shouldCountLiveSession ? sessionDuration : 0);
    const sTotal = goalBaseStats.sub + (shouldCountLiveSession ? sessionDuration : 0);

    if (mainGoalMins > 0) {
        const rem = Math.max(0, mainGoalMins * 60 - mTotal);
        let el = document.getElementById('main-goal-item');
        if (!el) {
            goalsDisplay.insertAdjacentHTML('afterbegin', `<div id="main-goal-item" class="goal-item"></div>`);
            el = document.getElementById('main-goal-item');
        }
        if (rem <= 0) {
            el.innerHTML = `<span class="remaining">目标已完成</span>`;
            el.classList.add('completed');
            el.removeAttribute('data-rem');
        } else {
            el.innerHTML = `目标剩余: <span class="remaining">${formatSeconds(rem)}</span>`;
            el.classList.remove('completed');
            el.setAttribute('data-rem', Math.ceil(rem / 60)); // Store minutes
        }
    } else document.getElementById('main-goal-item')?.remove();

    if (subGoalMins > 0 && sCat !== '默认') {
        const rem = Math.max(0, subGoalMins * 60 - sTotal);
        let el = document.getElementById('sub-goal-item');
        if (!el) {
            goalsDisplay.insertAdjacentHTML('beforeend', `<div id="sub-goal-item" class="goal-item"></div>`);
            el = document.getElementById('sub-goal-item');
        }
        if (rem <= 0) {
            el.innerHTML = `<span class="remaining">目标已完成</span>`;
            el.classList.add('completed');
            el.removeAttribute('data-rem');
        } else {
            el.innerHTML = `目标剩余: <span class="remaining">${formatSeconds(rem)}</span>`;
            el.classList.remove('completed');
            el.setAttribute('data-rem', Math.ceil(rem / 60)); // Store minutes
        }
    } else document.getElementById('sub-goal-item')?.remove();

    // Also update the full today goals view
    updateTodayGoalsView(forceFetch);
}

function formatSeconds(secs) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}


// Initial update
renderMainCategories();
updateSubCatUI();


const mainCatListSettings = document.getElementById('settings-main-cat-list');
const subCatListSettings = document.getElementById('settings-sub-cat-list');
const addMainCatBtn = document.getElementById('add-main-cat');
const addSubCatBtnSettings = document.getElementById('add-sub-cat');

let settingsSelectedMain = selectedMainCat;

function renderMainCategories() {
    const keys = Object.keys(categoryConfig).filter(key => !categoryConfig[key].hidden);
    if (keys.length === 0) {
        mainCatSelector.innerHTML = '<span class="no-cats">请在设置中开启分类</span>';
        return;
    }

    if (!selectedMainCat || !categoryConfig[selectedMainCat] || categoryConfig[selectedMainCat].hidden) {
        selectedMainCat = keys[0];
    }

    mainCatSelector.innerHTML = keys.map(name =>
        `<button class="segment ${name === selectedMainCat ? 'active' : ''}" data-value="${name}">${name}</button>`
    ).join('');

    // Re-bind clicks
    mainCatSelector.querySelectorAll('.segment').forEach(btn => {
        btn.onclick = () => {
            if (isFocusing) return;
            selectedMainCat = btn.dataset.value;
            renderMainCategories();
            updateSubCatUI(true);
        };
    });
}

function renderSettingsMainCats() {
    mainCatListSettings.innerHTML = Object.keys(categoryConfig).map(name => {
        const isHidden = categoryConfig[name].hidden;
        const goal = categoryConfig[name].goal || 0;
        return `
            <div class="cat-item ${name === settingsSelectedMain ? 'selected' : ''} ${isHidden ? 'hidden' : ''}" 
                 draggable="true" 
                 data-name="${name}"
                 onclick="selectSettingsMain('${name}')">
                <span class="cat-item-name">${name}</span>
                <div class="cat-item-goal">
                    <input type="number" class="mini-input cat-goal-input" value="${goal}" placeholder="分" title="设置完成目标 (分钟)" onclick="event.stopPropagation()" onchange="saveMainCatGoal(event, '${name}')">
                </div>
                <div class="cat-item-actions">
                    <button class="tiny-icon-btn ${isHidden ? 'dim' : ''}" onclick="toggleCategoryVisibility(event, '${name}')" title="${isHidden ? '显示' : '隐藏'}">
                        ${isHidden
                ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>'
                : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>'}
                    </button>
                    <button class="tiny-icon-btn" onclick="renameMainCat(event, '${name}')">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                    </button>
                    <button class="tiny-icon-btn danger" onclick="deleteMainCat(event, '${name}')">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                    </button>
                </div>
            </div>
        `;
    }).join('');
    initDragAndDrop(mainCatListSettings, 'main');
    renderSettingsSubCats();
}

window.toggleCategoryVisibility = async (e, name) => {
    e.stopPropagation();
    categoryConfig[name].hidden = !categoryConfig[name].hidden;
    await saveCategoryConfig();
    renderSettingsMainCats();
    renderMainCategories();
    updateSubCatUI();
};

function renderSettingsSubCats() {
    const data = categoryConfig[settingsSelectedMain] || { subs: [], subGoals: {}, hiddenSubs: [] };
    const subs = data.subs || [];
    const subGoals = data.subGoals || {};
    const hiddenSubs = data.hiddenSubs || [];

    subCatListSettings.innerHTML = subs.map(name => {
        const isHidden = hiddenSubs.includes(name);
        return `
            <div class="cat-item ${isHidden ? 'hidden' : ''}" draggable="true" data-name="${name}">
                <span class="cat-item-name">${name}</span>
                <div class="cat-item-goal">
                    <input type="number" class="mini-input sub-goal-input" value="${subGoals[name] || 0}" placeholder="分" title="设置完成目标 (分钟)" onchange="saveSubCatGoal(event, '${name}')">
                </div>
                <div class="cat-item-actions">
                    <button class="tiny-icon-btn ${isHidden ? 'dim' : ''}" onclick="toggleSubCategoryVisibility(event, '${name}')" title="${isHidden ? '显示' : '隐藏'}">
                        ${isHidden
                ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>'
                : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>'}
                    </button>
                    <button class="tiny-icon-btn" onclick="renameSubCat(event, '${name}')">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                    </button>
                    <button class="tiny-icon-btn danger" onclick="deleteSubCat(event, '${name}')">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                    </button>
                </div>
            </div>
        `;
    }).join('');
    initDragAndDrop(subCatListSettings, 'sub');
}

window.toggleSubCategoryVisibility = async (e, name) => {
    e.stopPropagation();
    const config = categoryConfig[settingsSelectedMain];
    if (!config.hiddenSubs) config.hiddenSubs = [];

    if (config.hiddenSubs.includes(name)) {
        config.hiddenSubs = config.hiddenSubs.filter(s => s !== name);
    } else {
        config.hiddenSubs.push(name);
    }

    await saveCategoryConfig();
    renderSettingsSubCats();
    updateSubCatUI(false);
};

function initDragAndDrop(container, type) {
    let dragSrcEl = null;

    container.querySelectorAll('.cat-item').forEach(item => {
        item.addEventListener('dragstart', (e) => {
            dragSrcEl = item;
            item.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
        });

        item.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';

            const targetItem = e.target.closest('.cat-item');
            if (targetItem && targetItem !== dragSrcEl) {
                const rect = targetItem.getBoundingClientRect();
                const next = (e.clientY - rect.top) / (rect.bottom - rect.top) > 0.5;
                container.insertBefore(dragSrcEl, next ? targetItem.nextSibling : targetItem);
            }
        });

        item.addEventListener('dragend', async () => {
            item.classList.remove('dragging');

            // Re-calc order based on DOM
            const newOrder = Array.from(container.querySelectorAll('.cat-item')).map(el => el.dataset.name);

            if (type === 'main') {
                const newConfig = {};
                newOrder.forEach(key => {
                    newConfig[key] = categoryConfig[key];
                });
                categoryConfig = newConfig;
                await saveCategoryConfig();
                renderMainCategories();
            } else {
                categoryConfig[settingsSelectedMain].subs = newOrder;
                await saveCategoryConfig();
                updateSubCatUI();
                updateTodayGoalsView();
            }
        });
    });
}

window.selectSettingsMain = (name) => {
    settingsSelectedMain = name;
    renderSettingsMainCats();
};

window.saveMainCatGoal = async (e, name) => {
    const val = parseInt(e.target.value) || 0;
    categoryConfig[name].goal = val;
    await saveCategoryConfig();
    updateGoalsDisplay();
};

window.saveSubCatGoal = async (e, name) => {
    const val = parseInt(e.target.value) || 0;
    if (!categoryConfig[settingsSelectedMain].subGoals) {
        categoryConfig[settingsSelectedMain].subGoals = {};
    }
    categoryConfig[settingsSelectedMain].subGoals[name] = val;
    await saveCategoryConfig();
    updateGoalsDisplay();
};


window.renameMainCat = async (e, oldName) => {
    e.stopPropagation();
    const newName = prompt('重命名大类:', oldName);
    if (newName && newName !== oldName) {
        if (categoryConfig[newName]) return alert('分类已存在');

        // Sync DB
        if (window.pywebview && window.pywebview.api) {
            await window.pywebview.api.rename_category_data(oldName, newName);
        }

        categoryConfig[newName] = categoryConfig[oldName];
        delete categoryConfig[oldName];
        if (selectedMainCat === oldName) selectedMainCat = newName;
        if (settingsSelectedMain === oldName) settingsSelectedMain = newName;
        await saveCategoryConfig();
        renderMainCategories();
        renderSettingsMainCats();
    }
};

window.deleteMainCat = async (e, name) => {
    e.stopPropagation();
    if (Object.keys(categoryConfig).length <= 1) return alert('至少保留一个分类');

    const msg = `确定删除大类 "${name}" 吗？\n\n警告：此操作将【永久删除】该分类下所有的历史专注记录，且不可恢复！`;
    if (confirm(msg)) {
        // 1. Delete session data from DB
        if (window.pywebview && window.pywebview.api) {
            await window.pywebview.api.delete_category_data(name);
        }

        // 2. Delete from config
        delete categoryConfig[name];
        if (selectedMainCat === name) selectedMainCat = Object.keys(categoryConfig)[0];
        if (settingsSelectedMain === name) settingsSelectedMain = Object.keys(categoryConfig)[0];

        await saveCategoryConfig();
        renderMainCategories();
        renderSettingsMainCats();
        updateSubCatUI(true);
    }
};

window.renameSubCat = async (e, oldName) => {
    e.stopPropagation();
    if (oldName === '默认') return alert('默认分类不可重命名');
    const newName = prompt('重命名子分类:', oldName);
    if (newName && newName !== oldName) {
        const trimmed = String(newName).trim();
        if (!trimmed || trimmed === oldName) return;

        const config = categoryConfig[settingsSelectedMain] || {};
        const subs = config.subs || [];
        if (subs.includes(trimmed)) return alert('Sub-category already exists');

        // Sync DB
        if (window.pywebview && window.pywebview.api) {
            await window.pywebview.api.rename_category_data(settingsSelectedMain, settingsSelectedMain, oldName, trimmed);
        }

        const idx = subs.indexOf(oldName);
        if (idx > -1) {
            subs[idx] = trimmed;

            if (config.subGoals && Object.prototype.hasOwnProperty.call(config.subGoals, oldName)) {
                config.subGoals[trimmed] = config.subGoals[oldName];
                delete config.subGoals[oldName];
            }

            if (Array.isArray(config.hiddenSubs)) {
                const hiddenIdx = config.hiddenSubs.indexOf(oldName);
                if (hiddenIdx > -1) config.hiddenSubs[hiddenIdx] = trimmed;
            }

            if (selectedMainCat === settingsSelectedMain && subCat.value === oldName) {
                subCat.value = trimmed;
            }

            await saveCategoryConfig();
            renderSettingsSubCats();
            updateSubCatUI();
        }
    }
};

window.deleteSubCat = async (e, name) => {
    e.stopPropagation();
    if (name === '默认') return alert('默认分类不可删除');
    if (confirm(`确定删除子分类 "${name}" 吗？`)) {
        categoryConfig[settingsSelectedMain].subs = categoryConfig[settingsSelectedMain].subs.filter(s => s !== name);
        await saveCategoryConfig();
        renderSettingsSubCats();
        updateSubCatUI();
    }
};

addMainCatBtn.onclick = async () => {
    const name = prompt('新增大类名称:');
    if (name) {
        if (categoryConfig[name]) return alert('分类已存在');
        categoryConfig[name] = { subs: ["默认"], hidden: false };
        await saveCategoryConfig();
        renderMainCategories();
        renderSettingsMainCats();
    }
};

addSubCatBtnSettings.onclick = async () => {
    const name = prompt(`为 "${settingsSelectedMain}" 新增子分类:`);
    if (name) {
        if (categoryConfig[settingsSelectedMain].subs.includes(name)) return alert('子分类已存在');
        categoryConfig[settingsSelectedMain].subs.push(name);
        await saveCategoryConfig();
        renderSettingsSubCats();
        updateSubCatUI();
    }
};

// Mode Toggling
// Mode Toggling
const modeIconTrigger = document.getElementById('mode-icon-trigger');

function updateModeIcon() {
    const iconCountdown = modeIconTrigger.querySelector('.icon-countdown');
    const iconStopwatch = modeIconTrigger.querySelector('.icon-stopwatch');
    if (mode === 'countdown') {
        iconCountdown.style.display = 'block';
        iconStopwatch.style.display = 'none';
        modeIconTrigger.title = "切换至正计时";
    } else {
        iconCountdown.style.display = 'none';
        iconStopwatch.style.display = 'block';
        modeIconTrigger.title = "切换至倒计时";
    }
}

const modeControl = {
    get value() { return mode; },
    set value(v) {
        if (isFocusing) return;

        mode = v;
        updateModeIcon();

        if (mode === 'countdown') {
            countdownPicker.classList.remove('hidden');
            resetTimerDisplay();
        } else {
            countdownPicker.classList.add('hidden');
            timerBox.textContent = '00:00';
            seconds = 0;
        }

        // Add a "pop" animation to the timer text
        timerBox.classList.add('mode-change-pop');
        setTimeout(() => {
            timerBox.classList.remove('mode-change-pop');
        }, 400);
    },
    set disabled(v) {
        modeIconTrigger.style.pointerEvents = v ? 'none' : 'all';
        modeIconTrigger.style.opacity = v ? '0.5' : '1';
    }
};

modeIconTrigger.onclick = () => {
    modeControl.value = (mode === 'countdown' ? 'stopwatch' : 'countdown');
};
// Initial render
updateModeIcon();

// Initialize
window.addEventListener('pywebviewready', async () => {
    const todaySecs = await window.pywebview.api.get_today_total();
    dailyTotalSeconds = todaySecs;
    updateDailyDisplay();

    // Load Categories from file
    let loadedConfig = await window.pywebview.api.get_categories();

    if (!loadedConfig) {
        loadedConfig = {
            "2025冬季学期": { subs: ["默认", "数学", "英语"], hidden: false },
            "价格行为学": { subs: ["默认"], hidden: false },
            "看书": { subs: ["默认"], hidden: false }
        };
    }

    // Ensure all items are in the new format: { subs: [], hidden: bool, hiddenSubs: [] }
    Object.keys(loadedConfig).forEach(key => {
        if (Array.isArray(loadedConfig[key])) {
            loadedConfig[key] = {
                subs: loadedConfig[key],
                hidden: false,
                hiddenSubs: []
            };
        }
        if (!loadedConfig[key].hiddenSubs) {
            loadedConfig[key].hiddenSubs = [];
        }
    });

    categoryConfig = loadedConfig;
    await saveCategoryConfig(); // Ensure it's on disk

    // UI Sync
    renderMainCategories();
    updateSubCatUI(true);
    renderStatsFilters();

    // Load Settings (Hotkey, Timezone etc)
    const settings = await window.pywebview.api.get_settings();
    if (settings.hotkey) {
        currentHotkey = settings.hotkey;
    }

    // Default: auto-open mini window on app start (can be disabled via settings.json)
    if (settings.openMiniOnStart === undefined) {
        settings.openMiniOnStart = true;
        window.pywebview.api.save_settings(settings);
    }

    // Prefer file settings; fall back to localStorage; otherwise default to Germany (UTC+1).
    const storedTz = localStorage.getItem(LOCAL_TZ_KEY);
    const initialTz = settings.timezone || storedTz || 'UTC+1';
    timezone.value = initialTz;

    // Sync Mini Effect
    if (settings.miniEffect) {
        miniEffect.value = settings.miniEffect;
    } else {
        miniEffect.value = "webgl-liquid"; // Default
    }

    // Sync hotkey on startup
    window.pywebview.api.update_hotkey(currentHotkey);
    hotkeyInput.value = currentHotkey.toUpperCase();

    // Load Background
    if (settings.background) {
        let bgToApply = settings.background;

        applyBackground(bgToApply, false);

        // Ensure current custom background is in the custom list if it's not a default one
        const staticPresets = [
            'background/bg.png',
            'background/bg_forest.png',
            'background/bg_workspace.png',
            'background/bg_galaxy.png',
            'background/bg_rain.png',
            'background/bg_library.png',
            'background/bg_sunrise.png'
        ];
        if (!staticPresets.includes(bgToApply)) {
            if (!settings.customBackgrounds) settings.customBackgrounds = [];
            if (!settings.customBackgrounds.includes(bgToApply)) {
                settings.customBackgrounds.push(bgToApply);
                window.pywebview.api.save_settings(settings);
            }
        }
    }

    // Initial random quote
    updateQuote(true);

    // Sync Fonts
    // New unified setting 'appFont'
    if (settings.appFont) {
        appFont.value = settings.appFont;
        document.documentElement.style.setProperty('--body-font', settings.appFont);
        document.documentElement.style.setProperty('--timer-font', settings.appFont);
    } else {
        appFont.value = "'Outfit'";
        document.documentElement.style.setProperty('--body-font', "'Outfit'");
        document.documentElement.style.setProperty('--timer-font', "'Outfit'");
    }

    // Sync Glass Blur
    if (settings.glassBlur !== undefined) {
        glassBlurSlider.value = settings.glassBlur;
        blurValueDisplay.textContent = settings.glassBlur + 'px';
        document.documentElement.style.setProperty('--glass-blur', settings.glassBlur + 'px');
    }

    // Auto-open mini window after initial UI/settings sync
    if (settings.openMiniOnStart) {
        window.pywebview.api.toggle_mini_window();
        setTimeout(pushDataToMini, 500);
    }
});

// Old select onchange handlers removed in favor of setupCustomDropdown logic

glassBlurSlider.oninput = () => {
    const val = glassBlurSlider.value;
    blurValueDisplay.textContent = val + 'px';
    document.documentElement.style.setProperty('--glass-blur', val + 'px');
};

glassBlurSlider.onchange = async () => {
    const val = parseInt(glassBlurSlider.value);
    if (window.pywebview) {
        const settings = await window.pywebview.api.get_settings();
        settings.glassBlur = val;
        await window.pywebview.api.save_settings(settings);
    }
};

// Settings Logic
openSettingsBtn.onclick = () => {
    settingsOverlay.classList.add('active');
    renderSettingsMainCats();
    renderBackgroundSelection();
};
closeSettingsBtn.onclick = () => settingsOverlay.classList.remove('active');

const recordedKeys = new Set();
/**
 * Render Stats Filters based on categoryConfig
 */
function renderStatsFilters() {
    const mainFilterMenu = document.getElementById('stat-filter-main-menu');
    if (!mainFilterMenu) return;

    // Preserve 'All' item
    let html = '<div class="dropdown-item" data-value="">全部大类</div>';

    // Add actual categories
    Object.keys(categoryConfig).forEach(name => {
        if (!categoryConfig[name].hidden) {
            html += `<div class="dropdown-item" data-value="${name}">${name}</div>`;
        }
    });

    statMainFilter.refreshOptions(html);
}
hotkeyInput.onkeydown = (e) => {
    e.preventDefault();
    const key = e.key.toLowerCase();
    if (['control', 'alt', 'shift', 'meta'].includes(key)) {
        recordedKeys.add(key === 'control' ? 'ctrl' : key);
    } else {
        const modifiers = Array.from(recordedKeys);
        const finalHotkey = modifiers.length > 0 ? modifiers.join('+') + '+' + key : key;
        hotkeyInput.value = finalHotkey.toUpperCase();
        recordedKeys.clear();
    }
};

hotkeyInput.onmousedown = (e) => {
    // Buttons: 0:Left, 1:Middle, 2:Right, 3:X1, 4:X2
    if (e.button === 3 || e.button === 4) {
        e.preventDefault();
        const mouseKey = e.button === 3 ? 'MOUSE_X1' : 'MOUSE_X2';
        hotkeyInput.value = mouseKey;
        recordedKeys.clear();
    }
};

hotkeyInput.onkeyup = () => recordedKeys.clear();

saveHotkeyBtn.onclick = async () => {
    const newHotkey = hotkeyInput.value.toLowerCase();
    if (!newHotkey) return;
    const res = await window.pywebview.api.update_hotkey(newHotkey);
    if (res === true) {
        currentHotkey = newHotkey;
        // Save to file via API, preserving existing settings (timezone etc).
        const settings = await window.pywebview.api.get_settings();
        settings.hotkey = currentHotkey;
        await window.pywebview.api.save_settings(settings);
        alert('快捷键设置成功！');
    } else {
        alert('设置失败: ' + res);
    }
};

clearDbBtn.onclick = async () => {
    if (confirm('警告：这将永久删除所有专注记录！确定要清空吗？')) {
        const res = await window.pywebview.api.clear_database();
        if (res) {
            alert('数据库已清空。');
            dailyTotalSeconds = 0;
            updateDailyDisplay();
            if (focusChart) updateChart();
        }
    }
};

function resetTimerState() {
    if (mode === 'countdown') {
        const mins = minsInput.value || 25;
        seconds = mins * 60;
    } else {
        seconds = 0;
    }
}

function resetTimerDisplay() {
    resetTimerState();
    updateTimerDisplay();
}

minsInput.oninput = () => {
    if (!isFocusing) resetTimerDisplay();
};

// Timer Logic
function startTimer(opts = null) {
    isFocusing = true;
    isPaused = false;
    isFinishing = false;
    pauseCount = 0;
    sessionActiveTotalSeconds = 0;
    document.body.classList.add('is-focusing');
    document.body.classList.add('timer-active');
    mainBtn.classList.add('active');
    mainBtn.classList.remove('paused');
    btnText.textContent = '暂停专注';

    focusStartTimestamp = Date.now();
    sessionStartTimestamp = focusStartTimestamp;
    sessionDuration = 0;
    const seedSessionId = (opts && typeof opts === 'object') ? opts.seedSessionId : null;
    currentSessionId = (typeof seedSessionId === 'string' && seedSessionId.trim()) ? seedSessionId : generateSessionId();
    hideFinishSummary();

    // Lock categories
    mainCat.disabled = true;
    subCat.disabled = true;

    // Lock mode switch
    modeControl.disabled = true;

    // Hide input picker during focus
    countdownPicker.classList.add('hidden');

    // Only set seconds if we haven't started yet (not resuming)
    if (seconds === 0 && mode === 'stopwatch') {
        seconds = 0;
    } else if (mode === 'countdown' && !timer) {
        // If first start of countdown (ROUTINE may pre-seed `seconds`)
        if (!routine.active || !seconds) {
            seconds = minsInput.value * 60;
        }
    }

    // Clear any pending revert timeouts from previous finishes
    if (finishRevertTimeout) {
        clearTimeout(finishRevertTimeout);
        finishRevertTimeout = null;
    }
    // Force reset styles in case we were mid-fade
    timerBox.style.opacity = '';
    timerBox.style.filter = '';
    timerBox.style.transform = '';

    updateTimerDisplay(); // Clear '专注完成' immediately on start
    timerBox.classList.remove('finished');
    modeIconTrigger.classList.remove('force-hidden');
    pushDataToMini();

    // Start Python-side heartbeat to bypass window throttling
    if (window.pywebview && window.pywebview.api) {
        window.pywebview.api.start_heartbeat();
    }

    // We still keep a local "visual" interval, but pythonTick will be the primary driver
    timer = setInterval(() => {
        // This is just a backup/visual update if python is slow
        // pythonTick will do the actual heavy lifting
        updateTimerLogic();
    }, 1000);
    pushDataToMini();

    // Force refresh goal cards to show 'active' state immediately
    updateGoalsDisplay(true);
}

let finishRevertTimeout;

function updateTimerLogic(allowAutoFinish = true) {
    if (!isFocusing || isPaused || isFinishing || routine.isTransitioning) return;

    const now = Date.now();

    const elapsedSinceLastStart = Math.floor((now - focusStartTimestamp) / 1000);

    // We update sessionDuration based on actual elapsed time
    const newSessionDuration = lastSavedSessionDuration + elapsedSinceLastStart;

    // Check if we need to update state
    if (newSessionDuration > sessionDuration) {
        const diff = newSessionDuration - sessionDuration;

        if (mode === 'countdown') {
            seconds -= diff;
        } else {
            seconds += diff;
        }

        // Clamp countdown at 0 to avoid briefly showing negative values (e.g. after delays/restore).
        if (mode === 'countdown' && seconds < 0) seconds = 0;

        sessionDuration = newSessionDuration;

        // In ROUTINE rest segments, we do not count time into focus score or daily totals.
        const isRoutineRest = routine.active && routineIsRest();
        if (!isRoutineRest) {
            sessionActiveTotalSeconds += diff;
            dailyTotalSeconds += diff;
        }

        updateTimerDisplay();
        if (!isRoutineRest) updateDailyDisplay();
        pushDataToMini();
        updateGoalsDisplay();

        if (mode === 'countdown' && seconds <= 0) {
            seconds = 0;
            updateTimerDisplay();
            pushDataToMini();
            if (routine.active) {
                // ROUTINE: focus -> short summary -> rest countdown (or next segment)
                if (routine.isTransitioning) return;
                const item = routineCurrentItem();
                if (item && item.type === 'focus') {
                    saveSessionToDB('end');
                    routinePlayFocusSummaryThen(() => routineAdvanceToNextSegment());
                    return;
                }
                routineAdvanceToNextSegment();
                return;
            }

            if (allowAutoFinish) {
                finishTimer();
                return;
            }
        }

        // Cycle quote every minute
        if (sessionDuration > 0 && sessionDuration % 60 === 0) {
            updateQuote();
        }
    }
}

// Global hook for Python heartbeat
let lastSavedSessionDuration = 0;
window.pythonTick = function () {
    updateTimerLogic();
};

function pauseTimer() {
    updateTimerLogic(); // Flush latest seconds before saving
    if (!(routine.active && routineIsRest())) pauseCount += 1;
    isPaused = true;
    if (!(routine.active && routineIsRest())) saveSessionToDB('pause'); // Save the current segment before pausing
    if (routine.active && routineIsRest()) {
        // For rest segments we don't persist, so keep the accumulator to avoid a "frozen" timer on resume.
        lastSavedSessionDuration = sessionDuration;
    } else {
        // Focus segments are persisted on pause; reset accumulator for the next segment.
        lastSavedSessionDuration = 0;
    }
    document.body.classList.add('is-paused');
    mainBtn.classList.add('paused');
    btnText.textContent = routine.active && routineIsRest() ? '继续休息' : '继续专注';
    pushDataToMini();
    updateGoalsDisplay(true); // Immediate UI refresh to show new totals

    // ROUTINE: while in a focus segment, show the floating status bar after a short delay when pausing.
    if (routine.active && !routineIsRest()) {
        routineScheduleStatusBarForFocusPause(true, true);
    }
}

function resumeTimer() {
    isPaused = false;
    focusStartTimestamp = Date.now(); // Reset start time for the current segment
    document.body.classList.remove('is-paused');
    mainBtn.classList.remove('paused');
    btnText.textContent = routine.active && routineIsRest() ? '暂停休息' : '暂停专注';
    pushDataToMini();

    // ROUTINE: while in a focus segment, hide the floating status bar after a short delay when resuming.
    if (routine.active && !routineIsRest()) {
        routineScheduleStatusBarForFocusPause(false, false);
    }
}

function finishTimer(isAuto = true) {
    if (isFinishing) return;

    // Manual finish can happen between ticks; flush once to avoid losing the last chunk.
    // Suppress auto-finish inside the flush to prevent recursion/double-save.
    if (!isAuto && isFocusing && !isPaused) {
        updateTimerLogic(false);
    }

    isFinishing = true;
    if (timer) {
        clearInterval(timer);
        timer = null;
    }

    // Stop Python-side heartbeat immediately to avoid extra ticks during the finish animation.
    if (window.pywebview && window.pywebview.api) {
        window.pywebview.api.stop_heartbeat();
    }
    saveSessionToDB('end');

    // If the session ended automatically, bring the main window to the front (best-effort).
    if (
        isAuto &&
        window.pywebview &&
        window.pywebview.api &&
        typeof window.pywebview.api.bring_main_to_front === 'function'
    ) {
        window.pywebview.api.bring_main_to_front();
    }

    // Phase 1: Fade out numerical timer
    timerBox.style.opacity = '0';
    timerBox.style.transform = 'scale(0.95)';
    timerBox.style.filter = 'blur(10px)';
    timerBox.style.transition = 'all 0.5s cubic-bezier(0.4, 0, 0.2, 1)';

    setTimeout(() => {
        // Phase 2: Switch to finished text and trigger animation
        timerBox.textContent = '专注完成';
        timerBox.classList.add('finished');
        modeIconTrigger.classList.add('force-hidden');
        timerBox.style.opacity = '';
        timerBox.style.transform = '';
        timerBox.style.filter = '';

        resetEverything(false, true); // Don't save again, preserve the '专注完成' text
        showFinishSummary();

        // Revert back to time after 12 seconds (Main Window Only)
        if (finishRevertTimeout) clearTimeout(finishRevertTimeout);
        finishRevertTimeout = setTimeout(() => {
            // Phase 3: Smooth fade out before reverting
            timerBox.style.opacity = '0';
            timerBox.style.filter = 'blur(10px)';
            timerBox.style.transform = 'scale(0.95)';

            setTimeout(() => {
                hideFinishSummary();
                timerBox.classList.remove('finished');
                modeIconTrigger.classList.remove('force-hidden');
                resetTimerDisplay();
                isFinishing = false;
                // Phase 4: Fade back in with default styles
                timerBox.style.opacity = '';
                timerBox.style.filter = '';
                timerBox.style.transform = '';
            }, 600);
        }, 5000);
    }, 500);
}

function resetEverything(shouldSave = true, preserveText = false) {
    if (shouldSave && isFocusing) {
        if (!isPaused) updateTimerLogic();
        saveSessionToDB('end');
    }

    isFocusing = false;
    isPaused = false;
    isFinishing = preserveText ? true : false;
    lastSavedSessionDuration = 0;
    if (timer) clearInterval(timer);
    timer = null;
    sessionDuration = 0;
    currentSessionId = null;

    if (!preserveText) {
        sessionStartTimestamp = 0;
        sessionActiveTotalSeconds = 0;
        pauseCount = 0;
    }

    // Stop Python-side heartbeat (idempotent)
    if (window.pywebview && window.pywebview.api) window.pywebview.api.stop_heartbeat();

    document.body.classList.remove('is-focusing');
    document.body.classList.remove('is-paused');
    document.body.classList.remove('timer-active');
    mainBtn.classList.remove('active');
    mainBtn.classList.remove('paused');
    btnText.textContent = '开始专注';
    resetTimerState(); // Reset seconds strictly now
    pushDataToMini();

    // Unlock categories
    mainCat.disabled = false;
    subCat.disabled = false;

    // Unlock mode switch
    modeControl.disabled = false;

    // Show input picker if in countdown mode
    if (mode === 'countdown') {
        if (preserveText) {
            countdownPicker.classList.remove('hidden');
        } else {
            countdownPicker.classList.remove('hidden');
        }
    }

    if (finishRevertTimeout) {
        clearTimeout(finishRevertTimeout);
        finishRevertTimeout = null;
    }
    // Reset styles (but don't touch the completion UI if we are preserving "专注完成")
    timerBox.style.opacity = '';
    timerBox.style.filter = '';
    timerBox.style.transform = '';
    timerBox.classList.remove('finished');

    if (!preserveText) {
        updateTimerDisplay();
        pushDataToMini();
        modeIconTrigger.classList.remove('force-hidden');
    }

    // Refresh goal cards to remove 'active' state and sync latest data
    updateGoalsDisplay(true);
}

function saveSessionToDB(reason = null) {
    // ROUTINE rest segments are display-only and should never be persisted.
    if (routine.active && routineIsRest()) {
        sessionDuration = 0;
        return;
    }
    if (!window.pywebview || !window.pywebview.api || !currentSessionId) {
        sessionDuration = 0;
        return;
    }

    // Allow an explicit 'end' marker even if this last segment is 0 seconds (e.g. ended while paused).
    if (sessionDuration < 1 && reason !== 'end') {
        sessionDuration = 0;
        return;
    }

    const mCat = mainCat.value;
    const sCat = subCat.value; // Store the actual selected sub-category for any main category

    let startTs = Math.floor(focusStartTimestamp / 1000);
    let endTs = startTs + Math.max(0, sessionDuration);
    if (sessionDuration === 0 && reason === 'end') {
        endTs = Math.floor(Date.now() / 1000);
        startTs = endTs;
    }

    window.pywebview.api.save_session(
        mCat,
        sCat,
        sessionDuration,
        currentSessionId,
        startTs,
        endTs,
        reason
    );

    sessionDuration = 0;
}

function showFinishSummary() {
    if (!finishSummary) return;

    const elapsedSeconds = sessionStartTimestamp
        ? Math.max(1, Math.floor((Date.now() - sessionStartTimestamp) / 1000))
        : 1;
    const focusScore = Math.max(0, Math.min(1, sessionActiveTotalSeconds / elapsedSeconds));
    const scorePct = Math.round(focusScore * 100);

    finishSummary.textContent = `暂停 ${pauseCount} 次 · 专注度 ${scorePct}%`;
    finishSummary.classList.remove('hidden');

    if (countdownPicker) {
        countdownPicker.classList.add('finish-mode');
        countdownPicker.classList.remove('hidden');
    }
}

function hideFinishSummary() {
    if (!finishSummary) return;
    finishSummary.classList.add('hidden');
    finishSummary.textContent = '';

    if (countdownPicker) countdownPicker.classList.remove('finish-mode');

    if (countdownPicker) {
        if (isFocusing) countdownPicker.classList.add('hidden');
        else if (mode === 'countdown') countdownPicker.classList.remove('hidden');
        else countdownPicker.classList.add('hidden');
    }
}

// Stats UI Logic
const showStats = async () => {
    statsOverlay.classList.add('active');

    // Dynamic populate stats filters
    const currentMainFilter = statMainFilter.value;
    statMainFilter.innerHTML = '<option value="">全部大类</option>' +
        Object.keys(categoryConfig).map(name => {
            const val = name; // Use actual name to avoid mapping issues
            return `<option value="${val}">${name}</option>`;
        }).join('');
    statMainFilter.value = currentMainFilter;

    // Use requestAnimationFrame to let the DOM visibility/layout settle 
    // before Chart.js tries to calculate container dimension.
    requestAnimationFrame(() => {
        updateChart();
    });
};
openStatsBtn.onclick = () => {
    showStats();
    renderTimeRangeSelector();
};

function renderTimeRangeSelector() {
    const cont = document.getElementById('stat-time-range');
    if (!cont) return;

    cont.querySelectorAll('.segment').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.range === selectedStatsRange);
        btn.onclick = async () => {
            selectedStatsRange = btn.dataset.range;
            setStatsDrill(null);
            renderTimeRangeSelector();
            await updateChart();
        };
    });
}

closeStatsBtn.onclick = () => {
    statsOverlay.classList.remove('active');
};

// Old stat filter onchange handlers removed in favor of setupCustomDropdown logic

async function updateChart() {
    if (!window.pywebview) return;

    renderStatsDrillBreadcrumb();

    // Show pie if:
    // 1. No main category selected (shows big cat distribution)
    // 2. A main category is selected but no specific sub-cat selected (shows sub-cat distribution)
    // AND only if there's more than 1 sub-category to show.
    const selectedMain = statMainFilter.value;
    const selectedSub = statSubFilter.value;
    let showPie = false;

    if (!selectedMain) {
        showPie = true;
    } else if (!selectedSub) {
        const subs = categoryConfig[selectedMain]?.subs || [];
        if (subs.length > 1) {
            showPie = true;
        }
    }

    const pieContainer = document.querySelector('.canvas-container.pie');
    const lineContainer = document.querySelector('.canvas-container.line');
    const distContainer = document.querySelector('.canvas-container.distribution');

    if (showPie) {
        pieContainer.style.display = 'block';
    } else {
        pieContainer.style.display = 'none';
    }

    const drill = getStatsDrillPayload();
    const isHourlyView = selectedStatsRange === 'today' || (selectedStatsRange === 'all' && drill?.level === 'day');

    // Hide distribution chart for hourly views because the main chart already shows hourly data
    if (isHourlyView) {
        if (distContainer.style.display !== 'none' && !distContainer.classList.contains('exit-animate')) {
            distContainer.classList.remove('appear-animate');
            distContainer.classList.add('exit-animate');
            if (distFadeTimeout) clearTimeout(distFadeTimeout);
            distFadeTimeout = setTimeout(() => {
                distContainer.style.display = 'none';
                distContainer.classList.remove('exit-animate');
                distFadeTimeout = null;
            }, 500); // Match CSS fadeOut duration
        }
    } else {
        if (distFadeTimeout) {
            clearTimeout(distFadeTimeout);
            distFadeTimeout = null;
        }
        const wasHidden = distContainer.style.display === 'none' || distContainer.classList.contains('exit-animate');
        distContainer.classList.remove('exit-animate');
        distContainer.style.display = 'block';
        if (wasHidden) {
            // Force reflow to ensure the animation can restart if needed
            void distContainer.offsetWidth;
            distContainer.classList.add('appear-animate');
        }
    }

    // Give the browser a moment to apply the display change
    await new Promise(r => setTimeout(r, 0));

    // Update Line Chart
    const lineData = await window.pywebview.api.get_stats(
        statMainFilter.value || null,
        statSubFilter.value || null,
        selectedStatsRange,
        drill
    );

    const labels = lineData.map(d => d.date);
    const yDivisor = isHourlyView ? 60 : 3600; // minutes for hourly line, hours otherwise
    const yUnit = isHourlyView ? '分钟' : '小时';
    const totals = lineData.map(d => Number(((d.total || 0) / yDivisor).toFixed(2)));

    // Calculate and display stats total
    const totalSeconds = lineData.reduce((acc, curr) => acc + curr.total, 0);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    statTotalTime.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    void updateWeightedFocusSummary();

    const ctx = document.getElementById('focus-chart').getContext('2d');
    if (focusChart) focusChart.destroy();

    // Create a gradient for the main chart
    const lineGradient = ctx.createLinearGradient(0, 0, 0, 400);
    lineGradient.addColorStop(0, 'rgba(99, 102, 241, 0.4)'); // Indigo pulse
    lineGradient.addColorStop(1, 'rgba(99, 102, 241, 0)');   // Fade to transparent

    const canDrill = selectedStatsRange === 'all' && (!drill || drill.level === 'month');
    const isValidMonthKey = (k) => typeof k === 'string' && /^\d{4}-\d{2}$/.test(k);
    const isValidDayKey = (k) => typeof k === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(k);

    focusChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: `专注时长 (${yUnit})`,
                data: totals,
                borderColor: '#6366f1',
                backgroundColor: lineGradient,
                borderWidth: 3,
                tension: 0.4,
                fill: 'origin',
                pointBackgroundColor: '#fff',
                pointRadius: 4,
                pointHitRadius: 12,
                pointHoverRadius: 7
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: {
                    beginAtZero: true,
                    grid: { color: 'rgba(255,255,255,0.1)' },
                    ticks: { color: 'rgba(255,255,255,0.7)' }
                },
                x: {
                    grid: { display: false },
                    ticks: { color: 'rgba(255,255,255,0.7)' }
                }
            },
            onHover: (event, elements, chart) => {
                if (!canDrill) {
                    chart.canvas.style.cursor = 'default';
                    return;
                }
                chart.canvas.style.cursor = elements && elements.length ? 'pointer' : 'default';
            },
            onClick: async (_event, elements) => {
                if (!canDrill) return;
                if (!elements || elements.length < 1) return;

                const idx = elements[0].index;
                const key = labels[idx];

                if (!drill && isValidMonthKey(key)) {
                    setStatsDrill({ level: 'month', key });
                    await updateChart();
                    return;
                }

                if (drill?.level === 'month' && isValidDayKey(key)) {
                    setStatsDrill({ level: 'day', key });
                    await updateChart();
                }
            },
            plugins: {
                legend: { labels: { color: '#fff' } }
            }
        }
    });

    // Update Pie Chart if needed
    if (showPie) {
        await updatePieChart(selectedStatsRange, drill);
    }

    // Always update distribution chart
    await updateDistributionChart(selectedStatsRange, drill);
}

async function updateWeightedFocusSummary() {
    if (!statFocusScore) return;

    const api = window.pywebview?.api;
    if (!api || typeof api.get_weighted_focus_score !== 'function') {
        statFocusScore.textContent = '--';
        if (statFocusDetails) statFocusDetails.textContent = '';
        return;
    }

    const requestId = ++focusScoreRequestId;
    // Don't clear text to avoid layout jump, just dim it
    statFocusScore.style.opacity = '0.5';
    if (statFocusDetails) statFocusDetails.style.opacity = '0.5';

    try {
        const res = await api.get_weighted_focus_score(
            statMainFilter.value || null,
            statSubFilter.value || null,
            selectedStatsRange,
            getStatsDrillPayload()
        );

        if (requestId !== focusScoreRequestId) return;

        const focusScore = Math.max(0, Math.min(1, Number(res?.focus_score ?? 0)));
        const pct = Math.round(focusScore * 100);
        statFocusScore.textContent = `${pct}%`;
        statFocusScore.style.opacity = '1';

        if (statFocusDetails) {
            statFocusDetails.textContent = '';
            statFocusDetails.style.opacity = '1';
        }
    } catch {
        if (requestId !== focusScoreRequestId) return;
        statFocusScore.textContent = '--';
        statFocusScore.style.opacity = '1';
        if (statFocusDetails) {
            statFocusDetails.textContent = '';
            statFocusDetails.style.opacity = '1';
        }
    }
}

async function updatePieChart(timeRange, drill) {
    const pieData = await window.pywebview.api.get_pie_stats(statMainFilter.value || null, timeRange, drill);

    const labels = pieData.map(d => d.label);
    const rawHours = pieData.map(d => (Number(d.total || 0) / 3600));
    // Keep raw values for the chart so tiny totals (e.g. 10s = 0.0028h) don't round to 0 and disappear.
    const totals = rawHours;

    const ctxPie = document.getElementById('focus-pie-chart').getContext('2d');
    if (focusPieChart) focusPieChart.destroy();

    focusPieChart = new Chart(ctxPie, {
        type: 'doughnut', // Use doughnut for a more modern look
        data: {
            labels: labels,
            datasets: [{
                data: totals,
                backgroundColor: [
                    'rgba(99, 102, 241, 0.7)',
                    'rgba(168, 85, 247, 0.7)',
                    'rgba(236, 72, 153, 0.7)',
                    'rgba(244, 63, 94, 0.7)',
                    'rgba(16, 185, 129, 0.7)',
                    'rgba(59, 130, 246, 0.7)'
                ],
                borderColor: 'rgba(255, 255, 255, 0.1)',
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: { color: '#fff', padding: 20 }
                },
                title: {
                    display: true,
                    text: (statMainFilter.value ? '子学科分布' : '大类分布') + ' (小时)',
                    color: '#fff',
                    font: { size: 14 }
                },
                tooltip: {
                    callbacks: {
                        label: (context) => {
                            const label = context.label || '';
                            const hoursRaw = Number(rawHours?.[context.dataIndex] ?? context.parsed ?? context.raw ?? 0);
                            const hoursShown = hoursRaw > 0 && hoursRaw < 0.01 ? 0.01 : hoursRaw;
                            const formatted = hoursShown.toFixed(2);
                            return `${label}: ${formatted} 小时`;
                        }
                    }
                }
            },
            cutout: '60%' // Doughnut hole size
        }
    });
}

async function updateDistributionChart(timeRange, drill) {
    // --- Distribution Chart (24h) ---
    const distData = await window.pywebview.api.get_hourly_distribution(
        statMainFilter.value || null,
        statSubFilter.value || null,
        timeRange,
        drill
    );

    const distLabels = distData.map(d => d.hour);
    const distTotals = distData.map(d => Number((d.total / 3600).toFixed(2))); // Use hours for distribution

    const distCtx = document.getElementById('distribution-chart').getContext('2d');
    if (distributionChart) distributionChart.destroy();

    // Create a gradient for the distribution chart
    const distGradient = distCtx.createLinearGradient(0, 0, 0, 400);
    distGradient.addColorStop(0, 'rgba(168, 85, 247, 0.4)'); // Purple
    distGradient.addColorStop(1, 'rgba(99, 102, 241, 0)');   // Indigo

    distributionChart = new Chart(distCtx, {
        type: 'line',
        data: {
            labels: distLabels,
            datasets: [{
                label: '24小时专注时间分布 (小时)',
                data: distTotals,
                borderColor: '#a855f7',
                backgroundColor: distGradient,
                borderWidth: 3,
                tension: 0.4,
                fill: 'origin',
                pointBackgroundColor: '#fff',
                pointRadius: 2,
                pointHoverRadius: 6,
                borderCapStyle: 'round'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: {
                    beginAtZero: true,
                    grid: { color: 'rgba(255,255,255,0.05)' },
                    ticks: {
                        color: 'rgba(255,255,255,0.6)',
                        font: { size: 10 }
                    }
                },
                x: {
                    grid: { display: false },
                    ticks: {
                        color: 'rgba(255,255,255,0.6)',
                        font: { size: 10 },
                        maxRotation: 0,
                        autoSkip: true,
                        maxTicksLimit: 12
                    }
                }
            },
            plugins: {
                legend: {
                    display: true,
                    labels: {
                        color: 'rgba(255,255,255,0.8)',
                        font: { size: 12, weight: '600' }
                    }
                },
                tooltip: {
                    backgroundColor: 'rgba(0, 0, 0, 0.8)',
                    titleColor: '#fff',
                    bodyColor: '#fff',
                    padding: 10,
                    cornerRadius: 8,
                    displayColors: false
                }
            }
        }
    });
}

// Drill breadcrumb click handling
document.addEventListener('click', async (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.closest('.custom-dropdown')) return;

    const crumb = target.closest('#stats-drill-breadcrumb .crumb-link');
    if (!crumb) return;

    const action = crumb.dataset.action;
    if (action === 'root') {
        setStatsDrill(null);
        await updateChart();
        return;
    }

    if (action === 'to-month') {
        const month = crumb.dataset.month;
        if (month) {
            setStatsDrill({ level: 'month', key: month });
            await updateChart();
        }
    }
});

function updateTimerDisplay() {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;

    if (h > 0) {
        timerBox.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    } else {
        timerBox.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
}

function updateDailyDisplay() {
    const h = Math.floor(dailyTotalSeconds / 3600);
    const m = Math.floor((dailyTotalSeconds % 3600) / 60);
    const s = dailyTotalSeconds % 60;
    dailyTimeDisplay.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function safeResyncTodayTotalFromDB(minValue = null) {
    const min = Number.isFinite(minValue) ? minValue : null;

    if (
        !window.pywebview ||
        !window.pywebview.api ||
        typeof window.pywebview.api.get_today_total !== 'function'
    ) {
        return;
    }

    try {
        window.pywebview.api.get_today_total().then((secs) => {
            const v = parseInt(secs, 10);
            if (!Number.isFinite(v)) return;
            // Avoid UI rollback if DB hasn't committed the last saved segment yet.
            if (min !== null && v < min) return;
            dailyTotalSeconds = v;
            updateDailyDisplay();
        }).catch(() => { });
    } catch { }
}

function pushDataToMini() {
    if (window.pywebview && window.pywebview.api) {
        const isRoutineRest = routine.active && routineIsRest();
        const data = {
            time: timerBox.textContent,
            mainCat: isRoutineRest ? '休息中' : (selectedMainCat || "未分类"),
            subCat: isRoutineRest ? '默认' : (subCat.value || "默认"),
            isPaused: isPaused || !isFocusing,
            isFinished: timerBox.classList.contains('finished'),
            mode: mode,
            miniEffect: miniEffect.value,
            appFont: appFont.value
        };
        window.pywebview.api.update_mini_data(data);
    }
}

toggleMiniBtn.onclick = () => {
    if (window.pywebview && window.pywebview.api) {
        window.pywebview.api.toggle_mini_window();
        // Initial push after a small delay to ensure window is ready
        setTimeout(pushDataToMini, 500);
    }
};

mainBtn.onclick = () => {
    if (routine.isTransitioning) return;
    if (!isFocusing) {
        startTimer();
    } else {
        if (isPaused) {
            resumeTimer();
        } else {
            pauseTimer();
        }
    }
};

let resetConfirmTimeout;

function syncResetBtnForRoutine() {
    if (!resetBtn) return;
    if (routine.active) {
        resetBtn.title = '结束ROUTINE';
        if (resetConfirmTextEl) resetConfirmTextEl.textContent = '结束ROUTINE?';
    } else {
        resetBtn.title = '完成专注并记录';
        if (resetConfirmTextEl) resetConfirmTextEl.textContent = '确定结束?';
    }
}

resetBtn.onclick = () => {
    if (!isFocusing) return;

    // Check if already in confirming state
    if (resetBtn.classList.contains('confirming')) {
        // Confirmed!
        if (routine.active) {
            routineEndEarlyWithTransition();
        } else {
            finishTimer(false);
        }
        clearTimeout(resetConfirmTimeout);
        resetBtn.classList.remove('confirming');
    } else {
        // Enter confirming state
        resetBtn.classList.add('confirming');

        // Auto-revert after 3 seconds
        if (resetConfirmTimeout) clearTimeout(resetConfirmTimeout);
        resetConfirmTimeout = setTimeout(() => {
            resetBtn.classList.remove('confirming');
        }, 3000);
    }
};

// Hotkey interface
window.toggleFocusFromHotkey = () => {
    mainBtn.click();
};

// Background movement logic removed in favor of CSS animations

// Routine Total Duration Logic
const routineTotalTimeDisplay = document.getElementById('routine-total-time-display');
const routineFocusTimeDisplay = document.getElementById('routine-focus-time-display');

function calculateRoutineStats() {
    const rows = routineItemsList.querySelectorAll('.routine-item-row');
    let totalMinutes = 0;
    let focusMinutes = 0;

    rows.forEach((row, index) => {
        const durationInput = row.querySelector('input:nth-of-type(1)');
        const restInput = row.querySelector('input:nth-of-type(2)');

        const duration = parseInt(durationInput?.value, 10) || 0;
        const rest = parseInt(restInput?.value, 10) || 0;

        focusMinutes += duration;
        totalMinutes += duration;

        // Add rest time only if it's NOT the last item
        if (index < rows.length - 1) {
            totalMinutes += rest;
        }
    });

    return { total: totalMinutes, focus: focusMinutes };
}

function formatDuration(minutes) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    let text = '';
    if (h > 0) text += `${h}小时`;
    if (m > 0 || minutes === 0) text += `${m}分钟`;
    return text;
}

function updateRoutineTotalDisplay() {
    const stats = calculateRoutineStats();

    if (routineTotalTimeDisplay) {
        routineTotalTimeDisplay.textContent = formatDuration(stats.total);
    }
    if (routineFocusTimeDisplay) {
        routineFocusTimeDisplay.textContent = formatDuration(stats.focus);
    }
}

// Hook into routine item changes
let originalAddRoutineItemFn = addRoutineItem;
addRoutineItem = function (main, sub, duration, rest) {
    originalAddRoutineItemFn(main, sub, duration, rest);
    // The new item is the last child
    const newRow = routineItemsList.lastElementChild;
    if (newRow) {
        const inputs = newRow.querySelectorAll('input');
        inputs.forEach(input => {
            input.addEventListener('input', updateRoutineTotalDisplay);
        });

        // The delete button is the last child of the row
        const delBtn = newRow.querySelector('.icon-btn.danger');
        if (delBtn) {
            const originalOnclick = delBtn.onclick;
            delBtn.onclick = () => {
                // Execute original logic (removal)
                if (originalOnclick) originalOnclick();
                // Then update stats
                updateRoutineTotalDisplay();
            }
        }
    }
    updateRoutineTotalDisplay();
};

// Initial update when opening routine
const originalOpenRoutineBtnOnClick = openRoutineBtn.onclick;
openRoutineBtn.onclick = () => {
    if (originalOpenRoutineBtnOnClick) originalOpenRoutineBtnOnClick();
    updateRoutineTotalDisplay();
};

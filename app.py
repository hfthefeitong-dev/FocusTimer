import webview
import os
import sys
import sqlite3
import json
import threading
import shutil
import tempfile
from datetime import datetime, date, timedelta, timezone
import time
import ctypes
from ctypes import wintypes

# File Paths
CAT_FILE = 'categories.json'
SETTINGS_FILE = 'settings.json'
DB_PATH = 'focus_data.db'

main_window = None
mini_window = None
MINI_WINDOW_WIDTH = 230
MINI_WINDOW_HEIGHT = 100

def _connect_db():
    """
    Centralized SQLite connection helper.
    - Adds a small busy timeout to reduce transient 'database is locked' errors.
    - Keeps per-call connections (pywebview may invoke API methods on worker threads).
    """
    conn = sqlite3.connect(DB_PATH, timeout=5)
    try:
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute("PRAGMA foreign_keys=ON")
    except Exception:
        pass
    return conn

# Windows taskbar separate identity setup
APP_ID = u'antigravity.focus.v1'
try:
    if os.name == 'nt':
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(APP_ID)
except Exception as e:
    print(f"Error setting AppID: {e}")

def set_window_icon(window_title, icon_path):
    """Sets the window icon using Win32 API."""
    if os.name != 'nt' or not os.path.exists(icon_path):
        return
        
    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    
    # Constants
    WM_SETICON = 0x0080
    ICON_SMALL = 0
    ICON_BIG = 1
    LR_LOADFROMFILE = 0x00000010
    IMAGE_ICON = 1
    
    # Standard sizes
    SM_CXSMICON = 49
    SM_CYSMICON = 50
    SM_CXICON = 11  
    SM_CYICON = 12

    def _apply_icon():
        hwnd = user32.FindWindowW(None, window_title)
        if hwnd:
            # Get system recommended sizes for small and big icons
            small_w = user32.GetSystemMetrics(SM_CXSMICON)
            small_h = user32.GetSystemMetrics(SM_CYSMICON)
            big_w = user32.GetSystemMetrics(SM_CXICON)
            big_h = user32.GetSystemMetrics(SM_CYICON)

            # Load small icon (16x16 usually)
            hicon_small = user32.LoadImageW(None, icon_path, IMAGE_ICON, small_w, small_h, LR_LOADFROMFILE)
            # Load big icon (32x32 usually)
            hicon_big = user32.LoadImageW(None, icon_path, IMAGE_ICON, big_w, big_h, LR_LOADFROMFILE)
            
            if hicon_small:
                user32.SendMessageW(hwnd, WM_SETICON, ICON_SMALL, hicon_small)
            if hicon_big:
                user32.SendMessageW(hwnd, WM_SETICON, ICON_BIG, hicon_big)
    
    # Retry a few times as window creation is async
    for delay in [0.5, 1.2, 2.5]:
        threading.Timer(delay, _apply_icon).start()

def hide_from_taskbar(window_title):
    """Adds WS_EX_TOOLWINDOW style to the window with the given title to hide it from taskbar."""
    if os.name != 'nt':
        return
        
    # Give the window a moment to be created by the OS, and retry a few times
    def _retry_hide(retries_left):
        if retries_left <= 0: return
        success = _apply_hide(window_title)
        if not success:
            threading.Timer(0.5, lambda: _retry_hide(retries_left - 1)).start()

    threading.Timer(0.5, lambda: _retry_hide(10)).start()

def _apply_hide(window_title):
    user32 = ctypes.windll.user32
    GWL_EXSTYLE = -20
    WS_EX_TOOLWINDOW = 0x00000080
    WS_EX_APPWINDOW = 0x00040000
    SWP_FRAMECHANGED = 0x0020
    SWP_NOMOVE = 0x0002
    SWP_NOSIZE = 0x0001
    SWP_NOZORDER = 0x0004
    SWP_NOACTIVATE = 0x0010
    
    hwnd = user32.FindWindowW(None, window_title)
    if hwnd:
        style = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
        # Remove APPWINDOW and add TOOLWINDOW
        new_style = (style & ~WS_EX_APPWINDOW) | WS_EX_TOOLWINDOW
        user32.SetWindowLongW(hwnd, GWL_EXSTYLE, new_style)
        # Force a frame change to refresh the taskbar
        user32.SetWindowPos(hwnd, 0, 0, 0, 0, 0, 
                           SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE)
        return True
    return False

def bring_window_to_front(window_title, keep_topmost_ms=200):
    """Best-effort: restore and bring the given window to the foreground (Windows only)."""
    if os.name != 'nt':
        return False

    user32 = ctypes.windll.user32

    SW_RESTORE = 9
    HWND_TOPMOST = -1
    HWND_NOTOPMOST = -2
    SWP_NOMOVE = 0x0002
    SWP_NOSIZE = 0x0001
    SWP_SHOWWINDOW = 0x0040

    try:
        hwnd = user32.FindWindowW(None, window_title)
        if not hwnd:
            return False

        user32.ShowWindow(hwnd, SW_RESTORE)

        def _attempt_activate():
            try:
                # Try to legally take foreground focus.
                fg = user32.GetForegroundWindow()
                if fg and fg != hwnd:
                    fg_thread = user32.GetWindowThreadProcessId(fg, None)
                    target_thread = user32.GetWindowThreadProcessId(hwnd, None)
                    if fg_thread and target_thread and fg_thread != target_thread:
                        user32.AttachThreadInput(fg_thread, target_thread, True)
                        user32.SetForegroundWindow(hwnd)
                        user32.BringWindowToTop(hwnd)
                        user32.SetActiveWindow(hwnd)
                        user32.SetFocus(hwnd)
                        user32.AttachThreadInput(fg_thread, target_thread, False)
                    else:
                        user32.SetForegroundWindow(hwnd)
                        user32.BringWindowToTop(hwnd)
                        user32.SetActiveWindow(hwnd)
                        user32.SetFocus(hwnd)
                else:
                    user32.SetForegroundWindow(hwnd)
                    user32.BringWindowToTop(hwnd)
                    user32.SetActiveWindow(hwnd)
                    user32.SetFocus(hwnd)

                # Ensure it's at the top of the TOPMOST band to avoid being covered by other topmost windows.
                user32.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW)
            except Exception:
                pass

        # Z-order/focus can be fickle; retry a couple times.
        for delay in [0.0, 0.1]:
            threading.Timer(delay, _attempt_activate).start()

        if keep_topmost_ms and keep_topmost_ms > 0:
            def _revert_notopmost():
                try:
                    user32.SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW)
                except Exception:
                    pass

            threading.Timer(keep_topmost_ms / 1000.0, _revert_notopmost).start()
        return True
    except Exception:
        return False

def _read_json_file(path, default):
    try:
        with open(path, 'r', encoding='utf-8-sig') as f:
            raw = f.read()
        if not raw.strip():
            return default
        return json.loads(raw)
    except FileNotFoundError:
        return default
    except Exception as e:
        print(f"Error loading {os.path.basename(path)}: {e}")
        return default

def _atomic_write_json(path, data):
    directory = os.path.dirname(os.path.abspath(path)) or os.getcwd()
    prefix = f"{os.path.basename(path)}."
    tmp_path = None

    try:
        fd, tmp_path = tempfile.mkstemp(prefix=prefix, suffix=".tmp", dir=directory, text=True)
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=4)
            f.flush()
            try:
                os.fsync(f.fileno())
            except Exception:
                pass
        os.replace(tmp_path, path)
        tmp_path = None
        return True
    finally:
        if tmp_path:
            try:
                os.remove(tmp_path)
            except Exception:
                pass

def _get_window_pos_by_title(window_title):
    """Returns (x, y) in screen coords for the window's top-left corner (Windows only)."""
    if os.name != 'nt':
        return None

    try:
        user32 = ctypes.windll.user32
        hwnd = user32.FindWindowW(None, window_title)
        if not hwnd:
            return None

        rect = wintypes.RECT()
        if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
            return None
        return int(rect.left), int(rect.top)
    except Exception:
        return None

def _get_virtual_screen_bounds():
    """Returns the virtual desktop bounds as (left, top, right, bottom)."""
    if os.name != 'nt':
        return None

    try:
        user32 = ctypes.windll.user32
        SM_XVIRTUALSCREEN = 76
        SM_YVIRTUALSCREEN = 77
        SM_CXVIRTUALSCREEN = 78
        SM_CYVIRTUALSCREEN = 79

        left = int(user32.GetSystemMetrics(SM_XVIRTUALSCREEN))
        top = int(user32.GetSystemMetrics(SM_YVIRTUALSCREEN))
        width = int(user32.GetSystemMetrics(SM_CXVIRTUALSCREEN))
        height = int(user32.GetSystemMetrics(SM_CYVIRTUALSCREEN))
        if width <= 0 or height <= 0:
            return None
        return left, top, left + width, top + height
    except Exception:
        return None

def _clamp_mini_window_position(x, y):
    """Keeps the mini window inside the current virtual desktop."""
    bounds = _get_virtual_screen_bounds()
    if not bounds:
        return int(x), int(y), False

    left, top, right, bottom = bounds
    max_x = max(left, right - MINI_WINDOW_WIDTH)
    max_y = max(top, bottom - MINI_WINDOW_HEIGHT)
    clamped_x = min(max(int(x), left), max_x)
    clamped_y = min(max(int(y), top), max_y)
    changed = clamped_x != int(x) or clamped_y != int(y)
    return clamped_x, clamped_y, changed

def _move_window_by_title(window_title, x, y):
    """Moves a window to (x, y) without changing size or z-order (Windows only)."""
    if os.name != 'nt':
        return False

    try:
        user32 = ctypes.windll.user32
        hwnd = user32.FindWindowW(None, window_title)
        if not hwnd:
            return False

        SWP_NOSIZE = 0x0001
        SWP_NOZORDER = 0x0004
        SWP_NOACTIVATE = 0x0010

        return bool(user32.SetWindowPos(hwnd, 0, int(x), int(y), 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE))
    except Exception:
        return False

def _persist_mini_window_position():
    pos = _get_window_pos_by_title('Focus Mini')
    if not pos:
        return

    x, y = pos
    settings = _read_json_file(SETTINGS_FILE, default={})
    if not isinstance(settings, dict):
        settings = {}

    settings['miniWindowPos'] = {'x': x, 'y': y}
    _atomic_write_json(SETTINGS_FILE, settings)

def _restore_mini_window_position():
    settings = _read_json_file(SETTINGS_FILE, default={})
    if not isinstance(settings, dict):
        return False

    pos = settings.get('miniWindowPos')
    if not isinstance(pos, dict):
        return False

    x = pos.get('x')
    y = pos.get('y')
    if not isinstance(x, int) or not isinstance(y, int):
        return False

    x, y, changed = _clamp_mini_window_position(x, y)
    moved = _move_window_by_title('Focus Mini', x, y)

    if moved and changed:
        settings['miniWindowPos'] = {'x': x, 'y': y}
        _atomic_write_json(SETTINGS_FILE, settings)

    return moved

def init_db():
    conn = _connect_db()
    cursor = conn.cursor()
    # Basic table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS focus_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT,
            main_cat TEXT,
            sub_cat TEXT,
            duration_seconds INTEGER,
            created_at_ts INTEGER,
            session_id TEXT,
            segment_start_ts INTEGER,
            segment_reason TEXT
        )
    ''')

    cursor.execute('CREATE INDEX IF NOT EXISTS idx_focus_sessions_ts ON focus_sessions(created_at_ts)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_focus_sessions_session_id ON focus_sessions(session_id)')
    conn.commit()
    conn.close()

class Api:
    def __init__(self):
        self.hotkey_handle = None
        self.heartbeat_active = False
        self.heartbeat_thread = None

    def bring_main_to_front(self, keep_topmost_ms=200):
        """Bring the main window to the foreground (best-effort)."""
        global main_window
        title = '专注 (Focus)'
        try:
            if main_window and getattr(main_window, 'title', None):
                title = main_window.title
        except Exception:
            pass

        try:
            if main_window:
                if hasattr(main_window, 'restore'):
                    main_window.restore()
                if hasattr(main_window, 'show'):
                    main_window.show()
                if hasattr(main_window, 'bring_to_front'):
                    main_window.bring_to_front()
        except Exception:
            pass

        try:
            keep_topmost_ms = int(keep_topmost_ms)
        except Exception:
            keep_topmost_ms = 200

        return bring_window_to_front(title, keep_topmost_ms=keep_topmost_ms)
        
    def get_categories(self):
        if os.path.exists(CAT_FILE):
            try:
                with open(CAT_FILE, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except Exception as e:
                print(f"Error loading categories: {e}")
        return None

    def save_categories(self, config):
        try:
            return _atomic_write_json(CAT_FILE, config)
        except Exception as e:
            print(f"Error saving categories: {e}")
            return str(e)

    def get_settings(self):
        settings = _read_json_file(SETTINGS_FILE, default={})
        return settings if isinstance(settings, dict) else {}

    def save_settings(self, settings):
        try:
            return _atomic_write_json(SETTINGS_FILE, settings)
        except Exception as e:
            print(f"Error saving settings: {e}")
            return str(e)

    def close_app(self):
        global main_window
        try:
            if main_window:
                main_window.destroy()
                return True
        except Exception as e:
            return str(e)
        return False

    def save_session(self, main_cat, sub_cat, duration, session_id=None, segment_start_ts=None, segment_end_ts=None, segment_reason=None):
        if duration is None:
            return
        try:
            duration = int(duration)
        except Exception:
            return

        # Ignore very short accidental sessions, but allow an explicit end marker (duration == 0).
        if duration < 1 and segment_reason != 'end':
            return

        try:
            segment_start_ts = int(segment_start_ts) if segment_start_ts is not None else None
        except Exception:
            segment_start_ts = None

        try:
            segment_end_ts = int(segment_end_ts) if segment_end_ts is not None else None
        except Exception:
            segment_end_ts = None

        if main_cat in ('阅读', '看书') and (sub_cat is None or str(sub_cat).strip() == '' or sub_cat == '默认'):
            sub_cat = '卡拉马佐夫兄弟'

        conn = _connect_db()
        cursor = conn.cursor()
        
        # Store in UTC as Unix epoch seconds (INTEGER). We treat this as the segment end time.
        created_at_ts = segment_end_ts if segment_end_ts is not None else int(time.time())
        # Derive date from UTC for the secondary 'date' column
        today_utc = datetime.fromtimestamp(created_at_ts, timezone.utc).date().isoformat()

        if segment_start_ts is None:
            segment_start_ts = created_at_ts - max(0, duration)
        
        cursor.execute('''
            INSERT INTO focus_sessions (
                date,
                main_cat,
                sub_cat,
                duration_seconds,
                created_at_ts,
                session_id,
                segment_start_ts,
                segment_reason
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ''', (today_utc, main_cat, sub_cat, duration, created_at_ts, session_id, segment_start_ts, segment_reason))
        conn.commit()
        conn.close()
        return True

    def clear_database(self):
        conn = _connect_db()
        cursor = conn.cursor()
        cursor.execute("DELETE FROM focus_sessions")
        conn.commit()
        conn.close()
        return True

    def delete_category_data(self, main_cat_name):
        conn = _connect_db()
        cursor = conn.cursor()
        cursor.execute("DELETE FROM focus_sessions WHERE main_cat = ?", (main_cat_name,))
        conn.commit()
        conn.close()
        return True

    def rename_category_data(self, old_main, new_main, old_sub=None, new_sub=None):
        conn = _connect_db()
        cursor = conn.cursor()
        if old_sub and new_sub:
            # Rename sub-category within a main category
            cursor.execute("""
                UPDATE focus_sessions 
                SET sub_cat = ? 
                WHERE main_cat = ? AND sub_cat = ?
            """, (new_sub, old_main, old_sub))
        else:
            # Rename main category
            cursor.execute("""
                UPDATE focus_sessions 
                SET main_cat = ? 
                WHERE main_cat = ?
            """, (new_main, old_main))
        conn.commit()
        conn.close()
        return True

    def update_hotkey(self, new_hotkey):
        """
        Setup global hotkey using pynput for both keyboard and mouse support.
        'new_hotkey' can be 'ctrl+alt+s' or 'mouse_x1', 'mouse_x2'.
        """
        try:
            from pynput import mouse, keyboard
            from pynput.keyboard import GlobalHotKeys
            
            # Stop existing listeners if any
            if hasattr(self, 'key_listener') and self.key_listener:
                self.key_listener.stop()
            if hasattr(self, 'mouse_listener') and self.mouse_listener:
                self.mouse_listener.stop()

            target = new_hotkey.lower()
            
            def trigger_action():
                if main_window:
                    main_window.evaluate_js('toggleFocusFromHotkey()')

            if target.startswith('mouse_x'):
                # Mouse side button listener
                is_x1 = 'x1' in target
                is_x2 = 'x2' in target
                
                def on_click(x, y, button, pressed):
                    if pressed:
                        if (is_x1 and str(button) == 'Button.x1') or (is_x2 and str(button) == 'Button.x2'):
                            trigger_action()

                self.mouse_listener = mouse.Listener(on_click=on_click)
                self.mouse_listener.start()
                print(f"Mouse hotkey set to: {target}")
            else:
                # Keyboard hotkey listener
                try:
                    # pynput GlobalHotKeys format: '<ctrl>+<alt>+s', '<f12>', etc.
                    parts = target.split('+')
                    formatted_hotkey = []
                    for p in parts:
                        p = p.strip()
                        # Mapping common variations to pynput canonical names
                        mapping = {
                            'meta': 'cmd',
                            'win': 'cmd',
                            'control': 'ctrl'
                        }
                        p = mapping.get(p, p)
                        
                        if len(p) > 1:
                            # Special keys and modifiers must be in angle brackets
                            formatted_hotkey.append(f'<{p}>')
                        else:
                            # Normal characters are raw
                            formatted_hotkey.append(p)
                    
                    final_combination = '+'.join(formatted_hotkey)
                    
                    self.key_listener = GlobalHotKeys({
                        final_combination: trigger_action
                    })
                    self.key_listener.start()
                    print(f"Keyboard hotkey set to: {final_combination}")
                except Exception as ke:
                    print(f"Keyboard setup error: {ke}")
                    return str(ke)

            return True
        except ImportError as ie:
            return f"导入失败: 请确保已安装 pynput ({ie})"
        except Exception as e:
            print(f"Hotkey setup failed: {e}")
            return str(e)

    def start_heartbeat(self):
        """Starts a Python-side heartbeat thread to drive the timer logic in JS."""
        if self.heartbeat_active:
            return
        
        self.heartbeat_active = True
        def _heartbeat_loop():
            while self.heartbeat_active:
                if main_window:
                    try:
                        # Call JS tick function
                        main_window.evaluate_js('window.pythonTick()')
                    except:
                        pass
                time.sleep(1)
        
        self.heartbeat_thread = threading.Thread(target=_heartbeat_loop, daemon=True)
        self.heartbeat_thread.start()

    def stop_heartbeat(self):
        """Stops the Python heartbeat thread."""
        self.heartbeat_active = False
        self.heartbeat_thread = None

    def get_user_offset(self):
        """Returns the UTC offset string like '+3600 seconds' or '-18000 seconds'"""
        settings = self.get_settings()
        tz_raw = settings.get('timezone', 'UTC+1')
        
        offset_hours = 0
        if tz_raw == 'system':
            # Calculate current system offset (includes DST when active).
            # Note: this is "current" offset; historical DST transitions are not modeled.
            try:
                offset_td = datetime.now().astimezone().utcoffset()
                offset_seconds = int(offset_td.total_seconds()) if offset_td else 0
            except Exception:
                offset_seconds = 0
            offset_hours = offset_seconds / 3600
        else:
            # Format: 'UTC+8' or 'UTC-5'
            try:
                offset_hours = float(tz_raw.replace('UTC', ''))
            except:
                offset_hours = 0
            
        # SQLite datetime doesn't like decimal hours (e.g. +8.0 hours)
        # Using seconds is safer and supports fractional timezones
        offset_total_seconds = int(offset_hours * 3600)
        sign = '+' if offset_total_seconds >= 0 else '-'
        return f"{sign}{abs(offset_total_seconds)} seconds", offset_hours

    def _get_user_timezone(self):
        _, offset_hours = self.get_user_offset()
        offset_total_seconds = int(offset_hours * 3600)
        return timezone(timedelta(seconds=offset_total_seconds)), offset_total_seconds

    def _get_user_now(self):
        user_tz, offset_total_seconds = self._get_user_timezone()
        user_now = datetime.now(timezone.utc).astimezone(user_tz)
        return user_now, user_tz, offset_total_seconds

    def _get_range_start_utc_ts(self, time_range, min_local_date=None):
        """
        Returns the UTC epoch seconds for the start boundary of the local date range.
        None means unbounded (time_range == 'all' and no min_local_date).
        """
        user_now, user_tz, _ = self._get_user_now()
        today_local = user_now.date()

        def local_midnight_to_utc_ts(local_date: date) -> int:
            local_midnight = datetime(local_date.year, local_date.month, local_date.day, tzinfo=user_tz)
            return int(local_midnight.astimezone(timezone.utc).timestamp())

        if min_local_date is not None:
            return local_midnight_to_utc_ts(min_local_date)
        if time_range == 'today':
            return local_midnight_to_utc_ts(today_local)
        if time_range == 'week':
            monday = (user_now - timedelta(days=user_now.weekday())).date()
            return local_midnight_to_utc_ts(monday)
        if time_range == 'month':
            first_day = user_now.replace(day=1).date()
            return local_midnight_to_utc_ts(first_day)
        return None

    def _query_sessions(
        self,
        filter_cat=None,
        filter_sub=None,
        time_range='all',
        include_categories=False,
        include_session_id=False,
        include_segment_start_ts=False,
        min_local_date=None,
    ):
        """
        Fetch raw sessions for downstream split-aggregation.
        Returns: (rows, offset_total_seconds, user_now, today_local)
        """
        conn = _connect_db()
        cursor = conn.cursor()

        offset_str, _ = self.get_user_offset()
        user_now, _, offset_total_seconds = self._get_user_now()
        today_local = user_now.date()

        where_clauses = []
        params = []

        start_utc_ts = self._get_range_start_utc_ts(time_range, min_local_date=min_local_date)

        if start_utc_ts is not None:
            where_clauses.append("created_at_ts >= ?")
            params.append(start_utc_ts)

        if filter_sub:
            where_clauses.append("main_cat = ? AND sub_cat = ?")
            params.extend([filter_cat, filter_sub])
        elif filter_cat:
            where_clauses.append("main_cat = ?")
            params.append(filter_cat)

        where_sql = ""
        if where_clauses:
            where_sql = " WHERE " + " AND ".join(where_clauses)

        select_cols = "created_at_ts, duration_seconds"
        if include_session_id:
            select_cols += ", session_id"
        if include_segment_start_ts:
            select_cols += ", segment_start_ts"
        if include_categories:
            select_cols += ", main_cat, sub_cat"

        cursor.execute(f"SELECT {select_cols} FROM focus_sessions{where_sql}", params)
        rows = cursor.fetchall()
        conn.close()
        return rows, offset_total_seconds, user_now, today_local

    def _iter_local_segments(self, created_at_ts, duration_seconds, offset_total_seconds):
        """
        Yield (segment_start_local_dt, contribution_seconds) for a session, split at hour boundaries.
        We store end timestamps in UTC, then convert to local by applying offset_total_seconds.
        """
        if created_at_ts is None or duration_seconds is None:
            return
        try:
            created_at_ts = int(created_at_ts)
            duration_seconds = int(duration_seconds)
        except Exception:
            return
        if duration_seconds <= 0:
            return

        user_tz = timezone(timedelta(seconds=offset_total_seconds))
        end_dt = datetime.fromtimestamp(created_at_ts, timezone.utc).astimezone(user_tz)
        start_dt = end_dt - timedelta(seconds=duration_seconds)

        curr = start_dt
        while curr < end_dt:
            next_boundary = (curr + timedelta(hours=1)).replace(minute=0, second=0, microsecond=0)
            segment_end = min(end_dt, next_boundary)
            contribution = int((segment_end - curr).total_seconds())
            if contribution > 0:
                yield curr, contribution
            curr = segment_end

    def _make_date_predicate(self, time_range, user_now, today_local, min_local_date=None):
        if min_local_date is not None:
            return lambda d: d >= min_local_date
        if time_range == 'today':
            return lambda d: d == today_local
        if time_range == 'week':
            monday_dt = (user_now - timedelta(days=user_now.weekday())).date()
            return lambda d: d >= monday_dt
        if time_range == 'month':
            first_dt = user_now.replace(day=1).date()
            return lambda d: d >= first_dt
        return lambda d: True

    def _local_midnight_to_utc_ts(self, local_date: date) -> int:
        user_tz, _ = self._get_user_timezone()
        local_midnight = datetime(local_date.year, local_date.month, local_date.day, tzinfo=user_tz)
        return int(local_midnight.astimezone(timezone.utc).timestamp())

    def _get_drill_local_date_bounds(self, drill):
        """
        Returns (start_local_date, end_local_date_exclusive) or (None, None).

        Supported:
        - { level: 'month', key: 'YYYY-MM' }
        - { level: 'day', key: 'YYYY-MM-DD' }
        """
        if not drill or not isinstance(drill, dict):
            return None, None

        level = drill.get('level')
        key = drill.get('key')
        if not isinstance(level, str) or not isinstance(key, str):
            return None, None

        try:
            if level == 'month':
                start = datetime.strptime(key, '%Y-%m').date().replace(day=1)
                if start.month == 12:
                    end = date(start.year + 1, 1, 1)
                else:
                    end = date(start.year, start.month + 1, 1)
                return start, end

            if level == 'day':
                start = datetime.strptime(key, '%Y-%m-%d').date()
                end = start + timedelta(days=1)
                return start, end
        except Exception:
            return None, None

        return None, None

    def get_pie_stats(self, filter_cat=None, time_range='all', drill=None):
        drill_start_local, drill_end_local = self._get_drill_local_date_bounds(drill)
        rows, offset_total_seconds, user_now, today_local = self._query_sessions(
            filter_cat=filter_cat,
            filter_sub=None,
            time_range=time_range,
            include_categories=True,
            min_local_date=drill_start_local if (time_range == 'all' and drill_start_local is not None) else None,
        )
        in_range = self._make_date_predicate(time_range, user_now, today_local)

        totals = {}
        for ts, duration, main_cat, sub_cat in rows:
            label = sub_cat if filter_cat else main_cat
            if not label:
                continue
            for seg_start, contribution in self._iter_local_segments(ts, duration, offset_total_seconds):
                seg_date = seg_start.date()
                if not in_range(seg_date):
                    continue
                if drill_start_local is not None and seg_date < drill_start_local:
                    continue
                if drill_end_local is not None and seg_date >= drill_end_local:
                    continue
                totals[label] = totals.get(label, 0) + contribution

        return [{"label": k, "total": v} for k, v in totals.items()]

    def get_weighted_focus_score(self, filter_cat=None, filter_sub=None, time_range='today', drill=None):
        """
        Returns a weighted-average focus score over sessions in the selected range.

        Focus score is defined as:
          total_active_seconds / total_elapsed_seconds

        Where per-session elapsed is computed from the earliest segment start to latest segment end.
        """
        drill_start_local, drill_end_local = self._get_drill_local_date_bounds(drill)
        drill_start_utc_ts = self._local_midnight_to_utc_ts(drill_start_local) if drill_start_local is not None else None
        drill_end_utc_ts = self._local_midnight_to_utc_ts(drill_end_local) if drill_end_local is not None else None

        rows, _, _, _ = self._query_sessions(
            filter_cat=filter_cat,
            filter_sub=filter_sub,
            time_range=time_range,
            include_categories=True,
            include_session_id=True,
            include_segment_start_ts=True,
            min_local_date=drill_start_local if (time_range == 'all' and drill_start_local is not None) else None,
        )

        range_start_utc_ts = self._get_range_start_utc_ts(time_range)

        start_bound_utc_ts = None
        for bound in (range_start_utc_ts, drill_start_utc_ts):
            if bound is None:
                continue
            start_bound_utc_ts = bound if start_bound_utc_ts is None else max(start_bound_utc_ts, bound)

        sessions = {}
        for created_at_ts, duration_seconds, session_id, segment_start_ts, main_cat, sub_cat in rows:
            if created_at_ts is None or duration_seconds is None:
                continue
            try:
                created_at_ts = int(created_at_ts)
                duration_seconds = int(duration_seconds)
            except Exception:
                continue

            try:
                segment_start_ts = int(segment_start_ts) if segment_start_ts is not None else None
            except Exception:
                segment_start_ts = None

            # Safety: approximate start if missing.
            approx_start_ts = created_at_ts - max(0, duration_seconds)
            seg_start_ts = segment_start_ts if segment_start_ts is not None else approx_start_ts
            seg_end_ts = created_at_ts

            if start_bound_utc_ts is not None:
                seg_start_ts = max(seg_start_ts, start_bound_utc_ts)
            if drill_end_utc_ts is not None:
                seg_end_ts = min(seg_end_ts, drill_end_utc_ts)

            seg_active = int(max(0, seg_end_ts - seg_start_ts))
            if seg_active <= 0:
                continue

            # If session_id is missing, treat each row as its own session-like unit.
            sid = session_id if session_id else f"sid_{created_at_ts}_{seg_start_ts}_{duration_seconds}_{main_cat}_{sub_cat}"

            if sid not in sessions:
                sessions[sid] = {
                    "active": 0,
                    "start": seg_start_ts,
                    "end": seg_end_ts,
                }

            sess = sessions[sid]
            sess["active"] += seg_active
            sess["start"] = min(sess["start"], seg_start_ts)
            sess["end"] = max(sess["end"], seg_end_ts)

        total_active = 0
        total_elapsed = 0
        for sess in sessions.values():
            elapsed = int(max(0, sess["end"] - sess["start"]))
            if elapsed <= 0:
                continue
            total_active += int(sess["active"])
            total_elapsed += elapsed

        focus_score = (total_active / total_elapsed) if total_elapsed > 0 else 0.0
        return {
            "focus_score": float(focus_score),
            "active_seconds": int(total_active),
            "elapsed_seconds": int(total_elapsed),
        }

    def get_today_total(self):
        data_map = self._get_split_data(None, None, 'today', 'hour')
        return int(sum(data_map.values()))

    def get_all_today_stats(self):
        rows, offset_total_seconds, user_now, today_local = self._query_sessions(
            time_range='today',
            include_categories=True
        )
        in_range = self._make_date_predicate('today', user_now, today_local)

        totals = {}
        for ts, duration, main_cat, sub_cat in rows:
            key = (main_cat, sub_cat)
            for seg_start, contribution in self._iter_local_segments(ts, duration, offset_total_seconds):
                if in_range(seg_start.date()):
                    totals[key] = totals.get(key, 0) + contribution

        items = [{"main": k[0], "sub": k[1], "total": v} for k, v in totals.items()]
        items.sort(key=lambda x: (x["main"] or "", x["sub"] or ""))
        return items

    def get_stats(self, filter_cat=None, filter_sub=None, time_range='all', drill=None):
        drill_start_local, drill_end_local = self._get_drill_local_date_bounds(drill)
        if time_range == 'all' and drill_start_local is not None and drill_end_local is not None:
            if drill.get('level') == 'day':
                data_map = self._get_split_data(
                    filter_cat, filter_sub, 'all', 'hour',
                    start_local_date=drill_start_local, end_local_date=drill_end_local
                )
                full_data = []
                for h in range(24):
                    h_str = f"{h:02d}"
                    full_data.append({"date": f"{h_str}:00", "total": data_map.get(h_str, 0)})
                return full_data

            if drill.get('level') == 'month':
                data_map = self._get_split_data(
                    filter_cat, filter_sub, 'all', 'day',
                    start_local_date=drill_start_local, end_local_date=drill_end_local
                )

                # Fill missing days for nicer continuity.
                # If the selected month is the current month, only fill up to today (avoid future zeros).
                user_now, _, _ = self._get_user_now()
                today_local = user_now.date()

                fill_end = drill_end_local
                if drill_start_local <= today_local < drill_end_local:
                    fill_end = min(drill_end_local, today_local + timedelta(days=1))

                curr = drill_start_local
                while curr < fill_end:
                    data_map.setdefault(curr.isoformat(), 0)
                    curr += timedelta(days=1)

                sorted_keys = sorted(data_map.keys())
                return [{"date": k, "total": data_map[k]} for k in sorted_keys]

        if time_range == 'today':
            data_map = self._get_split_data(filter_cat, filter_sub, 'today', 'hour')
            full_data = []
            for h in range(24):
                h_str = f"{h:02d}"
                full_data.append({"date": f"{h_str}:00", "total": data_map.get(h_str, 0)})
            return full_data
        
        # For Week/Month/All, we want daily/monthly totals
        group_by = 'day' if time_range in ['week', 'month'] else 'month'
        data_map = self._get_split_data(filter_cat, filter_sub, time_range, group_by)

        # For week/month charts, fill missing days with 0 so the line chart shows continuous dates.
        if time_range in ['week', 'month']:
            user_now, _, _ = self._get_user_now()
            today_local = user_now.date()

            if time_range == 'week':
                start_local = (user_now - timedelta(days=user_now.weekday())).date()
            else:  # month
                start_local = user_now.replace(day=1).date()

            curr = start_local
            while curr <= today_local:
                data_map.setdefault(curr.isoformat(), 0)
                curr += timedelta(days=1)
        
        # Format for frontend (sort by date)
        sorted_keys = sorted(data_map.keys())
        return [{"date": k, "total": data_map[k]} for k in sorted_keys]

    def _get_split_data(
        self,
        filter_cat=None,
        filter_sub=None,
        time_range='all',
        aggregation='hour',
        start_local_date=None,
        end_local_date=None,
    ):
        """
        Unified helper to get aggregated stats with cross-boundary splitting.
        aggregation: 'hour' (returns '00'-'23') or 'day' (returns 'YYYY-MM-DD') or 'month' (returns 'YYYY-MM')
        """
        rows, offset_total_seconds, user_now, today_local = self._query_sessions(
            filter_cat=filter_cat,
            filter_sub=filter_sub,
            time_range=time_range,
            include_categories=False,
            min_local_date=start_local_date if start_local_date is not None else None,
        )
        in_range = self._make_date_predicate(time_range, user_now, today_local)

        data_map = {}
        if aggregation == 'hour':
            data_map = {f"{h:02d}": 0 for h in range(24)}

        for ts, duration in rows:
            for seg_start, contribution in self._iter_local_segments(ts, duration, offset_total_seconds):
                seg_date = seg_start.date()
                if not in_range(seg_date):
                    continue
                if start_local_date is not None and seg_date < start_local_date:
                    continue
                if end_local_date is not None and seg_date >= end_local_date:
                    continue
                if aggregation == 'hour':
                    key = seg_start.strftime('%H')
                elif aggregation == 'day':
                    key = seg_start.strftime('%Y-%m-%d')
                else:  # month
                    key = seg_start.strftime('%Y-%m')
                data_map[key] = data_map.get(key, 0) + contribution

        return data_map

        conn = _connect_db()
        cursor = conn.cursor()
        
        offset_str, _ = self.get_user_offset()
        user_now, _, offset_total_seconds = self._get_user_now()
        today_local = user_now.date()
        
        where_clauses = []
        params = []

        # We fetch a bit more than the range to catch sessions that started in range but finished just after,
        # or vice versa. Since sessions are auto-split hourly, ±1 hour buffer is enough.
        # But for simplicity, we capture anything that finished after the start of the range.
        
        if time_range == 'today':
            start_bound = today_local.isoformat()
            where_clauses.append(f"strftime('%Y-%m-%d', datetime(created_at_ts, 'unixepoch', '{offset_str}')) >= ?")
            params.append(start_bound)
        elif time_range == 'week':
            monday = (user_now - timedelta(days=user_now.weekday())).date().isoformat()
            where_clauses.append(f"strftime('%Y-%m-%d', datetime(created_at_ts, 'unixepoch', '{offset_str}')) >= ?")
            params.append(monday)
        elif time_range == 'month':
            first_day = user_now.replace(day=1).date().isoformat()
            where_clauses.append(f"strftime('%Y-%m-%d', datetime(created_at_ts, 'unixepoch', '{offset_str}')) >= ?")
            params.append(first_day)

        if filter_sub:
            where_clauses.append("main_cat = ? AND sub_cat = ?")
            params.extend([filter_cat, filter_sub])
        elif filter_cat:
            where_clauses.append("main_cat = ?")
            params.append(filter_cat)

        where_sql = ""
        if where_clauses:
            where_sql = " WHERE " + " AND ".join(where_clauses)

        query = f"SELECT created_at_ts, duration_seconds FROM focus_sessions {where_sql}"
        cursor.execute(query, params)
        rows = cursor.fetchall()
        conn.close()

        data_map = {}
        if aggregation == 'hour':
            data_map = {f"{h:02d}": 0 for h in range(24)}

        for ts, duration in rows:
            user_tz = timezone(timedelta(seconds=offset_total_seconds))
            end_dt = datetime.fromtimestamp(ts, timezone.utc).astimezone(user_tz)
            start_dt = end_dt - timedelta(seconds=duration)
            
            curr = start_dt
            while curr < end_dt:
                # Splitting by hour is the most granular and works for all aggregations
                next_boundary = (curr + timedelta(hours=1)).replace(minute=0, second=0, microsecond=0)
                segment_end = min(end_dt, next_boundary)
                contribution = (segment_end - curr).total_seconds()
                
                # Check if this segment belongs to our target range
                is_in_range = True
                curr_date = curr.date()
                if time_range == 'today' and curr_date != today_local:
                    is_in_range = False
                elif time_range == 'week':
                    monday_dt = (user_now - timedelta(days=user_now.weekday())).date()
                    if curr_date < monday_dt: is_in_range = False
                elif time_range == 'month':
                    first_dt = user_now.replace(day=1).date()
                    if curr_date < first_dt: is_in_range = False

                if is_in_range:
                    if aggregation == 'hour':
                        key = curr.strftime('%H')
                    elif aggregation == 'day':
                        key = curr.strftime('%Y-%m-%d')
                    else: # month
                        key = curr.strftime('%Y-%m')
                    
                    data_map[key] = data_map.get(key, 0) + contribution
                
                curr = segment_end
        
        return data_map

    def get_hourly_distribution(self, filter_cat=None, filter_sub=None, time_range='all', drill=None):
        drill_start_local, drill_end_local = self._get_drill_local_date_bounds(drill)
        data_map = self._get_split_data(
            filter_cat, filter_sub, time_range, 'hour',
            start_local_date=drill_start_local, end_local_date=drill_end_local
        )
        full_data = []
        for h in range(24):
            h_str = f"{h:02d}"
            full_data.append({"hour": f"{h_str}:00", "total": data_map.get(h_str, 0)})
        return full_data

    def get_calendar_stats(self, filter_cat=None, filter_sub=None):
        user_now, _, _ = self._get_user_now()
        start_date = (user_now - timedelta(days=365)).date()

        rows, offset_total_seconds, user_now, today_local = self._query_sessions(
            filter_cat=filter_cat,
            filter_sub=filter_sub,
            time_range='all',
            include_categories=False,
            min_local_date=start_date
        )
        in_range = self._make_date_predicate('all', user_now, today_local, min_local_date=start_date)

        totals = {}
        for ts, duration in rows:
            for seg_start, contribution in self._iter_local_segments(ts, duration, offset_total_seconds):
                if not in_range(seg_start.date()):
                    continue
                key = seg_start.strftime('%Y-%m-%d')
                totals[key] = totals.get(key, 0) + contribution

        return totals

        conn = _connect_db()
        cursor = conn.cursor()
        
        offset_str, _ = self.get_user_offset()
        local_expr = f"datetime(created_at_ts, 'unixepoch', '{offset_str}')"
        
        user_now, _, _ = self._get_user_now()
        # Look back 365 days
        start_date = (user_now - timedelta(days=365)).date().isoformat()
        
        where_clauses = [f"strftime('%Y-%m-%d', {local_expr}) >= ?"]
        params = [start_date]

        if filter_sub:
            where_clauses.append("main_cat = ? AND sub_cat = ?")
            params.extend([filter_cat, filter_sub])
        elif filter_cat:
            where_clauses.append("main_cat = ?")
            params.append(filter_cat)

        where_sql = " WHERE " + " AND ".join(where_clauses)
        
        query = f"SELECT strftime('%Y-%m-%d', {local_expr}) as dt, SUM(duration_seconds) FROM focus_sessions {where_sql} GROUP BY dt"
        
        cursor.execute(query, params)
        rows = cursor.fetchall()
        conn.close()
        
        return {r[0]: r[1] for r in rows}

    # --- Mini Window Logic ---
    def toggle_mini_window(self):
        global mini_window
        if mini_window:
            _persist_mini_window_position()
            mini_window.destroy()
            mini_window = None
            return False
        else:
            mini_window = webview.create_window(
                'Focus Mini',
                url='mini.html',
                width=MINI_WINDOW_WIDTH,
                height=MINI_WINDOW_HEIGHT,
                resizable=False,
                on_top=True,
                frameless=True,
                transparent=False,
                background_color='#141414',
                js_api=self
            )
            # Apply icon and hide from taskbar
            set_window_icon('Focus Mini', 'icon.ico')
            hide_from_taskbar('Focus Mini')

            # Restore last position (best-effort; window creation is async)
            for delay in [0.05, 0.2, 0.6, 1.2]:
                threading.Timer(delay, _restore_mini_window_position).start()
            return True

    def update_mini_data(self, data):
        global mini_window
        if mini_window:
            try:
                # data is a dict passed from JS
                mini_window.evaluate_js(f"updateDisplay({json.dumps(data, ensure_ascii=False)})")
            except:
                pass

    def pick_background(self):
        """Opens a file dialog for the user to pick an image, copies it to the project, and returns the path."""
        file_types = ('Image files (*.jpg;*.jpeg;*.png;*.webp)', 'All files (*.*)')
        try:
            result = main_window.create_file_dialog(webview.FileDialog.OPEN, allow_multiple=False, file_types=file_types)
            if result and len(result) > 0:
                original_path = result[0]
                # Generate a unique filename in the custom_backgrounds directory
                ext = os.path.splitext(original_path)[1].lower()
                if not ext: ext = '.jpg' # Fallback
                new_filename = f"custom_bg_{int(time.time())}{ext}"
                
                custom_bg_dir = os.path.join(os.getcwd(), 'custom_backgrounds')
                if not os.path.exists(custom_bg_dir):
                    os.makedirs(custom_bg_dir)
                
                target_path = os.path.join(custom_bg_dir, new_filename)
                
                # Copy the file
                shutil.copy2(original_path, target_path)
                
                # Return the relative path
                return f"custom_backgrounds/{new_filename}"
        except Exception as e:
            print(f"Error picking background: {e}")
            return None

    def delete_custom_background(self, relative_path):
        """Deletes a custom background file if it exists and is in the custom_backgrounds directory."""
        try:
            if not relative_path or not relative_path.startswith('custom_backgrounds/'):
                return False
            
            full_path = os.path.join(os.getcwd(), relative_path)
            if os.path.exists(full_path):
                os.remove(full_path)
                return True
            return False
        except Exception as e:
            print(f"Error deleting custom background: {e}")
            return str(e)
        return None

def get_entrypoint():
    if getattr(sys, 'frozen', False):
        return os.path.join(sys._MEIPASS, 'index.html')
    return 'index.html'

def setup_hotkeys(window):
    # This is called once on start. We will wait for JS to tell us the user's preferred hotkey.
    pass

def _destroy_mini_window():
    global mini_window
    if not mini_window:
        return
    _persist_mini_window_position()
    try:
        mini_window.destroy()
    except Exception:
        pass
    mini_window = None

def _bind_close_to_destroy_mini(window):
    def _on_close(*_args, **_kwargs):
        _destroy_mini_window()

    try:
        window.events.closing += _on_close
        return
    except Exception:
        pass

    try:
        window.events.closed += _on_close
    except Exception:
        pass

if __name__ == '__main__':
    init_db()
    
    api = Api()
    main_window = webview.create_window(
        '专注Focus',
        url=get_entrypoint(),
        width=1000,
        height=1050,
        resizable=True,
        js_api=api,
        background_color='#0a0a0a',
        frameless=False
    )
    
    # Set main window icon
    set_window_icon('专注Focus', 'icon.ico')
    _bind_close_to_destroy_mini(main_window)
    
    # Use a thread or a hook to setup hotkeys after window is ready
    webview.start(setup_hotkeys, main_window, debug=False)

    # Fallback: ensure mini is closed when the app exits (in case event hooks aren't available).
    _destroy_mini_window()

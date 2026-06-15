import { useState, useEffect, useCallback, useRef, createContext, useContext } from "react";
import {
  UserPlus, ChevronRight, Trash2, Calendar,
  ChevronDown, ChevronUp, CheckCircle, Clock,
  AlertCircle, ClipboardList, History, Settings as SettingsIcon,
  Send, AlertCircle as AlertCircleIcon, CheckCircle2, FileText,
  Copy, Check, X, ChevronLeft, Pencil, ArrowUp, ArrowDown,
  UploadCloud, DownloadCloud, KeyRound, Eye, EyeOff, Cloud, CloudOff, ShieldCheck,
  Pin,
  LogIn, LogOut, Wifi, WifiOff, RefreshCw, UserCircle2
} from "lucide-react";

// ═══════════════════════════════════════════════════════════════════════════
//  Firebase（Cloud Firestore）設定
//  ※ Firebaseコンソールで取得した値を "" の中に貼り付けてください。
//    未設定の間は、これまで通り端末内（localStorage）のみで動作します。
// ═══════════════════════════════════════════════════════════════════════════
const firebaseConfig = {
  apiKey: "AIzaSyACZg832_55Vt7jPE94oGNi4vIGwUheAzE",
  authDomain: "carekiro-733c5.firebaseapp.com",
  projectId: "carekiro-733c5",
  storageBucket: "carekiro-733c5.firebasestorage.app",
  messagingSenderId: "219337002728",
  appId: "1:219337002728:web:72f5b218c54be230d9435d"
};

const CLOUD_COLLECTION = "carekiro_backups";
const AUTH_KEY = "care_auth_v1";        // { userId, docId } を保存
const SYNC_DOC = "carekiro_backups";    // バックアップと同じコレクションを使用

function isCloudConfigured() {
  return Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);
}

// パスワードは平文では一切送信・保存しません。
// 「ID + パスワード」からSHA-256でドキュメントIDを生成し、
// その組み合わせを知っている人だけがデータに到達できる方式です。
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function backupDocId(id, password) {
  return sha256Hex(`carekiro::v1::${id.trim()}::${password}`);
}

function firestoreDocUrl(docId) {
  return `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/${CLOUD_COLLECTION}/${docId}?key=${firebaseConfig.apiKey}`;
}

// クラウドへ保存（作成 / 上書き）
async function cloudBackup(id, password, logs, settings) {
  const docId = await backupDocId(id, password);
  const payload = JSON.stringify({ app: "carekiro", version: 1, savedAt: new Date().toISOString(), logs, settings });
  const res = await fetch(firestoreDocUrl(docId), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fields: {
        app: { stringValue: "carekiro" },
        payload: { stringValue: payload },
        updatedAt: { stringValue: new Date().toISOString() },
      },
    }),
  });
  if (!res.ok) throw new Error(`保存に失敗しました（${res.status}）。Firestoreの設定とセキュリティルールをご確認ください。`);
}

// クラウドから取得（IDとパスワードの組み合わせが正しい場合のみ見つかる）
async function cloudRestoreFetch(id, password) {
  const docId = await backupDocId(id, password);
  const res = await fetch(firestoreDocUrl(docId));
  if (res.status === 404 || res.status === 403) {
    throw new Error("バックアップが見つかりません。IDとパスワードをご確認ください。");
  }
  if (!res.ok) throw new Error(`通信エラーが発生しました（${res.status}）。時間をおいて再度お試しください。`);
  const doc = await res.json();
  const raw = doc?.fields?.payload?.stringValue;
  if (!raw) throw new Error("バックアップデータの形式が正しくありません。");
  return JSON.parse(raw);
}

// ─── Cloud Sync（自動同期） ──────────────────────────────────────────────────

// ドキュメントURL（同期用）
function syncDocUrl(docId) {
  return `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/${SYNC_DOC}/${docId}?key=${firebaseConfig.apiKey}`;
}

// クラウドへ全データを保存（自動同期）
async function cloudSave(docId, logs, settings) {
  const payload = JSON.stringify({
    app: "carekiro", version: 1,
    savedAt: new Date().toISOString(),
    logs, settings,
  });
  const res = await fetch(syncDocUrl(docId), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fields: {
        payload: { stringValue: payload },
        updatedAt: { stringValue: new Date().toISOString() },
      },
    }),
  });
  if (!res.ok) throw new Error(`同期失敗 (${res.status})`);
}

// クラウドから最新データを取得
async function cloudLoad(docId) {
  const res = await fetch(syncDocUrl(docId));
  if (res.status === 404) return null;  // 初回は空
  if (!res.ok) throw new Error(`取得失敗 (${res.status})`);
  const doc = await res.json();
  const raw = doc?.fields?.payload?.stringValue;
  if (!raw) return null;
  return JSON.parse(raw);
}

// ローカルにセッション認証を保存
function saveAuth(userId, docId) {
  try { localStorage.setItem(AUTH_KEY, JSON.stringify({ userId, docId })); } catch {}
}
function loadAuth() {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function clearAuth() {
  try { localStorage.removeItem(AUTH_KEY); } catch {}
}

// ─── Types ────────────────────────────────────────────────────────────────────
// CareRecord: { id, name, memo, checks:{schedule,shift,contact,unnecessary}, createdAt }
// DayLog: { date, records, outputAt? }
// AppSettings: { notificationEnabled, notificationTime }

const CHECK_ITEMS = [
  { key: "schedule",    label: "次回予定記入済" },
  { key: "shift",       label: "シフト変更済"   },
  { key: "contact",     label: "連絡済"         },
  { key: "unnecessary", label: "不要"           },
];

function defaultChecks() {
  return { schedule: false, shift: false, contact: false, unnecessary: false };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const STORAGE_KEY = "care_logs_v1";
const SETTINGS_KEY = "care_settings_v1";
const RETENTION_DAYS = 30;

const FONT_BODY = "'Noto Sans JP', -apple-system, BlinkMacSystemFont, 'Hiragino Sans', sans-serif";
const FONT_DISPLAY = "'Zen Maru Gothic', 'Hiragino Maru Gothic ProN', 'Noto Sans JP', sans-serif";

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function purgeOld(logs) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const result = {};
  for (const [date, log] of Object.entries(logs)) {
    if (date >= cutoffStr) result[date] = log;
  }
  return result;
}

function loadLogs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return purgeOld(JSON.parse(raw));
  } catch { return {}; }
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { notificationEnabled: false, notificationTime: "17:00" };
    return JSON.parse(raw);
  } catch { return { notificationEnabled: false, notificationTime: "17:00" }; }
}

function formatOutput(records) {
  return records.map(r => {
    const nameLine = r.name ? `【${r.name}】` : "";
    const body = nameLine && r.memo
      ? `${nameLine}\n${r.memo}`
      : nameLine || r.memo || "";
    const checks = r.checks ?? {};
    const checkedLabels = CHECK_ITEMS
      .filter(item => item.key !== "unnecessary" && checks[item.key])
      .map(item => item.label);
    const footer = checkedLabels.length > 0
      ? `\n\n${checkedLabels.join("　")}`
      : "";
    return body + footer;
  }).join("\n\n");
}

function formatDate(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric", weekday: "short" });
}

function formatTime(isoStr) {
  return new Date(isoStr).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}

// ─── Global Style（デザイントークン）──────────────────────────────────────────
function GlobalStyle() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Zen+Maru+Gothic:wght@500;700;900&family=Noto+Sans+JP:wght@400;500;700&display=swap');

      /* ─ palette ─
         胡桃   #3B362F  (深いエスプレッソ)
         真鍮   #B49A6C  (シャンパンゴールド)
         グレージュ #F2F0EB (背景)
         墨茶   #2C2823  (本文)
         霞     #9C9488  (補助テキスト)                        */

      .ck-card {
        background: #ffffff;
        border: 1px solid #E7E2D9;
        border-radius: 20px;
        box-shadow: 0 1px 2px rgba(59,54,47,0.05), 0 12px 32px -16px rgba(59,54,47,0.14);
      }
      .ck-input {
        background: #F5F3EE;
        border: 1.5px solid #E3DED4;
        border-radius: 14px;
        transition: all .18s ease;
      }
      .ck-input:focus {
        background: #ffffff;
        border-color: #6E6456;
        box-shadow: 0 0 0 3px rgba(160,140,104,0.15);
        outline: none;
      }
      .ck-input::placeholder { color: #C5BDAE; }
      .ck-btn-primary {
        background: linear-gradient(135deg, #3B362F 0%, #6E6456 100%);
        color: #fff;
        box-shadow: 0 10px 24px -10px rgba(59,54,47,0.55);
        transition: all .18s ease;
      }
      .ck-btn-primary:hover { filter: brightness(1.06); box-shadow: 0 12px 28px -10px rgba(59,54,47,0.65); }
      .ck-btn-primary:active { transform: scale(0.97); }
      .ck-btn-disabled {
        background: #EDE9E1;
        color: #C5BDAE;
        cursor: not-allowed;
        box-shadow: none;
      }
      .ck-chip-on {
        background: linear-gradient(135deg, #45403A 0%, #6B6151 100%);
        color: #fff;
        border: 1px solid transparent;
        box-shadow: 0 4px 10px -4px rgba(59,54,47,0.5);
      }
      .ck-chip-na {
        background: #8B8478;
        color: #fff;
        border: 1px solid transparent;
      }
      .ck-chip-off {
        background: #ffffff;
        color: #9C9488;
        border: 1px solid #DED8CC;
      }
      .ck-chip-off:hover { border-color: #6E6456; color: #A08C68; }
      .ck-chip-disabled {
        background: #F1EEE8;
        color: #D9D3C7;
        border: 1px solid #EDE9E1;
        cursor: not-allowed;
      }
      .ck-modal-in { animation: ckSlideUp 0.25s cubic-bezier(0.16, 1, 0.3, 1) both; }
      @keyframes ckSlideUp { from { opacity:0; transform:translateY(18px); } to { opacity:1; transform:translateY(0); } }
      @keyframes ckBreathe {
        0%,100% { transform: scale(1); opacity:.5; }
        50%     { transform: scale(1.18); opacity:.85; }
      }
      @keyframes ckPop { 0% { transform: scale(.92); } 60% { transform: scale(1.04); } 100% { transform: scale(1); } }
      .ck-pop { animation: ckPop .25s ease both; }
      @media (prefers-reduced-motion: reduce) {
        * { animation: none !important; transition: none !important; }
      }
    `}</style>
  );
}

// ─── Context ──────────────────────────────────────────────────────────────────
const AppContext = createContext(null);

function AppProvider({ children }) {
  const [view, setView] = useState("main");
  const [allLogs, setAllLogs] = useState(loadLogs);
  const [settings, setSettings] = useState(loadSettings);
  const [selectedHistoryDate, setSelectedHistoryDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  });

  // ── 認証・同期状態 ──
  const [auth, setAuth] = useState(loadAuth);   // { userId, docId } | null
  const [syncStatus, setSyncStatus] = useState("idle"); // "idle"|"syncing"|"ok"|"error"
  const syncTimerRef = useRef(null);

  const todayRecords = allLogs[todayStr()]?.records ?? [];
  const isLoggedIn = Boolean(auth);

  // ローカル保存（常時）
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(allLogs));
  }, [allLogs]);

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  // ── クラウド同期（ログイン中のみ）: データ変更後300msデバウンス ──
  const syncToCloud = useCallback(async (logs, cfg) => {
    if (!isCloudConfigured() || !auth) return;
    setSyncStatus("syncing");
    try {
      await cloudSave(auth.docId, logs, cfg);
      setSyncStatus("ok");
    } catch {
      setSyncStatus("error");
    }
  }, [auth]);

  useEffect(() => {
    if (!auth) return;
    clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => {
      syncToCloud(allLogs, settings);
    }, 300);
    return () => clearTimeout(syncTimerRef.current);
  }, [allLogs, settings, auth, syncToCloud]);

  // ── 起動時にクラウドから最新データを取得（ログイン中のみ） ──
  useEffect(() => {
    if (!auth || !isCloudConfigured()) return;
    setSyncStatus("syncing");
    cloudLoad(auth.docId).then(data => {
      if (!data) { setSyncStatus("ok"); return; }
      setAllLogs(purgeOld(data.logs ?? {}));
      if (data.settings) setSettings(data.settings);
      setSyncStatus("ok");
    }).catch(() => setSyncStatus("error"));
  }, [auth]);

  const addRecord = useCallback((name, memo) => {
    const date = todayStr();
    const record = { id: crypto.randomUUID(), name, memo, checks: defaultChecks(), createdAt: new Date().toISOString() };
    setAllLogs(prev => {
      const day = prev[date] ?? { date, records: [] };
      return { ...prev, [date]: { ...day, records: [...day.records, record] } };
    });
  }, []);

  // 既存レコードにメモを追記してマージ（氏名はそのまま、メモを改行で結合）
  const mergeRecord = useCallback((id, additionalMemo) => {
    const date = todayStr();
    setAllLogs(prev => {
      const day = prev[date];
      if (!day) return prev;
      return {
        ...prev,
        [date]: {
          ...day,
          records: day.records.map(r => {
            if (r.id !== id) return r;
            const merged = r.memo
              ? `${r.memo}\n${additionalMemo}`
              : additionalMemo;
            return { ...r, memo: merged, checks: defaultChecks() };
          }),
        },
      };
    });
  }, []);

  const updateRecord = useCallback((id, updates) => {
    const date = todayStr();
    setAllLogs(prev => {
      const day = prev[date];
      if (!day) return prev;
      return { ...prev, [date]: { ...day, records: day.records.map(r => r.id === id ? { ...r, ...updates } : r) } };
    });
  }, []);

  const deleteRecord = useCallback((id) => {
    const date = todayStr();
    setAllLogs(prev => {
      const day = prev[date];
      if (!day) return prev;
      return { ...prev, [date]: { ...day, records: day.records.filter(r => r.id !== id) } };
    });
  }, []);

  const markOutput = useCallback(() => {
    const date = todayStr();
    setAllLogs(prev => {
      const day = prev[date];
      if (!day) return prev;
      return { ...prev, [date]: { ...day, outputAt: new Date().toISOString() } };
    });
  }, []);

  const reorderRecord = useCallback((id, direction) => {
    const date = todayStr();
    setAllLogs(prev => {
      const day = prev[date];
      if (!day) return prev;
      const records = [...day.records];
      const idx = records.findIndex(r => r.id === id);
      if (idx === -1) return prev;
      if (direction === "up" && idx === 0) return prev;
      if (direction === "down" && idx === records.length - 1) return prev;
      const swapIdx = direction === "up" ? idx - 1 : idx + 1;
      [records[idx], records[swapIdx]] = [records[swapIdx], records[idx]];
      return { ...prev, [date]: { ...day, records } };
    });
  }, []);

  const togglePin = useCallback((id) => {
    const date = todayStr();
    setAllLogs(prev => {
      const day = prev[date];
      if (!day) return prev;
      return {
        ...prev,
        [date]: {
          ...day,
          records: day.records.map(r =>
            r.id === id ? { ...r, pinned: !r.pinned } : r
          ),
        },
      };
    });
  }, []);

  const saveSettings = useCallback((s) => setSettings(s), []);

  // ── ログイン（IDとパスワードからdocIdを生成して認証） ──
  const login = useCallback(async (userId, password) => {
    const docId = await backupDocId(userId, password);
    const newAuth = { userId, docId };
    saveAuth(userId, docId);
    setAuth(newAuth);
    return docId;
  }, []);

  // ── ログアウト ──
  const logout = useCallback(() => {
    clearAuth();
    setAuth(null);
    setSyncStatus("idle");
  }, []);

  // クラウド復元時：取得したデータでローカルを丸ごと置き換える
  const restoreData = useCallback((logs, restoredSettings) => {
    setAllLogs(purgeOld(logs ?? {}));
    if (restoredSettings) setSettings(restoredSettings);
  }, []);

  return (
    <AppContext.Provider value={{
      view, setView, todayRecords, allLogs,
      addRecord, mergeRecord, updateRecord, deleteRecord, markOutput, reorderRecord, togglePin,
      settings, saveSettings, restoreData,
      auth, login, logout, syncStatus, isLoggedIn,
      selectedHistoryDate, setSelectedHistoryDate,
    }}>
      {children}
    </AppContext.Provider>
  );
}

function useApp() { return useContext(AppContext); }

// ─── SyncBadge（同期状態インジケーター）───────────────────────────────────────
function SyncBadge() {
  const { syncStatus, isLoggedIn } = useApp();
  if (!isLoggedIn || !isCloudConfigured()) return null;
  const map = {
    syncing: { icon: <RefreshCw size={11} className="animate-spin" />, text: "同期中", color: "#B49A6C" },
    ok:      { icon: <Wifi size={11} />,    text: "同期済", color: "#7A8765" },
    error:   { icon: <WifiOff size={11} />, text: "同期エラー", color: "#B91C1C" },
    idle:    null,
  };
  const item = map[syncStatus];
  if (!item) return null;
  return (
    <span className="flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full"
      style={{ background: "#F8F6F1", color: item.color, border: `1px solid ${item.color}33` }}>
      {item.icon}{item.text}
    </span>
  );
}

// ─── LoginScreen ──────────────────────────────────────────────────────────────
function LoginScreen({ onDone }) {
  const { login, restoreData } = useApp();
  const [userId, setUserId]   = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw]   = useState(false);
  const [autoLogin, setAutoLogin] = useState(true);
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState("");

  const canSubmit = userId.trim().length >= 1 && password.length >= 4;

  const handleLogin = async () => {
    if (!canSubmit || busy) return;
    setBusy(true); setError("");
    try {
      const docId = await login(userId.trim(), password);
      // クラウドから既存データを取得して適用
      if (isCloudConfigured()) {
        try {
          const data = await cloudLoad(docId);
          if (data) restoreData(data.logs, data.settings);
        } catch {}
      }
      if (!autoLogin) {
        // 自動ログインOFFなら認証情報をセッションのみに留める（localStorageから消す）
        clearAuth();
      }
      onDone();
    } catch (e) {
      setError(e.message || "ログインに失敗しました");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 py-12"
      style={{ background: "linear-gradient(165deg, #FDFCFB 0%, #F5F2EC 55%, #ECE7DD 100%)", fontFamily: FONT_BODY }}>

      {/* Logo */}
      <div className="flex flex-col items-center mb-10">
        <div className="w-20 h-20 flex items-center justify-center mb-4"
          style={{ borderRadius: 24, background: "linear-gradient(145deg, #3B362F 0%, #6E6456 60%, #9A8459 100%)", boxShadow: "0 14px 36px rgba(59,54,47,0.3)" }}>
          <AppLogoSvg size={52} />
        </div>
        <p className="font-black text-3xl" style={{ color: "#3B362F", fontFamily: FONT_DISPLAY, letterSpacing: "0.05em" }}>けあキロ</p>
        <p className="text-xs mt-1.5" style={{ color: "#9C9488", letterSpacing: "0.15em" }}>-Care no Kiroku-</p>
      </div>

      {/* Card */}
      <div className="ck-card w-full max-w-sm p-6">
        <h2 className="font-bold text-base mb-4" style={{ color: "#2C2823", fontFamily: FONT_DISPLAY }}>ログインして同期する</h2>

        <div className="space-y-3.5">
          <div>
            <label className="block text-xs font-bold mb-1.5" style={{ color: "#9C9488" }}>ID</label>
            <input type="text" value={userId} onChange={e => setUserId(e.target.value)}
              placeholder="例：yamada-kaigo" autoCapitalize="none" autoCorrect="off"
              className="ck-input w-full px-4 py-3 text-base"
              onKeyDown={e => e.key === "Enter" && handleLogin()} />
          </div>
          <div>
            <label className="block text-xs font-bold mb-1.5" style={{ color: "#9C9488" }}>パスワード（4文字以上）</label>
            <div className="relative">
              <input type={showPw ? "text" : "password"} value={password} onChange={e => setPassword(e.target.value)}
                placeholder="忘れないものを設定" autoCapitalize="none"
                className="ck-input w-full px-4 py-3 pr-12 text-base"
                onKeyDown={e => e.key === "Enter" && handleLogin()} />
              <button onClick={() => setShowPw(v => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 rounded-lg"
                style={{ color: "#B0A899" }}>
                {showPw ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            </div>
          </div>

          {/* 自動ログイン */}
          <button onClick={() => setAutoLogin(v => !v)}
            className="flex items-center gap-2.5 w-full py-2 text-sm"
            style={{ color: "#756E62" }}>
            <span className="w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0 transition-all"
              style={{ background: autoLogin ? "#3B362F" : "#F0EDE6", border: autoLogin ? "none" : "1.5px solid #D9D3C7" }}>
              {autoLogin && <Check size={12} className="text-white" />}
            </span>
            このデバイスで自動ログインする
          </button>

          {error && (
            <p className="text-xs px-3 py-2 rounded-xl" style={{ background: "#FEF2F2", color: "#B91C1C", border: "1px solid #FECACA" }}>{error}</p>
          )}

          <button onClick={handleLogin} disabled={!canSubmit || busy}
            className={`w-full flex items-center justify-center gap-2 py-4 rounded-2xl font-bold text-base ${canSubmit && !busy ? "ck-btn-primary" : "ck-btn-disabled"}`}
            style={{ fontFamily: FONT_DISPLAY }}>
            {busy ? <RefreshCw size={18} className="animate-spin" /> : <LogIn size={18} />}
            {busy ? "ログイン中…" : "ログインして開始"}
          </button>
        </div>
      </div>

      {/* ログインせずに使う */}
      <button onClick={onDone}
        className="mt-5 text-sm py-3 px-6 rounded-2xl transition-all active:scale-95"
        style={{ color: "#9C9488", background: "rgba(255,255,255,0.6)" }}>
        ログインせずに使う（同期なし）
      </button>

      <p className="mt-6 text-[11px] text-center leading-relaxed px-4" style={{ color: "#BCC0B8" }}>
        IDとパスワードは個人を特定する情報ではありません。同じ組み合わせで複数端末から同じデータにアクセスできます。
      </p>
    </div>
  );
}

// ─── MergeConfirmDialog ───────────────────────────────────────────────────────
function MergeConfirmDialog({ existingRecords, newMemo, onMerge, onSeparate, onCancel }) {
  const [selectedId, setSelectedId] = useState(existingRecords[0].id);
  const selectedRecord = existingRecords.find(r => r.id === selectedId);
  const hasMultiple = existingRecords.length > 1;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4"
      style={{ background: "rgba(42,38,32,0.45)", backdropFilter: "blur(5px)" }}>
      <div className="ck-modal-in bg-white w-full max-w-md shadow-2xl" style={{ borderRadius: 24 }}>

        {/* Header */}
        <div className="px-5 pt-5 pb-4" style={{ borderBottom: "1px solid #EFEBE3" }}>
          <div className="flex items-center gap-2.5 mb-1">
            <div className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0">
              <AlertCircle size={16} className="text-amber-600" />
            </div>
            <h2 className="font-bold" style={{ color: "#2C2823", fontFamily: FONT_DISPLAY }}>同じ氏名が見つかりました</h2>
          </div>
          <p className="text-xs ml-10" style={{ color: "#9C9488" }}>
            「{existingRecords[0].name}」の記録が{hasMultiple ? `${existingRecords.length}件` : "すでに"}存在します。まとめますか？
          </p>
        </div>

        {/* Target selector (複数ある場合のみ表示) */}
        {hasMultiple && (
          <div className="px-5 pt-4">
            <p className="text-xs font-bold mb-2" style={{ color: "#9C9488", letterSpacing: "0.08em" }}>どの記録にまとめますか？</p>
            <div className="space-y-2">
              {existingRecords.map((r, i) => (
                <button key={r.id} onClick={() => setSelectedId(r.id)}
                  className="w-full text-left px-3.5 py-2.5 transition-all"
                  style={{
                    borderRadius: 14,
                    border: selectedId === r.id ? "1.5px solid #6E6456" : "1.5px solid #E7E2D9",
                    background: selectedId === r.id ? "#F3EFE7" : "#F8F6F1",
                    boxShadow: selectedId === r.id ? "0 0 0 3px rgba(160,140,104,0.12)" : "none",
                  }}>
                  <p className="text-xs font-bold mb-0.5" style={{ color: "#3B362F" }}>記録 {i + 1}</p>
                  {r.memo
                    ? <p className="text-xs truncate" style={{ color: "#756E62" }}>{r.memo.split("\n")[0]}</p>
                    : <p className="text-xs italic" style={{ color: "#CFC8BA" }}>（メモなし）</p>}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Preview of selected */}
        <div className="px-5 py-4 space-y-3">
          {!hasMultiple && (
            <div>
              <p className="text-xs font-bold mb-1.5" style={{ color: "#9C9488", letterSpacing: "0.08em" }}>既存の内容</p>
              <div className="px-3.5 py-2.5" style={{ background: "#F8F6F1", border: "1px solid #E7E2D9", borderRadius: 14 }}>
                <p className="text-xs font-bold mb-1" style={{ color: "#3B362F" }}>【{selectedRecord.name}】</p>
                {selectedRecord.memo
                  ? <p className="text-xs whitespace-pre-wrap leading-relaxed" style={{ color: "#5B554B" }}>{selectedRecord.memo}</p>
                  : <p className="text-xs italic" style={{ color: "#CFC8BA" }}>（メモなし）</p>}
              </div>
            </div>
          )}
          {newMemo && (
            <div>
              <p className="text-xs font-bold mb-1.5" style={{ color: "#9C9488", letterSpacing: "0.08em" }}>追加されるメモ</p>
              <div className="px-3.5 py-2.5" style={{ background: "#F3EFE7", border: "1px solid #E0D7C5", borderRadius: 14 }}>
                <p className="text-xs whitespace-pre-wrap leading-relaxed" style={{ color: "#3B362F" }}>{newMemo}</p>
              </div>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="px-5 pb-5 space-y-2.5">
          <button onClick={() => onMerge(selectedRecord)}
            className="ck-btn-primary w-full flex items-center justify-center gap-2 py-3.5 rounded-xl font-bold text-sm">
            <CheckCircle size={16} />
            {hasMultiple ? "選択した記録にまとめる" : "まとめる（既存に追記）"}
          </button>
          <button onClick={onSeparate}
            className="w-full flex items-center justify-center gap-2 py-3.5 rounded-xl font-bold text-sm transition-all active:scale-95"
            style={{ background: "#EFEBE3", color: "#5B554B" }}>
            <UserPlus size={16} />
            別々に保存する
          </button>
          <button onClick={onCancel}
            className="w-full py-2.5 rounded-xl text-sm transition-colors"
            style={{ color: "#9C9488" }}>
            キャンセル（入力に戻る）
          </button>
        </div>
      </div>
    </div>
  );
}

// 苗字（スペース前の部分）または全体で一致するか判定
function extractLastName(name) {
  return name.trim().split(/[\s　]+/)[0];
}

function isSamePerson(nameA, nameB) {
  if (!nameA || !nameB) return false;
  const a = nameA.trim();
  const b = nameB.trim();
  if (a === b) return true;
  return extractLastName(a) === extractLastName(b);
}

// ─── RecordForm ───────────────────────────────────────────────────────────────
function RecordForm() {
  const { addRecord, mergeRecord, todayRecords } = useApp();
  const [name, setName] = useState("");
  const [memo, setMemo] = useState("");
  const [flash, setFlash] = useState(false);
  const [mergeTarget, setMergeTarget] = useState(null); // { records, pendingName, pendingMemo }
  const nameRef = useRef(null);

  useEffect(() => { nameRef.current?.focus(); }, []);

  const canSave = name.trim().length > 0 || memo.trim().length > 0;

  const commitSave = (asNew = false, targetRecord = null, pendingName = "", pendingMemo = "") => {
    if (asNew) {
      addRecord(pendingName, pendingMemo);
    } else {
      mergeRecord(targetRecord.id, pendingMemo);
    }
    setName(""); setMemo("");
    setMergeTarget(null);
    setFlash(true);
    setTimeout(() => setFlash(false), 600);
    nameRef.current?.focus();
  };

  const handleNext = () => {
    if (!canSave) return;
    const trimmedName = name.trim();
    const trimmedMemo = memo.trim();

    // Check for duplicate names in today's records (may be multiple)
    const duplicates = todayRecords.filter(r => isSamePerson(r.name, trimmedName));
    if (duplicates.length > 0) {
      setMergeTarget({ records: duplicates, pendingName: trimmedName, pendingMemo: trimmedMemo });
      return;
    }

    addRecord(trimmedName, trimmedMemo);
    setName(""); setMemo("");
    setFlash(true);
    setTimeout(() => setFlash(false), 600);
    nameRef.current?.focus();
  };

  return (
    <>
      <div className="ck-card p-5"
        style={{
          transition: "box-shadow 0.3s, border-color 0.3s",
          ...(flash ? { borderColor: "#6E6456", boxShadow: "0 0 0 3px rgba(160,140,104,0.2), 0 12px 32px -16px rgba(59,54,47,0.2)" } : {}),
        }}>
        <div className="flex items-center gap-2.5 mb-4">
          <div className="w-9 h-9 flex items-center justify-center flex-shrink-0"
            style={{ borderRadius: 12, background: "linear-gradient(135deg, #3B362F 0%, #6E6456 100%)", boxShadow: "0 6px 14px -6px rgba(59,54,47,0.5)" }}>
            <UserPlus size={17} className="text-white" />
          </div>
          <h2 className="text-sm font-bold" style={{ color: "#5B554B", letterSpacing: "0.1em", fontFamily: FONT_DISPLAY }}>新しい記録</h2>
        </div>
        <div className="space-y-3.5">
          <div>
            <label className="block text-xs font-bold mb-1.5" style={{ color: "#9C9488" }}>氏名 / タイトル</label>
            <input ref={nameRef} type="text" value={name} onChange={e => setName(e.target.value)}
              placeholder="例：山田 花子"
              className="ck-input w-full px-4 py-3 text-base" />
          </div>
          <div>
            <label className="block text-xs font-bold mb-1.5" style={{ color: "#9C9488" }}>メモ内容</label>
            <textarea value={memo} onChange={e => setMemo(e.target.value)}
              placeholder="業務内容・申し送り事項など"
              rows={4}
              className="ck-input w-full px-4 py-3 text-base resize-none leading-relaxed" />
          </div>
          <button onClick={handleNext} disabled={!canSave}
            className={`w-full flex items-center justify-center gap-2 py-4 rounded-2xl text-base font-bold ${canSave ? "ck-btn-primary" : "ck-btn-disabled"}`}
            style={{ fontFamily: FONT_DISPLAY }}>
            <span>次の記録へ</span>
            <ChevronRight size={18} />
          </button>
        </div>
      </div>

      {mergeTarget && (
        <MergeConfirmDialog
          existingRecords={mergeTarget.records}
          newMemo={mergeTarget.pendingMemo}
          onMerge={(targetRecord) => commitSave(false, targetRecord, mergeTarget.pendingName, mergeTarget.pendingMemo)}
          onSeparate={() => commitSave(true, null, mergeTarget.pendingName, mergeTarget.pendingMemo)}
          onCancel={() => setMergeTarget(null)}
        />
      )}
    </>
  );
}

// ─── EditRecordModal ──────────────────────────────────────────────────────────
function EditRecordModal({ record, onClose }) {
  const { updateRecord } = useApp();
  const [name, setName] = useState(record.name);
  const [memo, setMemo] = useState(record.memo);
  const nameRef = useRef(null);

  useEffect(() => { nameRef.current?.focus(); }, []);

  const hasChanged = name.trim() !== record.name || memo.trim() !== record.memo;

  const handleSave = () => {
    updateRecord(record.id, { name: name.trim(), memo: memo.trim() });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4"
      style={{ background: "rgba(42,38,32,0.45)", backdropFilter: "blur(5px)" }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="ck-modal-in bg-white w-full max-w-lg shadow-2xl" style={{ borderRadius: 24 }}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: "1px solid #EFEBE3" }}>
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: "#F3EFE7" }}>
              <Pencil size={14} style={{ color: "#A08C68" }} />
            </div>
            <h2 className="font-bold" style={{ color: "#2C2823", fontFamily: FONT_DISPLAY }}>記録を編集</h2>
          </div>
          <button onClick={onClose}
            className="p-2 rounded-xl transition-colors hover:bg-slate-100"
            style={{ color: "#9C9488" }}>
            <X size={18} />
          </button>
        </div>

        {/* Form */}
        <div className="px-5 py-4 space-y-3.5">
          <div>
            <label className="block text-xs font-bold mb-1.5" style={{ color: "#9C9488" }}>氏名 / タイトル</label>
            <input ref={nameRef} type="text" value={name} onChange={e => setName(e.target.value)}
              className="ck-input w-full px-4 py-3 text-base" />
          </div>
          <div>
            <label className="block text-xs font-bold mb-1.5" style={{ color: "#9C9488" }}>メモ内容</label>
            <textarea value={memo} onChange={e => setMemo(e.target.value)} rows={5}
              className="ck-input w-full px-4 py-3 text-base resize-none leading-relaxed" />
          </div>
        </div>

        {/* Actions */}
        <div className="px-5 pb-5 flex gap-2.5">
          <button onClick={onClose}
            className="flex-1 py-3.5 rounded-xl font-bold text-sm transition-all active:scale-95"
            style={{ background: "#EFEBE3", color: "#5B554B" }}>
            キャンセル
          </button>
          <button onClick={handleSave} disabled={!hasChanged}
            className={`flex-1 flex items-center justify-center gap-2 py-3.5 rounded-xl font-bold text-sm ${hasChanged ? "ck-btn-primary" : "ck-btn-disabled"}`}>
            <Check size={16} />
            保存する
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── RecordCard ───────────────────────────────────────────────────────────────
function RecordCard({ record, index }) {
  const { updateRecord, deleteRecord, reorderRecord, togglePin, todayRecords } = useApp();
  const [expanded, setExpanded] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState(false);

  const confirmed = record.checks ? Object.values(record.checks).some(Boolean) : false;
  const pinned = record.pinned ?? false;
  const total = todayRecords.length;
  const handleDelete = () => {
    if (confirmDelete) { deleteRecord(record.id); }
    else { setConfirmDelete(true); setTimeout(() => setConfirmDelete(false), 3000); }
  };

  const iconBtn = "p-1.5 rounded-lg transition-colors";

  return (
    <>
      <div className="overflow-hidden transition-all duration-200"
        style={{
          borderRadius: 18,
          background: pinned
            ? "linear-gradient(180deg, #FDFAF3 0%, #F9F3E5 100%)"
            : confirmed ? "linear-gradient(180deg, #F8F5EE 0%, #F2EDE2 100%)" : "#ffffff",
          border: pinned ? "1.5px solid #D9C193" : confirmed ? "1px solid #E0D7C5" : "1px solid #E7E2D9",
          boxShadow: pinned
            ? "0 1px 2px rgba(59,54,47,0.06), 0 10px 28px -14px rgba(180,154,108,0.35)"
            : confirmed ? "0 1px 2px rgba(59,54,47,0.05)" : "0 1px 2px rgba(59,54,47,0.05), 0 10px 26px -16px rgba(59,54,47,0.16)",
        }}>
        <div className="flex items-center gap-3 px-4 py-3">
          <span className="text-xs font-bold w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0"
            style={{
              background: confirmed ? "#E6DECB" : "#F0EDE6",
              color: confirmed ? "#3B362F" : "#B0A899",
            }}>{index + 1}</span>
          <div className="flex-1 min-w-0">
            <p className="font-bold text-base truncate"
              style={{ color: confirmed ? "#3B362F" : "#2C2823", fontFamily: FONT_DISPLAY }}>
              {record.name || "　"}
            </p>
          </div>
          <div className="flex items-center gap-0.5">
            <button onClick={() => togglePin(record.id)}
              className={`${iconBtn}`}
              style={pinned ? { color: "#B49A6C" } : { color: "#CFC8BA" }}
              onMouseEnter={e => { e.currentTarget.style.color = "#B49A6C"; }}
              onMouseLeave={e => { e.currentTarget.style.color = pinned ? "#B49A6C" : "#CFC8BA"; }}
              title={pinned ? "ピン留めを外す" : "ピン留め"}>
              <Pin size={15} />
            </button>
            <button onClick={() => setExpanded(v => !v)}
              className={`${iconBtn} hover:bg-slate-100`} style={{ color: "#B0A899" }}>
              {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
            </button>
            <button onClick={() => reorderRecord(record.id, "up")} disabled={index === 0}
              className={`${iconBtn} disabled:opacity-20 disabled:cursor-not-allowed`}
              style={{ color: "#B0A899" }}
              onMouseEnter={e => { if (index !== 0) e.currentTarget.style.color = "#A08C68"; }}
              onMouseLeave={e => { e.currentTarget.style.color = "#B0A899"; }}
              title="上へ">
              <ArrowUp size={15} />
            </button>
            <button onClick={() => reorderRecord(record.id, "down")} disabled={index === total - 1}
              className={`${iconBtn} disabled:opacity-20 disabled:cursor-not-allowed`}
              style={{ color: "#B0A899" }}
              onMouseEnter={e => { if (index !== total - 1) e.currentTarget.style.color = "#A08C68"; }}
              onMouseLeave={e => { e.currentTarget.style.color = "#B0A899"; }}
              title="下へ">
              <ArrowDown size={15} />
            </button>
            <button onClick={() => setEditing(true)}
              className={iconBtn}
              style={{ color: "#B0A899" }}
              onMouseEnter={e => { e.currentTarget.style.color = "#A08C68"; }}
              onMouseLeave={e => { e.currentTarget.style.color = "#B0A899"; }}
              title="編集">
              <Pencil size={15} />
            </button>
            <button onClick={handleDelete}
              className={iconBtn}
              style={confirmDelete ? { background: "#FEE2E2", color: "#DC2626" } : { color: "#CFC8BA" }}
              onMouseEnter={e => { if (!confirmDelete) e.currentTarget.style.color = "#F87171"; }}
              onMouseLeave={e => { if (!confirmDelete) e.currentTarget.style.color = "#CFC8BA"; }}
              title={confirmDelete ? "もう一度押すと削除" : "削除"}>
              <Trash2 size={15} />
            </button>
          </div>
        </div>
        {expanded && record.memo && (
          <div className="px-4 pb-3" style={{ paddingLeft: "3.25rem" }}>
            <p className="text-sm leading-relaxed whitespace-pre-wrap"
              style={{ color: confirmed ? "#6B6048" : "#5B554B" }}>
              {record.memo}
            </p>
          </div>
        )}
        {!expanded && record.memo && (
          <div className="px-4 pb-2" style={{ paddingLeft: "3.25rem" }}>
            <p className="text-sm truncate" style={{ color: "#B0A899" }}>{record.memo.split("\n")[0]}...</p>
          </div>
        )}
        {/* Chip-style check area — always visible, 4 chips equally spaced */}
        <div className="px-3 py-2.5 grid grid-cols-4 gap-1.5"
          style={{
            borderTop: confirmed ? "1px solid #E6DECB" : "1px solid #EFEBE3",
            background: confirmed ? "rgba(160,140,104,0.06)" : "#F7F3EA",
          }}>
          {CHECK_ITEMS.map(item => {
            const checked = record.checks?.[item.key] ?? false;
            const isUnnecessary = item.key === "unnecessary";
            const toggle = () => {
              const current = record.checks ?? defaultChecks();
              let next;
              if (isUnnecessary) {
                next = { ...defaultChecks(), unnecessary: !checked };
              } else {
                next = { ...current, [item.key]: !checked, unnecessary: false };
              }
              updateRecord(record.id, { checks: next });
            };
            const disabled = !isUnnecessary && (record.checks?.unnecessary ?? false);
            const chipClass = disabled
              ? "ck-chip-disabled"
              : checked
                ? (isUnnecessary ? "ck-chip-na ck-pop" : "ck-chip-on ck-pop")
                : "ck-chip-off";
            return (
              <button key={item.key} onClick={toggle} disabled={disabled}
                className={`py-1.5 rounded-full text-[11px] font-bold transition-all duration-150 active:scale-95 text-center ${chipClass}`}>
                {item.label}
              </button>
            );
          })}
        </div>
      </div>

      {editing && <EditRecordModal record={record} onClose={() => setEditing(false)} />}
    </>
  );
}

function RecordList() {
  const { todayRecords } = useApp();
  if (todayRecords.length === 0) {
    return (
      <div className="text-center py-10">
        <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-3"
          style={{ background: "linear-gradient(135deg, #F3EFE7, #F5F3EE)" }}>
          <Calendar size={26} style={{ color: "#D5CDBE" }} />
        </div>
        <p className="text-sm font-medium" style={{ color: "#9C9488" }}>本日の記録はまだありません</p>
        <p className="text-xs mt-1" style={{ color: "#C5BDAE" }}>上のフォームから入力してください</p>
      </div>
    );
  }
  // ピン留め優先でソート（ピン内・非ピン内の相対順は維持）
  const sorted = [
    ...todayRecords.filter(r => r.pinned),
    ...todayRecords.filter(r => !r.pinned),
  ];
  const pinnedCount = todayRecords.filter(r => r.pinned).length;
  return (
    <div className="space-y-3">
      {pinnedCount > 0 && (
        <div className="flex items-center gap-1.5 px-1 pb-0.5">
          <Pin size={11} style={{ color: "#B49A6C" }} />
          <span className="text-[11px] font-bold" style={{ color: "#B49A6C" }}>ピン留め {pinnedCount}件</span>
          {pinnedCount < sorted.length && (
            <span className="text-[11px]" style={{ color: "#CFC8BA" }}>/ 全{sorted.length}件</span>
          )}
        </div>
      )}
      {sorted.map((record, i) => (
        <RecordCard key={record.id} record={record} index={i} />
      ))}
    </div>
  );
}

// ─── OutputModal ──────────────────────────────────────────────────────────────
function OutputModal({ onClose }) {
  const { todayRecords, markOutput } = useApp();
  const [copied, setCopied] = useState(false);
  // 出力もピン留め優先順
  const sortedForOutput = [
    ...todayRecords.filter(r => r.pinned),
    ...todayRecords.filter(r => !r.pinned),
  ];
  const text = formatOutput(sortedForOutput);
  const today = new Date().toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric", weekday: "short" });

  useEffect(() => { markOutput(); }, []);

  const handleCopy = async () => {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const el = document.createElement("textarea");
      el.value = text; document.body.appendChild(el); el.select();
      document.execCommand("copy"); document.body.removeChild(el);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4"
      style={{ background: "rgba(42,38,32,0.45)", backdropFilter: "blur(5px)" }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="ck-modal-in bg-white w-full max-w-lg shadow-2xl" style={{ borderRadius: 24 }}>
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: "1px solid #EFEBE3" }}>
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 flex items-center justify-center"
              style={{ borderRadius: 12, background: "linear-gradient(135deg, #3B362F 0%, #6E6456 100%)" }}>
              <FileText size={17} className="text-white" />
            </div>
            <div>
              <h2 className="font-bold" style={{ color: "#2C2823", fontFamily: FONT_DISPLAY }}>本日の記録まとめ</h2>
              <p className="text-xs" style={{ color: "#9C9488" }}>{today}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 rounded-xl transition-colors hover:bg-slate-100" style={{ color: "#9C9488" }}>
            <X size={18} />
          </button>
        </div>
        <div className="px-5 py-4">
          <div className="p-4 max-h-72 overflow-y-auto"
            style={{ background: "#F8F6F1", border: "1px solid #E7E2D9", borderRadius: 16 }}>
            <pre className="text-sm whitespace-pre-wrap leading-relaxed" style={{ color: "#3C372F", fontFamily: FONT_BODY }}>{text}</pre>
          </div>
          <p className="text-xs mt-2 text-center" style={{ color: "#9C9488" }}>{todayRecords.length}件の記録</p>
        </div>
        <div className="px-5 pb-5">
          <button onClick={handleCopy}
            className={`w-full flex items-center justify-center gap-2.5 py-4 rounded-2xl font-bold text-base transition-all duration-200 ${copied ? "" : "ck-btn-primary"}`}
            style={copied ? { background: "#6F7B59", color: "#fff" } : { fontFamily: FONT_DISPLAY }}>
            {copied ? <><Check size={20} /><span>コピーしました！</span></> : <><Copy size={20} /><span>全員分をまとめてコピー</span></>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── CloudBackupSection（ID・パスワード方式のバックアップ／復元）──────────────
function CloudBackupSection() {
  const { allLogs, settings, restoreData } = useApp();
  const cloudOK = isCloudConfigured();

  const [backupId, setBackupId] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(null);          // "backup" | "restore" | null
  const [status, setStatus] = useState(null);      // { type: "ok"|"error"|"info", text }
  const [pendingRestore, setPendingRestore] = useState(null); // 取得済みデータ（上書き前の確認用）

  const inputsOK = backupId.trim().length >= 1 && password.length >= 4;

  const totalDays = Object.keys(allLogs).length;
  const totalRecords = Object.values(allLogs).reduce((n, day) => n + (day.records?.length ?? 0), 0);

  const handleBackup = async () => {
    if (!inputsOK || busy) return;
    setBusy("backup"); setStatus(null); setPendingRestore(null);
    try {
      await cloudBackup(backupId, password, allLogs, settings);
      setStatus({ type: "ok", text: `バックアップが完了しました（${totalDays}日分・${totalRecords}件）。同じIDとパスワードで、いつでも・どの端末からでも復元できます。` });
    } catch (e) {
      setStatus({ type: "error", text: e.message || "バックアップに失敗しました。" });
    } finally {
      setBusy(null);
    }
  };

  const handleRestoreFetch = async () => {
    if (!inputsOK || busy) return;
    setBusy("restore"); setStatus(null); setPendingRestore(null);
    try {
      const data = await cloudRestoreFetch(backupId, password);
      const logs = data.logs ?? {};
      const days = Object.keys(logs).length;
      const records = Object.values(logs).reduce((n, day) => n + (day.records?.length ?? 0), 0);
      setPendingRestore({ data, days, records });
      setStatus({ type: "info", text: "バックアップが見つかりました。内容を確認して復元してください。" });
    } catch (e) {
      setStatus({ type: "error", text: e.message || "復元に失敗しました。" });
    } finally {
      setBusy(null);
    }
  };

  const handleRestoreConfirm = () => {
    if (!pendingRestore) return;
    restoreData(pendingRestore.data.logs, pendingRestore.data.settings);
    setStatus({ type: "ok", text: "復元が完了しました。「記録」「履歴」タブでデータをご確認ください。" });
    setPendingRestore(null);
  };

  const statusStyle = {
    ok:    { background: "#F2F4EC", border: "1px solid #CBD3B8", color: "#5A6840" },
    error: { background: "#FEF2F2", border: "1px solid #FECACA", color: "#B91C1C" },
    info:  { background: "#F3EFE7", border: "1px solid #E0D7C5", color: "#3B362F" },
  };

  return (
    <div className="ck-card p-5">
      <div className="flex items-center gap-2.5 mb-1">
        <div className="w-9 h-9 flex items-center justify-center flex-shrink-0"
          style={{ borderRadius: 12, background: cloudOK ? "linear-gradient(135deg, #3B362F 0%, #6E6456 100%)" : "#EFEBE3" }}>
          {cloudOK
            ? <Cloud size={17} className="text-white" />
            : <CloudOff size={17} style={{ color: "#B0A899" }} />}
        </div>
        <div>
          <h2 className="font-bold text-sm" style={{ color: "#2C2823", fontFamily: FONT_DISPLAY }}>データのバックアップと復元</h2>
          <p className="text-[11px]" style={{ color: "#9C9488" }}>機種変更・端末の引き継ぎに</p>
        </div>
      </div>

      {/* クラウド未設定の案内 */}
      {!cloudOK && (
        <div className="mt-3 px-3.5 py-3 rounded-xl"
          style={{ background: "#FFFBEB", border: "1px solid #FDE68A" }}>
          <p className="text-xs font-bold text-amber-700 mb-0.5">クラウド保存は準備中です</p>
          <p className="text-[11px] leading-relaxed text-amber-600">
            現在、記録はこの端末内のみに保存されています。コード内の firebaseConfig にFirebaseの設定値を入力すると、ここからバックアップ・復元ができるようになります。
          </p>
        </div>
      )}

      <div className="mt-4 space-y-3">
        {/* ID / パスワード入力 */}
        <div>
          <label className="block text-xs font-bold mb-1.5" style={{ color: "#9C9488" }}>ID（自由に決めてください）</label>
          <input type="text" value={backupId} onChange={e => setBackupId(e.target.value)}
            placeholder="例：kaigo-yamada" autoCapitalize="none" autoCorrect="off"
            disabled={!cloudOK}
            className="ck-input w-full px-4 py-3 text-base disabled:opacity-50" />
        </div>
        <div>
          <label className="block text-xs font-bold mb-1.5" style={{ color: "#9C9488" }}>パスワード（引き継ぎコード・4文字以上）</label>
          <div className="relative">
            <input type={showPw ? "text" : "password"} value={password} onChange={e => setPassword(e.target.value)}
              placeholder="忘れないものを設定" autoCapitalize="none"
              disabled={!cloudOK}
              className="ck-input w-full px-4 py-3 pr-12 text-base disabled:opacity-50" />
            <button onClick={() => setShowPw(v => !v)} disabled={!cloudOK}
              className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 rounded-lg transition-colors disabled:opacity-40"
              style={{ color: "#B0A899" }}
              title={showPw ? "パスワードを隠す" : "パスワードを表示"}>
              {showPw ? <EyeOff size={17} /> : <Eye size={17} />}
            </button>
          </div>
        </div>

        {/* 操作ボタン */}
        <div className="grid grid-cols-2 gap-2.5 pt-1">
          <button onClick={handleBackup} disabled={!cloudOK || !inputsOK || busy !== null}
            className={`flex items-center justify-center gap-1.5 py-3.5 rounded-xl font-bold text-sm ${cloudOK && inputsOK && !busy ? "ck-btn-primary" : "ck-btn-disabled"}`}>
            <UploadCloud size={16} />
            {busy === "backup" ? "保存中…" : "バックアップ"}
          </button>
          <button onClick={handleRestoreFetch} disabled={!cloudOK || !inputsOK || busy !== null}
            className="flex items-center justify-center gap-1.5 py-3.5 rounded-xl font-bold text-sm transition-all active:scale-95 disabled:cursor-not-allowed"
            style={cloudOK && inputsOK && !busy
              ? { background: "#F3EFE7", color: "#3B362F", border: "1.5px solid #E0D7C5" }
              : { background: "#EDE9E1", color: "#C5BDAE", border: "1.5px solid transparent" }}>
            <DownloadCloud size={16} />
            {busy === "restore" ? "確認中…" : "復元する"}
          </button>
        </div>

        {/* ステータスメッセージ */}
        {status && (
          <div className="px-3.5 py-3 rounded-xl text-xs leading-relaxed font-medium" style={statusStyle[status.type]}>
            {status.text}
          </div>
        )}

        {/* 復元の最終確認 */}
        {pendingRestore && (
          <div className="px-3.5 py-3.5 rounded-xl space-y-2.5"
            style={{ background: "#F8F6F1", border: "1.5px solid #E0D7C5" }}>
            <div className="flex items-center gap-2">
              <ShieldCheck size={15} style={{ color: "#A08C68" }} />
              <p className="text-xs font-bold" style={{ color: "#3B362F" }}>復元できるデータ</p>
            </div>
            <p className="text-xs leading-relaxed" style={{ color: "#5B554B" }}>
              {pendingRestore.days}日分・{pendingRestore.records}件の記録
              {pendingRestore.data.savedAt && (
                <span className="block mt-0.5" style={{ color: "#9C9488" }}>
                  最終バックアップ：{new Date(pendingRestore.data.savedAt).toLocaleString("ja-JP")}
                </span>
              )}
            </p>
            <p className="text-[11px] leading-relaxed text-amber-600 font-medium">
              ⚠ 復元すると、この端末の現在の記録はバックアップの内容で置き換えられます。
            </p>
            <div className="flex gap-2">
              <button onClick={() => { setPendingRestore(null); setStatus(null); }}
                className="flex-1 py-2.5 rounded-xl font-bold text-xs transition-all active:scale-95"
                style={{ background: "#EFEBE3", color: "#5B554B" }}>
                やめる
              </button>
              <button onClick={handleRestoreConfirm}
                className="ck-btn-primary flex-1 py-2.5 rounded-xl font-bold text-xs">
                この内容で復元する
              </button>
            </div>
          </div>
        )}

        {/* 注意書き */}
        <div className="pt-1 space-y-1.5">
          {[
            "メールアドレスや電話番号などの個人情報は使いません",
            "IDとパスワードを忘れるとデータを取り出せなくなります。メモ等に控えてください",
            "パスワードはそのままの形では保存されません（暗号化キーとしてのみ使用）",
          ].map((t, i) => (
            <p key={i} className="flex items-start gap-1.5 text-[11px] leading-relaxed" style={{ color: "#9C9488" }}>
              <KeyRound size={11} className="flex-shrink-0 mt-0.5" style={{ color: "#D5CDBE" }} />
              <span>{t}</span>
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Settings ─────────────────────────────────────────────────────────────────
function Settings() {
  const { auth, logout, isLoggedIn, syncStatus } = useApp();
  const cloudOK = isCloudConfigured();

  const syncLabel = { syncing: "同期中…", ok: "同期済み", error: "同期エラー", idle: "待機中" };
  const syncColor = { syncing: "#B49A6C", ok: "#7A8765", error: "#B91C1C", idle: "#9C9488" };

  return (
    <div className="space-y-4">

      {/* ── ログイン状態カード ── */}
      <div className="ck-card p-5">
        <div className="flex items-center gap-2.5 mb-3">
          <div className="w-9 h-9 flex items-center justify-center flex-shrink-0"
            style={{ borderRadius: 12, background: isLoggedIn && cloudOK ? "linear-gradient(135deg, #3B362F 0%, #6E6456 100%)" : "#EFEBE3" }}>
            {isLoggedIn && cloudOK ? <Cloud size={17} className="text-white" /> : <CloudOff size={17} style={{ color: "#B0A899" }} />}
          </div>
          <div>
            <h2 className="font-bold text-sm" style={{ color: "#2C2823", fontFamily: FONT_DISPLAY }}>クラウド同期</h2>
            <p className="text-[11px]" style={{ color: "#9C9488" }}>
              {isLoggedIn && cloudOK ? `同期中 — ${auth.userId}` : isLoggedIn ? "ログイン済み（クラウド未設定）" : "ログインしていません"}
            </p>
          </div>
        </div>

        {isLoggedIn ? (
          <div className="space-y-3">
            {/* 同期ステータス */}
            {cloudOK && (
              <div className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl"
                style={{ background: "#F8F6F1", border: "1px solid #E7E2D9" }}>
                <span style={{ color: syncColor[syncStatus] }}>
                  {syncStatus === "syncing" ? <RefreshCw size={14} className="animate-spin" /> : syncStatus === "ok" ? <Wifi size={14} /> : <WifiOff size={14} />}
                </span>
                <div>
                  <p className="text-xs font-bold" style={{ color: syncColor[syncStatus] }}>{syncLabel[syncStatus]}</p>
                  <p className="text-[11px]" style={{ color: "#9C9488" }}>記録の変更は自動的にクラウドへ保存されます</p>
                </div>
              </div>
            )}
            {/* ログアウトボタン */}
            <button onClick={logout}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-xl font-bold text-sm transition-all active:scale-95"
              style={{ background: "#F8F6F1", color: "#756E62", border: "1px solid #E7E2D9" }}>
              <LogOut size={15} />
              ログアウト（同期を停止）
            </button>
            <p className="text-[11px] leading-relaxed" style={{ color: "#BCC0B8" }}>
              ログアウトしても記録はこの端末に残ります。別のIDでログインしたい場合はログアウトしてください。
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-xs leading-relaxed" style={{ color: "#756E62" }}>
              ログインするとクラウドへ自動同期されます。複数端末で同じデータを使えます。
            </p>
            {!cloudOK && (
              <div className="px-3 py-2.5 rounded-xl"
                style={{ background: "#FFFBEB", border: "1px solid #FDE68A" }}>
                <p className="text-[11px] text-amber-700 leading-relaxed">
                  firebaseConfig が未設定のため、クラウド同期は利用できません。
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── ローカルモード向け手動バックアップ（ログアウト中のみ表示） ── */}
      {!isLoggedIn && <CloudBackupSection />}

      {/* ── アプリについて ── */}
      <div className="ck-card p-5">
        <h2 className="font-bold mb-3 text-sm" style={{ color: "#2C2823", fontFamily: FONT_DISPLAY }}>アプリについて</h2>
        <ul className="space-y-2 text-xs" style={{ color: "#877F72" }}>
          {[
            isLoggedIn && cloudOK
              ? "記録はクラウドに自動保存されます（端末にも30日間保存）"
              : "記録データはこの端末のブラウザに30日間保存されます",
            "ブラウザのキャッシュ削除でも、クラウド同期中はデータが消えません",
            "IDとパスワードを同じにすれば複数の端末で同じデータを使えます",
          ].map((t, i) => (
            <li key={i} className="flex items-start gap-2 leading-relaxed">
              <span className="mt-0.5" style={{ color: "#6E6456" }}>•</span><span>{t}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ─── HistoryView ──────────────────────────────────────────────────────────────
function CopyPastButton({ records }) {
  const [copied, setCopied] = useState(false);
  const text = formatOutput(records);
  const handleCopy = async () => {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const el = document.createElement("textarea");
      el.value = text; document.body.appendChild(el); el.select();
      document.execCommand("copy"); document.body.removeChild(el);
    }
    setCopied(true); setTimeout(() => setCopied(false), 2500);
  };
  if (records.length === 0) return null;
  return (
    <button onClick={handleCopy}
      className="w-full flex items-center justify-center gap-2 py-3.5 rounded-xl font-bold text-sm transition-all duration-200 active:scale-95"
      style={copied
        ? { background: "#6F7B59", color: "#fff" }
        : { background: "#EFEBE3", color: "#5B554B" }}>
      <FileText size={16} />
      {copied ? "コピーしました！" : "この日の記録をコピー"}
    </button>
  );
}

function HistoryView() {
  const { allLogs, selectedHistoryDate, setSelectedHistoryDate } = useApp();
  const today = todayStr();
  const availableDates = Object.keys(allLogs).filter(d => d !== today).sort((a, b) => b.localeCompare(a));
  const currentIndex = availableDates.indexOf(selectedHistoryDate);
  const dayLog = allLogs[selectedHistoryDate];

  if (availableDates.length === 0) {
    return (
      <div className="ck-card text-center py-12">
        <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-3"
          style={{ background: "linear-gradient(135deg, #F3EFE7, #F5F3EE)" }}>
          <Calendar size={26} style={{ color: "#D5CDBE" }} />
        </div>
        <p className="text-sm font-medium" style={{ color: "#9C9488" }}>過去の記録がありません</p>
        <p className="text-xs mt-1" style={{ color: "#C5BDAE" }}>記録が蓄積されると、ここで確認できます</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="ck-card p-4">
        <div className="flex items-center gap-2 mb-3">
          <Calendar size={15} style={{ color: "#A08C68" }} />
          <span className="text-xs font-bold" style={{ color: "#877F72", letterSpacing: "0.08em" }}>日付を選択</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => currentIndex < availableDates.length - 1 && setSelectedHistoryDate(availableDates[currentIndex + 1])}
            disabled={currentIndex >= availableDates.length - 1}
            className="p-2.5 rounded-xl transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            style={{ border: "1.5px solid #E3DED4", color: "#877F72" }}>
            <ChevronLeft size={16} />
          </button>
          <select value={selectedHistoryDate} onChange={e => setSelectedHistoryDate(e.target.value)}
            className="ck-input flex-1 px-3 py-2.5 text-sm font-bold"
            style={{ color: "#3C372F" }}>
            {availableDates.map(d => <option key={d} value={d}>{formatDate(d)}</option>)}
          </select>
          <button onClick={() => currentIndex > 0 && setSelectedHistoryDate(availableDates[currentIndex - 1])}
            disabled={currentIndex <= 0}
            className="p-2.5 rounded-xl transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            style={{ border: "1.5px solid #E3DED4", color: "#877F72" }}>
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      {!dayLog ? (
        <div className="ck-card text-center py-8">
          <p className="text-sm" style={{ color: "#9C9488" }}>この日の記録はありません</p>
        </div>
      ) : (
        <div className="space-y-3">
          {dayLog.outputAt && (
            <div className="flex items-center gap-2 px-1">
              <Clock size={12} style={{ color: "#6E6456" }} />
              <p className="text-xs" style={{ color: "#9C9488" }}>{formatTime(dayLog.outputAt)} に出力済み</p>
            </div>
          )}
          {dayLog.records.map((r, i) => (
            <div key={r.id} className="ck-card p-4" style={{ borderRadius: 18 }}>
              <div className="flex items-start gap-3">
                <span className="text-xs font-bold w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5"
                  style={{ background: "#F0EDE6", color: "#B0A899" }}>{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-bold text-sm" style={{ color: "#2C2823", fontFamily: FONT_DISPLAY }}>
                      {r.name ? `【${r.name}】` : "（氏名なし）"}
                    </span>
                    {r.checks && Object.values(r.checks).some(Boolean) && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-md font-bold"
                        style={{ background: "#ECE5D6", color: "#3B362F" }}>確認済</span>
                    )}
                  </div>
                  {r.memo && <p className="text-sm whitespace-pre-wrap leading-relaxed" style={{ color: "#5B554B" }}>{r.memo}</p>}
                  <p className="text-[11px] mt-1.5" style={{ color: "#CFC8BA" }}>{formatTime(r.createdAt)}</p>
                </div>
              </div>
            </div>
          ))}
          <CopyPastButton records={dayLog.records} />
        </div>
      )}
    </div>
  );
}

// ─── App Shell ────────────────────────────────────────────────────────────────
function AppShell() {
  const { view, setView, todayRecords, isLoggedIn } = useApp();
  const [showOutput, setShowOutput] = useState(false);

  // A record is "confirmed" if at least one check is ticked
  const isConfirmed = r => r.checks ? Object.values(r.checks).some(Boolean) : false;
  const allChecked = todayRecords.length > 0 && todayRecords.every(isConfirmed);
  const uncheckedCount = todayRecords.filter(r => !isConfirmed(r)).length;
  const today = new Date().toLocaleDateString("ja-JP", { month: "long", day: "numeric", weekday: "short" });

  const navItems = [
    { id: "main", icon: ClipboardList, label: "記録" },
    { id: "history", icon: History, label: "履歴" },
    { id: "settings", icon: SettingsIcon, label: "設定" },
  ];

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "#F2F0EB", fontFamily: FONT_BODY }}>
      {/* Header */}
      <header className="sticky top-0 z-40"
        style={{ background: "rgba(255,255,255,0.86)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)", borderBottom: "1px solid #E7E2D9" }}>
        <div className="max-w-lg mx-auto px-4 flex items-center justify-between"
          style={{ paddingTop: "calc(env(safe-area-inset-top) + 0.75rem)", paddingBottom: "0.75rem" }}>
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 flex items-center justify-center flex-shrink-0"
              style={{ borderRadius: 12, background: "linear-gradient(145deg, #3B362F 0%, #6E6456 100%)", boxShadow: "0 6px 14px -6px rgba(59,54,47,0.5)" }}>
              <AppLogoSvg size={26} />
            </div>
            <div>
              <h1 className="font-black text-lg leading-none" style={{ color: "#3B362F", fontFamily: FONT_DISPLAY, letterSpacing: "0.04em" }}>けあキロ</h1>
              <p className="text-[11px] mt-0.5" style={{ color: "#9C9488" }}>{today}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <SyncBadge />
            {todayRecords.length > 0 && (
              <span className="text-xs font-bold px-2.5 py-1 rounded-full"
                style={{ background: "linear-gradient(135deg, #ECE5D6, #F6F1E7)", color: "#3B362F" }}>
                {todayRecords.length}件
              </span>
            )}
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 max-w-lg mx-auto w-full px-4 py-5 space-y-4" style={{ paddingBottom: "6.5rem" }}>
        {view === "main" && (
          <>
            <RecordForm />
            {todayRecords.length > 0 && (
              <section>
                <h2 className="text-xs font-bold px-1 mb-3" style={{ color: "#9C9488", letterSpacing: "0.1em" }}>
                  本日の記録 — {todayRecords.length}件
                </h2>
                <RecordList />
              </section>
            )}
            {todayRecords.length > 0 && (
              <section className="pt-2">
                {!allChecked && (
                  <div className="flex items-start gap-2.5 px-4 py-3 mb-3 rounded-2xl"
                    style={{ background: "#FFFBEB", border: "1px solid #FDE68A" }}>
                    <AlertCircleIcon size={16} className="text-amber-500 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-bold text-amber-800">出力前に確認が必要です</p>
                      <p className="text-xs text-amber-600 mt-0.5">
                        {uncheckedCount}件で「次回予定をカレンダーに入力済み」チェックが未完了です
                      </p>
                    </div>
                  </div>
                )}
                {allChecked && (
                  <div className="flex items-center gap-2 px-4 py-3 mb-3 rounded-2xl"
                    style={{ background: "#F2F4EC", border: "1px solid #CBD3B8" }}>
                    <CheckCircle2 size={16} className="flex-shrink-0" style={{ color: "#7A8765" }} />
                    <p className="text-sm font-bold" style={{ color: "#5A6840" }}>全件チェック完了！出力できます</p>
                  </div>
                )}
                <button onClick={() => setShowOutput(true)} disabled={!allChecked}
                  title={!allChecked ? `${uncheckedCount}件のカレンダー確認チェックが未完了です` : ""}
                  className={`w-full flex items-center justify-center gap-2.5 py-4 rounded-2xl font-bold text-base ${allChecked ? "ck-btn-primary" : "ck-btn-disabled"}`}
                  style={{ fontFamily: FONT_DISPLAY }}>
                  <Send size={18} />
                  <span>本日の記録を出力する</span>
                </button>
              </section>
            )}
          </>
        )}

        {view === "history" && (
          <>
            <div className="flex items-center gap-2 px-1">
              <History size={16} style={{ color: "#A08C68" }} />
              <h2 className="font-bold" style={{ color: "#3C372F", fontFamily: FONT_DISPLAY }}>過去の記録</h2>
            </div>
            <HistoryView />
          </>
        )}

        {view === "settings" && (
          <>
            <div className="flex items-center gap-2 px-1">
              <SettingsIcon size={16} style={{ color: "#A08C68" }} />
              <h2 className="font-bold" style={{ color: "#3C372F", fontFamily: FONT_DISPLAY }}>設定</h2>
            </div>
            <Settings />
          </>
        )}
      </main>

      {/* Bottom nav */}
      <nav className="fixed bottom-0 inset-x-0 z-40"
        style={{ background: "rgba(255,255,255,0.92)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)", borderTop: "1px solid #E7E2D9" }}>
        <div className="max-w-lg mx-auto flex" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
          {navItems.map(({ id, icon: Icon, label }) => {
            const active = view === id;
            return (
              <button key={id} onClick={() => setView(id)}
                className="flex-1 flex flex-col items-center justify-center py-2.5 gap-1 transition-colors">
                <span className="flex items-center justify-center transition-all duration-200"
                  style={{
                    width: 44, height: 28, borderRadius: 14,
                    background: active ? "#ECE5D6" : "transparent",
                    color: active ? "#3B362F" : "#B0A899",
                  }}>
                  <Icon size={21} />
                </span>
                <span className="text-[10px] font-bold"
                  style={{ color: active ? "#3B362F" : "#B0A899" }}>{label}</span>
              </button>
            );
          })}
        </div>
      </nav>

      {showOutput && <OutputModal onClose={() => setShowOutput(false)} />}
    </div>
  );
}


// ─── Logo SVG (clipboard + heart, brushed up) ────────────────────────────────
function AppLogoSvg({ size = 48 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="ckHeart" x1="26" y1="32" x2="54" y2="57" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#D9C193" />
          <stop offset="1" stopColor="#B49A6C" />
        </linearGradient>
      </defs>
      {/* Clipboard body */}
      <rect x="14" y="18" width="52" height="54" rx="10" fill="white" fillOpacity="0.95"/>
      {/* Subtle text lines on clipboard */}
      <rect x="24" y="60" width="32" height="3" rx="1.5" fill="#3B362F" fillOpacity="0.14"/>
      {/* Clipboard clip at top */}
      <rect x="30" y="12" width="20" height="12" rx="6" fill="white" fillOpacity="0.95"/>
      <rect x="34" y="14" width="12" height="8" rx="4" fill="#D9C193"/>
      {/* Heart shape */}
      <path d="M40 57 C40 57 26 47.5 26 39.5 C26 35.36 29.36 32 33.5 32 C36.1 32 38.4 33.34 40 35.36 C41.6 33.34 43.9 32 46.5 32 C50.64 32 54 35.36 54 39.5 C54 47.5 40 57 40 57Z"
        fill="url(#ckHeart)"/>
      {/* Heart highlight */}
      <path d="M31 36.5 C31.8 35 33.4 34 35 34" stroke="white" strokeOpacity="0.6" strokeWidth="2" strokeLinecap="round"/>
    </svg>
  );
}

// ─── SplashScreen ─────────────────────────────────────────────────────────────
function SplashScreen({ onDone }) {
  const [phase, setPhase] = useState("in"); // "in" | "hold" | "out"

  useEffect(() => {
    // in(0) → hold(700ms) → out(3000ms) → done(3800ms)
    const t1 = setTimeout(() => setPhase("hold"), 700);
    const t2 = setTimeout(() => setPhase("out"),  3000);
    const t3 = setTimeout(() => onDone(),          3800);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, []);

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9999,
      background: "linear-gradient(165deg, #FDFCFB 0%, #F5F2EC 55%, #ECE7DD 100%)",
      display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center",
      overflow: "hidden",
      opacity: phase === "out" ? 0 : 1,
      transition: phase === "out" ? "opacity 0.8s ease" : "opacity 0.4s ease",
      fontFamily: FONT_DISPLAY,
    }}>
      {/* やわらかく呼吸する背景の光 */}
      <div style={{
        position: "absolute", width: 360, height: 360, borderRadius: "50%",
        background: "radial-gradient(circle, rgba(160,140,104,0.16) 0%, rgba(160,140,104,0) 70%)",
        animation: "ckBreathe 4.5s ease-in-out infinite",
      }} />
      <div style={{
        position: "absolute", width: 520, height: 520, borderRadius: "50%",
        background: "radial-gradient(circle, rgba(59,54,47,0.08) 0%, rgba(59,54,47,0) 70%)",
        animation: "ckBreathe 4.5s ease-in-out infinite 1.2s",
      }} />

      {/* Logo icon */}
      <div style={{
        position: "relative",
        width: 104, height: 104, borderRadius: 30,
        background: "linear-gradient(145deg, #3B362F 0%, #6E6456 60%, #C8AE7E 100%)",
        display: "flex", alignItems: "center", justifyContent: "center",
        marginBottom: 26,
        boxShadow: "0 18px 50px rgba(59,54,47,0.32), inset 0 1px 0 rgba(255,255,255,0.25)",
        opacity: phase === "in" ? 0 : 1,
        transform: phase === "in" ? "scale(0.82) translateY(10px)" : "scale(1) translateY(0)",
        transition: "opacity 0.55s ease, transform 0.6s cubic-bezier(0.34,1.56,0.64,1)",
      }}>
        <AppLogoSvg size={64} />
      </div>

      {/* Title */}
      <div style={{
        position: "relative",
        textAlign: "center",
        opacity: phase === "in" ? 0 : 1,
        transform: phase === "in" ? "translateY(14px)" : "translateY(0)",
        transition: "opacity 0.55s ease 0.18s, transform 0.55s ease 0.18s",
      }}>
        <p style={{
          fontSize: 40, fontWeight: 900, letterSpacing: "0.06em", lineHeight: 1.1, margin: 0,
          background: "linear-gradient(120deg, #3B362F 15%, #9A8459 85%)",
          WebkitBackgroundClip: "text", backgroundClip: "text",
          WebkitTextFillColor: "transparent", color: "#3B362F",
        }}>
          けあキロ
        </p>
        <p style={{ fontSize: 13, color: "#6E6456", fontWeight: 700, letterSpacing: "0.18em", marginTop: 10 }}>
          -Care no Kiroku-
        </p>
      </div>

      {/* Tagline */}
      <p style={{
        position: "relative",
        marginTop: 34, fontSize: 12.5, color: "#A39B8C", fontWeight: 500, letterSpacing: "0.12em",
        opacity: phase === "in" ? 0 : 1,
        transition: "opacity 0.55s ease 0.35s",
      }}>
        介護記録をかんたんに
      </p>
    </div>
  );
}

// ─── AppEntry（スプラッシュ → ログイン → メイン）─────────────────────────────
function AppEntry() {
  const { auth, login } = useApp();
  const [splashDone, setSplashDone] = useState(false);
  // 自動ログイン: localStorageに認証情報があれば画面スキップ
  const [loginDone, setLoginDone] = useState(() => Boolean(loadAuth()));

  const handleSplashDone = () => {
    try { sessionStorage.setItem("splash_shown", "1"); } catch {}
    setSplashDone(true);
  };

  // スプラッシュ中
  if (!splashDone) {
    return <SplashScreen onDone={handleSplashDone} />;
  }

  // ログイン画面（未ログイン かつ ログインスキップされていない場合）
  if (!loginDone) {
    return <LoginScreen onDone={() => setLoginDone(true)} />;
  }

  return <AppShell />;
}

export default function App() {
  return (
    <>
      <GlobalStyle />
      <AppProvider>
        <AppEntry />
      </AppProvider>
    </>
  );
}

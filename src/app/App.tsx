import { useState, useRef, useEffect } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, ErrorBar,
} from "recharts";
import { MapContainer, TileLayer, Marker, Tooltip as LeafletTooltip, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";

// Vite doesn't serve Leaflet's default marker images from the path its CSS
// expects — without this the pin silently renders as a broken image.
delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});
import {
  apiGet, apiPost, apiUploadFile,
  login as apiLogin, logout as apiLogout,
  changePassword as apiChangePassword, completeFacilityProfile, refreshCurrentUser, requestPasswordReset,
  adminListFacilities, adminCreateFacility, adminSetFacilityActive, adminResetAccountPassword,
  type AdminFacility, type AdminFacilityAccount, type CreateFacilityAccountResult, type AdminPasswordResetResult,
  uploadHistoricalInventorySnapshots, type HistoricalUploadResult,
  getMyFacilityProfile, updatePassword as apiUpdatePassword,
  listNotifications, markNotificationRead, markAllNotificationsRead, type NotificationItem,
  notifyNearbyHospitals, type NotifyNearbyHospitalsResult,
  listUploadHistory, downloadUploadHistoryFile, type UploadType, type UploadHistoryEntry,
  previewUploadUndo, applyUploadUndo, type UndoPreviewResult, type UndoRow, type UndoApplyResult,
} from "./lib/api";
import { getCurrentUser, type SessionUser } from "./lib/session";
import { isDevModeEnabled, getDevFacilityId, setDevFacilityId } from "./lib/devMode";
import {
  AlertTriangle, CheckCircle, Clock, MapPin, Send,
  Plus, Upload, Phone, Search, Bell, User, LogOut,
  Activity, Package, ArrowRight, ChevronDown,
  MessageSquare, RefreshCw, ShieldCheck, Zap, FlaskConical, Building2, TrendingUp,
  KeyRound, X, Download, History, RotateCcw,
} from "lucide-react";

type Screen = "login" | "dashboard" | "inventory" | "requests" | "chat";
type RequestTab = "sourcing" | "transfer" | "pending";

// ─── Data ────────────────────────────────────────────────────────────────────

const bloodCompatibility: Record<string, string[]> = {
  "A+":  ["A+", "A-", "O+", "O-"],
  "A-":  ["A-", "O-"],
  "B+":  ["B+", "B-", "O+", "O-"],
  "B-":  ["B-", "O-"],
  "O+":  ["O+", "O-"],
  "O-":  ["O-"],
  "AB+": ["A+", "A-", "B+", "B-", "O+", "O-", "AB+", "AB-"],
  "AB-": ["A-", "B-", "O-", "AB-"],
};

// Canonical display order for the 8 blood types — matches the order the
// Dashboard's own "Inventory by Blood Type" chart renders in, reused here
// (Inventory's grouped view) so the app doesn't have two conventions.
const BLOOD_TYPE_ORDER = ["A-", "A+", "AB-", "AB+", "B-", "B+", "O-", "O+"];

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Mirrors the backend's NOTIFY_EXPIRY_CRITICAL_DAYS / NOTIFY_EXPIRY_NEAR_DAYS
// (server/main.py) — can't literally share a constant across languages, but
// the two values must stay in sync: this is what decides "critical"/"near
// expiry" here, and the backend uses the same cutoffs to decide when an
// expiry notification actually fires. Named here (not inlined) so the two
// places in this file that care about "is this expiring soon" both go
// through one definition instead of each hardcoding 3/7 independently.
const EXPIRY_CRITICAL_DAYS = 3;
const EXPIRY_NEAR_DAYS = 7;

// Single source of truth for expiry status, shared by Inventory and Dashboard
// so the two screens can't quietly drift onto different day cutoffs.
type ExpiryStatus = "expired" | "critical" | "near-expiry" | "ok";

function getExpiryStatus(daysLeft: number): ExpiryStatus {
  if (daysLeft < 0) return "expired";
  if (daysLeft <= EXPIRY_CRITICAL_DAYS) return "critical";
  if (daysLeft <= EXPIRY_NEAR_DAYS) return "near-expiry";
  return "ok";
}

// The 3-state status language (safe/watch/critical — see theme.css's
// --status-* tokens) used identically everywhere status appears. "expired"
// is deliberately a 4th, separate neutral state — it isn't a warning level,
// it's inventory that's already unusable, so it gets its own gray treatment
// rather than being folded into "critical".
type StatusLevel = "safe" | "watch" | "critical";

const STATUS_STYLES: Record<StatusLevel, { badge: string; dot: string; panel: string; solid: string; text: string }> = {
  safe: {
    badge: "bg-status-safe-tint text-status-safe-text border-status-safe-border",
    dot: "bg-status-safe",
    panel: "bg-status-safe-tint border border-status-safe-border",
    solid: "bg-status-safe text-white",
    text: "text-status-safe-text",
  },
  watch: {
    badge: "bg-status-watch-tint text-status-watch-text border-status-watch-border",
    dot: "bg-status-watch",
    panel: "bg-status-watch-tint border border-status-watch-border",
    solid: "bg-status-watch text-white",
    text: "text-status-watch-text",
  },
  critical: {
    badge: "bg-status-critical-tint text-status-critical-text border-status-critical-border",
    dot: "bg-status-critical",
    panel: "bg-status-critical-tint border border-status-critical-border",
    solid: "bg-status-critical text-white",
    text: "text-status-critical-text",
  },
};

const EXPIRED_STYLE = {
  badge: "bg-gray-100 text-gray-600 border-gray-300",
  dot: "bg-gray-400",
  panel: "bg-gray-50 border border-gray-200",
  solid: "bg-gray-500 text-white",
  text: "text-gray-600",
};

const EXPIRY_STYLES: Record<ExpiryStatus, { badge: string; dot: string; rowTint: string; panel: string; solid: string; text: string; label: (daysLeft: number) => string }> = {
  expired: { ...EXPIRED_STYLE, rowTint: "bg-gray-50", label: () => "Expired" },
  critical: { ...STATUS_STYLES.critical, rowTint: "bg-status-critical-tint/50", label: (d) => `${d}d — Critical` },
  "near-expiry": { ...STATUS_STYLES.watch, rowTint: "bg-status-watch-tint/40", label: (d) => `${d}d — Near Expiry` },
  ok: { ...STATUS_STYLES.safe, rowTint: "", label: () => "OK" },
};

// units/min ratio → status level, the one rule used everywhere stock is
// judged against a minimum (dashboard grid, chart bars, threshold dots).
function stockStatus(units: number, min: number): StatusLevel {
  const ratio = min > 0 ? units / min : units > 0 ? 1 : 0;
  if (ratio < 0.6) return "critical";
  if (ratio < 0.9) return "watch";
  return "safe";
}

// Raw hex twins of the --status-* tokens, for the few spots (SVG/Recharts
// `fill`) that can't take a Tailwind class and need an actual color value.
const STATUS_HEX: Record<StatusLevel, string> = {
  safe: "#0F766E",
  watch: "#B8860B",
  critical: "#BD4024",
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function BloodDropLogo({ size = 32, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" className={className}>
      <path
        d="M16 4C16 4 7 14.5 7 20C7 24.97 11.03 29 16 29C20.97 29 25 24.97 25 20C25 14.5 16 4 16 4Z"
        fill="#8C1B3A"
      />
      <path
        d="M16 10C16 10 11 17 11 20.5C11 23.538 13.239 26 16 26"
        stroke="rgba(255,255,255,0.35)"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function StatusDot({ status }: { status: StatusLevel }) {
  return <span className={`inline-block w-2 h-2 rounded-full ${STATUS_STYLES[status].dot} mr-1.5`} />;
}

// The product's signature element — one shared badge for every blood type
// display, from table cells to search-picker buttons, so O-, A+, etc. always
// read the same way no matter where they appear.
const BLOOD_BADGE_SIZES = {
  sm: "h-6 min-w-[26px] px-1 text-[10.5px]",
  md: "h-7 min-w-[34px] px-1.5 text-[12px]",
  lg: "h-9 min-w-[44px] px-2 text-[15px]",
  // "Stamp" scale — the label-system treatment (Inventory group headers,
  // Emergency Sourcing's compatible-alternative badges), not for ordinary
  // inline use.
  xl: "h-14 min-w-[64px] px-3 text-[24px]",
} as const;

function BloodTypeBadge({ type, size = "md", selected = false, className = "" }: {
  type: string;
  size?: keyof typeof BLOOD_BADGE_SIZES;
  selected?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center justify-center rounded-md font-display font-bold tracking-tight leading-none ${BLOOD_BADGE_SIZES[size]} ${
        selected
          ? "bg-primary text-white"
          : "bg-white text-primary border border-primary/25 shadow-sm"
      } ${className}`}
    >
      {type}
    </span>
  );
}

// Inventory's DIN cell — wide-tracked mono text. Used only where a DIN is
// shown at label weight (Inventory rows).
function DinLabel({ din }: { din: string }) {
  return (
    <span className="inline-flex items-center font-mono text-[12px] tracking-wider uppercase text-foreground">
      {din}
    </span>
  );
}

// The "stamped" expiry callout — a bordered box colored by the same
// EXPIRY_STYLES status language used everywhere else, deliberately more
// visually weighted than the plain collection-date text next to it (mirrors
// how a real bag's printed expiry is the prominent, boxed date).
function DateStamp({ date, status }: { date: string; status: ExpiryStatus }) {
  const style = EXPIRY_STYLES[status];
  return (
    <span className={`inline-block font-mono text-[12px] font-semibold tracking-tight px-1.5 py-0.5 rounded border ${style.badge}`}>
      {date}
    </span>
  );
}

// Same row shown two ways (what will be removed, what's blocking removal) —
// one formatter so both stay in sync with whatever fields each upload type's
// eligible/blocked rows actually carry (see UndoRow in api.ts).
function formatUndoRow(uploadType: UploadType, row: UndoRow): string {
  if (uploadType === "inventory") return `${row.din} (${row.blood_type})`;
  if (uploadType === "donors") return `${row.name} — ${row.phone} (${row.blood_type})`;
  return `${row.snapshot_date} — ${row.blood_type}: ${row.units} units`;
}

// Confirmation step for "Undo this upload" — always previews fresh on open
// (never reuses a stale eligibility list) and shows exactly what would be
// removed and what's blocked, before anything actually happens.
function UndoUploadModal({ entry, onClose, onUndone }: {
  entry: UploadHistoryEntry;
  onClose: () => void;
  onUndone: () => void;
}) {
  const [preview, setPreview] = useState<UndoPreviewResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [result, setResult] = useState<UndoApplyResult | null>(null);

  useEffect(() => {
    previewUploadUndo(entry.id)
      .then(setPreview)
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Failed to load undo preview"))
      .finally(() => setLoading(false));
  }, [entry.id]);

  async function handleConfirm() {
    setApplying(true);
    setApplyError(null);
    try {
      const applied = await applyUploadUndo(entry.id);
      setResult(applied);
      onUndone();
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : "Failed to undo upload");
    } finally {
      setApplying(false);
    }
  }

  return (
    <Modal title="Undo This Upload" onClose={onClose}>
      {loading && <div className="py-8 text-center text-[14px] text-muted-foreground">Checking what can be undone…</div>}
      {!loading && loadError && (
        <div className="text-[13px] text-status-critical-text bg-status-critical-tint border border-status-critical-border rounded-md px-3 py-2">
          {loadError}
        </div>
      )}

      {!loading && !loadError && preview && preview.already_undone && !result && (
        <div className="text-center py-3">
          <p className="text-[13px] text-muted-foreground mb-4">This upload has already been undone.</p>
          <button onClick={onClose} className="w-full h-10 bg-primary text-white text-sm font-bold rounded-md hover:bg-primary-hover transition-colors">
            Close
          </button>
        </div>
      )}

      {!loading && !loadError && preview && !preview.already_undone && !result && (
        <div className="space-y-4">
          <p className="text-[13px] text-muted-foreground">
            {entry.filename ?? "This upload"} — uploaded{" "}
            {new Date(entry.uploaded_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}.
          </p>

          {preview.eligible.length === 0 && preview.blocked.length === 0 && (
            <div className="text-[13px] text-muted-foreground">There's nothing left from this upload to remove.</div>
          )}

          {preview.eligible.length > 0 && (
            <div>
              <div className="text-[12px] font-bold text-foreground mb-1.5">
                Will remove {preview.eligible.length} record{preview.eligible.length === 1 ? "" : "s"}:
              </div>
              <div className="max-h-40 overflow-y-auto border border-border rounded-lg divide-y divide-border">
                {preview.eligible.map((row, i) => (
                  <div key={i} className="px-3 py-1.5 text-[12px] font-mono text-foreground">
                    {formatUndoRow(preview.upload_type, row)}
                  </div>
                ))}
              </div>
            </div>
          )}

          {preview.blocked.length > 0 && (
            <div className="rounded-lg border border-status-watch-border bg-status-watch-tint px-3 py-2.5">
              <div className="flex items-center gap-1.5 text-[12px] font-bold text-status-watch-text mb-1.5">
                <AlertTriangle size={13} /> {preview.blocked.length} record{preview.blocked.length === 1 ? "" : "s"} can't be removed
              </div>
              <div className="space-y-1">
                {preview.blocked.map((row, i) => (
                  <div key={i} className="text-[12px] text-status-watch-text">
                    {formatUndoRow(preview.upload_type, row)} — {row.reason}
                  </div>
                ))}
              </div>
            </div>
          )}

          {applyError && (
            <div className="text-[12px] text-status-critical-text bg-status-critical-tint border border-status-critical-border rounded-md px-3 py-2">
              {applyError}
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="flex-1 h-10 border border-border rounded-md text-sm font-semibold text-foreground hover:bg-secondary transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              disabled={applying}
              className="flex-1 h-10 bg-status-critical-text text-white text-sm font-bold rounded-md hover:opacity-90 transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
            >
              {applying ? (
                <><RefreshCw size={15} className="animate-spin" /> Removing…</>
              ) : preview.eligible.length > 0 ? (
                `Confirm undo (${preview.eligible.length})`
              ) : (
                "Confirm"
              )}
            </button>
          </div>
        </div>
      )}

      {result && (
        <div className="text-center py-3">
          <div className="w-12 h-12 rounded-full bg-status-safe-tint flex items-center justify-center mx-auto mb-3">
            <CheckCircle size={22} className="text-status-safe" />
          </div>
          <div className="font-display font-bold text-foreground mb-1">
            {result.removed_count} record{result.removed_count === 1 ? "" : "s"} removed
          </div>
          {result.blocked.length > 0 && (
            <p className="text-[13px] text-status-watch-text mb-3">
              {result.blocked.length} record{result.blocked.length === 1 ? "" : "s"} couldn't be removed — see reasons above.
            </p>
          )}
          <button
            onClick={onClose}
            className="w-full h-10 bg-primary text-white text-sm font-bold rounded-md hover:bg-primary-hover transition-colors"
          >
            Done
          </button>
        </div>
      )}
    </Modal>
  );
}

// ─── Upload History ─────────────────────────────────────────────────────────
// Shared by Inventory, Donors, and the Dashboard's historical-stock backfill
// — one component, one facility-scoped log behind all three. `refreshKey`
// lets each screen force a reload right after its own upload finishes,
// without this component needing to know how that upload happened.
// `onUndone` lets the same screen also refresh its OWN primary data (the
// units table, donor count, forecast) once an undo actually removes something.
function UploadHistoryPanel({ uploadType, refreshKey, onUndone }: { uploadType: UploadType; refreshKey?: number; onUndone?: () => void }) {
  const [entries, setEntries] = useState<UploadHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [downloadingId, setDownloadingId] = useState<number | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [undoEntry, setUndoEntry] = useState<UploadHistoryEntry | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    listUploadHistory(uploadType)
      .then(setEntries)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load upload history"))
      .finally(() => setLoading(false));
  }
  useEffect(() => { load(); }, [uploadType, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleDownload(entry: UploadHistoryEntry) {
    setDownloadingId(entry.id);
    setDownloadError(null);
    try {
      await downloadUploadHistoryFile(entry.id, entry.filename ?? `${entry.upload_type}-upload-${entry.id}.csv`);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : "Failed to download file");
    } finally {
      setDownloadingId(null);
    }
  }

  return (
    <div className="bg-white border border-border rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-secondary flex items-center justify-center">
            <History size={14} className="text-muted-foreground" />
          </div>
          <h3 className="font-semibold text-foreground text-[15px]">Upload History</h3>
        </div>
        <button onClick={load} className="text-[11px] font-semibold text-muted-foreground hover:text-foreground transition-colors">
          Refresh
        </button>
      </div>

      {loading && <div className="py-6 text-center text-[13px] text-muted-foreground">Loading…</div>}
      {!loading && error && <div className="py-4 text-center text-[13px] text-red-700">Failed to load: {error}</div>}
      {!loading && !error && entries.length === 0 && (
        <div className="py-6 text-center text-[13px] text-muted-foreground">No uploads yet.</div>
      )}
      {!loading && !error && entries.length > 0 && (
        <div className="space-y-2">
          {entries.map((entry) => {
            const expanded = expandedId === entry.id;
            const hasErrors = entry.rows_failed > 0;
            const isUndone = entry.undone_at !== null;
            return (
              <div key={entry.id} className="border border-border rounded-lg overflow-hidden">
                <button
                  onClick={() => setExpandedId(expanded ? null : entry.id)}
                  className="w-full px-3 py-2.5 text-left hover:bg-secondary transition-colors"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[12.5px] font-semibold text-foreground truncate min-w-0">
                      {entry.filename ?? "Untitled upload"}
                    </div>
                    <ChevronDown size={14} className={`text-muted-foreground transition-transform shrink-0 ${expanded ? "rotate-180" : ""}`} />
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-0.5 truncate">
                    {new Date(entry.uploaded_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
                    {entry.uploaded_by_email && ` · ${entry.uploaded_by_email}`}
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
                    {isUndone && (
                      <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full border whitespace-nowrap bg-secondary text-muted-foreground border-border">
                        Undone {new Date(entry.undone_at!).toLocaleDateString([], { dateStyle: "medium" })}
                      </span>
                    )}
                    <span
                      className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border whitespace-nowrap ${
                        hasErrors
                          ? "bg-status-watch-tint text-status-watch-text border-status-watch-border"
                          : "bg-status-safe-tint text-status-safe-text border-status-safe-border"
                      }`}
                    >
                      {entry.rows_processed} processed{hasErrors ? `, ${entry.rows_failed} failed` : ""}
                    </span>
                  </div>
                </button>
                {expanded && (
                  <div className="px-3 py-2.5 border-t border-border bg-[#FAFAFA] space-y-2">
                    {entry.has_raw_content ? (
                      <button
                        onClick={() => handleDownload(entry)}
                        disabled={downloadingId === entry.id}
                        className="flex items-center gap-1.5 text-[11px] font-semibold text-primary hover:underline disabled:opacity-60"
                      >
                        <Download size={12} /> {downloadingId === entry.id ? "Downloading…" : "Download original file"}
                      </button>
                    ) : (
                      <div className="text-[11px] text-muted-foreground">
                        The original file isn't stored for this upload type.
                      </div>
                    )}
                    {downloadError && <div className="text-[11px] text-red-700">{downloadError}</div>}
                    {entry.error_details.length > 0 && (
                      <div className="space-y-1">
                        <div className="text-[11px] font-semibold text-foreground">Rows that failed:</div>
                        {entry.error_details.map((e, i) => (
                          <div key={i} className="text-[11px] text-red-700">
                            Row {e.row}: {e.reason}
                          </div>
                        ))}
                      </div>
                    )}
                    {!isUndone && (
                      <button
                        onClick={() => setUndoEntry(entry)}
                        className="flex items-center gap-1.5 text-[11px] font-semibold text-status-critical-text hover:underline"
                      >
                        <RotateCcw size={12} /> Undo this upload
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {undoEntry && (
        <UndoUploadModal
          entry={undoEntry}
          onClose={() => setUndoEntry(null)}
          onUndone={() => { load(); onUndone?.(); }}
        />
      )}
    </div>
  );
}

// ─── Top Navigation ───────────────────────────────────────────────────────────

function TopNav({
  screen, setScreen, onLogout, user, onNotificationNavigate,
}: {
  screen: Screen;
  setScreen: (s: Screen) => void;
  onLogout: () => void;
  user: SessionUser;
  onNotificationNavigate: (n: NotificationItem) => void;
}) {
  // Donors is blood-bank-only, the same split already applied to Forecasting
  // (GET /forecast) vs. threshold status — a hospital account gets no tab
  // for it at all, matching the server-side rejection in _require_bloodbank_facility.
  const navItems: { key: Screen; label: string; icon: React.ReactNode }[] = [
    { key: "dashboard", label: "Dashboard", icon: <Activity size={17} /> },
    { key: "inventory", label: "Inventory", icon: <Package size={17} /> },
    { key: "requests", label: "Requests", icon: <MapPin size={17} /> },
    ...(user.facility_type !== "hospital" ? [{ key: "chat" as const, label: "Donors", icon: <Phone size={17} /> }] : []),
  ];

  return (
    <header className="sticky top-0 z-[1100] bg-white border-b border-border">
      <div className="max-w-screen-xl mx-auto px-6 flex items-center gap-8 h-14">
        {/* Logo */}
        <div className="flex items-center gap-2.5 shrink-0">
          <BloodDropLogo size={28} />
          <span className="text-[15px] font-bold tracking-tight text-foreground">
            Blood<span className="text-primary">Link</span>
          </span>
        </div>

        {/* Nav */}
        <nav className="flex items-center gap-1 flex-1">
          {navItems.map((item) => (
            <button
              key={item.key}
              onClick={() => setScreen(item.key)}
              className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded text-[13px] font-medium transition-colors ${
                screen === item.key
                  ? "bg-accent text-primary"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary"
              }`}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </nav>

        {/* Right */}
        <div className="flex items-center gap-3">
          <NotificationBell onNavigate={onNotificationNavigate} />
          <AccountMenu user={user} onLogout={onLogout} />
        </div>
      </div>
    </header>
  );
}

// ─── Login Screen ─────────────────────────────────────────────────────────────

// Permanent demo accounts (seeded server-side) so the two dashboard
// experiences — forecast for blood banks, threshold/action for hospitals,
// see Section 2.7 of the status report — are one click away to try, without
// needing to know real facility credentials.
const DEMO_ACCOUNTS = {
  hospital: { email: "demo.hospital@example.com", password: "BloodLinkDemo123!", label: "Hospital" },
  bloodbank: { email: "demo.bloodbank@example.com", password: "BloodLinkDemo123!", label: "Blood Bank" },
  admin: { email: "demo.admin@example.com", password: "BloodLinkDemo123!", label: "Admin" },
} as const;

type DemoAccountType = keyof typeof DEMO_ACCOUNTS;

// "temp_password": an admin just created/reset this account and issued a
// one-time password — reused as-is by /auth/change-password's ChangePasswordBody.
// "self_service": the facility itself requested this via "Forgot password?" —
// same token shape and same set-new-password form, different framing copy.
type PendingReset = { resetToken: string; email: string; facilityName: string; reason: "temp_password" | "self_service" };

function LoginScreen({ onLogin }: { onLogin: (user: SessionUser) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedDemo, setSelectedDemo] = useState<DemoAccountType | null>(null);
  const [pendingReset, setPendingReset] = useState<PendingReset | null>(null);

  const [forgotMode, setForgotMode] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotLoading, setForgotLoading] = useState(false);
  const [forgotError, setForgotError] = useState<string | null>(null);

  function handleSelectDemo(type: DemoAccountType) {
    setSelectedDemo(type);
    setEmail(DEMO_ACCOUNTS[type].email);
    setPassword(DEMO_ACCOUNTS[type].password);
    setError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const result = await apiLogin(email, password);
      if (result.mustChangePassword) {
        // No access token was issued — see api.ts's LoginResult. Nothing to
        // do here but hand off to the forced-reset form; onLogin only fires
        // once that form actually establishes a real session.
        setPendingReset({ resetToken: result.resetToken, email: result.email, facilityName: result.facilityName, reason: "temp_password" });
      } else {
        onLogin(result.user);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleForgotSubmit(e: React.FormEvent) {
    e.preventDefault();
    setForgotLoading(true);
    setForgotError(null);
    try {
      const result = await requestPasswordReset(forgotEmail);
      setPendingReset({ resetToken: result.resetToken, email: result.email, facilityName: result.facilityName, reason: "self_service" });
      setForgotMode(false);
      setForgotEmail("");
    } catch (err) {
      setForgotError(err instanceof Error ? err.message : "Failed to request a reset");
    } finally {
      setForgotLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#F8F9FB] flex">
      {/* Left panel */}
      <div className="hidden lg:flex flex-col justify-between w-[480px] bg-primary text-white p-12">
        <div>
          <div className="flex items-center gap-3 mb-16">
            <BloodDropLogo size={36} />
            <span className="text-xl font-bold tracking-tight">BloodLink</span>
          </div>
          <h1 className="text-4xl font-bold leading-tight mb-6">
            Connected blood supply for modern healthcare
          </h1>
          <p className="text-white/70 text-[15px] leading-relaxed">
            Real-time inventory management, emergency sourcing, and donor coordination — unified for blood banks and hospitals across the network.
          </p>
        </div>

        <div className="space-y-4">
          {[
            { icon: <ShieldCheck size={16} />, text: "Verified healthcare facilities only" },
            { icon: <Zap size={16} />, text: "Live shortage alerts and forecasting" },
            { icon: <RefreshCw size={16} />, text: "Automated donor outreach via SMS" },
          ].map((item, i) => (
            <div key={i} className="flex items-center gap-3 text-white/80 text-sm">
              <div className="w-7 h-7 rounded bg-white/15 flex items-center justify-center shrink-0">
                {item.icon}
              </div>
              {item.text}
            </div>
          ))}
        </div>
      </div>

      {/* Right panel */}
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="w-full max-w-[400px]">
          <div className="flex items-center gap-2 mb-2 lg:hidden">
            <BloodDropLogo size={28} />
            <span className="text-lg font-bold">Blood<span className="text-primary">Link</span></span>
          </div>

          {pendingReset ? (
            <ForcePasswordChangeForm
              pendingReset={pendingReset}
              onCancel={() => setPendingReset(null)}
              onSuccess={onLogin}
            />
          ) : forgotMode ? (
            <>
              <h2 className="font-display text-2xl font-bold text-foreground mb-1">Reset your password</h2>
              <p className="text-muted-foreground text-sm mb-6">
                Enter the email address on your facility's account. If it's active, we'll generate a reset code you can use right away — no email needed.
              </p>

              <form onSubmit={handleForgotSubmit} className="space-y-4">
                <div>
                  <label className="text-[13px] font-semibold text-foreground block mb-1.5">
                    Email address
                  </label>
                  <input
                    type="email"
                    required
                    autoComplete="email"
                    value={forgotEmail}
                    onChange={(e) => setForgotEmail(e.target.value)}
                    className="w-full h-10 px-3 text-sm border border-border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all"
                  />
                </div>

                {forgotError && (
                  <div className="text-[12px] text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
                    {forgotError}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={forgotLoading}
                  className="w-full h-10 bg-primary text-white text-sm font-semibold rounded-md hover:bg-primary-hover transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
                >
                  {forgotLoading ? (
                    <><RefreshCw size={15} className="animate-spin" /> Requesting…</>
                  ) : (
                    "Send me a reset code"
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => { setForgotMode(false); setForgotError(null); }}
                  className="w-full text-[12px] text-muted-foreground hover:text-foreground transition-colors"
                >
                  Back to sign in
                </button>
              </form>
            </>
          ) : (
            <>
              <h2 className="font-display text-2xl font-bold text-foreground mb-1">Sign in</h2>
              <p className="text-muted-foreground text-sm mb-4">
                Access your facility's blood management dashboard.
              </p>

              <div className="mb-5">
                <p className="text-[12px] font-semibold text-muted-foreground mb-1.5">Quick demo login</p>
                <div className="flex gap-1 bg-secondary rounded-lg p-1">
                  {(Object.keys(DEMO_ACCOUNTS) as DemoAccountType[]).map((type) => (
                    <button
                      key={type}
                      type="button"
                      onClick={() => handleSelectDemo(type)}
                      className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-[13px] font-semibold rounded transition-colors ${
                        selectedDemo === type
                          ? "bg-white text-foreground shadow-sm border border-border"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {type === "hospital" ? <Building2 size={15} /> : type === "bloodbank" ? <FlaskConical size={15} /> : <ShieldCheck size={15} />}
                      {DEMO_ACCOUNTS[type].label}
                    </button>
                  ))}
                </div>
              </div>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="text-[13px] font-semibold text-foreground block mb-1.5">
                    Email address
                  </label>
                  <input
                    type="email"
                    required
                    autoComplete="email"
                    value={email}
                    onChange={(e) => { setEmail(e.target.value); setSelectedDemo(null); }}
                    className="w-full h-10 px-3 text-sm border border-border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all"
                  />
                </div>
                <div>
                  <div className="flex justify-between mb-1.5">
                    <label className="text-[13px] font-semibold text-foreground">Password</label>
                    <button
                      type="button"
                      onClick={() => { setForgotMode(true); setError(null); setForgotEmail(email); }}
                      className="text-[12px] text-primary hover:underline"
                    >
                      Forgot password?
                    </button>
                  </div>
                  <input
                    type="password"
                    required
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => { setPassword(e.target.value); setSelectedDemo(null); }}
                    className="w-full h-10 px-3 text-sm border border-border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all"
                  />
                </div>

                {error && (
                  <div className="text-[12px] text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full h-10 bg-primary text-white text-sm font-semibold rounded-md hover:bg-primary-hover transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
                >
                  {loading ? (
                    <><RefreshCw size={15} className="animate-spin" /> Signing in…</>
                  ) : (
                    "Sign in"
                  )}
                </button>
              </form>

              <div className="mt-8 p-4 rounded-lg bg-amber-50 border border-amber-200 flex gap-3">
                <ShieldCheck size={16} className="text-amber-600 shrink-0 mt-0.5" />
                <p className="text-[12px] text-amber-800 leading-relaxed">
                  <strong>Admin-provisioned accounts.</strong> New facilities are onboarded by a BloodLink administrator, who issues a temporary password for first sign-in — there's no self-service registration.
                </p>
              </div>

              <p className="mt-6 text-center text-[12px] text-muted-foreground">
                Need access? Contact your BloodLink administrator.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ForcePasswordChangeForm({
  pendingReset,
  onCancel,
  onSuccess,
}: {
  pendingReset: PendingReset;
  onCancel: () => void;
  onSuccess: (user: SessionUser) => void;
}) {
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("Passwords don't match");
      return;
    }
    setLoading(true);
    try {
      const user = await apiChangePassword(pendingReset.resetToken, newPassword);
      onSuccess(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to set new password");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <h2 className="font-display text-2xl font-bold text-foreground mb-1">Set a new password</h2>
      <p className="text-muted-foreground text-sm mb-1">
        {pendingReset.facilityName} — {pendingReset.email}
      </p>
      <p className={`text-muted-foreground text-sm ${pendingReset.reason === "self_service" ? "mb-2" : "mb-6"}`}>
        {pendingReset.reason === "self_service"
          ? "You requested a password reset for this account. Choose a new password to continue."
          : "This account was created with a temporary password. Choose a new one to continue."}
      </p>
      {pendingReset.reason === "self_service" && (
        <p className="text-[11px] font-mono text-muted-foreground bg-secondary rounded px-2 py-1.5 mb-6 break-all">
          reset code (no email provider connected — shown here instead): {pendingReset.resetToken.slice(0, 24)}…
        </p>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="text-[13px] font-semibold text-foreground block mb-1.5">New password</label>
          <input
            type="password"
            required
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="w-full h-10 px-3 text-sm border border-border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all"
          />
        </div>
        <div>
          <label className="text-[13px] font-semibold text-foreground block mb-1.5">Confirm new password</label>
          <input
            type="password"
            required
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className="w-full h-10 px-3 text-sm border border-border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all"
          />
        </div>

        {error && (
          <div className="text-[12px] text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full h-10 bg-primary text-white text-sm font-semibold rounded-md hover:bg-primary-hover transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
        >
          {loading ? (
            <><RefreshCw size={15} className="animate-spin" /> Setting password…</>
          ) : (
            "Set password and continue"
          )}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="w-full text-[12px] text-muted-foreground hover:text-foreground transition-colors"
        >
          Back to sign in
        </button>
      </form>
    </>
  );
}

// ─── Complete Profile (post-onboarding) ────────────────────────────────────
// Default center: Metro Manila, matching where the seeded demo facilities
// already are — a sane starting point for a new facility that hasn't
// searched or placed its pin yet.
const DEFAULT_MAP_CENTER: [number, number] = [14.5995, 120.9842];
const DEFAULT_MAP_ZOOM = 12;
const PIN_PLACED_ZOOM = 15;

function RecenterMap({ position, zoom }: { position: [number, number]; zoom: number }) {
  const map = useMap();
  useEffect(() => {
    map.setView(position, zoom);
  }, [position[0], position[1]]);
  return null;
}

function LocationClickHandler({ onPick }: { onPick: (lat: number, lng: number) => void }) {
  useMap().on("click", (e) => onPick(e.latlng.lat, e.latlng.lng));
  return null;
}

// Selected candidate reads as the primary pin (larger, brand red); every
// other ranked candidate stays visible but visually secondary (small, muted)
// — panning across the real map is how you see the whole ranked list at once.
function facilityMarkerIcon(selected: boolean): L.DivIcon {
  const size = selected ? 24 : 13;
  const color = selected ? "#8C1B3A" : "#9CA3AF";
  const border = selected ? 3 : 2;
  return L.divIcon({
    className: "",
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:${border}px solid white;box-shadow:0 1px 5px rgba(17,24,39,0.35);"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

// Real Leaflet/OpenStreetMap map for Emergency Sourcing — replaces the old
// hand-drawn SVG city grid. `key`'d by search type at the call site so a new
// search (a genuinely different candidate set from GET /facilities/nearby)
// remounts with a fresh bounds fit, rather than trying to imperatively
// re-fit an existing map instance.
function FacilityNetworkMap({
  banks, selectedBankId, onSelectBank,
}: {
  banks: Facility[];
  selectedBankId: number | null;
  onSelectBank: (id: number) => void;
}) {
  const positions = banks.map((b): [number, number] => [b.latitude, b.longitude]);
  const bounds: [[number, number], [number, number]] =
    positions.length > 0
      ? [
          [Math.min(...positions.map((p) => p[0])), Math.min(...positions.map((p) => p[1]))],
          [Math.max(...positions.map((p) => p[0])), Math.max(...positions.map((p) => p[1]))],
        ]
      : [DEFAULT_MAP_CENTER, DEFAULT_MAP_CENTER];

  // Deliberately no auto-recenter on selection — the whole ranked list stays
  // in view (the initial bounds fit above), and the selected pin just grows
  // and changes color in place. Re-centering on every click would fight the
  // "see the whole network at once" point of showing every candidate.
  return (
    <MapContainer
      bounds={bounds}
      boundsOptions={{ padding: [36, 36] }}
      style={{ height: "100%", width: "100%" }}
      scrollWheelZoom={false}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      {banks.map((bank) => (
        <Marker
          key={bank.id}
          position={[bank.latitude, bank.longitude]}
          icon={facilityMarkerIcon(bank.id === selectedBankId)}
          eventHandlers={{ click: () => onSelectBank(bank.id) }}
        >
          <LeafletTooltip direction="top" offset={[0, -6]}>
            <span className="font-semibold">{bank.name}</span> — {bank.distance_km} km
          </LeafletTooltip>
        </Marker>
      ))}
    </MapContainer>
  );
}

// Shared by CompleteProfileScreen (first-time onboarding) and
// EditFacilityProfileModal (Account menu, after the fact) — the exact same
// address/geocode/map/department/DOH-license fields, just wrapped in
// different layouts with different submit handling. All state is
// controlled from the parent so both callers can prefill it differently.
function FacilityLocationFields({
  address, onAddressChange,
  position, onPositionChange,
  department, onDepartmentChange,
  dohLicense, onDohLicenseChange,
}: {
  address: string;
  onAddressChange: (v: string) => void;
  position: [number, number] | null;
  onPositionChange: (p: [number, number]) => void;
  department: string;
  onDepartmentChange: (v: string) => void;
  dohLicense: string;
  onDohLicenseChange: (v: string) => void;
}) {
  const [geocoding, setGeocoding] = useState(false);
  const [geocodeError, setGeocodeError] = useState<string | null>(null);

  async function handleLookUpAddress() {
    if (!address.trim()) return;
    setGeocoding(true);
    setGeocodeError(null);
    try {
      // OSM Nominatim's public search endpoint — free, no API key, rate-limited
      // to ~1 req/sec which this "look up on click" pattern respects (never
      // fires on keystroke).
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address)}`
      );
      if (!res.ok) throw new Error("Address lookup failed");
      const results = await res.json();
      if (results.length === 0) {
        setGeocodeError("No match found — try a more specific address, or drop the pin manually on the map.");
        return;
      }
      onPositionChange([parseFloat(results[0].lat), parseFloat(results[0].lon)]);
    } catch (err) {
      setGeocodeError(err instanceof Error ? err.message : "Address lookup failed");
    } finally {
      setGeocoding(false);
    }
  }

  return (
    <>
      <div>
        <label className="text-[13px] font-semibold text-foreground block mb-1.5">Address</label>
        <div className="flex gap-2">
          <input
            type="text"
            required
            value={address}
            onChange={(e) => onAddressChange(e.target.value)}
            placeholder="Street, barangay, city"
            className="flex-1 h-10 px-3 text-sm border border-border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all"
          />
          <button
            type="button"
            onClick={handleLookUpAddress}
            disabled={geocoding || !address.trim()}
            className="h-10 px-4 bg-white border border-border rounded-md text-[13px] font-semibold text-foreground hover:bg-secondary transition-colors disabled:opacity-60 flex items-center gap-1.5 shrink-0"
          >
            <Search size={15} /> {geocoding ? "Looking up…" : "Look up"}
          </button>
        </div>
        {geocodeError && <p className="text-[12px] text-status-critical-text mt-1.5">{geocodeError}</p>}
      </div>

      <div>
        <label className="text-[13px] font-semibold text-foreground block mb-1.5">
          Confirm location on map
        </label>
        <p className="text-[12px] text-muted-foreground mb-2">
          Look up your address above, or click anywhere on the map to place the pin. Drag it to fine-tune.
        </p>
        <div className="h-72 rounded-lg overflow-hidden border border-border">
          <MapContainer center={position ?? DEFAULT_MAP_CENTER} zoom={position ? PIN_PLACED_ZOOM : DEFAULT_MAP_ZOOM} style={{ height: "100%", width: "100%" }}>
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            <LocationClickHandler onPick={(lat, lng) => onPositionChange([lat, lng])} />
            {position && (
              <>
                <RecenterMap position={position} zoom={PIN_PLACED_ZOOM} />
                <Marker
                  position={position}
                  draggable
                  eventHandlers={{
                    dragend: (e) => {
                      const marker = e.target as L.Marker;
                      const { lat, lng } = marker.getLatLng();
                      onPositionChange([lat, lng]);
                    },
                  }}
                />
              </>
            )}
          </MapContainer>
        </div>
        {position && (
          <p className="text-[11px] text-muted-foreground mt-1.5 font-mono">
            {position[0].toFixed(5)}, {position[1].toFixed(5)}
          </p>
        )}
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        <div>
          <label className="text-[13px] font-semibold text-foreground block mb-1.5">Department / Branch</label>
          <input
            type="text"
            required
            value={department}
            onChange={(e) => onDepartmentChange(e.target.value)}
            placeholder="e.g. Blood Services Unit"
            className="w-full h-10 px-3 text-sm border border-border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all"
          />
        </div>
        <div>
          <label className="text-[13px] font-semibold text-foreground block mb-1.5">DOH license number</label>
          <input
            type="text"
            required
            value={dohLicense}
            onChange={(e) => onDohLicenseChange(e.target.value)}
            placeholder="e.g. DOH-BSU-00123"
            className="w-full h-10 px-3 text-sm border border-border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all"
          />
        </div>
      </div>
    </>
  );
}

function CompleteProfileScreen({ user, onComplete }: { user: SessionUser; onComplete: () => void }) {
  const [address, setAddress] = useState("");
  const [department, setDepartment] = useState("");
  const [dohLicense, setDohLicense] = useState("");
  const [position, setPosition] = useState<[number, number] | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    if (!position) {
      setSubmitError("Confirm this facility's location on the map before continuing");
      return;
    }
    setSubmitting(true);
    try {
      await completeFacilityProfile({
        address,
        latitude: position[0],
        longitude: position[1],
        department,
        doh_license_number: dohLicense,
      });
      onComplete();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Failed to save profile");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#F8F9FB] flex items-center justify-center p-6">
      <div className="w-full max-w-3xl bg-white border border-border rounded-xl p-8">
        <div className="flex items-center gap-3 mb-2">
          <BloodDropLogo size={32} />
          <span className="text-lg font-bold">Blood<span className="text-primary">Link</span></span>
        </div>
        <h2 className="font-display text-2xl font-bold text-foreground mb-1">Complete your facility profile</h2>
        <p className="text-muted-foreground text-sm mb-6">
          {user.facility_name} — one last step before you can access the dashboard.
        </p>

        <form onSubmit={handleSubmit} className="space-y-5">
          <FacilityLocationFields
            address={address} onAddressChange={setAddress}
            position={position} onPositionChange={setPosition}
            department={department} onDepartmentChange={setDepartment}
            dohLicense={dohLicense} onDohLicenseChange={setDohLicense}
          />

          {submitError && (
            <div className="text-[12px] text-status-critical-text bg-status-critical-tint border border-status-critical-border rounded-md px-3 py-2">
              {submitError}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full h-10 bg-primary text-white text-sm font-semibold rounded-md hover:bg-primary-hover transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
          >
            {submitting ? (
              <><RefreshCw size={15} className="animate-spin" /> Saving…</>
            ) : (
              "Save and continue"
            )}
          </button>
        </form>
      </div>
    </div>
  );
}

// ─── Account Menu (Change Password / Edit Facility Profile / Log out) ─────

function Modal({
  title, onClose, children, wide = false,
}: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 px-4">
      <div
        className={`w-full ${wide ? "max-w-2xl" : "max-w-md"} bg-white rounded-xl border border-border shadow-xl max-h-[90vh] overflow-y-auto`}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h3 className="font-display font-bold text-[16px] text-foreground">{title}</h3>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-secondary text-muted-foreground transition-colors"
          >
            <X size={16} />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword.length < 8) {
      setError("New password must be at least 8 characters");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("New passwords don't match");
      return;
    }
    setLoading(true);
    try {
      await apiUpdatePassword(currentPassword, newPassword);
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to change password");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal title="Change Password" onClose={onClose}>
      {success ? (
        <div className="text-center py-3">
          <div className="w-12 h-12 rounded-full bg-status-safe-tint flex items-center justify-center mx-auto mb-3">
            <CheckCircle size={22} className="text-status-safe" />
          </div>
          <div className="font-display font-bold text-foreground mb-1">Password updated</div>
          <p className="text-[13px] text-muted-foreground mb-4">Use your new password next time you sign in.</p>
          <button
            onClick={onClose}
            className="w-full h-10 bg-primary text-white text-sm font-bold rounded-md hover:bg-primary-hover transition-colors"
          >
            Done
          </button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-[13px] font-semibold text-foreground block mb-1.5">Current password</label>
            <input
              type="password"
              required
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="w-full h-10 px-3 text-sm border border-border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all"
            />
          </div>
          <div>
            <label className="text-[13px] font-semibold text-foreground block mb-1.5">New password</label>
            <input
              type="password"
              required
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full h-10 px-3 text-sm border border-border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all"
            />
          </div>
          <div>
            <label className="text-[13px] font-semibold text-foreground block mb-1.5">Confirm new password</label>
            <input
              type="password"
              required
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full h-10 px-3 text-sm border border-border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all"
            />
          </div>

          {error && (
            <div className="text-[12px] text-status-critical-text bg-status-critical-tint border border-status-critical-border rounded-md px-3 py-2">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full h-10 bg-primary text-white text-sm font-bold rounded-md hover:bg-primary-hover transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
          >
            {loading ? (
              <><RefreshCw size={15} className="animate-spin" /> Updating…</>
            ) : (
              "Update Password"
            )}
          </button>
        </form>
      )}
    </Modal>
  );
}

function EditFacilityProfileModal({ facilityName, onClose, onSaved }: {
  facilityName: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [address, setAddress] = useState("");
  const [department, setDepartment] = useState("");
  const [dohLicense, setDohLicense] = useState("");
  const [position, setPosition] = useState<[number, number] | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    getMyFacilityProfile()
      .then((profile) => {
        setAddress(profile.address ?? "");
        setDepartment(profile.department ?? "");
        setDohLicense(profile.doh_license_number ?? "");
        if (profile.latitude !== null && profile.longitude !== null) {
          setPosition([profile.latitude, profile.longitude]);
        }
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Failed to load profile"))
      .finally(() => setLoading(false));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    if (!position) {
      setSubmitError("Confirm this facility's location on the map before saving");
      return;
    }
    setSubmitting(true);
    try {
      await completeFacilityProfile({
        address, latitude: position[0], longitude: position[1],
        department, doh_license_number: dohLicense,
      });
      setSuccess(true);
      onSaved();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Failed to save profile");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Edit Facility Profile" onClose={onClose} wide>
      {loading && <div className="py-8 text-center text-[14px] text-muted-foreground">Loading…</div>}
      {!loading && loadError && (
        <div className="text-[13px] text-status-critical-text bg-status-critical-tint border border-status-critical-border rounded-md px-3 py-2">
          {loadError}
        </div>
      )}
      {!loading && !loadError && success && (
        <div className="text-center py-3">
          <div className="w-12 h-12 rounded-full bg-status-safe-tint flex items-center justify-center mx-auto mb-3">
            <CheckCircle size={22} className="text-status-safe" />
          </div>
          <div className="font-display font-bold text-foreground mb-1">Profile updated</div>
          <p className="text-[13px] text-muted-foreground mb-4">{facilityName}'s address, location, and license are saved.</p>
          <button
            onClick={onClose}
            className="w-full h-10 bg-primary text-white text-sm font-bold rounded-md hover:bg-primary-hover transition-colors"
          >
            Done
          </button>
        </div>
      )}
      {!loading && !loadError && !success && (
        <form onSubmit={handleSubmit} className="space-y-5">
          <FacilityLocationFields
            address={address} onAddressChange={setAddress}
            position={position} onPositionChange={setPosition}
            department={department} onDepartmentChange={setDepartment}
            dohLicense={dohLicense} onDohLicenseChange={setDohLicense}
          />

          {submitError && (
            <div className="text-[12px] text-status-critical-text bg-status-critical-tint border border-status-critical-border rounded-md px-3 py-2">
              {submitError}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full h-10 bg-primary text-white text-sm font-bold rounded-md hover:bg-primary-hover transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
          >
            {submitting ? (
              <><RefreshCw size={15} className="animate-spin" /> Saving…</>
            ) : (
              "Save Changes"
            )}
          </button>
        </form>
      )}
    </Modal>
  );
}

function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return new Date(iso).toLocaleDateString();
}

const NOTIFICATION_POLL_MS = 20000;
const CHAT_MESSAGE_POLL_MS = 4000;

// Bell trigger + dropdown for facility accounts (TopNav only — admins have no
// facility_id, so notifications, which are facility-scoped, never apply to
// them; AdminDashboardScreen's header renders AccountMenu without this).
function NotificationBell({ onNavigate }: { onNavigate: (n: NotificationItem) => void }) {
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const menuRef = useRef<HTMLDivElement>(null);

  function loadNotifications() {
    listNotifications()
      .then(setNotifications)
      // A failed poll shouldn't surface an error banner on every screen —
      // it'll just quietly retry on the next interval tick.
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    loadNotifications();
    const interval = setInterval(loadNotifications, NOTIFICATION_POLL_MS);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const unreadCount = notifications.filter((n) => n.read_at === null).length;

  function handleNotificationClick(n: NotificationItem) {
    setOpen(false);
    if (n.read_at === null) {
      markNotificationRead(n.id).catch(() => {});
      setNotifications((prev) => prev.map((x) => (x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x)));
    }
    onNavigate(n);
  }

  async function handleMarkAllRead() {
    try {
      await markAllNotificationsRead();
      setNotifications((prev) => prev.map((n) => ({ ...n, read_at: n.read_at ?? new Date().toISOString() })));
    } catch {
      // best-effort — next poll will reconcile actual state
    }
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative p-1.5 text-muted-foreground hover:text-foreground rounded transition-colors"
      >
        <Bell size={19} />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 bg-primary text-white text-[10px] font-bold rounded-full flex items-center justify-center leading-none">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-80 bg-white border border-border rounded-xl shadow-lg z-50 overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <h3 className="font-display font-bold text-[14px] text-foreground">Notifications</h3>
            {unreadCount > 0 && (
              <button onClick={handleMarkAllRead} className="text-[11px] font-semibold text-primary hover:underline">
                Mark all as read
              </button>
            )}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {loading && <div className="px-4 py-8 text-center text-[13px] text-muted-foreground">Loading…</div>}
            {!loading && notifications.length === 0 && (
              <div className="px-4 py-8 text-center text-[13px] text-muted-foreground">No notifications yet.</div>
            )}
            {!loading && notifications.map((n) => (
              <button
                key={n.id}
                onClick={() => handleNotificationClick(n)}
                className={`w-full text-left px-4 py-3 border-b border-border last:border-0 hover:bg-secondary transition-colors flex gap-2.5 ${
                  n.read_at === null ? "bg-primary-tint/40" : ""
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${n.read_at === null ? "bg-primary" : "bg-transparent"}`} />
                <div className="min-w-0">
                  <div className={`text-[13px] leading-snug ${n.read_at === null ? "font-semibold text-foreground" : "text-muted-foreground"}`}>
                    {n.message}
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-0.5 font-mono">
                    {formatRelativeTime(n.created_at)}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Trigger + dropdown shared by TopNav (facility accounts) and
// AdminDashboardScreen's header (admin accounts) — the admin variant just
// omits Edit Facility Profile, since role='admin' has no facility_id to edit.
function AccountMenu({ user, onLogout }: { user: SessionUser; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [showEditProfile, setShowEditProfile] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const isAdmin = user.role === "admin";

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 pl-3 pr-2 py-1 border-l border-border rounded-lg hover:bg-secondary transition-colors"
      >
        <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
          <User size={16} className="text-primary" />
        </div>
        <div className="text-[12px] text-left">
          <div className="font-semibold text-foreground leading-tight">{user.email}</div>
          <div className="text-muted-foreground leading-tight">{isAdmin ? "Administrator" : user.facility_name}</div>
        </div>
        <ChevronDown size={15} className={`text-muted-foreground transition-transform shrink-0 ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-72 bg-white border border-border rounded-xl shadow-lg z-50 overflow-hidden">
          <div className="px-4 py-3 border-b border-border">
            <div className="text-[13px] font-bold text-foreground">{user.email}</div>
            {!isAdmin && <div className="text-[12px] text-muted-foreground mt-0.5">{user.facility_name}</div>}
            <span className="inline-flex items-center mt-1.5 px-2 py-0.5 rounded-full text-[10.5px] font-bold uppercase tracking-wide bg-primary-tint text-primary">
              {isAdmin ? "Admin" : user.role}
            </span>
          </div>

          <div className="py-1.5">
            <button
              onClick={() => { setShowChangePassword(true); setOpen(false); }}
              className="w-full flex items-center gap-2.5 px-4 py-2 text-[13px] font-semibold text-foreground hover:bg-secondary transition-colors"
            >
              <KeyRound size={15} className="text-muted-foreground" /> Change Password
            </button>
            {!isAdmin && (
              <button
                onClick={() => { setShowEditProfile(true); setOpen(false); }}
                className="w-full flex items-center gap-2.5 px-4 py-2 text-[13px] font-semibold text-foreground hover:bg-secondary transition-colors"
              >
                <Building2 size={15} className="text-muted-foreground" /> Edit Facility Profile
              </button>
            )}
          </div>

          <div className="border-t border-border py-1.5">
            <button
              onClick={onLogout}
              className="w-full flex items-center gap-2.5 px-4 py-2 text-[13px] font-semibold text-status-critical-text hover:bg-status-critical-tint transition-colors"
            >
              <LogOut size={15} /> Log out
            </button>
          </div>
        </div>
      )}

      {showChangePassword && <ChangePasswordModal onClose={() => setShowChangePassword(false)} />}
      {showEditProfile && !isAdmin && (
        <EditFacilityProfileModal
          facilityName={user.facility_name}
          onClose={() => setShowEditProfile(false)}
          onSaved={() => {}}
        />
      )}
    </div>
  );
}

// ─── Admin Dashboard ────────────────────────────────────────────────────────

function AdminDashboardScreen({ user, onLogout }: { user: SessionUser; onLogout: () => void }) {
  const [facilities, setFacilities] = useState<AdminFacility[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [facilityType, setFacilityType] = useState<"hospital" | "bloodbank">("hospital");
  const [email, setEmail] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createResult, setCreateResult] = useState<CreateFacilityAccountResult | null>(null);

  const [statusBusyId, setStatusBusyId] = useState<number | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [resetBusyId, setResetBusyId] = useState<number | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetResult, setResetResult] = useState<AdminPasswordResetResult | null>(null);

  function loadFacilities() {
    setLoading(true);
    setLoadError(null);
    adminListFacilities()
      .then(setFacilities)
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Failed to load facilities"))
      .finally(() => setLoading(false));
  }
  useEffect(() => { loadFacilities(); }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    setCreateResult(null);
    try {
      const result = await adminCreateFacility({ name, facility_type: facilityType, email });
      setCreateResult(result);
      setName("");
      setEmail("");
      loadFacilities();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create facility account");
    } finally {
      setCreating(false);
    }
  }

  async function handleToggleActive(facility: AdminFacility) {
    setStatusBusyId(facility.id);
    setStatusError(null);
    try {
      await adminSetFacilityActive(facility.id, !facility.is_active);
      loadFacilities();
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : "Failed to update facility status");
    } finally {
      setStatusBusyId(null);
    }
  }

  async function handleResetPassword(account: AdminFacilityAccount) {
    if (!window.confirm(`Reset the password for ${account.email}? Their current password stops working immediately, and they'll need this new temporary one to sign in.`)) {
      return;
    }
    setResetBusyId(account.id);
    setResetError(null);
    setResetResult(null);
    try {
      const result = await adminResetAccountPassword(account.id);
      setResetResult(result);
      loadFacilities();
    } catch (err) {
      setResetError(err instanceof Error ? err.message : "Failed to reset password");
    } finally {
      setResetBusyId(null);
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="border-b border-border bg-white px-6 h-14 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BloodDropLogo size={24} />
          <span className="font-bold">Blood<span className="text-primary">Link</span></span>
          <span className="ml-2 px-2 py-0.5 rounded-full bg-primary/10 text-primary text-[11px] font-bold uppercase tracking-wide">
            Admin
          </span>
        </div>
        <div className="flex items-center gap-3">
          <AccountMenu user={user} onLogout={onLogout} />
        </div>
      </div>

      <div className="max-w-screen-xl mx-auto px-6 py-6 space-y-6">
        <div className="bg-white border border-border rounded-xl p-5">
          <h3 className="font-semibold text-foreground mb-4">Create Facility Account</h3>
          <form onSubmit={handleCreate} className="grid sm:grid-cols-4 gap-3 items-end">
            <div>
              <label className="text-[12px] font-semibold text-foreground block mb-1.5">Facility name</label>
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full h-9 px-3 text-sm border border-border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all"
              />
            </div>
            <div>
              <label className="text-[12px] font-semibold text-foreground block mb-1.5">Type</label>
              <select
                value={facilityType}
                onChange={(e) => setFacilityType(e.target.value as "hospital" | "bloodbank")}
                className="w-full h-9 px-3 text-sm border border-border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all"
              >
                <option value="hospital">Hospital</option>
                <option value="bloodbank">Blood Bank</option>
              </select>
            </div>
            <div>
              <label className="text-[12px] font-semibold text-foreground block mb-1.5">Official email</label>
              <input
                required
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full h-9 px-3 text-sm border border-border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all"
              />
            </div>
            <button
              type="submit"
              disabled={creating}
              className="h-9 bg-primary text-white rounded-md text-[13px] font-semibold hover:bg-primary-hover transition-colors disabled:opacity-60 flex items-center justify-center gap-1.5"
            >
              <Plus size={15} /> {creating ? "Creating…" : "Create Account"}
            </button>
          </form>

          {createError && (
            <div className="mt-3 text-[12px] text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
              {createError}
            </div>
          )}
          {createResult && (
            <div className="mt-3 text-[12px] bg-secondary rounded-md px-3 py-2.5 space-y-1">
              <div className="font-semibold text-foreground">
                {createResult.facility.name} created — {createResult.user.email}
              </div>
              <div className="text-muted-foreground">
                Temporary password (shown once — relay this to the facility; there's no email delivery yet):{" "}
                <span className="font-mono font-semibold text-foreground">{createResult.temporary_password}</span>
              </div>
            </div>
          )}
        </div>

        <div className="bg-white border border-border rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-border flex items-center justify-between">
            <h3 className="font-semibold text-foreground">Facilities</h3>
            <span className="text-[12px] text-muted-foreground">{facilities.length} total</span>
          </div>

          {loading && (
            <div className="p-8 text-center text-[13px] text-muted-foreground">Loading…</div>
          )}
          {!loading && loadError && (
            <div className="p-6 text-center text-[13px] text-red-700">{loadError}</div>
          )}
          {!loading && !loadError && (
            <>
              {statusError && (
                <div className="mx-5 mt-4 text-[12px] text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
                  {statusError}
                </div>
              )}
              {resetError && (
                <div className="mx-5 mt-4 text-[12px] text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
                  {resetError}
                </div>
              )}
              {resetResult && (
                <div className="mx-5 mt-4 text-[12px] bg-secondary rounded-md px-3 py-2.5 flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="font-semibold text-foreground">New password issued for {resetResult.email}</div>
                    <div className="text-muted-foreground">
                      Temporary password (shown once — relay this to the facility):{" "}
                      <span className="font-mono font-semibold text-foreground">{resetResult.temporary_password}</span>
                    </div>
                  </div>
                  <button
                    onClick={() => setResetResult(null)}
                    className="w-6 h-6 shrink-0 flex items-center justify-center rounded hover:bg-white text-muted-foreground transition-colors"
                  >
                    <X size={14} />
                  </button>
                </div>
              )}
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-border bg-[#F8F9FB]">
                    {["Facility", "Type", "Account(s)", "Profile", "Status", ""].map((h) => (
                      <th key={h} className="text-left py-3 px-4 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {facilities.map((f) => (
                    <tr key={f.id} className="border-b border-border last:border-0">
                      <td className="py-3 px-4 font-semibold text-foreground">{f.name}</td>
                      <td className="py-3 px-4 text-muted-foreground capitalize">{f.facility_type}</td>
                      <td className="py-3 px-4">
                        {f.accounts.length === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          f.accounts.map((a) => (
                            <div key={a.id} className="flex items-center gap-1.5 py-0.5">
                              <div className="font-mono text-[12px] text-foreground">
                                {a.email}
                                {a.must_change_password && (
                                  <span className="ml-1.5 font-sans text-[11px] text-status-watch-text">(pending first login)</span>
                                )}
                              </div>
                              <button
                                onClick={() => handleResetPassword(a)}
                                disabled={resetBusyId === a.id}
                                title="Reset password"
                                className="shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-semibold text-muted-foreground hover:text-primary hover:bg-primary-tint transition-colors disabled:opacity-60"
                              >
                                <KeyRound size={11} /> {resetBusyId === a.id ? "…" : "Reset"}
                              </button>
                            </div>
                          ))
                        )}
                      </td>
                      <td className="py-3 px-4">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border ${
                            f.profile_completed ? STATUS_STYLES.safe.badge : STATUS_STYLES.watch.badge
                          }`}
                        >
                          {f.profile_completed ? "Complete" : "Incomplete"}
                        </span>
                      </td>
                      <td className="py-3 px-4">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border ${
                            f.is_active ? STATUS_STYLES.safe.badge : STATUS_STYLES.critical.badge
                          }`}
                        >
                          {f.is_active ? "Active" : "Deactivated"}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right">
                        <button
                          onClick={() => handleToggleActive(f)}
                          disabled={statusBusyId === f.id}
                          className={`h-7 px-3 rounded-md text-[12px] font-semibold border transition-colors disabled:opacity-60 ${
                            f.is_active
                              ? "border-status-critical-border text-status-critical-text hover:bg-status-critical-tint"
                              : "border-status-safe-border text-status-safe-text hover:bg-status-safe-tint"
                          }`}
                        >
                          {statusBusyId === f.id ? "…" : f.is_active ? "Deactivate" : "Reactivate"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

function ExpiryWarningRow({ row }: { row: InventoryUnit }) {
  const [notifyState, setNotifyState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [notifyResult, setNotifyResult] = useState<NotifyNearbyHospitalsResult | null>(null);
  const [notifyError, setNotifyError] = useState<string | null>(null);
  const status = getExpiryStatus(row.daysLeft);
  const style = EXPIRY_STYLES[status];

  async function handleNotify() {
    setNotifyState("sending");
    setNotifyError(null);
    try {
      const result = await notifyNearbyHospitals(row.din);
      setNotifyResult(result);
      setNotifyState("sent");
    } catch (err) {
      setNotifyError(err instanceof Error ? err.message : "Failed to notify nearby hospitals");
      setNotifyState("error");
    }
  }

  return (
    <div className={`rounded-lg px-3 py-2.5 text-[13px] ${style.panel}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className={`font-bold text-[13px] w-7 h-6 flex items-center justify-center rounded shrink-0 ${style.solid}`}>
            {row.type}
          </span>
          <div>
            <div className="font-mono text-[13px] font-semibold text-foreground">{row.din}</div>
            <div className="text-gray-600 text-[12px]">{row.component}</div>
          </div>
        </div>
        <div className={`font-bold text-right shrink-0 ${style.text}`}>
          {status === "expired" ? "Expired" : `${row.daysLeft}d`}
          {status !== "expired" && <div className="text-gray-600 text-[11px] font-normal">left</div>}
        </div>
      </div>
      <div className="mt-2 pt-2 border-t border-black/5">
        {notifyState === "sent" ? (
          <span className="flex items-center gap-1 text-[12px] font-semibold text-status-safe-text">
            <CheckCircle size={13} />
            {notifyResult && notifyResult.notified_count > 0
              ? `${notifyResult.notified_count} nearby hospital${notifyResult.notified_count === 1 ? "" : "s"} alerted`
              : "No nearby hospitals to alert"}
          </span>
        ) : (
          <button
            onClick={handleNotify}
            disabled={notifyState === "sending"}
            className={`w-full h-6 rounded text-[12px] font-semibold transition-colors flex items-center justify-center gap-1 ${style.solid} hover:opacity-90 disabled:opacity-60`}
          >
            <Bell size={12} /> {notifyState === "sending" ? "Notifying…" : "Notify Nearby Hospitals"}
          </button>
        )}
        {notifyState === "error" && (
          <div className="mt-1.5 text-[11px] text-red-700">{notifyError}</div>
        )}
      </div>
    </div>
  );
}

type InventorySummaryRow = { blood_type: string; minimum_units: number; units: number };

type ForecastAlert = {
  type: string;
  severity: "critical" | "warn";
  reason: string;
  days_until_threshold: number;
};

// Blood-bank-type facilities: /forecast returns this shape (Steps 4 + SARIMAX work).
type ForecastView = {
  view: "forecast";
  has_sufficient_history: boolean;
  days_of_history: number;
  min_days_required: number;
  is_dengue_season: boolean;
  forecast_source: "real_facility_history" | "synthetic_model_stand_in" | "none";
  synthetic_model_label?: string;
  // Only present (non-null) on the real_facility_history path once at least
  // one blood type has n >= 3 points of its own — see
  // _prediction_interval_half_width in main.py. null on every other path
  // (synthetic never has one; "none" has no series at all).
  interval_confidence: number | null;
  series: { day: string; units: number; lower: number | null; upper: number | null }[];
  alerts: ForecastAlert[];
};

// Hospital-type facilities: /forecast returns this instead — no forecast at
// all, just current-stock-vs-minimum and an explicit, staff-confirmed action
// per shortage. See _build_hospital_threshold_view in main.py.
type ThresholdEntry = {
  blood_type: string;
  units: number;
  minimum_units: number;
  status: "ok" | "below_minimum";
  deficit: number;
};

type ActionPrompt = {
  blood_type: string;
  units: number;
  minimum_units: number;
  deficit: number;
  message: string;
  requires_confirmation: boolean;
};

type ThresholdView = {
  view: "threshold_status";
  is_dengue_season: boolean;
  thresholds: ThresholdEntry[];
  action_prompts: ActionPrompt[];
};

type DashboardData = ForecastView | ThresholdView;

function DashboardScreen({ onRequestBloodType }: { onRequestBloodType: (bloodType: string) => void }) {
  const [summary, setSummary] = useState<InventorySummaryRow[]>([]);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  const [expiryUnits, setExpiryUnits] = useState<InventoryUnit[]>([]);
  const [expiryLoading, setExpiryLoading] = useState(true);
  const [expiryError, setExpiryError] = useState<string | null>(null);

  // Named for what it actually is now — either a blood bank's forecast or a
  // hospital's threshold view, discriminated by "view" (see DashboardData).
  const [dashboardData, setDashboardData] = useState<DashboardData | null>(null);
  const [forecastLoading, setForecastLoading] = useState(true);
  const [forecastError, setForecastError] = useState<string | null>(null);

  const [activeRequestsCount, setActiveRequestsCount] = useState<number | null>(null);
  const [activeRequestsEmergencyCount, setActiveRequestsEmergencyCount] = useState<number | null>(null);

  // Historical inventory-snapshot backfill — only ever rendered when
  // dashboardData.view === "forecast", i.e. never for hospitals (see
  // DashboardData and _build_hospital_threshold_view server-side).
  const historyFileInputRef = useRef<HTMLInputElement>(null);
  const [uploadingHistory, setUploadingHistory] = useState(false);
  const [historyUploadResult, setHistoryUploadResult] = useState<HistoricalUploadResult | null>(null);
  const [historyUploadError, setHistoryUploadError] = useState<string | null>(null);
  const [backfillUploadHistoryKey, setBackfillUploadHistoryKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    apiGet<InventorySummaryRow[]>("/inventory/summary")
      .then((data) => { if (!cancelled) setSummary(data); })
      .catch((err) => { if (!cancelled) setSummaryError(err instanceof Error ? err.message : "Failed to load"); })
      .finally(() => { if (!cancelled) setSummaryLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    apiGet<InventoryApiRow[]>("/inventory")
      .then((data) => { if (!cancelled) setExpiryUnits(data.map(toInventoryUnit)); })
      .catch((err) => { if (!cancelled) setExpiryError(err instanceof Error ? err.message : "Failed to load"); })
      .finally(() => { if (!cancelled) setExpiryLoading(false); });
    return () => { cancelled = true; };
  }, []);

  function loadForecast() {
    let cancelled = false;
    setForecastLoading(true);
    setForecastError(null);
    apiGet<DashboardData>("/forecast")
      .then((data) => { if (!cancelled) setDashboardData(data); })
      .catch((err) => { if (!cancelled) setForecastError(err instanceof Error ? err.message : "Failed to load"); })
      .finally(() => { if (!cancelled) setForecastLoading(false); });
    return () => { cancelled = true; };
  }
  useEffect(() => loadForecast(), []);

  async function handleHistoryFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingHistory(true);
    setHistoryUploadError(null);
    setHistoryUploadResult(null);
    try {
      const result = await uploadHistoricalInventorySnapshots(file);
      setHistoryUploadResult(result);
      loadForecast();
      setBackfillUploadHistoryKey((k) => k + 1);
    } catch (err) {
      setHistoryUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploadingHistory(false);
      if (historyFileInputRef.current) historyFileInputRef.current.value = "";
    }
  }

  useEffect(() => {
    if (!dashboardData?.view) return;
    let cancelled = false;
    // Hospitals count their own outgoing requests; blood banks count the
    // requests directed at them as the supplier — /requests/incoming is the
    // same endpoint the Transfer tab's "Incoming Requests" panel already uses.
    const endpoint = dashboardData.view === "threshold_status" ? "/requests" : "/requests/incoming";
    apiGet<RequestRow[]>(endpoint)
      .then((rows) => {
        if (cancelled) return;
        const active = rows.filter((r) => r.status === "pending" || r.status === "accepted");
        const emergency = active.filter((r) => r.emergency_type === "trauma" || r.emergency_type === "scheduled_surgery");
        setActiveRequestsCount(active.length);
        setActiveRequestsEmergencyCount(emergency.length);
      })
      .catch(() => {}); // KPI card falls back to "…" below — not worth a dedicated error state
    return () => { cancelled = true; };
  }, [dashboardData?.view]);

  const totalUnits = summary.reduce((a, b) => a + b.units, 0);
  const expiringRows = expiryUnits.filter((r) => {
    const status = getExpiryStatus(r.daysLeft);
    return status === "critical" || status === "near-expiry";
  });

  // One overall read on "are we okay," not four competing numbers — worst
  // condition present wins: any type below minimum outranks anything running
  // low, which outranks everything being fine. See stockStatus/STATUS_STYLES.
  const criticalTypes = summary.filter((b) => stockStatus(b.units, b.minimum_units) === "critical");
  const watchTypes = summary.filter((b) => stockStatus(b.units, b.minimum_units) === "watch");
  const heroStatus: StatusLevel =
    criticalTypes.length > 0 ? "critical" : watchTypes.length > 0 || expiringRows.length > 0 ? "watch" : "safe";
  const heroHeadline =
    heroStatus === "critical"
      ? `${criticalTypes.length} blood type${criticalTypes.length === 1 ? "" : "s"} below minimum`
      : heroStatus === "watch" && watchTypes.length > 0
      ? `${watchTypes.length} blood type${watchTypes.length === 1 ? "" : "s"} running low`
      : heroStatus === "watch"
      ? `${expiringRows.length} unit${expiringRows.length === 1 ? "" : "s"} expiring within 7 days`
      : "Supply steady across all types";
  const heroDetail =
    heroStatus === "critical"
      ? `${criticalTypes.map((t) => t.blood_type).join(", ")} below minimum threshold`
      : heroStatus === "watch" && watchTypes.length > 0
      ? `${watchTypes.map((t) => t.blood_type).join(", ")} approaching minimum — see the breakdown below`
      : heroStatus === "watch"
      ? "See Expiry Warnings below for which units"
      : "No shortages or expiring stock flagged right now";

  return (
    <div className="max-w-screen-xl mx-auto px-6 py-6 space-y-6">
      {/* Hero status — the one thing to know at a glance */}
      {(summaryLoading || expiryLoading) && (
        <div className="rounded-xl border border-border bg-white p-6 text-center text-[14px] text-muted-foreground">
          Loading supply status…
        </div>
      )}
      {!summaryLoading && !expiryLoading && (summaryError || expiryError) && (
        <div className="rounded-xl border border-status-critical-border bg-status-critical-tint p-6 text-center text-[14px] text-status-critical-text">
          Failed to load supply status: {summaryError || expiryError}
        </div>
      )}
      {!summaryLoading && !expiryLoading && !summaryError && !expiryError && (
        <div className={`rounded-xl border p-6 ${STATUS_STYLES[heroStatus].panel}`}>
          <div className="flex items-start justify-between gap-6 flex-wrap">
            <div className="flex-1 min-w-[260px]">
              <div className="flex items-center gap-2 mb-2">
                <StatusDot status={heroStatus} />
                <span className={`text-[12px] font-bold uppercase tracking-wider ${STATUS_STYLES[heroStatus].text}`}>
                  Supply Status
                </span>
              </div>
              <h2 className={`font-display font-extrabold text-[30px] leading-tight tracking-tight text-balance ${STATUS_STYLES[heroStatus].text}`}>
                {heroHeadline}
              </h2>
              <p className="text-[14px] text-gray-600 mt-1.5">{heroDetail}</p>
            </div>

            <div className="flex items-center gap-6 sm:gap-8 flex-wrap">
              <div>
                <div className="text-[11px] font-bold uppercase tracking-wide text-gray-500 mb-1">Total Units</div>
                <div className="text-2xl font-display font-bold tabular-nums text-foreground">{totalUnits}</div>
              </div>
              <div className="w-px h-10 bg-border hidden sm:block" />
              <div>
                <div className="text-[11px] font-bold uppercase tracking-wide text-gray-500 mb-1">Expiring ≤7d</div>
                <div className="text-2xl font-display font-bold tabular-nums text-foreground">{expiringRows.length}</div>
              </div>
              <div className="w-px h-10 bg-border hidden sm:block" />
              <div
                title={
                  activeRequestsCount !== null
                    ? `${activeRequestsEmergencyCount ?? 0} emergency, ${activeRequestsCount - (activeRequestsEmergencyCount ?? 0)} routine`
                    : undefined
                }
              >
                <div className="text-[11px] font-bold uppercase tracking-wide text-gray-500 mb-1">Active Requests</div>
                <div className="text-2xl font-display font-bold tabular-nums text-foreground">
                  {activeRequestsCount === null ? "…" : activeRequestsCount}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Blood type breakdown */}
      {summaryLoading && (
        <div className="bg-white border border-border rounded-xl p-10 text-center text-[13px] text-muted-foreground">
          Loading inventory summary…
        </div>
      )}
      {!summaryLoading && summaryError && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-6 text-center text-[13px] text-red-700">
          Failed to load inventory summary: {summaryError}
        </div>
      )}
      {!summaryLoading && !summaryError && (
        <div className="grid lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 bg-white border border-border rounded-xl p-5">
            <div className="flex items-center justify-between mb-5">
              <div>
                <h3 className="font-semibold text-foreground text-[17px]">Inventory by Blood Type</h3>
                <p className="text-[14px] text-gray-600 mt-0.5">
                  Current units vs. minimum threshold
                </p>
              </div>
              <div className="flex gap-3 text-[13px] font-semibold">
                <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-primary inline-block" /> Current</span>
                <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-gray-200 inline-block" /> Minimum</span>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={summary} barGap={2} barCategoryGap="25%">
                <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" vertical={false} />
                <XAxis
                  dataKey="blood_type"
                  tick={{ fontSize: 13, fontFamily: "Plus Jakarta Sans", fill: "#4B5563", fontWeight: 600 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fontSize: 12, fontFamily: "Plus Jakarta Sans", fill: "#6B7280" }}
                  axisLine={false}
                  tickLine={false}
                  width={30}
                />
                <Tooltip
                  contentStyle={{
                    border: "1px solid #E5E7EB",
                    borderRadius: "8px",
                    fontSize: 13,
                    fontFamily: "Plus Jakarta Sans",
                  }}
                  cursor={{ fill: "#F9FAFB" }}
                />
                <Bar dataKey="units" radius={[4, 4, 0, 0]} name="Units">
                  {summary.map((entry, i) => (
                    <Cell key={`bt-${i}`} fill={STATUS_HEX[stockStatus(entry.units, entry.minimum_units)]} />
                  ))}
                </Bar>
                <Bar dataKey="minimum_units" fill="#E5E7EB" radius={[4, 4, 0, 0]} name="Minimum" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Type grid */}
          <div className="bg-white border border-border rounded-xl p-5">
            <h3 className="font-semibold text-foreground text-[17px] mb-4">Status by Type</h3>
            <div className="grid grid-cols-2 gap-2">
              {summary.map((bt) => {
                const status = stockStatus(bt.units, bt.minimum_units);
                const label = status === "critical" ? "Low" : status === "watch" ? "Marginal" : "Adequate";
                return (
                  <div key={bt.blood_type} className={`rounded-lg border p-3 ${STATUS_STYLES[status].panel}`}>
                    <div className="flex items-center justify-between mb-1.5">
                      <BloodTypeBadge type={bt.blood_type} size="md" />
                      <StatusDot status={status} />
                    </div>
                    <div className={`text-2xl font-display font-bold leading-tight tabular-nums ${STATUS_STYLES[status].text}`}>{bt.units}</div>
                    <div className={`text-[13px] font-semibold mt-0.5 ${STATUS_STYLES[status].text}`}>{label}</div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Forecast/Threshold + Alert/Action + Expiry */}
      <div className="grid lg:grid-cols-3 gap-4">
        {dashboardData?.view === "forecast" && (
          <>
            {/* 30-day forecast */}
            <div className="lg:col-span-1 bg-white border border-border rounded-xl p-5">
              <div className="flex items-center justify-between mb-1">
                <h3 className="font-semibold text-foreground text-[17px]">30-Day Shortage Forecast</h3>
                {dashboardData.forecast_source === "synthetic_model_stand_in" && (
                  <span className="flex items-center gap-1 text-[12px] font-bold text-violet-700 bg-violet-50 px-2 py-0.5 rounded-full border border-violet-200">
                    <FlaskConical size={13} /> Synthetic Model
                  </span>
                )}
                {dashboardData.forecast_source === "real_facility_history" && dashboardData.alerts.length > 0 && (
                  <span className="flex items-center gap-1 text-[12px] font-bold text-status-watch-text bg-status-watch-tint px-2 py-0.5 rounded-full border border-status-watch-border">
                    <AlertTriangle size={13} /> At Risk
                  </span>
                )}
                {dashboardData.forecast_source === "real_facility_history" && dashboardData.alerts.length === 0 && (
                  <span className="flex items-center gap-1 text-[12px] font-bold text-status-safe-text bg-status-safe-tint px-2 py-0.5 rounded-full border border-status-safe-border">
                    <CheckCircle size={13} /> Stable
                  </span>
                )}
                {dashboardData.forecast_source === "none" && (
                  <span className="flex items-center gap-1 text-[12px] font-bold text-gray-600 bg-secondary px-2 py-0.5 rounded-full border border-border">
                    <Clock size={13} /> Collecting Data
                  </span>
                )}
              </div>
              <p className="text-[14px] text-gray-600 mb-3">
                {dashboardData.forecast_source === "synthetic_model_stand_in"
                  ? "Synthetic model, not this facility's real history — see banner below"
                  : "Simplified linear trend over real daily snapshots — not a full statistical model"}
              </p>

              {/* Historical backfill — lets a facility with real past
                  records skip the days_of_history wait instead of it. */}
              <input
                ref={historyFileInputRef}
                type="file"
                accept=".csv"
                onChange={handleHistoryFileSelected}
                className="hidden"
              />

              {dashboardData.forecast_source !== "real_facility_history" ? (
                <div className="mb-4 rounded-lg border border-primary-tint bg-primary-tint/50 p-3.5">
                  <div className="flex items-center gap-2.5 mb-3">
                    <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                      <TrendingUp size={16} className="text-primary" />
                    </div>
                    <div>
                      <div className="text-[13px] font-bold text-foreground leading-tight">Unlock your real forecast</div>
                      <div className="text-[12px] text-muted-foreground leading-tight">
                        Have past stock records? Upload them to switch off the synthetic model now.
                      </div>
                    </div>
                  </div>

                  <div className="mb-3">
                    <div className="flex items-center justify-between text-[11px] font-bold text-muted-foreground uppercase tracking-wide mb-1">
                      <span>History on file</span>
                      <span className="font-mono tabular-nums normal-case">
                        {dashboardData.days_of_history} of {dashboardData.min_days_required} days
                      </span>
                    </div>
                    <div className="h-2.5 rounded-full bg-white border border-border overflow-hidden">
                      <div
                        className="h-full bg-primary rounded-full transition-all duration-500"
                        style={{ width: `${Math.min(100, (dashboardData.days_of_history / dashboardData.min_days_required) * 100)}%` }}
                      />
                    </div>
                  </div>

                  <button
                    onClick={() => historyFileInputRef.current?.click()}
                    disabled={uploadingHistory}
                    title="Columns: snapshot_date, blood_type, units. Dates must be before today — today's stock is recorded automatically."
                    className="w-full h-9 bg-primary text-white text-[12.5px] font-bold rounded-lg hover:bg-primary-hover transition-colors disabled:opacity-60 flex items-center justify-center gap-1.5"
                  >
                    <Upload size={14} /> {uploadingHistory ? "Uploading…" : "Upload Historical Data"}
                  </button>
                  <p className="text-[10.5px] text-muted-foreground mt-1.5 leading-snug">
                    CSV columns: snapshot_date, blood_type, units — one row per day per blood type, dated before today.
                  </p>
                </div>
              ) : (
                <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-status-safe-border bg-status-safe-tint px-3 py-2.5">
                  <div className="flex items-center gap-1.5 text-[12px] font-bold text-status-safe-text">
                    <CheckCircle size={14} /> Real forecast active — {dashboardData.days_of_history} days of history on file
                  </div>
                  <button
                    onClick={() => historyFileInputRef.current?.click()}
                    disabled={uploadingHistory}
                    className="text-[11px] font-bold text-primary hover:underline disabled:opacity-60 shrink-0"
                  >
                    {uploadingHistory ? "Uploading…" : "Add more history"}
                  </button>
                </div>
              )}

              {historyUploadError && (
                <div className="mb-4 text-[11px] text-status-critical-text bg-status-critical-tint border border-status-critical-border rounded-lg px-2.5 py-2">
                  {historyUploadError}
                </div>
              )}
              {historyUploadResult && (
                <div className="mb-4 text-[11px] bg-secondary rounded-lg px-2.5 py-2 space-y-1">
                  <div className="font-semibold text-foreground">
                    {historyUploadResult.rows_processed} day{historyUploadResult.rows_processed === 1 ? "" : "s"}-of-type
                    record{historyUploadResult.rows_processed === 1 ? "" : "s"} processed
                    {historyUploadResult.errors.length > 0 && `, ${historyUploadResult.errors.length} row${historyUploadResult.errors.length === 1 ? "" : "s"} skipped`}
                  </div>
                  <div className="text-muted-foreground">
                    Now {historyUploadResult.days_of_history} of {historyUploadResult.min_days_required} days of history on file.
                  </div>
                  {historyUploadResult.errors.map((e, i) => (
                    <div key={i} className="text-status-critical-text">
                      Row {e.row}: {e.reason}
                    </div>
                  ))}
                </div>
              )}

              <div className="mb-4">
                <UploadHistoryPanel uploadType="historical_stock" refreshKey={backfillUploadHistoryKey} onUndone={loadForecast} />
              </div>

              {dashboardData.forecast_source === "synthetic_model_stand_in" && (
                <div className="mb-4 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-[13px] text-violet-900 leading-relaxed">
                  <strong>SYNTHETIC — not real data.</strong> Only {dashboardData.days_of_history} of{" "}
                  {dashboardData.min_days_required} days of this facility's own history have been collected, so this
                  trajectory comes from {dashboardData.synthetic_model_label ?? "a synthetic reference model"} trained on
                  generated data, rescaled to today's real stock. It will switch to a real facility-derived trend once
                  enough history accumulates.
                </div>
              )}

              {forecastLoading && (
                <div className="py-8 text-center text-[14px] text-gray-600">Loading forecast…</div>
              )}
              {!forecastLoading && forecastError && (
                <div className="py-8 text-center text-[14px] text-red-700">Failed to load: {forecastError}</div>
              )}
              {!forecastLoading && !forecastError && dashboardData.forecast_source === "none" && (
                <div className="py-6 text-center text-[14px] text-gray-600 leading-relaxed">
                  Not enough history yet to forecast a trend.
                  <br />
                  Collecting daily snapshots: <strong className="text-foreground">{dashboardData.days_of_history}</strong> of{" "}
                  <strong className="text-foreground">{dashboardData.min_days_required}</strong> days needed.
                </div>
              )}
              {!forecastLoading && !forecastError && dashboardData.forecast_source !== "none" && (
                <>
                  <ResponsiveContainer width="100%" height={140}>
                    <BarChart data={dashboardData.series}>
                      <XAxis
                        dataKey="day"
                        tick={{ fontSize: 12, fill: "#6B7280", fontFamily: "Plus Jakarta Sans", fontWeight: 600 }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <YAxis hide />
                      <Tooltip
                        contentStyle={{ fontSize: 13, fontFamily: "Plus Jakarta Sans", border: "1px solid #E5E7EB", borderRadius: 6 }}
                        cursor={{ fill: "#F9FAFB" }}
                      />
                      <Bar
                        dataKey="units"
                        fill={dashboardData.forecast_source === "synthetic_model_stand_in" ? "#7C3AED" : "var(--role-accent)"}
                        opacity={0.85}
                        radius={[3, 3, 0, 0]}
                        name="Units"
                      >
                        {dashboardData.interval_confidence !== null && (
                          <ErrorBar
                            dataKey={(d: { units: number; lower: number | null; upper: number | null }) => {
                              if (d.lower === null || d.upper === null) return [0, 0];
                              const deltaLow = d.units - d.lower;
                              const deltaHigh = d.upper - d.units;
                              // Recharts renders duplicate-keyed cap lines when both
                              // deltas are exactly 0 (a genuinely zero-width interval —
                              // happens when a facility's recorded history hasn't
                              // varied day to day, so the fit has zero residual). A
                              // hairline rendering floor avoids that React warning
                              // without touching the actual lower/upper values
                              // reported in the API or the tooltip.
                              return deltaLow === 0 && deltaHigh === 0 ? [0.4, 0.4] : [deltaLow, deltaHigh];
                            }}
                            width={4}
                            strokeWidth={1.5}
                            stroke="#58514B"
                            direction="y"
                          />
                        )}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                  {dashboardData.interval_confidence !== null && (
                    <p className="mt-2 text-[11.5px] text-gray-500 leading-snug">
                      Whiskers show a {Math.round(dashboardData.interval_confidence * 100)}% prediction interval —
                      wider with less history on file or further into the future, narrowing as more real days accumulate.
                    </p>
                  )}
                  <div className="mt-4 text-[14px] text-gray-600">
                    {dashboardData.alerts.length > 0 ? (
                      <>
                        {dashboardData.alerts.map((a) => a.type).join(", ")} projected to fall below minimum within{" "}
                        <strong className="text-foreground">
                          {Math.max(...dashboardData.alerts.map((a) => a.days_until_threshold))} days
                        </strong>.
                      </>
                    ) : dashboardData.forecast_source === "synthetic_model_stand_in" ? (
                      "No blood types currently trending toward shortage, based on the synthetic reference model."
                    ) : (
                      `No blood types currently trending toward shortage, based on ${dashboardData.days_of_history} days of history.`
                    )}
                  </div>
                </>
              )}
            </div>

            {/* Shortage Alert */}
            <div className="lg:col-span-1 bg-white border border-border rounded-xl p-5">
              <div className="flex items-center gap-2 mb-4">
                <div className="w-7 h-7 rounded-lg bg-status-critical-tint flex items-center justify-center">
                  <Zap size={15} className="text-status-critical-text" />
                </div>
                <h3 className="font-semibold text-foreground text-[17px]">Predictive Shortage Alert</h3>
              </div>

              {forecastLoading && (
                <div className="py-8 text-center text-[14px] text-gray-600">Loading…</div>
              )}
              {!forecastLoading && forecastError && (
                <div className="py-8 text-center text-[14px] text-red-700">Failed to load: {forecastError}</div>
              )}
              {!forecastLoading && !forecastError && dashboardData.forecast_source === "none" && (
                <div className="py-6 text-center text-[14px] text-gray-600 leading-relaxed">
                  No predictions yet — {dashboardData.days_of_history} of {dashboardData.min_days_required} days of history
                  collected. Shortage predictions require a real trend, not a guess.
                </div>
              )}
              {!forecastLoading && !forecastError && dashboardData.forecast_source !== "none" && dashboardData.alerts.length === 0 && (
                <div className="py-6 text-center text-[14px] text-gray-600 leading-relaxed">
                  {dashboardData.forecast_source === "synthetic_model_stand_in"
                    ? "No shortages currently predicted by the synthetic reference model."
                    : `No shortages currently predicted, based on a ${dashboardData.days_of_history}-day trend.`}
                </div>
              )}
              {!forecastLoading && !forecastError && dashboardData.forecast_source !== "none" && dashboardData.alerts.length > 0 && (
                <div className="space-y-3">
                  {dashboardData.alerts.map((alert, i) => {
                    const level: StatusLevel = alert.severity === "critical" ? "critical" : "watch";
                    return (
                      <div key={i} className={`rounded-lg p-3 flex gap-3 ${STATUS_STYLES[level].panel}`}>
                        <div className={`w-8 h-8 rounded-md font-display font-bold text-[14px] flex items-center justify-center shrink-0 ${STATUS_STYLES[level].solid}`}>
                          {alert.type}
                        </div>
                        <div>
                          <div className={`text-[14px] font-bold mb-0.5 ${STATUS_STYLES[level].text}`}>
                            {alert.severity === "critical" ? "Critical shortage likely" : "Shortage warning"}
                          </div>
                          <div className="text-[13px] text-gray-700 leading-snug">{alert.reason}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}

        {dashboardData?.view === "threshold_status" && (
          <div className="lg:col-span-2 bg-white border border-border rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-lg bg-status-critical-tint flex items-center justify-center">
                  <Zap size={15} className="text-status-critical-text" />
                </div>
                <h3 className="font-semibold text-foreground text-[17px]">Action Required</h3>
              </div>
              {dashboardData.action_prompts.length > 0 ? (
                <span className="flex items-center gap-1 text-[12px] font-bold text-status-critical-text bg-status-critical-tint px-2 py-0.5 rounded-full border border-status-critical-border">
                  <AlertTriangle size={13} /> {dashboardData.action_prompts.length} below minimum
                </span>
              ) : (
                <span className="flex items-center gap-1 text-[12px] font-bold text-status-safe-text bg-status-safe-tint px-2 py-0.5 rounded-full border border-status-safe-border">
                  <CheckCircle size={13} /> Fully stocked
                </span>
              )}
            </div>
            <p className="text-[14px] text-gray-600 mb-4">
              Current stock vs. minimum threshold, per type. Sending a request is never automatic — confirm each one yourself.
            </p>

            {forecastLoading && (
              <div className="py-8 text-center text-[14px] text-gray-600">Loading…</div>
            )}
            {!forecastLoading && forecastError && (
              <div className="py-8 text-center text-[14px] text-red-700">Failed to load: {forecastError}</div>
            )}
            {!forecastLoading && !forecastError && dashboardData.action_prompts.length === 0 && (
              <div className="py-6 text-center text-[14px] text-gray-600 leading-relaxed">
                All blood types are at or above minimum threshold. No action needed right now.
              </div>
            )}
            {!forecastLoading && !forecastError && dashboardData.action_prompts.length > 0 && (
              <div className="space-y-3">
                {dashboardData.action_prompts.map((prompt) => (
                  <div key={prompt.blood_type} className="rounded-lg p-3 flex gap-3 bg-status-critical-tint border border-status-critical-border">
                    <div className="w-8 h-8 rounded-md font-bold text-[14px] flex items-center justify-center shrink-0 bg-status-critical text-white">
                      {prompt.blood_type}
                    </div>
                    <div className="flex-1">
                      <div className="text-[14px] font-bold mb-0.5 text-status-critical-text">
                        {prompt.units} of {prompt.minimum_units} units — short by {prompt.deficit}
                      </div>
                      <div className="text-[13px] text-gray-700 leading-snug mb-2">{prompt.message}</div>
                      <button
                        onClick={() => onRequestBloodType(prompt.blood_type)}
                        className="flex items-center gap-1.5 h-8 px-3 bg-primary text-white rounded-lg text-[12px] font-semibold hover:bg-primary-hover transition-colors"
                      >
                        <ArrowRight size={14} /> Request {prompt.blood_type} from nearby blood banks
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Expiry warnings */}
        <div className="lg:col-span-1 bg-white border border-border rounded-xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-7 h-7 rounded-lg bg-amber-100 flex items-center justify-center">
              <Clock size={15} className="text-amber-600" />
            </div>
            <h3 className="font-semibold text-foreground text-[17px]">Expiry Warnings</h3>
          </div>
          {expiryLoading && (
            <div className="py-8 text-center text-[14px] text-gray-600">Loading…</div>
          )}
          {!expiryLoading && expiryError && (
            <div className="py-8 text-center text-[14px] text-red-700">Failed to load: {expiryError}</div>
          )}
          {!expiryLoading && !expiryError && expiringRows.length === 0 && (
            <div className="py-8 text-center text-[14px] text-gray-600">No units expiring soon.</div>
          )}
          {!expiryLoading && !expiryError && expiringRows.length > 0 && (
            <div className="space-y-2">
              {expiringRows.map((row) => (
                <ExpiryWarningRow key={row.din} row={row} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Inventory ────────────────────────────────────────────────────────────────

type InventoryUnit = {
  din: string;
  type: string;
  component: string;
  location: string;
  volume: number;
  collected: string;
  expires: string;
  daysLeft: number;
};

type InventoryApiRow = {
  din: string;
  blood_type: string;
  component: string;
  location: string;
  volume_ml: number;
  collected_date: string;
  expires_date: string;
};

function toInventoryUnit(row: InventoryApiRow): InventoryUnit {
  const msPerDay = 1000 * 60 * 60 * 24;
  const daysLeft = Math.ceil((new Date(row.expires_date).getTime() - Date.now()) / msPerDay);
  return {
    din: row.din,
    type: row.blood_type,
    component: row.component,
    location: row.location,
    volume: row.volume_ml,
    collected: row.collected_date,
    expires: row.expires_date,
    daysLeft,
  };
}

type InventoryUploadResult = { rows_processed: number; errors: { row: number | string; reason: string }[] };

function InventoryScreen() {
  const [rows, setRows] = useState<InventoryUnit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterType, setFilterType] = useState("All");
  const [collapsedTypes, setCollapsedTypes] = useState<Set<string>>(new Set());

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<InventoryUploadResult | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadHistoryRefreshKey, setUploadHistoryRefreshKey] = useState(0);

  function loadInventory(onSettled?: () => void) {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiGet<InventoryApiRow[]>("/inventory")
      .then((data) => {
        if (!cancelled) setRows(data.map(toInventoryUnit));
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load inventory");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
        onSettled?.();
      });
    return () => {
      cancelled = true;
    };
  }

  useEffect(() => loadInventory(), []);

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    setUploadResult(null);
    try {
      const result = await apiUploadFile<InventoryUploadResult>("/inventory/upload", file);
      setUploadResult(result);
      loadInventory();
      setUploadHistoryRefreshKey((k) => k + 1);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  const types = ["All", ...Array.from(new Set(rows.map((r) => r.type)))];

  const filtered = filterType === "All"
    ? rows
    : rows.filter((r) => r.type === filterType);

  // One "shelf" per blood type present in the filtered data, canonical order,
  // rows within a shelf sorted soonest-to-expire first — mirrors the FEFO
  // (first-expired-first-out) logic the backend already uses for real
  // transfers, so the on-screen order matches how units would actually be
  // pulled.
  const groups = BLOOD_TYPE_ORDER
    .map((type) => ({
      type,
      units: filtered.filter((r) => r.type === type).sort((a, b) => a.daysLeft - b.daysLeft),
    }))
    .filter((g) => g.units.length > 0);

  function toggleGroup(type: string) {
    setCollapsedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  return (
    <div className="max-w-screen-xl mx-auto px-6 py-6 space-y-5">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 className="font-display text-lg font-bold text-foreground">Blood Inventory</h2>
          <p className="text-[13px] text-muted-foreground">{rows.length} units on record</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex gap-1 bg-secondary rounded-lg p-1">
            {types.map((t) => (
              <button
                key={t}
                onClick={() => setFilterType(t)}
                className={`px-3 py-1 text-[12px] font-semibold rounded transition-colors ${
                  filterType === t
                    ? "bg-white text-foreground shadow-sm border border-border"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            onChange={handleFileSelected}
            className="hidden"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            title="Columns: din, blood_type, component, location, volume_ml, collected_date, expires_date. Re-uploading a DIN already on file at this facility updates it as a correction."
            className="flex items-center gap-1.5 h-8 px-3 bg-white border border-border rounded-lg text-[12px] font-semibold text-foreground hover:bg-secondary transition-colors disabled:opacity-60"
          >
            <Upload size={14} /> {uploading ? "Uploading…" : "Upload CSV"}
          </button>
          <button className="flex items-center gap-1.5 h-8 px-3 bg-primary text-white rounded-lg text-[12px] font-semibold hover:bg-primary-hover transition-colors">
            <Plus size={14} /> Add Unit
          </button>
        </div>
      </div>

      {uploadError && (
        <div className="text-[12px] text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {uploadError}
        </div>
      )}
      {uploadResult && (
        <div className="text-[12px] bg-white border border-border rounded-lg px-3 py-2.5 space-y-1">
          <div className="font-semibold text-foreground">
            {uploadResult.rows_processed} unit{uploadResult.rows_processed === 1 ? "" : "s"} processed
            {uploadResult.errors.length > 0 && `, ${uploadResult.errors.length} row${uploadResult.errors.length === 1 ? "" : "s"} skipped`}
          </div>
          {uploadResult.errors.map((e, i) => (
            <div key={i} className="text-red-700">
              Row {e.row}: {e.reason}
            </div>
          ))}
        </div>
      )}

      {/* Shelves — one collapsible group per blood type */}
      {loading && (
        <div className="bg-white border border-border rounded-xl p-12 text-center text-[13px] text-muted-foreground">
          Loading inventory…
        </div>
      )}

      {!loading && error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-6 text-center text-[13px] text-red-700">
          Failed to load inventory: {error}
        </div>
      )}

      {!loading && !error && groups.length === 0 && (
        <div className="bg-white border border-border rounded-xl p-12 text-center text-[13px] text-muted-foreground">
          No units on record{filterType !== "All" ? ` for ${filterType}` : ""}.
        </div>
      )}

      {!loading && !error && groups.map((group) => {
        const isCollapsed = collapsedTypes.has(group.type);
        return (
          <div key={group.type} className="bg-white border border-border rounded-xl overflow-hidden">
            <button
              onClick={() => toggleGroup(group.type)}
              className="w-full flex items-center justify-between gap-3 px-4 py-3 bg-[#F8F9FB] hover:bg-[#F1F3F6] transition-colors"
            >
              <div className="flex items-center gap-3">
                <BloodTypeBadge type={group.type} size="xl" />
                <span className="text-[13px] font-semibold text-muted-foreground">
                  {group.units.length} unit{group.units.length === 1 ? "" : "s"}
                </span>
              </div>
              <ChevronDown
                size={16}
                className={`text-muted-foreground transition-transform shrink-0 ${isCollapsed ? "" : "rotate-180"}`}
              />
            </button>

            {!isCollapsed && (
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-border bg-[#FAFBFC]">
                    {["DIN", "Component", "Location", "Volume (mL)", "Collection Date", "Expiration Date", "Status"].map((h) => (
                      <th key={h} className="text-left py-3 px-4 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {group.units.map((row) => {
                    const status = getExpiryStatus(row.daysLeft);
                    const style = EXPIRY_STYLES[status];
                    return (
                      <tr
                        key={row.din}
                        className={`border-b border-border last:border-0 hover:bg-[#FAFAFA] transition-colors ${style.rowTint}`}
                      >
                        <td className="py-3 px-4">
                          <DinLabel din={row.din} />
                        </td>
                        <td className="py-3 px-4 text-foreground">{row.component}</td>
                        <td className="py-3 px-4">
                          <span className="font-mono text-[12px] text-muted-foreground">{row.location}</span>
                        </td>
                        <td className="py-3 px-4 text-foreground tabular-nums">{row.volume}</td>
                        <td className="py-3 px-4 text-muted-foreground font-mono text-[12px]">{row.collected}</td>
                        <td className="py-3 px-4">
                          <DateStamp date={row.expires} status={status} />
                        </td>
                        <td className="py-3 px-4">
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border ${style.badge}`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
                            {style.label(row.daysLeft)}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        );
      })}

      <UploadHistoryPanel uploadType="inventory" refreshKey={uploadHistoryRefreshKey} onUndone={() => loadInventory()} />
    </div>
  );
}

// ─── Requests (Emergency Sourcing + Transfer) ─────────────────────────────────

type CompatibleAlternative = { blood_type: string; usable_units: number; label: string };

type Facility = {
  id: number;
  name: string;
  facility_type: string;
  address: string;
  latitude: number;
  longitude: number;
  distance_km: number;
  matching_units: number;
  usable_units: number;
  available: boolean;
  compatible_alternatives: CompatibleAlternative[];
};

type EmergencyType = "trauma" | "scheduled_surgery" | "restock";

const EMERGENCY_TYPE_LABELS: Record<EmergencyType, string> = {
  trauma: "Trauma",
  scheduled_surgery: "Scheduled Surgery",
  restock: "Restock",
};

type RequestRow = {
  id: number;
  requesting_facility_id: number;
  supplying_facility_id: number;
  blood_type: string;
  quantity: number;
  emergency_type: EmergencyType;
  status: string;
  created_at: string;
  supplier_confirmed_at: string | null;
  requester_confirmed_at: string | null;
  supplying_facility_name?: string;
  requesting_facility_name?: string;
};

type ActingFacility = { id: number; name: string; facility_type: string };

type RequestAction = "accept" | "decline" | "cancel" | "confirm-release" | "confirm-receipt";

type RequestMessage = {
  id: number;
  request_id: number;
  sender_facility_id: number;
  sender_facility_name: string;
  message: string;
  created_at: string;
};

function IncomingRequestCard({
  req, busy, onAction, isChatSelected, onOpenChat,
}: {
  req: RequestRow;
  busy: boolean;
  onAction: (id: number, action: RequestAction) => void;
  isChatSelected: boolean;
  onOpenChat: (id: number) => void;
}) {
  return (
    <div className={`rounded-lg border p-3 ${isChatSelected ? "border-primary" : "border-border"}`}>
      <div className="flex items-center justify-between mb-1.5">
        <div className="text-[13px] font-semibold text-foreground">
          {req.requesting_facility_name ?? "Unknown facility"}
        </div>
        <BloodTypeBadge type={req.blood_type} size="sm" />
      </div>
      <div className="text-[11px] text-muted-foreground mb-2">
        {req.quantity} units · {EMERGENCY_TYPE_LABELS[req.emergency_type]}
      </div>
      <button
        onClick={() => onOpenChat(req.id)}
        className={`block text-[11px] font-semibold mb-2 hover:underline ${isChatSelected ? "text-primary" : "text-muted-foreground"}`}
      >
        {isChatSelected ? "Viewing chat" : "Open chat"}
      </button>

      {req.status === "pending" && (
        <div className="flex gap-1.5">
          <button
            onClick={() => onAction(req.id, "accept")}
            disabled={busy}
            className="h-7 px-3 bg-primary text-white text-[11px] font-semibold rounded-lg hover:bg-primary-hover transition-colors disabled:opacity-60"
          >
            {busy ? "…" : "Accept"}
          </button>
          <button
            onClick={() => onAction(req.id, "decline")}
            disabled={busy}
            className="h-7 px-3 bg-white border border-border text-[11px] font-semibold text-foreground rounded-lg hover:bg-secondary transition-colors disabled:opacity-60"
          >
            Decline
          </button>
        </div>
      )}

      {req.status === "accepted" && !req.supplier_confirmed_at && (
        <button
          onClick={() => onAction(req.id, "confirm-release")}
          disabled={busy}
          className="w-full h-7 bg-primary text-white text-[11px] font-semibold rounded-lg hover:bg-primary-hover transition-colors disabled:opacity-60"
        >
          {busy ? "Confirming…" : "Confirm Release"}
        </button>
      )}

      {req.status === "accepted" && req.supplier_confirmed_at && !req.requester_confirmed_at && (
        <span className="text-[11px] font-semibold text-status-watch-text">Released — awaiting requester confirmation</span>
      )}

      {req.status === "completed" && (
        <span className="flex items-center gap-1 text-[11px] font-semibold text-status-safe-text">
          <CheckCircle size={12} /> Completed
        </span>
      )}

      {req.status === "declined" && (
        <span className="text-[11px] font-semibold text-muted-foreground">Declined</span>
      )}

      {req.status === "cancelled" && (
        <span className="text-[11px] font-semibold text-muted-foreground">Cancelled by requester</span>
      )}
    </div>
  );
}

function RequestsScreen({
  initialSearchType, onConsumedSourcingPrefill,
  initialHighlightRequestId, onConsumedHighlight,
}: {
  initialSearchType?: string | null;
  onConsumedSourcingPrefill?: () => void;
  initialHighlightRequestId?: number | null;
  onConsumedHighlight?: () => void;
}) {
  const [tab, setTab] = useState<RequestTab>(initialHighlightRequestId ? "transfer" : "sourcing");
  const [searchType, setSearchType] = useState(initialSearchType ?? "O-");
  const [quantityNeeded, setQuantityNeeded] = useState(3);
  // Blood banks have no patients, so trauma/scheduled_surgery (which grant
  // non-preemptive priority ahead of restock — see IMMEDIATE_USE_TYPES in
  // main.py) can never legitimately apply to a blood-bank-originated
  // request. The server enforces this regardless of what's sent here; this
  // just keeps the UI honest about the only value that will actually land.
  const isBloodBankRequester = getCurrentUser()?.facility_type === "bloodbank";
  const [emergencyType, setEmergencyType] = useState<EmergencyType>(isBloodBankRequester ? "restock" : "trauma");
  const [selectedBank, setSelectedBank] = useState<number | null>(null);
  const [chatInput, setChatInput] = useState("");
  const [selectedRequestId, setSelectedRequestId] = useState<number | null>(initialHighlightRequestId ?? null);
  const [messages, setMessages] = useState<RequestMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [sendingMessage, setSendingMessage] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);

  // Consume each one-shot prefill whenever it actually arrives — keyed off
  // the prop itself, not mount, since this screen does NOT remount when a
  // notification is clicked while already sitting on Requests (screen state
  // stays "requests", so only the props change). Mount-only would silently
  // no-op in exactly that case: a user already on this screen clicking a
  // notification. Each effect re-firing on the same value it just consumed
  // (App() resets the corresponding state to null right after) is harmless —
  // the `if` guard just skips it.
  useEffect(() => {
    if (initialSearchType) {
      setSearchType(initialSearchType);
      onConsumedSourcingPrefill?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSearchType]);

  useEffect(() => {
    if (initialHighlightRequestId) {
      setTab("transfer");
      setSelectedRequestId(initialHighlightRequestId);
      onConsumedHighlight?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialHighlightRequestId]);

  const [banks, setBanks] = useState<Facility[]>([]);
  const [banksLoading, setBanksLoading] = useState(true);
  const [banksError, setBanksError] = useState<string | null>(null);

  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [requestsLoading, setRequestsLoading] = useState(true);
  const [requestsError, setRequestsError] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [justSentBankId, setJustSentBankId] = useState<number | null>(null);

  // Acting facility now resolves the same way api.ts resolves it server-side:
  // dev override (if ?dev=1 and the global DevFacilityBanner picked one) wins,
  // else the real logged-in user's own facility. No local switcher here
  // anymore — selection happens once, globally, in App().
  const actingFacilityId = getDevFacilityId() ?? getCurrentUser()?.facility_id ?? null;

  // Only fetched for display-name resolution when dev-overriding to a facility
  // that isn't the logged-in user's own (whose name we already have via session).
  const [facilities, setFacilities] = useState<ActingFacility[]>([]);
  useEffect(() => {
    if (!isDevModeEnabled()) return;
    apiGet<ActingFacility[]>("/facilities").then(setFacilities);
  }, []);

  // /requests and /requests/incoming each only resolve the OTHER side's name
  // (the "us" side is implied) — this fills in "us" for the chat header,
  // whichever side of the transfer that happens to be.
  function resolveFacilityName(id: number, providedName?: string): string {
    if (providedName) return providedName;
    if (id === actingFacilityId) {
      return facilities.find((f) => f.id === id)?.name ?? getCurrentUser()?.facility_name ?? `Facility #${id}`;
    }
    return facilities.find((f) => f.id === id)?.name ?? `Facility #${id}`;
  }

  const [incomingRequests, setIncomingRequests] = useState<RequestRow[]>([]);
  const [incomingLoading, setIncomingLoading] = useState(true);
  const [incomingError, setIncomingError] = useState<string | null>(null);

  const [actionPendingId, setActionPendingId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Which of the requester's own pending requests is showing the "are you
  // sure" confirmation before cancel — cancel is real and non-reversible,
  // unlike accept/decline elsewhere in this screen, so it gets a step the
  // others don't.
  const [cancelConfirmId, setCancelConfirmId] = useState<number | null>(null);

  function fetchRequests() {
    setRequestsLoading(true);
    setRequestsError(null);
    apiGet<RequestRow[]>("/requests")
      .then((data) => setRequests(data))
      .catch((err) => setRequestsError(err instanceof Error ? err.message : "Failed to load"))
      .finally(() => setRequestsLoading(false));
  }

  useEffect(() => {
    fetchRequests();
  }, []);

  function fetchIncoming() {
    if (actingFacilityId === null) return;
    setIncomingLoading(true);
    setIncomingError(null);
    apiGet<RequestRow[]>("/requests/incoming")
      .then((data) => setIncomingRequests(data))
      .catch((err) => setIncomingError(err instanceof Error ? err.message : "Failed to load"))
      .finally(() => setIncomingLoading(false));
  }

  useEffect(() => {
    fetchIncoming();
  }, [actingFacilityId]);

  async function performRequestAction(requestId: number, action: RequestAction) {
    if (actingFacilityId === null) return;
    setActionPendingId(requestId);
    setActionError(null);
    try {
      await apiPost(`/requests/${requestId}/${action}`, {});
      fetchRequests();
      fetchIncoming();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setActionPendingId(null);
    }
  }

  async function sendRequest(bankId: number) {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await apiPost("/requests", {
        supplying_facility_id: bankId,
        blood_type: searchType,
        quantity: quantityNeeded,
        emergency_type: emergencyType,
      });
      setJustSentBankId(bankId);
      fetchRequests();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Failed to send request");
    } finally {
      setSubmitting(false);
    }
  }

  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [messages]);

  // Real coordination-chat history for whichever request is selected, scoped
  // server-side to the two facilities on either side of it. Polled rather than
  // pushed — there's no websocket layer in this app, and 4s is close enough to
  // "live" at this scale.
  useEffect(() => {
    if (selectedRequestId === null) {
      setMessages([]);
      setMessagesError(null);
      return;
    }
    let cancelled = false;
    function fetchMessages() {
      apiGet<RequestMessage[]>(`/requests/${selectedRequestId}/messages`)
        .then((data) => {
          if (cancelled) return;
          setMessages(data);
          setMessagesError(null);
        })
        .catch((err) => {
          if (!cancelled) setMessagesError(err instanceof Error ? err.message : "Failed to load");
        })
        .finally(() => {
          if (!cancelled) setMessagesLoading(false);
        });
    }
    setMessagesLoading(true);
    fetchMessages();
    const interval = setInterval(fetchMessages, CHAT_MESSAGE_POLL_MS);
    return () => { cancelled = true; clearInterval(interval); };
  }, [selectedRequestId]);

  useEffect(() => {
    let cancelled = false;
    setBanksLoading(true);
    setBanksError(null);
    setJustSentBankId(null);
    setSubmitError(null);
    const params = new URLSearchParams({ blood_type: searchType, quantity: String(quantityNeeded) });
    apiGet<Facility[]>(`/facilities/nearby?${params}`)
      .then((data) => {
        if (cancelled) return;
        setBanks(data);
        // Default to the nearest facility that actually has enough stock; fall
        // back to just-nearest if none currently qualify.
        const nearestAvailable = data.find((b) => b.available);
        setSelectedBank((nearestAvailable ?? data[0])?.id ?? null);
      })
      .catch((err) => {
        if (!cancelled) setBanksError(err instanceof Error ? err.message : "Failed to load");
      })
      .finally(() => {
        if (!cancelled) setBanksLoading(false);
      });
    return () => { cancelled = true; };
  }, [searchType, quantityNeeded]);

  async function sendMessage() {
    if (!chatInput.trim() || selectedRequestId === null || sendingMessage) return;
    setSendingMessage(true);
    try {
      const sent = await apiPost<RequestMessage>(`/requests/${selectedRequestId}/messages`, {
        message: chatInput.trim(),
      });
      setMessages((prev) => [...prev, sent]);
      setChatInput("");
      setMessagesError(null);
    } catch (err) {
      setMessagesError(err instanceof Error ? err.message : "Failed to send message");
    } finally {
      setSendingMessage(false);
    }
  }

  const bloodTypes = ["A+", "A-", "B+", "B-", "O+", "O-", "AB+", "AB-"];
  const pendingOnly = requests.filter((r) => r.status === "pending");

  return (
    <div className="max-w-screen-xl mx-auto px-6 py-6">
      {/* Sub-tabs */}
      <div className="flex gap-1 mb-6 bg-secondary rounded-lg p-1 w-fit">
        {(["sourcing", "transfer", "pending"] as RequestTab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`relative px-5 py-2 text-[13px] font-semibold rounded transition-colors ${
              tab === t
                ? "bg-white text-foreground shadow-sm border border-border"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t === "sourcing" ? "Emergency Sourcing" : t === "transfer" ? "Request & Transfer" : "Pending Requests"}
            {t === "pending" && pendingOnly.length > 0 && (
              <span className="absolute -top-1 -right-1 w-4 h-4 bg-primary text-white text-[9px] font-bold rounded-full flex items-center justify-center">
                {pendingOnly.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {tab === "sourcing" && (
        <div className="grid lg:grid-cols-5 gap-5">
          {/* Left: search + results */}
          <div className="lg:col-span-2 space-y-4">
            <div className="bg-white border border-border rounded-xl p-5">
              <h3 className="font-semibold text-foreground mb-4">Find Blood Supply</h3>
              <div className="mb-3">
                <label className="text-[12px] font-semibold text-muted-foreground block mb-1.5">
                  Blood type needed
                </label>
                <div className="grid grid-cols-4 gap-1.5">
                  {bloodTypes.map((bt) => (
                    <button
                      key={bt}
                      onClick={() => setSearchType(bt)}
                      className={`py-2 text-[13px] font-display font-bold rounded-lg border transition-colors ${
                        searchType === bt
                          ? "bg-primary text-white border-primary"
                          : "bg-primary-tint text-primary border-transparent hover:border-primary/40"
                      }`}
                    >
                      {bt}
                    </button>
                  ))}
                </div>
              </div>
              <div className="mb-4">
                <label className="text-[12px] font-semibold text-muted-foreground block mb-1.5">
                  Units needed
                </label>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setQuantityNeeded(Math.max(1, quantityNeeded - 1))}
                    className="w-8 h-8 border border-border rounded-lg text-foreground font-bold hover:bg-secondary flex items-center justify-center"
                  >
                    −
                  </button>
                  <span className="text-lg font-bold text-foreground w-8 text-center">{quantityNeeded}</span>
                  <button
                    onClick={() => setQuantityNeeded(quantityNeeded + 1)}
                    className="w-8 h-8 border border-border rounded-lg text-foreground font-bold hover:bg-secondary flex items-center justify-center"
                  >
                    +
                  </button>
                </div>
              </div>
            </div>

            {/* Blood type compatibility notice */}
            {(() => {
              const compatible = (bloodCompatibility[searchType] ?? []).filter((t) => t !== searchType);
              return compatible.length > 0 ? (
                <div className="bg-info-tint border border-info-border rounded-xl px-4 py-3 flex gap-3">
                  <AlertTriangle size={15} className="text-info shrink-0 mt-0.5" />
                  <div>
                    <div className="text-[12px] font-semibold text-info-text mb-1">
                      No exact match? Compatible alternatives:
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {compatible.map((t) => (
                        <button
                          key={t}
                          onClick={() => setSearchType(t)}
                          className="px-2.5 py-0.5 text-[12px] font-bold rounded border bg-white border-info-border text-info hover:bg-info-tint transition-colors"
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                    <div className="text-[10px] text-info mt-1.5 leading-snug">
                      Based on standard donor-recipient compatibility. Always verify with clinical staff.
                    </div>
                  </div>
                </div>
              ) : null;
            })()}

            <div className="space-y-2">
              <div className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground px-1">
                Nearest Facilities — {searchType} Available
              </div>
              {banksLoading && (
                <div className="bg-white border border-border rounded-xl p-6 text-center text-[12px] text-muted-foreground">
                  Loading facilities…
                </div>
              )}
              {!banksLoading && banksError && (
                <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-center text-[12px] text-red-700">
                  Failed to load facilities: {banksError}
                </div>
              )}
              {!banksLoading && !banksError && banks.map((bank, i) => (
                <div
                  key={bank.id}
                  onClick={() => setSelectedBank(bank.id)}
                  className={`w-full text-left bg-white border rounded-xl p-4 transition-all cursor-pointer ${
                    selectedBank === bank.id
                      ? "border-primary ring-2 ring-primary/20"
                      : "border-border hover:border-primary/40"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex gap-3">
                      <div className="w-6 h-6 rounded-full bg-primary/10 text-primary font-bold text-[11px] flex items-center justify-center shrink-0 mt-0.5">
                        {i + 1}
                      </div>
                      <div>
                        <div className="font-semibold text-[13px] text-foreground leading-tight">
                          {bank.name}
                        </div>
                        <div className="text-[11px] text-muted-foreground mt-0.5">{bank.address}</div>
                        <div className="flex items-center gap-1 mt-1.5">
                          <MapPin size={11} className="text-muted-foreground" />
                          <span className="text-[12px] font-semibold text-foreground">{bank.distance_km} km</span>
                        </div>
                      </div>
                    </div>
                    <div className="shrink-0">
                      {bank.available ? (
                        <span className="flex items-center gap-1 text-[11px] font-semibold bg-status-safe-tint text-status-safe-text px-2 py-0.5 rounded-full border border-status-safe-border">
                          <CheckCircle size={11} /> Available
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-[11px] font-semibold bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full border border-gray-200">
                          Unavailable
                        </span>
                      )}
                    </div>
                  </div>
                  {!bank.available && bank.compatible_alternatives.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-border">
                      <div className="text-[11px] text-info-text font-medium mb-1">
                        {searchType} unavailable here — compatible alternative{bank.compatible_alternatives.length > 1 ? "s" : ""} in stock:
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {bank.compatible_alternatives.map((alt) => (
                          <button
                            key={alt.blood_type}
                            onClick={(e) => { e.stopPropagation(); setSearchType(alt.blood_type); }}
                            className="flex items-center gap-1.5 rounded-lg hover:opacity-80 transition-opacity"
                          >
                            <BloodTypeBadge type={alt.blood_type} size="lg" />
                            <span className="text-[11px] font-semibold text-muted-foreground">{alt.usable_units} units</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {selectedBank === bank.id && bank.available && (
                    <div className="mt-3 pt-3 border-t border-border">
                      {justSentBankId === bank.id ? (
                        <div className="w-full h-8 bg-status-safe-tint text-status-safe-text border border-status-safe-border rounded-lg text-[12px] font-semibold flex items-center justify-center gap-1.5">
                          <CheckCircle size={14} /> Request Sent
                        </div>
                      ) : (
                        <button
                          onClick={() => sendRequest(bank.id)}
                          disabled={submitting}
                          className="w-full h-8 bg-primary text-white text-[12px] font-semibold rounded-lg hover:bg-primary-hover transition-colors flex items-center justify-center gap-1.5 disabled:opacity-60"
                        >
                          <ArrowRight size={14} /> {submitting ? "Sending…" : "Request from this facility"}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Facility detail panel */}
          <div className="lg:col-span-3 bg-white border border-border rounded-xl flex flex-col">
            {banksLoading && (
              <div className="flex-1 flex items-center justify-center text-center px-8 py-16 text-[13px] text-muted-foreground">
                Loading facilities…
              </div>
            )}
            {!banksLoading && banksError && (
              <div className="flex-1 flex items-center justify-center text-center px-8 py-16 text-[13px] text-red-700">
                Failed to load facilities: {banksError}
              </div>
            )}
            {!banksLoading && !banksError && (selectedBank ? (() => {
              const bank = banks.find((b) => b.id === selectedBank)!;
              return (
                <>
                  <div className="px-6 py-4 border-b border-border flex items-center justify-between">
                    <div>
                      <h3 className="font-semibold text-foreground">{bank.name}</h3>
                      <p className="text-[12px] text-muted-foreground mt-0.5">{bank.address}</p>
                    </div>
                    {bank.available ? (
                      <span className="flex items-center gap-1 text-[12px] font-semibold bg-status-safe-tint text-status-safe-text px-3 py-1 rounded-full border border-status-safe-border">
                        <CheckCircle size={13} /> Available
                      </span>
                    ) : (
                      <span className="text-[12px] font-semibold bg-gray-100 text-gray-500 px-3 py-1 rounded-full border border-gray-200">
                        Unavailable
                      </span>
                    )}
                  </div>

                  {/* Real map — every ranked candidate is a real pin at its
                      real coordinates; the selected one is the larger, primary-
                      colored pin. Click any pin to select that facility. */}
                  <div className="mx-6 mt-5 rounded-xl overflow-hidden border border-border" style={{ height: 240 }}>
                    <FacilityNetworkMap key={searchType} banks={banks} selectedBankId={selectedBank} onSelectBank={setSelectedBank} />
                  </div>

                  <div className="px-6 py-5 space-y-3">
                    <div className="grid grid-cols-2 gap-3 text-[13px]">
                      {[
                        { label: "Distance", value: `${bank.distance_km} km` },
                        { label: "Availability", value: bank.available ? "Available" : "Unavailable" },
                        { label: "Blood type needed", value: `${searchType} (${quantityNeeded} units)` },
                        {
                          label: "Est. usable stock",
                          value: bank.available ? `${bank.usable_units} units above reserve` : "Below safety reserve",
                        },
                      ].map(({ label, value }) => (
                        <div key={label} className="bg-secondary rounded-lg px-4 py-3">
                          <div className="text-[11px] text-muted-foreground font-medium mb-0.5">{label}</div>
                          <div className="font-semibold text-foreground">{value}</div>
                        </div>
                      ))}
                    </div>

                    {!bank.available && bank.compatible_alternatives.length > 0 && (
                      <div className="bg-info-tint border border-info-border rounded-lg px-4 py-3">
                        <div className="text-[12px] font-semibold text-info-text mb-1.5">
                          {searchType} unavailable here — compatible alternatives in stock:
                        </div>
                        <div className="flex flex-wrap gap-2.5">
                          {bank.compatible_alternatives.map((alt) => (
                            <button
                              key={alt.blood_type}
                              onClick={() => setSearchType(alt.blood_type)}
                              className="flex items-center gap-1.5 rounded-lg hover:opacity-80 transition-opacity"
                            >
                              <BloodTypeBadge type={alt.blood_type} size="xl" />
                              <span className="text-[12px] font-semibold text-muted-foreground">{alt.usable_units} units</span>
                            </button>
                          ))}
                        </div>
                        <div className="text-[10px] text-info mt-1.5 leading-snug">
                          Selecting a type re-runs the search — you'll need to review and confirm before sending a request for a different type.
                        </div>
                      </div>
                    )}

                    {bank.available && (
                      <>
                        <div>
                          <label className="text-[12px] font-semibold text-muted-foreground block mb-1.5">
                            Reason for request
                          </label>
                          {isBloodBankRequester ? (
                            <div className="py-2 px-3 text-[12px] font-bold rounded-lg border border-border bg-secondary text-foreground w-fit">
                              Restock
                            </div>
                          ) : (
                            <div className="grid grid-cols-3 gap-1.5">
                              {(Object.keys(EMERGENCY_TYPE_LABELS) as EmergencyType[]).map((et) => (
                                <button
                                  key={et}
                                  onClick={() => setEmergencyType(et)}
                                  className={`py-2 text-[12px] font-bold rounded-lg border transition-colors ${
                                    emergencyType === et
                                      ? "bg-primary text-white border-primary"
                                      : "bg-white text-foreground border-border hover:border-primary/40"
                                  }`}
                                >
                                  {EMERGENCY_TYPE_LABELS[et]}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>

                        {submitError && (
                          <div className="text-[12px] text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                            Failed to send request: {submitError}
                          </div>
                        )}

                        {justSentBankId === bank.id ? (
                          <div className="w-full h-10 bg-status-safe-tint text-status-safe-text border border-status-safe-border rounded-lg text-[13px] font-semibold flex items-center justify-center gap-2">
                            <CheckCircle size={15} /> Request Sent
                          </div>
                        ) : (
                          <button
                            onClick={() => sendRequest(bank.id)}
                            disabled={submitting}
                            className="w-full h-10 bg-primary text-white text-[13px] font-semibold rounded-lg hover:bg-primary-hover transition-colors flex items-center justify-center gap-2 disabled:opacity-60"
                          >
                            <ArrowRight size={15} /> {submitting ? "Sending…" : "Send Request to This Facility"}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </>
              );
            })() : (
              <div className="flex-1 flex flex-col items-center justify-center text-center px-8 py-16">
                <div className="w-14 h-14 rounded-full bg-secondary flex items-center justify-center mb-4">
                  <MapPin size={22} className="text-muted-foreground" />
                </div>
                <h3 className="font-semibold text-foreground mb-1">Select a facility</h3>
                <p className="text-[13px] text-muted-foreground max-w-xs leading-relaxed">
                  Choose a blood bank from the list to view its details and send a request.
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === "transfer" && (
        <div className="grid lg:grid-cols-5 gap-5">
          {/* Transfer confirmation flow */}
          <div className="lg:col-span-2 space-y-4">
            {actionError && (
              <div className="text-[12px] text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {actionError}
              </div>
            )}

            {/* Incoming requests — supplier-side actions */}
            <div className="bg-white border border-border rounded-xl p-5">
              <h3 className="font-semibold text-foreground mb-1">
                Incoming Requests — {
                  facilities.find((f) => f.id === actingFacilityId)?.name
                  ?? getCurrentUser()?.facility_name
                  ?? "…"
                }
              </h3>
              <p className="text-[12px] text-muted-foreground mb-4">
                Requests directed to you as the supplying facility
              </p>

              {incomingLoading && (
                <div className="text-[12px] text-muted-foreground py-4 text-center">Loading…</div>
              )}
              {!incomingLoading && incomingError && (
                <div className="text-[12px] text-red-700 py-4 text-center">Failed to load: {incomingError}</div>
              )}
              {!incomingLoading && !incomingError && incomingRequests.length === 0 && (
                <div className="text-[12px] text-muted-foreground py-4 text-center">
                  No incoming requests for this facility.
                </div>
              )}
              {!incomingLoading && !incomingError && incomingRequests.length > 0 && (
                <div className="space-y-2">
                  {incomingRequests.map((req) => (
                    <IncomingRequestCard
                      key={req.id}
                      req={req}
                      busy={actionPendingId === req.id}
                      onAction={performRequestAction}
                      isChatSelected={selectedRequestId === req.id}
                      onOpenChat={setSelectedRequestId}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Outgoing requests — requester-side confirmation */}
            <div className="bg-white border border-border rounded-xl p-5">
              <h3 className="font-semibold text-foreground mb-1">Your Requests Awaiting Confirmation</h3>
              <p className="text-[12px] text-muted-foreground mb-4">Requests you sent that have been accepted</p>

              {requestsLoading && (
                <div className="text-[12px] text-muted-foreground py-4 text-center">Loading…</div>
              )}
              {!requestsLoading && requestsError && (
                <div className="text-[12px] text-red-700 py-4 text-center">Failed to load: {requestsError}</div>
              )}
              {!requestsLoading && !requestsError && (() => {
                const accepted = requests.filter((r) => r.status === "accepted" || r.status === "completed");
                if (accepted.length === 0) {
                  return (
                    <div className="text-[12px] text-muted-foreground py-4 text-center">
                      Nothing accepted yet.
                    </div>
                  );
                }
                return (
                  <div className="space-y-2">
                    {accepted.map((req) => {
                      const canConfirmReceipt = actingFacilityId === req.requesting_facility_id;
                      const busy = actionPendingId === req.id;
                      return (
                        <div
                          key={req.id}
                          className={`rounded-lg border p-3 ${selectedRequestId === req.id ? "border-primary" : "border-border"}`}
                        >
                          <div className="flex items-center justify-between mb-1.5">
                            <div className="text-[13px] font-semibold text-foreground">
                              {req.supplying_facility_name}
                            </div>
                            <BloodTypeBadge type={req.blood_type} size="sm" />
                          </div>
                          <div className="text-[11px] text-muted-foreground mb-2">
                            {req.quantity} units · {EMERGENCY_TYPE_LABELS[req.emergency_type]}
                          </div>
                          <button
                            onClick={() => setSelectedRequestId(req.id)}
                            className={`block text-[11px] font-semibold mb-2 hover:underline ${selectedRequestId === req.id ? "text-primary" : "text-muted-foreground"}`}
                          >
                            {selectedRequestId === req.id ? "Viewing chat" : "Open chat"}
                          </button>

                          {req.status === "completed" ? (
                            <span className="flex items-center gap-1 text-[11px] font-semibold text-status-safe-text">
                              <CheckCircle size={12} /> Completed
                            </span>
                          ) : !req.supplier_confirmed_at ? (
                            <span className="text-[11px] text-muted-foreground">
                              Waiting for supplier to confirm release
                            </span>
                          ) : canConfirmReceipt ? (
                            <button
                              onClick={() => performRequestAction(req.id, "confirm-receipt")}
                              disabled={busy}
                              className="w-full h-7 bg-primary text-white text-[11px] font-semibold rounded-lg hover:bg-primary-hover transition-colors disabled:opacity-60"
                            >
                              {busy ? "Confirming…" : "Confirm Receipt"}
                            </button>
                          ) : (
                            <span className="text-[11px] text-muted-foreground">
                              Switch to the requesting facility above to confirm receipt
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          </div>

          {/* Coordination chat — real, per-request messages (see request_messages table) */}
          <div className="lg:col-span-3 bg-white border border-border rounded-xl flex flex-col" style={{ height: 600 }}>
            {(() => {
              const selectedRequest = [...requests, ...incomingRequests].find((r) => r.id === selectedRequestId);
              return (
                <>
                  <div className="px-5 py-4 border-b border-border flex items-center justify-between">
                    <div>
                      <h3 className="font-semibold text-foreground">Coordination Chat</h3>
                      <p className="text-[12px] text-muted-foreground">
                        {selectedRequest
                          ? `REQ-${selectedRequest.id} · ${resolveFacilityName(selectedRequest.requesting_facility_id, selectedRequest.requesting_facility_name)} ↔ ${resolveFacilityName(selectedRequest.supplying_facility_id, selectedRequest.supplying_facility_name)} · ${selectedRequest.blood_type} · ${selectedRequest.quantity} units`
                          : "Select a request from the left to view its coordination chat"}
                      </p>
                    </div>
                    {selectedRequestId !== null && (
                      <div className="flex items-center gap-1.5 text-[12px] font-semibold text-green-700">
                        <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                        Live
                      </div>
                    )}
                  </div>

                  <div ref={chatRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
                    {selectedRequestId === null && (
                      <div className="h-full flex flex-col items-center justify-center text-center px-8">
                        <div className="w-14 h-14 rounded-full bg-secondary flex items-center justify-center mb-4">
                          <MessageSquare size={22} className="text-muted-foreground" />
                        </div>
                        <h3 className="font-semibold text-foreground mb-1">No request selected</h3>
                        <p className="text-[13px] text-muted-foreground max-w-xs leading-relaxed">
                          Click "Open chat" on a request in either list to the left.
                        </p>
                      </div>
                    )}
                    {selectedRequestId !== null && messagesLoading && messages.length === 0 && (
                      <div className="text-center text-[12px] text-muted-foreground py-8">Loading messages…</div>
                    )}
                    {selectedRequestId !== null && messagesError && (
                      <div className="text-center text-[12px] text-red-700 py-2">{messagesError}</div>
                    )}
                    {selectedRequestId !== null && !messagesLoading && messages.length === 0 && !messagesError && (
                      <div className="h-full flex flex-col items-center justify-center text-center px-8">
                        <div className="w-14 h-14 rounded-full bg-primary-tint flex items-center justify-center mb-4">
                          <MessageSquare size={22} className="text-primary" />
                        </div>
                        <h3 className="font-semibold text-foreground mb-1">No messages yet</h3>
                        <p className="text-[13px] text-muted-foreground max-w-xs leading-relaxed">
                          Say hello below to get coordination started with the other facility.
                        </p>
                      </div>
                    )}
                    {messages.map((msg) => {
                      const isOwn = msg.sender_facility_id === actingFacilityId;
                      const time = new Date(msg.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                      return (
                        <div key={msg.id} className={`flex flex-col ${isOwn ? "items-end" : "items-start"}`}>
                          <div className={`text-[11px] font-semibold mb-1 ${isOwn ? "text-primary" : "text-muted-foreground"}`}>
                            {msg.sender_facility_name} · {time}
                          </div>
                          <div
                            className={`max-w-[80%] px-4 py-3 rounded-2xl text-[13px] leading-relaxed ${
                              isOwn
                                ? "bg-primary text-white rounded-br-md"
                                : "bg-secondary text-foreground rounded-bl-md"
                            }`}
                          >
                            {msg.message}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {(() => {
                    // Mirrors the backend's send_request_message guard exactly —
                    // sending is only meaningful once the other side can actually
                    // see it (the requester's own chat access only opens up once
                    // accepted), so a still-pending request can't send either.
                    const canSend = selectedRequest
                      ? selectedRequest.status === "accepted" || selectedRequest.status === "completed"
                      : false;
                    const placeholder =
                      selectedRequestId === null
                        ? "Select a request first…"
                        : canSend
                        ? "Type a message…"
                        : "Messaging opens once this request is accepted";
                    return (
                      <div className="px-4 py-3 border-t border-border flex gap-2">
                        <input
                          type="text"
                          value={chatInput}
                          onChange={(e) => setChatInput(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && sendMessage()}
                          placeholder={placeholder}
                          disabled={!canSend || sendingMessage}
                          className="flex-1 h-9 px-3 text-[13px] border border-border rounded-lg bg-[#F9FAFB] focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary disabled:opacity-60"
                        />
                        <button
                          onClick={sendMessage}
                          disabled={!canSend || sendingMessage || !chatInput.trim()}
                          className="h-9 w-9 bg-primary text-white rounded-lg flex items-center justify-center hover:bg-primary-hover transition-colors disabled:opacity-50"
                        >
                          <Send size={15} />
                        </button>
                      </div>
                    );
                  })()}
                </>
              );
            })()}
          </div>
        </div>
      )}

      {tab === "pending" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-foreground">Outgoing Requests</h3>
              <p className="text-[13px] text-muted-foreground mt-0.5">
                Immediate-use requests shown first, then by submission time — accepted requests aren't reshuffled
              </p>
            </div>
            <span className="text-[12px] font-semibold text-muted-foreground bg-secondary px-3 py-1 rounded-full border border-border">
              {pendingOnly.length} pending
            </span>
          </div>

          {actionError && (
            <div className="text-[12px] text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {actionError}
            </div>
          )}

          {requestsLoading && (
            <div className="bg-white border border-border rounded-xl p-10 text-center text-[13px] text-muted-foreground">
              Loading requests…
            </div>
          )}
          {!requestsLoading && requestsError && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-6 text-center text-[13px] text-red-700">
              Failed to load requests: {requestsError}
            </div>
          )}
          {!requestsLoading && !requestsError && pendingOnly.length === 0 && (
            <div className="bg-white border border-border rounded-xl p-10 text-center text-[13px] text-muted-foreground">
              No pending requests. Send one from the Emergency Sourcing tab.
            </div>
          )}
          {!requestsLoading && !requestsError && pendingOnly.length > 0 && (
            <div className="bg-white border border-border rounded-xl overflow-hidden">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-border bg-[#F8F9FB]">
                    {["Request ID", "Supplying Facility", "Blood Type", "Qty", "Reason", "Submitted", "Status", ""].map((h) => (
                      <th key={h} className="text-left py-3 px-4 text-[11px] font-bold uppercase tracking-wide text-muted-foreground whitespace-nowrap">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pendingOnly
                    .map((req) => {
                      const reasonStyle = {
                        trauma: "bg-status-critical-tint text-status-critical-text border-status-critical-border",
                        scheduled_surgery: "bg-info-tint text-info-text border-info-border",
                        restock: "bg-secondary text-muted-foreground border-border",
                      }[req.emergency_type];
                      const submittedTime = new Date(req.created_at).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      });
                      return (
                        <tr key={req.id} className="border-b border-border last:border-0 hover:bg-[#FAFAFA] transition-colors">
                          <td className="py-3 px-4">
                            <span className="font-mono text-[12px] text-muted-foreground">REQ-{req.id}</span>
                          </td>
                          <td className="py-3 px-4 font-medium text-foreground">{req.supplying_facility_name}</td>
                          <td className="py-3 px-4">
                            <BloodTypeBadge type={req.blood_type} size="md" />
                          </td>
                          <td className="py-3 px-4 font-semibold text-foreground tabular-nums">{req.quantity}</td>
                          <td className="py-3 px-4">
                            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold border ${reasonStyle}`}>
                              {EMERGENCY_TYPE_LABELS[req.emergency_type]}
                            </span>
                          </td>
                          <td className="py-3 px-4 font-mono text-[12px] text-muted-foreground">{submittedTime}</td>
                          <td className="py-3 px-4">
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-status-watch-tint text-status-watch-text border border-status-watch-border">
                              <Clock size={11} /> Awaiting response
                            </span>
                          </td>
                          <td className="py-3 px-4 text-right">
                            <button
                              onClick={() => setCancelConfirmId(req.id)}
                              disabled={actionPendingId === req.id}
                              className="h-7 px-3 bg-white border border-border text-[11px] font-semibold text-status-critical-text rounded-lg hover:bg-status-critical-tint transition-colors disabled:opacity-60"
                            >
                              Cancel Request
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {cancelConfirmId !== null && (() => {
        const req = requests.find((r) => r.id === cancelConfirmId);
        if (!req) return null;
        return (
          <Modal title="Cancel Request" onClose={() => setCancelConfirmId(null)}>
            <div className="space-y-4">
              <p className="text-[13px] text-muted-foreground">
                Cancel the {req.quantity}-unit {req.blood_type} request to {req.supplying_facility_name}?
                This can't be undone — you'll need to submit a new request if you still need this blood type.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setCancelConfirmId(null)}
                  className="flex-1 h-10 border border-border rounded-md text-sm font-semibold text-foreground hover:bg-secondary transition-colors"
                >
                  Keep Request
                </button>
                <button
                  onClick={async () => {
                    setCancelConfirmId(null);
                    await performRequestAction(req.id, "cancel");
                  }}
                  className="flex-1 h-10 bg-status-critical-text text-white text-sm font-bold rounded-md hover:opacity-90 transition-colors"
                >
                  Cancel Request
                </button>
              </div>
            </div>
          </Modal>
        );
      })()}
    </div>
  );
}

// ─── SMS Donor Blast ──────────────────────────────────────────────────────────

type DonorUploadResult = { rows_processed: number; errors: { row: number; reason: string }[] };

type BlastSummary = {
  id: number;
  blood_type: string;
  target_count: number;
  time_limit_hours: number;
  status: string;
  created_at: string;
  deadline_at: string;
};

type BlastMessageEntry = {
  donor_id: number;
  donor_name: string;
  phone: string;
  message_text: string;
};

type CreateBlastResponse = {
  blast: BlastSummary;
  simulated: boolean;
  label: string;
  recipient_count: number;
  messages: BlastMessageEntry[];
};

type BlastMessagesResponse = { simulated: boolean; label: string; messages: BlastMessageEntry[] };

type ConfirmedDonor = { name: string; phone: string; replied_at: string };
type ConfirmedResponse = {
  blast_status: string;
  target_count: number;
  confirmed_count: number;
  confirmed_donors: ConfirmedDonor[];
};

function ChatScreen() {
  const bloodTypes = ["A+", "A-", "B+", "B-", "O+", "O-", "AB+", "AB-"];
  const isDevMode = isDevModeEnabled();

  // Donor roster upload
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<DonorUploadResult | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [donorCount, setDonorCount] = useState<number | null>(null);
  const [uploadHistoryRefreshKey, setUploadHistoryRefreshKey] = useState(0);

  function refreshDonorCount() {
    apiGet<unknown[]>("/donors").then((rows) => setDonorCount(rows.length)).catch(() => {});
  }
  useEffect(() => { refreshDonorCount(); }, []);

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    setUploadResult(null);
    try {
      const result = await apiUploadFile<DonorUploadResult>("/donors/upload", file);
      setUploadResult(result);
      refreshDonorCount();
      setUploadHistoryRefreshKey((k) => k + 1);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  // Blast creation
  const [selectedType, setSelectedType] = useState("O-");
  const [targetCount, setTargetCount] = useState(5);
  const [timeLimitHours, setTimeLimitHours] = useState(2);
  const [creatingBlast, setCreatingBlast] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Active blast detail — either just created, or the most recent one on
  // mount, so a page refresh doesn't lose visibility mid-drive.
  const [activeBlastId, setActiveBlastId] = useState<number | null>(null);
  const [blastSummary, setBlastSummary] = useState<BlastSummary | null>(null);
  const [blastMessagesData, setBlastMessagesData] = useState<BlastMessagesResponse | null>(null);
  const [confirmedData, setConfirmedData] = useState<ConfirmedResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  // Tracks the latest requested blast id so an in-flight fetch for a
  // previous blast (e.g. the on-mount "resume most recent" load) can't
  // overwrite fresher data if it resolves after a newer blast was created —
  // a real race condition otherwise, since both fetches hit the same setters.
  const activeBlastIdRef = useRef<number | null>(null);
  useEffect(() => {
    activeBlastIdRef.current = activeBlastId;
  }, [activeBlastId]);

  function loadBlastDetails(blastId: number) {
    setDetailLoading(true);
    setDetailError(null);
    return Promise.all([
      apiGet<BlastMessagesResponse>(`/donors/blasts/${blastId}/messages`),
      apiGet<ConfirmedResponse>(`/donors/blasts/${blastId}/confirmed`),
    ])
      .then(([messagesRes, confirmedRes]) => {
        if (activeBlastIdRef.current !== blastId) return; // stale response, a newer blast is now active
        setBlastMessagesData(messagesRes);
        setConfirmedData(confirmedRes);
        setBlastSummary((prev) => (prev && prev.id === blastId ? { ...prev, status: confirmedRes.blast_status } : prev));
      })
      .catch((err) => {
        if (activeBlastIdRef.current === blastId) {
          setDetailError(err instanceof Error ? err.message : "Failed to load blast details");
        }
      })
      .finally(() => {
        if (activeBlastIdRef.current === blastId) setDetailLoading(false);
      });
  }

  useEffect(() => {
    apiGet<BlastSummary[]>("/donors/blasts")
      .then((blasts) => {
        if (blasts.length > 0) {
          setActiveBlastId(blasts[0].id);
          setBlastSummary(blasts[0]);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (activeBlastId !== null) loadBlastDetails(activeBlastId);
  }, [activeBlastId]);

  async function handleCreateBlast() {
    setCreatingBlast(true);
    setCreateError(null);
    try {
      const result = await apiPost<CreateBlastResponse>("/donors/blast", {
        blood_type: selectedType,
        target_count: targetCount,
        time_limit_hours: timeLimitHours,
      });
      setBlastSummary(result.blast);
      setActiveBlastId(result.blast.id);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create blast");
    } finally {
      setCreatingBlast(false);
    }
  }

  // DEV-ONLY tools (?dev=1) — the only way a reply is ever recorded, since
  // there's no real SMS provider/webhook. Mirrors ALLOW_DEV_TEST_TOOLS
  // server-side; if that's disabled the calls below will 403 with a clear message.
  const [simDonorId, setSimDonorId] = useState<number | "">("");
  const [simReply, setSimReply] = useState<"yes" | "no">("yes");
  const [simTimestamp, setSimTimestamp] = useState("");
  const [simBusy, setSimBusy] = useState(false);
  const [simError, setSimError] = useState<string | null>(null);

  async function handleSimulateReply() {
    if (activeBlastId === null || simDonorId === "") return;
    setSimBusy(true);
    setSimError(null);
    try {
      await apiPost(`/donors/blasts/${activeBlastId}/simulate-reply`, {
        donor_id: simDonorId,
        reply: simReply,
        replied_at: simTimestamp ? new Date(simTimestamp).toISOString() : undefined,
      });
      // Awaited so the busy state (and the button it disables) doesn't clear
      // until the refreshed confirmed-donor list has actually landed — closes
      // a window where a fast second click could act on stale progress data.
      await loadBlastDetails(activeBlastId);
    } catch (err) {
      setSimError(err instanceof Error ? err.message : "Failed to simulate reply");
    } finally {
      setSimBusy(false);
    }
  }

  async function handleForceExpire() {
    if (activeBlastId === null) return;
    setSimBusy(true);
    setSimError(null);
    try {
      await apiPost(`/donors/blasts/${activeBlastId}/dev-force-expire`, {});
      await loadBlastDetails(activeBlastId);
    } catch (err) {
      setSimError(err instanceof Error ? err.message : "Failed to force expire");
    } finally {
      setSimBusy(false);
    }
  }

  const messagedDonors = blastMessagesData
    ? Array.from(new Map(blastMessagesData.messages.map((m) => [m.donor_id, m])).values())
    : [];

  const confirmedCount = confirmedData?.confirmed_count ?? 0;
  const target = blastSummary?.target_count ?? targetCount;
  const isCompleted = blastSummary?.status === "completed";

  return (
    <div className="max-w-screen-xl mx-auto px-6 py-6 space-y-6">
      <div className="grid lg:grid-cols-5 gap-5">
        {/* Compose panel */}
        <div className="lg:col-span-2 space-y-4">
          {/* Donor roster upload */}
          <div className="bg-white border border-border rounded-xl p-5">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center">
                <Upload size={15} className="text-primary" />
              </div>
              <div>
                <h3 className="font-semibold text-foreground">Donor Roster</h3>
                <p className="text-[12px] text-muted-foreground">
                  {donorCount === null ? "Loading…" : `${donorCount} donors on file`}
                </p>
              </div>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              onChange={handleFileSelected}
              className="hidden"
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="w-full h-9 bg-white border border-border rounded-lg text-[12px] font-semibold text-foreground hover:bg-secondary transition-colors flex items-center justify-center gap-1.5 disabled:opacity-60"
            >
              <Upload size={14} /> {uploading ? "Uploading…" : "Upload Donor CSV"}
            </button>
            <p className="text-[11px] text-muted-foreground mt-1.5">
              Columns: name, blood_type, phone. Re-uploading updates existing donors by phone number.
            </p>
            {uploadError && (
              <div className="mt-2 text-[11px] text-red-700 bg-red-50 border border-red-200 rounded-lg px-2.5 py-2">
                {uploadError}
              </div>
            )}
            {uploadResult && (
              <div className="mt-2 text-[11px] bg-secondary rounded-lg px-2.5 py-2 space-y-1">
                <div className="font-semibold text-foreground">{uploadResult.rows_processed} donors processed</div>
                {uploadResult.errors.map((e, i) => (
                  <div key={i} className="text-red-700">
                    Row {e.row}: {e.reason}
                  </div>
                ))}
              </div>
            )}
          </div>

          <UploadHistoryPanel uploadType="donors" refreshKey={uploadHistoryRefreshKey} onUndone={refreshDonorCount} />

          {/* Blast composer */}
          <div className="bg-white border border-border rounded-xl p-5">
            <div className="flex items-center gap-2 mb-5">
              <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center">
                <Phone size={15} className="text-primary" />
              </div>
              <div>
                <h3 className="font-semibold text-foreground">SMS Donor Blast</h3>
                <p className="text-[12px] text-muted-foreground">Simulated — no real provider connected</p>
              </div>
            </div>

            <div className="space-y-4">
              <div>
                <label className="text-[12px] font-semibold text-foreground block mb-2">Blood Type</label>
                <div className="grid grid-cols-4 gap-1.5">
                  {bloodTypes.map((bt) => (
                    <button
                      key={bt}
                      onClick={() => setSelectedType(bt)}
                      className={`py-2 text-[13px] font-display font-bold rounded-lg border transition-colors ${
                        selectedType === bt
                          ? "bg-primary text-white border-primary"
                          : "bg-primary-tint text-primary border-transparent hover:border-primary/40"
                      }`}
                    >
                      {bt}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[12px] font-semibold text-foreground block mb-1.5">
                    Donors needed
                  </label>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setTargetCount(Math.max(1, targetCount - 1))}
                      className="w-8 h-8 border border-border rounded-lg text-foreground font-bold hover:bg-secondary flex items-center justify-center"
                    >
                      −
                    </button>
                    <span className="text-lg font-bold text-foreground w-8 text-center">{targetCount}</span>
                    <button
                      onClick={() => setTargetCount(targetCount + 1)}
                      className="w-8 h-8 border border-border rounded-lg text-foreground font-bold hover:bg-secondary flex items-center justify-center"
                    >
                      +
                    </button>
                  </div>
                </div>
                <div>
                  <label className="text-[12px] font-semibold text-foreground block mb-1.5">
                    Time limit (hrs)
                  </label>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setTimeLimitHours(Math.max(1, timeLimitHours - 1))}
                      className="w-8 h-8 border border-border rounded-lg text-foreground font-bold hover:bg-secondary flex items-center justify-center"
                    >
                      −
                    </button>
                    <span className="text-lg font-bold text-foreground w-8 text-center">{timeLimitHours}</span>
                    <button
                      onClick={() => setTimeLimitHours(timeLimitHours + 1)}
                      className="w-8 h-8 border border-border rounded-lg text-foreground font-bold hover:bg-secondary flex items-center justify-center"
                    >
                      +
                    </button>
                  </div>
                </div>
              </div>

              {createError && (
                <div className="text-[11px] text-red-700 bg-red-50 border border-red-200 rounded-lg px-2.5 py-2">
                  {createError}
                </div>
              )}

              <button
                onClick={handleCreateBlast}
                disabled={creatingBlast}
                className="w-full h-10 bg-primary text-white text-[13px] font-semibold rounded-lg hover:bg-primary-hover transition-colors flex items-center justify-center gap-2 disabled:opacity-60"
              >
                <Send size={15} />
                {creatingBlast ? "Sending…" : "Send Blast"}
              </button>
            </div>
          </div>

          {/* Dev-only reply/expiry simulation tools */}
          {isDevMode && activeBlastId !== null && (
            <div className="bg-amber-50 border border-amber-300 rounded-xl p-5 space-y-3">
              <div className="flex items-center gap-1.5 text-[11px] font-bold text-amber-800 uppercase tracking-wide">
                <AlertTriangle size={14} /> Dev Tools — Simulate Donor Activity
              </div>
              <p className="text-[11px] text-amber-700 leading-snug">
                Stands in for a real donor's SMS reply, since no provider is connected. Only works because this
                server has ALLOW_DEV_TEST_TOOLS enabled.
              </p>

              <div>
                <label className="text-[11px] font-semibold text-amber-800 block mb-1">Donor</label>
                <select
                  value={simDonorId}
                  onChange={(e) => setSimDonorId(e.target.value ? Number(e.target.value) : "")}
                  className="w-full h-8 px-2 rounded-md border border-amber-300 bg-white text-[12px] text-foreground"
                >
                  <option value="">Select a messaged donor…</option>
                  {messagedDonors.map((d) => (
                    <option key={d.donor_id} value={d.donor_id}>
                      {d.donor_name} ({d.phone})
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[11px] font-semibold text-amber-800 block mb-1">Reply</label>
                  <div className="flex gap-1.5">
                    {(["yes", "no"] as const).map((r) => (
                      <button
                        key={r}
                        onClick={() => setSimReply(r)}
                        className={`flex-1 h-8 text-[12px] font-bold rounded-md border transition-colors ${
                          simReply === r
                            ? "bg-primary text-white border-primary"
                            : "bg-white text-foreground border-amber-300"
                        }`}
                      >
                        {r.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="text-[11px] font-semibold text-amber-800 block mb-1">
                    Reply time (optional)
                  </label>
                  <input
                    type="datetime-local"
                    value={simTimestamp}
                    onChange={(e) => setSimTimestamp(e.target.value)}
                    className="w-full h-8 px-2 rounded-md border border-amber-300 bg-white text-[11px] text-foreground"
                  />
                </div>
              </div>

              {simError && (
                <div className="text-[11px] text-red-700 bg-red-50 border border-red-200 rounded-lg px-2.5 py-2">
                  {simError}
                </div>
              )}

              <button
                onClick={handleSimulateReply}
                disabled={simBusy || simDonorId === ""}
                className="w-full h-8 bg-amber-600 text-white text-[12px] font-semibold rounded-lg hover:bg-amber-700 transition-colors disabled:opacity-60"
              >
                {simBusy ? "Working…" : "Simulate Reply"}
              </button>
              <button
                onClick={handleForceExpire}
                disabled={simBusy}
                className="w-full h-8 bg-white border border-amber-300 text-amber-800 text-[12px] font-semibold rounded-lg hover:bg-amber-100 transition-colors disabled:opacity-60"
              >
                Force Deadline Into the Past
              </button>
            </div>
          )}
        </div>

        {/* Results panel */}
        <div className="lg:col-span-3 space-y-4">
          {!blastSummary && !detailLoading && (
            <div className="bg-white border border-border rounded-xl p-10 flex flex-col items-center text-center">
              <div className="w-14 h-14 rounded-full bg-primary-tint flex items-center justify-center mb-4">
                <Send size={22} className="text-primary" />
              </div>
              <h3 className="font-semibold text-foreground mb-1">No blast sent yet</h3>
              <p className="text-[13px] text-muted-foreground max-w-xs leading-relaxed">
                Pick a blood type and donor count on the left, then send to start tracking confirmations here.
              </p>
            </div>
          )}

          {blastSummary && (
            <>
              {/* SIMULATED banner — deliberately the most visually prominent
                  element on this screen, using the exact label text the
                  backend returns, so there's one source of truth for the wording. */}
              {blastMessagesData && (
                <div className="bg-info-tint border-2 border-info-border rounded-xl px-4 py-3 flex items-center gap-2.5">
                  <MessageSquare size={18} className="text-info-text shrink-0" />
                  <div>
                    <div className="text-[13px] font-bold text-info-text">{blastMessagesData.label}</div>
                    <div className="text-[11px] text-info-text">
                      No real SMS provider is connected — this is a logged simulation only.
                    </div>
                  </div>
                </div>
              )}

              <div className="bg-white border border-border rounded-xl">
                <div className="px-5 py-4 border-b border-border flex items-center justify-between">
                  <div>
                    <h3 className="font-semibold text-foreground">
                      {blastSummary.blood_type} Donor Drive
                      {isDevMode && <span className="text-muted-foreground font-normal"> · blast #{blastSummary.id}</span>}
                    </h3>
                    <p className="text-[12px] text-muted-foreground mt-0.5">
                      Target {target} donors within {blastSummary.time_limit_hours}h
                    </p>
                  </div>
                  {isCompleted ? (
                    <span className="flex items-center gap-1 text-[12px] font-semibold bg-status-safe-tint text-status-safe-text px-3 py-1 rounded-full border border-status-safe-border">
                      <CheckCircle size={13} /> Drive Complete
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-[12px] font-semibold bg-status-watch-tint text-status-watch-text px-3 py-1 rounded-full border border-status-watch-border">
                      <Clock size={13} /> Active
                    </span>
                  )}
                </div>

                <div className="px-5 py-3 border-b border-border">
                  <div className="flex justify-between text-[11px] font-semibold mb-1.5">
                    <span className="text-muted-foreground">Confirmation progress</span>
                    <span className="text-status-safe-text">{confirmedCount} of {target} needed</span>
                  </div>
                  <div className="h-2 bg-secondary rounded-full overflow-hidden">
                    <div
                      className="h-full bg-status-safe rounded-full transition-all"
                      style={{ width: `${Math.min(100, (confirmedCount / target) * 100)}%` }}
                    />
                  </div>
                </div>

                {detailError && (
                  <div className="px-5 py-3 text-[12px] text-red-700">Failed to load: {detailError}</div>
                )}

                {confirmedData && confirmedData.confirmed_donors.length === 0 && (
                  <div className="px-5 py-8 text-center text-[12px] text-muted-foreground">
                    No confirmed donors yet.
                  </div>
                )}

                {confirmedData && confirmedData.confirmed_donors.length > 0 && (
                  <div className="divide-y divide-border">
                    {confirmedData.confirmed_donors.map((donor, i) => (
                      <div key={`${donor.phone}-${i}`} className="px-5 py-3 flex items-center gap-4">
                        <span className="text-[10px] font-bold bg-primary/10 text-primary px-1.5 py-0.5 rounded shrink-0">
                          #{i + 1}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="font-semibold text-[13px] text-foreground">{donor.name}</div>
                          <div className="text-[11px] text-muted-foreground font-mono mt-0.5">{donor.phone}</div>
                        </div>
                        <div className="text-[11px] text-muted-foreground font-mono shrink-0">
                          {new Date(donor.replied_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </div>
                        <span className="flex items-center gap-1 text-[11px] font-semibold text-status-safe-text bg-status-safe-tint px-2.5 py-1 rounded-full border border-status-safe-border shrink-0">
                          <CheckCircle size={12} /> Confirmed
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Simulated message log */}
              {blastMessagesData && (
                <div className="bg-white border border-border rounded-xl">
                  <div className="px-5 py-4 border-b border-border">
                    <h3 className="font-semibold text-foreground">Simulated Message Log</h3>
                    <p className="text-[12px] text-muted-foreground mt-0.5">
                      {blastMessagesData.messages.length} log entries — every donor messaged, including drive-complete follow-ups
                    </p>
                  </div>
                  <div className="divide-y divide-border max-h-80 overflow-y-auto">
                    {blastMessagesData.messages.map((m, i) => (
                      <div key={i} className="px-5 py-3">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="font-semibold text-[12px] text-foreground">{m.donor_name}</span>
                          <span className="text-[11px] text-muted-foreground font-mono">{m.phone}</span>
                        </div>
                        <div className="text-[11px] text-muted-foreground leading-relaxed">{m.message_text}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Dev Facility Banner ────────────────────────────────────────────────────
// Global (?dev=1 only) — overrides which facility every screen acts as, for
// testing without needing a second real login. Only works because the server
// has ALLOW_DEV_FACILITY_OVERRIDE enabled (see main.py); off by default there.

function DevFacilityBanner() {
  const [facilities, setFacilities] = useState<ActingFacility[]>([]);
  const [selected, setSelected] = useState<number | null>(() => getDevFacilityId());

  useEffect(() => {
    apiGet<ActingFacility[]>("/facilities").then(setFacilities);
  }, []);

  function handleChange(id: number) {
    setSelected(id);
    setDevFacilityId(id);
    // Simplest way to make every already-mounted screen refetch with the new
    // override header — this is a testing tool, not a polished feature.
    window.location.reload();
  }

  return (
    <div className="bg-amber-50 border-b border-amber-300 px-6 py-2 flex items-center gap-3 text-[12px] flex-wrap">
      <span className="flex items-center gap-1.5 font-bold text-amber-800 uppercase tracking-wide shrink-0">
        <AlertTriangle size={14} /> Dev Mode
      </span>
      <span className="text-amber-700 shrink-0">Viewing every screen as:</span>
      <select
        value={selected ?? ""}
        onChange={(e) => handleChange(Number(e.target.value))}
        className="h-7 px-2 rounded-md border border-amber-300 bg-white text-[12px] font-semibold text-foreground"
      >
        <option value="" disabled>
          Select a facility…
        </option>
        {facilities.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name} ({f.facility_type})
          </option>
        ))}
      </select>
      <span className="text-amber-600 ml-auto shrink-0">Remove "?dev=1" from the URL for normal use.</span>
    </div>
  );
}

// ─── Root App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [screen, setScreen] = useState<Screen>("dashboard");
  // Lazy init reads localStorage synchronously (see session.ts) — if a session
  // was persisted from a previous visit, we're logged in from the very first
  // render, no loading flash or effect needed.
  const [currentUser, setCurrentUser] = useState<SessionUser | null>(() => getCurrentUser());

  // One-shot: set when a hospital's dashboard action prompt sends staff to
  // Emergency Sourcing for a specific blood type. RequestsScreen consumes it
  // on mount (via onConsumedSourcingPrefill) so a later, unrelated visit to
  // Requests (e.g. the top nav) doesn't inherit a stale prefill.
  const [sourcingPrefillType, setSourcingPrefillType] = useState<string | null>(null);

  // Same one-shot pattern, driven by clicking a "requests:{id}" notification
  // — jumps Requests straight to its transfer tab with that request selected.
  const [requestsHighlightId, setRequestsHighlightId] = useState<number | null>(null);

  function handleNotificationNavigate(n: NotificationItem) {
    if (!n.link) return;
    if (n.link.startsWith("requests:")) {
      const id = parseInt(n.link.slice("requests:".length), 10);
      if (!Number.isNaN(id)) setRequestsHighlightId(id);
      setScreen("requests");
    } else if (n.link.startsWith("sourcing:")) {
      setSourcingPrefillType(n.link.slice("sourcing:".length));
      setScreen("requests");
    } else if (n.link === "dashboard" || n.link === "inventory" || n.link === "requests" || n.link === "chat") {
      setScreen(n.link);
    }
  }

  // A session restored from localStorage may be stale — profile_completed
  // could have changed in another tab, or an admin could have reset this
  // account since the last visit. Re-check against the DB once on mount
  // rather than trusting what was persisted; a failure here (e.g. an
  // expired token) just logs the session out, same as any other 401 would.
  useEffect(() => {
    if (!currentUser) return;
    refreshCurrentUser()
      .then((user) => setCurrentUser(user))
      .catch(() => { apiLogout(); setCurrentUser(null); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Drives --role-accent (theme.css): hospital gets navy, everything else
  // (bloodbank, admin, logged-out) keeps the original oxblood default. Set
  // on <html> rather than a wrapper div so it's in effect before any themed
  // element paints, and so it still applies to full-bleed screens like the
  // login page's own brand panel once cleared on logout.
  useEffect(() => {
    if (currentUser?.facility_type === "hospital") {
      document.documentElement.setAttribute("data-role", "hospital");
    } else {
      document.documentElement.removeAttribute("data-role");
    }
  }, [currentUser?.facility_type]);

  function handleLogout() {
    apiLogout();
    setCurrentUser(null);
    setScreen("dashboard");
  }

  if (!currentUser) {
    return (
      <div style={{ fontFamily: "var(--font-body)" }}>
        <LoginScreen onLogin={(user) => { setCurrentUser(user); setScreen("dashboard"); }} />
      </div>
    );
  }

  if (currentUser.role === "admin") {
    return (
      <div style={{ fontFamily: "var(--font-body)" }}>
        <AdminDashboardScreen user={currentUser} onLogout={handleLogout} />
      </div>
    );
  }

  if (!currentUser.profile_completed) {
    return (
      <div style={{ fontFamily: "var(--font-body)" }}>
        <CompleteProfileScreen user={currentUser} onComplete={() => setCurrentUser(getCurrentUser())} />
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "var(--font-body)" }} className="min-h-screen bg-background">
      <TopNav screen={screen} setScreen={setScreen} onLogout={handleLogout} user={currentUser} onNotificationNavigate={handleNotificationNavigate} />
      {isDevModeEnabled() && <DevFacilityBanner />}
      <main>
        {screen === "dashboard" && (
          <DashboardScreen
            onRequestBloodType={(bloodType) => {
              setSourcingPrefillType(bloodType);
              setScreen("requests");
            }}
          />
        )}
        {screen === "inventory" && <InventoryScreen />}
        {screen === "requests" && (
          <RequestsScreen
            initialSearchType={sourcingPrefillType}
            onConsumedSourcingPrefill={() => setSourcingPrefillType(null)}
            initialHighlightRequestId={requestsHighlightId}
            onConsumedHighlight={() => setRequestsHighlightId(null)}
          />
        )}
        {screen === "chat" && <ChatScreen />}
      </main>
    </div>
  );
}

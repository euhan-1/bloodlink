import { useState, useRef, useEffect } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, ErrorBar,
} from "recharts";
import { AlertTriangle, ArrowRight, Bell, CheckCircle, Clock, FlaskConical, TrendingUp, Upload, Zap } from "lucide-react";
import {
  apiGet, uploadHistoricalInventorySnapshots, notifyNearbyHospitals,
  type HistoricalUploadResult, type NotifyNearbyHospitalsResult,
} from "../lib/api";
import {
  getExpiryStatus, EXPIRY_STYLES, type StatusLevel, STATUS_STYLES, stockStatus, STATUS_HEX,
} from "../lib/statusTokens";
import { StatusDot, BloodTypeBadge } from "../components/BloodTypeBadge";
import { UploadHistoryPanel } from "../components/UploadHistoryPanel";
import { type InventoryUnit, type InventoryApiRow, toInventoryUnit } from "../lib/inventoryTypes";

// Narrowed to just the fields this screen actually reads — the full request
// shape (RequestRow) belongs to the Requests screen; Dashboard only ever
// counts how many are active/emergency, so it doesn't need the rest.
type ActiveRequestSummary = { status: string; emergency_type: string };

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

export function DashboardScreen({ onRequestBloodType }: { onRequestBloodType: (bloodType: string) => void }) {
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
    apiGet<ActiveRequestSummary[]>(endpoint)
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

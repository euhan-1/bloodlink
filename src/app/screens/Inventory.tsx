import { useState, useRef, useEffect } from "react";
import { Plus, Upload, ChevronDown } from "lucide-react";
import { apiGet, apiUploadFile } from "../lib/api";
import { BLOOD_TYPE_ORDER, getExpiryStatus, EXPIRY_STYLES } from "../lib/statusTokens";
import { BloodTypeBadge, DinLabel, DateStamp } from "../components/BloodTypeBadge";
import { Skeleton } from "../components/Skeleton";
import { UploadHistoryPanel } from "../components/UploadHistoryPanel";
import { type InventoryUnit, type InventoryApiRow, toInventoryUnit } from "../lib/inventoryTypes";

// ─── Inventory ────────────────────────────────────────────────────────────────

type InventoryUploadResult = { rows_processed: number; errors: { row: number | string; reason: string }[] };

export function InventoryScreen() {
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
    <div className="max-w-screen-2xl mx-auto px-6 py-6 space-y-5">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 className="font-display text-lg font-bold text-foreground">Blood Inventory</h2>
          <p className="text-[14px] text-muted-foreground">{rows.length} units on record</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex gap-1 bg-secondary rounded-lg p-1">
            {types.map((t) => (
              <button
                key={t}
                onClick={() => setFilterType(t)}
                className={`px-3 py-1 text-[13px] font-semibold rounded transition-colors ${
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
            className="flex items-center gap-1.5 h-8 px-3 bg-white border border-border rounded-lg text-[13px] font-semibold text-foreground hover:bg-secondary transition-colors disabled:opacity-60"
          >
            <Upload size={14} /> {uploading ? "Uploading…" : "Upload CSV"}
          </button>
          <button className="flex items-center gap-1.5 h-8 px-3 bg-primary text-white rounded-lg text-[13px] font-semibold hover:bg-primary-hover transition-colors">
            <Plus size={14} /> Add Unit
          </button>
        </div>
      </div>

      {uploadError && (
        <div className="text-[13px] text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {uploadError}
        </div>
      )}
      {uploadResult && (
        <div className="text-[13px] bg-white border border-border rounded-lg px-3 py-2.5 space-y-1">
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
        <div className="space-y-5" aria-label="Loading inventory">
          {[0, 1, 2].map((i) => (
            <div key={i} className="bg-white border border-border rounded-xl overflow-hidden">
              <div className="flex items-center gap-3 px-4 py-3 bg-[#F8F9FB]">
                <Skeleton className="w-14 h-14 rounded-lg shrink-0" />
                <Skeleton className="h-4 w-24" />
              </div>
              <div className="px-4 py-3 space-y-3">
                {[0, 1].map((j) => (
                  <div key={j} className="flex items-center gap-4">
                    <Skeleton className="h-4 flex-1" />
                    <Skeleton className="h-4 w-20" />
                    <Skeleton className="h-4 w-16" />
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-4 w-20" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-6 text-center text-[14px] text-red-700">
          Failed to load inventory: {error}
        </div>
      )}

      {!loading && !error && groups.length === 0 && (
        <div className="bg-white border border-border rounded-xl p-12 text-center text-[14px] text-muted-foreground">
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
                <span className="text-[14px] font-semibold text-muted-foreground">
                  {group.units.length} unit{group.units.length === 1 ? "" : "s"}
                </span>
              </div>
              <ChevronDown
                size={16}
                className={`text-muted-foreground transition-transform shrink-0 ${isCollapsed ? "" : "rotate-180"}`}
              />
            </button>

            {/* Height-animated via the CSS grid 0fr/1fr trick rather than
                mounting/unmounting the table — lets the collapse/expand
                transition smoothly instead of snapping instantly, without
                measuring pixel heights in JS. */}
            <div
              className={`grid transition-[grid-template-rows] duration-200 ease-out ${
                isCollapsed ? "grid-rows-[0fr]" : "grid-rows-[1fr]"
              }`}
            >
              <div className="overflow-hidden">
                {/* table-layout: fixed keeps column widths stable while the
                    wrapper's height animates — a shelf can hold dozens of
                    rows, and letting the browser keep recomputing
                    auto-layout column widths every animation frame is what
                    makes a big table look janky mid-transition. */}
                <table className="w-full text-[14px] table-fixed">
                  <thead>
                    <tr className="border-b border-border bg-[#FAFBFC]">
                      {["DIN", "Component", "Location", "Volume (mL)", "Collection Date", "Expiration Date", "Status"].map((h) => (
                        <th key={h} className="text-left py-3 px-4 text-[12px] font-bold uppercase tracking-wide text-muted-foreground">
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
                            <span className="font-mono text-[13px] text-muted-foreground">{row.location}</span>
                          </td>
                          <td className="py-3 px-4 text-foreground tabular-nums">{row.volume}</td>
                          <td className="py-3 px-4 text-muted-foreground font-mono text-[13px]">{row.collected}</td>
                          <td className="py-3 px-4">
                            <DateStamp date={row.expires} status={status} />
                          </td>
                          <td className="py-3 px-4">
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[12px] font-semibold border ${style.badge}`}>
                              <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
                              {style.label(row.daysLeft)}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        );
      })}

      <UploadHistoryPanel uploadType="inventory" refreshKey={uploadHistoryRefreshKey} onUndone={() => loadInventory()} />
    </div>
  );
}


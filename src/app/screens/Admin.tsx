import { useState, useEffect } from "react";
import { AlertTriangle, KeyRound, Plus, Trash2, X } from "lucide-react";
import {
  adminListFacilities, adminCreateFacility, adminSetFacilityActive, adminResetAccountPassword, adminDeleteFacility,
  type AdminFacility, type AdminFacilityAccount, type CreateFacilityAccountResult, type AdminPasswordResetResult,
} from "../lib/api";
import { type SessionUser } from "../lib/session";
import { STATUS_STYLES } from "../lib/statusTokens";
import { BloodDropLogo } from "../components/BloodTypeBadge";
import { AccountMenu } from "../components/AccountMenu";
import { Modal } from "../components/Modal";

// Deliberately the one place in the app that asks for typed confirmation
// instead of a Yes/No click — reserved for the one action with no undo.
// Only ever reachable for an already-deactivated facility (see the Delete
// button below, which doesn't even render for an active one); the server
// re-checks both that and full data-entanglement independently regardless,
// so this modal is a UX gate, not the actual safety mechanism.
function DeleteFacilityModal({ facility, onClose, onDeleted }: {
  facility: AdminFacility;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [typedName, setTypedName] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameMatches = typedName === facility.name;

  async function handleDelete() {
    if (!nameMatches) return;
    setDeleting(true);
    setError(null);
    try {
      await adminDeleteFacility(facility.id, typedName);
      onDeleted();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete facility");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Modal title="Delete Facility" onClose={onClose}>
      <div className="space-y-4">
        <div className="rounded-lg border border-status-critical-border bg-status-critical-tint px-3 py-2.5 flex gap-2.5">
          <AlertTriangle size={16} className="text-status-critical-text shrink-0 mt-0.5" />
          <p className="text-[14px] text-status-critical-text leading-snug">
            This permanently deletes <b>{facility.name}</b> — including its login account(s) — and cannot be undone.
            It only succeeds if no other real data (blood units, donors, requests, uploads, notifications, blasts)
            still references it.
          </p>
        </div>

        <div>
          <label className="text-[13px] font-semibold text-foreground block mb-1.5">
            Type <span className="font-mono font-bold">{facility.name}</span> to confirm
          </label>
          <input
            autoFocus
            value={typedName}
            onChange={(e) => setTypedName(e.target.value)}
            placeholder={facility.name}
            className="w-full h-9 px-3 text-sm border border-border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-status-critical-border focus:border-status-critical-text transition-all"
          />
        </div>

        {error && (
          <div className="text-[13.5px] text-status-critical-text bg-status-critical-tint border border-status-critical-border rounded-md px-3 py-2 leading-snug">
            {error}
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
            onClick={handleDelete}
            disabled={!nameMatches || deleting}
            className="flex-1 h-10 bg-status-critical-text text-white text-sm font-bold rounded-md hover:opacity-90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {deleting ? "Deleting…" : "Delete Permanently"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Admin Dashboard ────────────────────────────────────────────────────────

export function AdminDashboardScreen({ user, onLogout }: { user: SessionUser; onLogout: () => void }) {
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

  const [deleteTarget, setDeleteTarget] = useState<AdminFacility | null>(null);

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
          <span className="ml-2 px-2 py-0.5 rounded-full bg-primary/10 text-primary text-[12px] font-bold uppercase tracking-wide">
            Admin
          </span>
        </div>
        <div className="flex items-center gap-3">
          <AccountMenu user={user} onLogout={onLogout} />
        </div>
      </div>

      <div className="max-w-screen-2xl mx-auto px-6 py-6 space-y-6">
        <div className="bg-white border border-border rounded-xl p-5">
          <h3 className="font-semibold text-foreground mb-4">Create Facility Account</h3>
          <form onSubmit={handleCreate} className="grid sm:grid-cols-4 gap-3 items-end">
            <div>
              <label className="text-[13px] font-semibold text-foreground block mb-1.5">Facility name</label>
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full h-9 px-3 text-sm border border-border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all"
              />
            </div>
            <div>
              <label className="text-[13px] font-semibold text-foreground block mb-1.5">Type</label>
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
              <label className="text-[13px] font-semibold text-foreground block mb-1.5">Official email</label>
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
              className="h-9 bg-primary text-white rounded-md text-[14px] font-semibold hover:bg-primary-hover transition-colors disabled:opacity-60 flex items-center justify-center gap-1.5"
            >
              <Plus size={15} /> {creating ? "Creating…" : "Create Account"}
            </button>
          </form>

          {createError && (
            <div className="mt-3 text-[13px] text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
              {createError}
            </div>
          )}
          {createResult && (
            <div className="mt-3 text-[13px] bg-secondary rounded-md px-3 py-2.5 space-y-1">
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
            <span className="text-[13px] text-muted-foreground">{facilities.length} total</span>
          </div>

          {loading && (
            <div className="p-8 text-center text-[14px] text-muted-foreground">Loading…</div>
          )}
          {!loading && loadError && (
            <div className="p-6 text-center text-[14px] text-red-700">{loadError}</div>
          )}
          {!loading && !loadError && (
            <>
              {statusError && (
                <div className="mx-5 mt-4 text-[13px] text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
                  {statusError}
                </div>
              )}
              {resetError && (
                <div className="mx-5 mt-4 text-[13px] text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
                  {resetError}
                </div>
              )}
              {resetResult && (
                <div className="mx-5 mt-4 text-[13px] bg-secondary rounded-md px-3 py-2.5 flex items-start justify-between gap-3">
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
              <table className="w-full text-[14px]">
                <thead>
                  <tr className="border-b border-border bg-[#F8F9FB]">
                    {["Facility", "Type", "Account(s)", "Profile", "Status", ""].map((h) => (
                      <th key={h} className="text-left py-3 px-4 text-[12px] font-bold uppercase tracking-wide text-muted-foreground">
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
                              <div className="font-mono text-[13px] text-foreground">
                                {a.email}
                                {a.must_change_password && (
                                  <span className="ml-1.5 font-sans text-[12px] text-status-watch-text">(pending first login)</span>
                                )}
                              </div>
                              <button
                                onClick={() => handleResetPassword(a)}
                                disabled={resetBusyId === a.id}
                                title="Reset password"
                                className="shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-[12px] font-semibold text-muted-foreground hover:text-primary hover:bg-primary-tint transition-colors disabled:opacity-60"
                              >
                                <KeyRound size={11} /> {resetBusyId === a.id ? "…" : "Reset"}
                              </button>
                            </div>
                          ))
                        )}
                      </td>
                      <td className="py-3 px-4">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-full text-[12px] font-semibold border ${
                            f.profile_completed ? STATUS_STYLES.safe.badge : STATUS_STYLES.watch.badge
                          }`}
                        >
                          {f.profile_completed ? "Complete" : "Incomplete"}
                        </span>
                      </td>
                      <td className="py-3 px-4">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-full text-[12px] font-semibold border ${
                            f.is_active ? STATUS_STYLES.safe.badge : STATUS_STYLES.critical.badge
                          }`}
                        >
                          {f.is_active ? "Active" : "Deactivated"}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            onClick={() => handleToggleActive(f)}
                            disabled={statusBusyId === f.id}
                            className={`h-7 px-3 rounded-md text-[13px] font-semibold border transition-colors disabled:opacity-60 ${
                              f.is_active
                                ? "border-status-critical-border text-status-critical-text hover:bg-status-critical-tint"
                                : "border-status-safe-border text-status-safe-text hover:bg-status-safe-tint"
                            }`}
                          >
                            {statusBusyId === f.id ? "…" : f.is_active ? "Deactivate" : "Reactivate"}
                          </button>
                          {/* Deletion is only ever reachable for an already-deactivated
                              facility — not just disabled, not rendered at all for an
                              active one, so there's no path to it without the
                              deactivate step happening first. */}
                          {!f.is_active && (
                            <button
                              onClick={() => setDeleteTarget(f)}
                              title="Delete facility"
                              className="h-7 w-7 flex items-center justify-center rounded-md border border-border text-muted-foreground hover:text-status-critical-text hover:border-status-critical-border hover:bg-status-critical-tint transition-colors"
                            >
                              <Trash2 size={13} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>

      {deleteTarget && (
        <DeleteFacilityModal
          facility={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={loadFacilities}
        />
      )}
    </div>
  );
}


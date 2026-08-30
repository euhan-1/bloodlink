import { useState, useEffect } from "react";
import "./lib/leafletSetup";
import {
  apiGet,
  login as apiLogin, logout as apiLogout,
  changePassword as apiChangePassword, completeFacilityProfile, refreshCurrentUser, requestPasswordReset,
  type NotificationItem,
} from "./lib/api";
import { getCurrentUser, type SessionUser } from "./lib/session";
import { isDevModeEnabled, getDevFacilityId, setDevFacilityId } from "./lib/devMode";
import { BloodDropLogo } from "./components/BloodTypeBadge";
import { FacilityLocationFields } from "./components/FacilityLocationPicker";
import { NotificationBell, AccountMenu } from "./components/AccountMenu";
import { DashboardScreen } from "./screens/Dashboard";
import { InventoryScreen } from "./screens/Inventory";
import { RequestsScreen } from "./screens/Requests";
import { ChatScreen } from "./screens/Donors";
import { AdminDashboardScreen } from "./screens/Admin";
import {
  AlertTriangle, MapPin,
  Phone,
  Activity, Package,
  RefreshCw, ShieldCheck, Zap, FlaskConical, Building2,
} from "lucide-react";

type Screen = "login" | "dashboard" | "inventory" | "requests" | "chat";

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

// ─── Dev Facility Banner ────────────────────────────────────────────────────
// Global (?dev=1 only) — overrides which facility every screen acts as, for
// testing without needing a second real login. Only works because the server
// has ALLOW_DEV_FACILITY_OVERRIDE enabled (see main.py); off by default there.

type ActingFacility = { id: number; name: string; facility_type: string };

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

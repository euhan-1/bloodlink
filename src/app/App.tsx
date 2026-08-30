import { useState, useRef, useEffect } from "react";
import "./lib/leafletSetup";
import {
  apiGet,
  login as apiLogin, logout as apiLogout,
  changePassword as apiChangePassword, completeFacilityProfile, refreshCurrentUser, requestPasswordReset,
  adminListFacilities, adminCreateFacility, adminSetFacilityActive, adminResetAccountPassword,
  type AdminFacility, type AdminFacilityAccount, type CreateFacilityAccountResult, type AdminPasswordResetResult,
  getMyFacilityProfile, updatePassword as apiUpdatePassword,
  listNotifications, markNotificationRead, markAllNotificationsRead, type NotificationItem,
} from "./lib/api";
import { getCurrentUser, type SessionUser } from "./lib/session";
import { isDevModeEnabled, getDevFacilityId, setDevFacilityId } from "./lib/devMode";
import { STATUS_STYLES } from "./lib/statusTokens";
import { BloodDropLogo } from "./components/BloodTypeBadge";
import { FacilityLocationFields } from "./components/FacilityLocationPicker";
import { Modal } from "./components/Modal";
import { DashboardScreen } from "./screens/Dashboard";
import { InventoryScreen } from "./screens/Inventory";
import { RequestsScreen } from "./screens/Requests";
import { ChatScreen } from "./screens/Donors";
import {
  AlertTriangle, CheckCircle, MapPin,
  Plus, Phone, Bell, User, LogOut,
  Activity, Package, ChevronDown,
  RefreshCw, ShieldCheck, Zap, FlaskConical, Building2,
  KeyRound, X,
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

// ─── Account Menu (Change Password / Edit Facility Profile / Log out) ─────

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

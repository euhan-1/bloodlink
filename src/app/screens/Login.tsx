import { useState } from "react";
import { Building2, FlaskConical, RefreshCw, ShieldCheck, Zap } from "lucide-react";
import {
  login as apiLogin, changePassword as apiChangePassword, requestPasswordReset,
} from "../lib/api";
import { type SessionUser } from "../lib/session";
import { BloodDropLogo } from "../components/BloodTypeBadge";

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

export function LoginScreen({ onLogin }: { onLogin: (user: SessionUser) => void }) {
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
          <p className="text-white/70 text-[16px] leading-relaxed">
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
                  <label className="text-[14px] font-semibold text-foreground block mb-1.5">
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
                  <div className="text-[13px] text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
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
                  className="w-full text-[13px] text-muted-foreground hover:text-foreground transition-colors"
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
                <p className="text-[13px] font-semibold text-muted-foreground mb-1.5">Quick demo login</p>
                <div className="flex gap-1 bg-secondary rounded-lg p-1">
                  {(Object.keys(DEMO_ACCOUNTS) as DemoAccountType[]).map((type) => (
                    <button
                      key={type}
                      type="button"
                      onClick={() => handleSelectDemo(type)}
                      className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-[14px] font-semibold rounded transition-colors ${
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
                  <label className="text-[14px] font-semibold text-foreground block mb-1.5">
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
                    <label className="text-[14px] font-semibold text-foreground">Password</label>
                    <button
                      type="button"
                      onClick={() => { setForgotMode(true); setError(null); setForgotEmail(email); }}
                      className="text-[13px] text-primary hover:underline"
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
                  <div className="text-[13px] text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
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
                <p className="text-[13px] text-amber-800 leading-relaxed">
                  <strong>Admin-provisioned accounts.</strong> New facilities are onboarded by a BloodLink administrator, who issues a temporary password for first sign-in — there's no self-service registration.
                </p>
              </div>

              <p className="mt-6 text-center text-[13px] text-muted-foreground">
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
        <p className="text-[12px] font-mono text-muted-foreground bg-secondary rounded px-2 py-1.5 mb-6 break-all">
          reset code (no email provider connected — shown here instead): {pendingReset.resetToken.slice(0, 24)}…
        </p>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="text-[14px] font-semibold text-foreground block mb-1.5">New password</label>
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
          <label className="text-[14px] font-semibold text-foreground block mb-1.5">Confirm new password</label>
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
          <div className="text-[13px] text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
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
          className="w-full text-[13px] text-muted-foreground hover:text-foreground transition-colors"
        >
          Back to sign in
        </button>
      </form>
    </>
  );
}


import { useState, useEffect } from "react";
import "./lib/leafletSetup";
import {
  apiGet, logout as apiLogout,
  completeFacilityProfile, refreshCurrentUser,
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
import { LoginScreen } from "./screens/Login";
import {
  AlertTriangle, MapPin,
  Phone,
  Activity, Package,
  RefreshCw,
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

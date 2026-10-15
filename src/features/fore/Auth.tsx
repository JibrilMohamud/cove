import { useUiText, UiText } from "./ui-text";
import { useEffect, useState } from "react";
import { Eye, EyeOff, Mail, ArrowRight, BookOpen } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { api } from "./client";
export type AuthMode = "login" | "signup" | "verify" | "reset" | "new-password";
function b64urlBytes(value: string) {
  const b64 = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const raw = atob(b64);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
function requestOptions(raw: any): PublicKeyCredentialRequestOptions {
  const o = structuredClone(raw);
  o.challenge = b64urlBytes(o.challenge);
  o.allowCredentials = (o.allowCredentials || []).map((c: any) => ({
    ...c,
    id: b64urlBytes(c.id),
  }));
  return o;
}
function credentialJson(c: PublicKeyCredential) {
  if ((c as any).toJSON) return (c as any).toJSON();
  const enc = (b: ArrayBuffer) => {
    let x = "";
    for (const n of new Uint8Array(b)) x += String.fromCharCode(n);
    return btoa(x).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  };
  const r: any = c.response;
  return {
    id: c.id,
    rawId: enc(c.rawId),
    type: c.type,
    response: {
      clientDataJSON: enc(r.clientDataJSON),
      authenticatorData: r.authenticatorData ? enc(r.authenticatorData) : undefined,
      signature: r.signature ? enc(r.signature) : undefined,
      userHandle: r.userHandle ? enc(r.userHandle) : null,
    },
    clientExtensionResults: c.getClientExtensionResults(),
    authenticatorAttachment: (c as any).authenticatorAttachment,
  };
}
export function AuthDialog({
  mode,
  onChange,
  onSuccess,
}: {
  mode: AuthMode | null;
  onChange: (v: AuthMode | null) => void;
  onSuccess: () => Promise<void>;
}) {
  const ui = useUiText();
  const [username, setUsername] = useState(""),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [code, setCode] = useState(""),
    [visible, setVisible] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [options, setOptions] = useState({ available: false, google: false }),
    [loading, setLoading] = useState(true),
    [acceptTerms, setAcceptTerms] = useState(false);
  useEffect(() => {
    if (!mode) return;
    setError("");
    setMessage("");
    setPassword("");
    setVisible(false);
    setAcceptTerms(false);
    setLoading(true);
    api("/auth/options")
      .then(setOptions)
      .catch(() => setOptions({ available: false, google: false }))
      .finally(() => setLoading(false));
  }, [mode]);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (mode === "signup") {
        if (!acceptTerms)
          throw Error(ui("Please review and agree to the Terms of Service and Privacy Policy."));
        await api("/auth/signup", "POST", { username, email, password, acceptTerms: true });
        onChange("verify");
      } else if (mode === "verify") {
        await api("/auth/verify", "POST", { email, code });
        await onSuccess();
        onChange(null);
      } else if (mode === "login") {
        const result = await api("/auth/login", "POST", { login: username, password });
        if (result?.mfaRequired) {
          const sec = await api<any>("/auth/security");
          const factor = sec?.factors?.totp?.find((f: any) => f.status === "verified");
          if (!factor)
            throw Error(
              ui(
                "This account requires MFA, but no verified authenticator factor is available. Use account recovery or contact support.",
              ),
            );
          const otp = prompt(ui("Enter the current code from your authenticator app:"));
          if (!otp) throw Error(ui("MFA verification is required to continue."));
          await api("/auth/mfa/verify", "POST", { factorId: factor.id, code: otp });
        }
        await onSuccess();
        onChange(null);
      } else if (mode === "reset") {
        const r = await api("/auth/reset", "POST", { email });
        setMessage(r.message);
      } else if (mode === "new-password") {
        await api("/auth/password", "POST", { password });
        onChange("login");
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const title =
    mode === "signup"
      ? ui("A reading life of your own.")
      : mode === "verify"
        ? ui("Check your inbox.")
        : mode === "reset"
          ? ui("Find your way back.")
          : mode === "new-password"
            ? ui("Choose a new password.")
            : ui("Welcome back.");
  return (
    <Dialog open={!!mode} onOpenChange={(v) => !v && onChange(null)}>
      <DialogContent className="fore-dialog auth-dialog">
        <span className="brand-icon">
          <BookOpen size={29} />
        </span>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {mode === "verify"
            ? ui(
                "We sent a verification link to {email}. Open it to verify your account, then sign in. You can also enter the email code below if one is included.",
                { email: email || ui("your email address") },
              )
            : mode === "signup"
              ? ui(
                  "Keep your books, notes, and reading progress together. Verify your email to finish creating your account.",
                )
              : mode === "reset"
                ? ui("Enter your verified email address for a password-reset link.")
                : ui("Your next chapter is waiting.")}
        </DialogDescription>
        {!loading && !options.available && (
          <p className="notice" role="status">
            {ui("Account sign-in is being set up. You can still browse and read.")}
          </p>
        )}
        {(mode === "signup" || mode === "login") && (
          <>
            <a
              className={"button outline google-signin" + (!options.google ? " is-disabled" : "")}
              aria-disabled={!options.google}
              href={options.google ? "/api/fore/auth/google" : undefined}
              onClick={(e) => {
                if (!options.google) e.preventDefault();
              }}
            >
              <span className="google-g" aria-hidden="true">
                G
              </span>{" "}
              {ui("Continue with Google")}
            </a>
            {mode === "login" &&
              typeof window !== "undefined" &&
              "PublicKeyCredential" in window && (
                <button
                  type="button"
                  className="button outline"
                  disabled={busy || !options.available}
                  onClick={async () => {
                    setBusy(true);
                    setError("");
                    try {
                      const start = await api<any>(
                        "/auth/passkey/authentication/start",
                        "POST",
                        {},
                      );
                      const credential = (await navigator.credentials.get({
                        publicKey: requestOptions(start.options),
                      })) as PublicKeyCredential | null;
                      if (!credential) throw Error(ui("Passkey sign-in was canceled."));
                      await api("/auth/passkey/authentication/verify", "POST", {
                        challengeId: start.challenge_id,
                        credential: credentialJson(credential),
                      });
                      await onSuccess();
                      onChange(null);
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {ui("Use a passkey")}
                </button>
              )}
            <div className="auth-divider">
              <span>
                {mode === "signup" ? ui("or use your email") : ui("or use your password")}
              </span>
            </div>
          </>
        )}
        <form className="fore-form auth-form" onSubmit={submit}>
          {(mode === "signup" || mode === "login") && (
            <label>
              {mode === "signup" ? ui("Username") : ui("Username or email")}
              <input
                autoComplete={mode === "signup" ? "username" : "username"}
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                minLength={mode === "signup" ? 3 : 1}
                maxLength={mode === "signup" ? 30 : 254}
                pattern={mode === "signup" ? "[a-zA-Z][a-zA-Z0-9_]{2,29}" : undefined}
                placeholder={mode === "signup" ? "your_reading_name" : ui("Username or email")}
              />
            </label>
          )}
          {(mode === "signup" || mode === "reset" || mode === "verify") && (
            <label>
              {ui("Email address")}
              <input
                type="email"
                autoComplete="email"
                required
                maxLength={254}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </label>
          )}
          {(mode === "signup" || mode === "login" || mode === "new-password") && (
            <label>
              {ui("Password")}
              <div className="password-input">
                <input
                  type={visible ? "text" : "password"}
                  autoComplete={mode === "login" ? "current-password" : "new-password"}
                  required
                  minLength={mode === "login" ? 1 : 12}
                  maxLength={128}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={
                    mode === "login" ? ui("Your password") : ui("At least 12 characters")
                  }
                />
                <button
                  type="button"
                  className="icon-button"
                  aria-label={visible ? ui("Hide password") : ui("Show password")}
                  aria-pressed={visible}
                  onClick={() => setVisible(!visible)}
                >
                  {visible ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </label>
          )}
          {mode === "verify" && (
            <label>
              {ui("Verification code")}
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                pattern="[0-9]{6,10}"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder={ui("Code from your email")}
              />
            </label>
          )}
          {error && (
            <p className="notice" role="alert">
              {error}
            </p>
          )}
          {message && (
            <p className="small" role="status">
              {message}
            </p>
          )}
          {mode === "signup" && (
            <label className="auth-legal-consent">
              <input
                type="checkbox"
                checked={acceptTerms}
                onChange={(e) => setAcceptTerms(e.target.checked)}
                required
              />{" "}
              <span>
                <UiText
                  source="I agree to Cove's {terms} and acknowledge its {privacy}."
                  values={{
                    terms: (
                      <a href="/terms" target="_blank" rel="noopener noreferrer">
                        {ui("Terms of Service")}
                      </a>
                    ),
                    privacy: (
                      <a href="/privacy" target="_blank" rel="noopener noreferrer">
                        {ui("Privacy Policy")}
                      </a>
                    ),
                  }}
                />
              </span>
            </label>
          )}
          <button
            className="button gold"
            disabled={busy || !options.available || (mode === "signup" && !acceptTerms)}
          >
            {busy
              ? ui("Please wait…")
              : mode === "signup"
                ? ui("Create account")
                : mode === "verify"
                  ? ui("Verify email")
                  : mode === "reset"
                    ? ui("Send reset link")
                    : mode === "new-password"
                      ? ui("Save new password")
                      : ui("Log in")}
            <ArrowRight size={17} />
          </button>
        </form>
        {mode === "verify" && (
          <button
            className="text-link"
            disabled={busy || !options.available}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await api("/auth/resend", "POST", { email });
                setMessage(r.message);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Mail size={15} />
            {ui("Resend verification email")}
          </button>
        )}
        {mode === "login" && (
          <button className="text-link" onClick={() => onChange("reset")}>
            {ui("Forgot your password?")}
          </button>
        )}
        <p className="small muted">
          {ui("We respect your reading privacy.")}{" "}
          <a href="/terms" target="_blank" rel="noopener noreferrer">
            {ui("Terms")}
          </a>{" "}
          ·{" "}
          <a href="/privacy" target="_blank" rel="noopener noreferrer">
            {ui("Privacy")}
          </a>
        </p>
        <p className="small muted">
          {mode === "signup"
            ? ui("Already have an account?") + " "
            : mode === "login"
              ? ui("New to Cove?") + " "
              : ""}
          <button
            className="text-link"
            onClick={() => onChange(mode === "login" ? "signup" : "login")}
          >
            {mode === "login" ? ui("Create account") : ui("Back to log in")}
          </button>
        </p>
      </DialogContent>
    </Dialog>
  );
}

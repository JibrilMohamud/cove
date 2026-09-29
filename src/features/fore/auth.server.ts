import { createServerClient, parseCookieHeader, serializeCookieHeader } from "@supabase/ssr";
import { z } from "zod";
import type { CoveEnv } from "./api.server";
import { ApiError, json, readBody, rateLimit, now } from "./service";
import { emitNotification } from "./notifications.server";
import { assessAccountTakeoverRisk } from "./risk-tax.server";
export type CoveIdentity = {
  id: string;
  email: string;
  name: string;
  registered: boolean;
  username?: string;
  aal?: "aal1" | "aal2" | null;
  authProvider?: string;
  authSubject?: string;
  sessionFingerprint?: string;
};
const identities = new WeakMap<Request, CoveIdentity | null>();
export const resolvedIdentity = (request: Request) => identities.get(request);
export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z][a-z0-9_]{2,29}$/,
    "Use 3–30 letters, numbers, or underscores; start with a letter.",
  );
const emailSchema = z
  .string()
  .trim()
  .email("Enter a valid email address.")
  .max(254)
  .transform((s) => s.toLowerCase());
const passwordSchema = z
  .string()
  .min(12, "Use at least 12 characters.")
  .max(128, "Use at most 128 characters.");
const providerSettings = new Map<string, { until: number; confirmation: boolean }>();
async function requireEmailConfirmation(env: CoveEnv) {
  const key = env.SUPABASE_URL!,
    cached = providerSettings.get(key);
  if (cached && cached.until > Date.now()) {
    if (!cached.confirmation)
      throw new ApiError(503, "Email verification must be enabled before registration can open.");
    return;
  }
  let settings: any;
  try {
    const response = await fetch(key.replace(/\/$/, "") + "/auth/v1/settings", {
      headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY! },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error("Provider settings unavailable");
    settings = await response.json();
  } catch {
    throw new ApiError(503, "Account sign-in is temporarily unavailable. Please try again later.");
  }
  const confirmation = settings.mailer_autoconfirm === false;
  providerSettings.set(key, { until: Date.now() + 60000, confirmation });
  if (!confirmation)
    throw new ApiError(503, "Email verification must be enabled before registration can open.");
}
export async function createAuth(request: Request, env: CoveEnv) {
  const changes: { name: string; value: string; options: any }[] = [],
    url = new URL(request.url);
  const configured = !!env.SUPABASE_URL && !!env.SUPABASE_PUBLISHABLE_KEY;
  const client = configured
    ? createServerClient(env.SUPABASE_URL!, env.SUPABASE_PUBLISHABLE_KEY!, {
        auth: { experimental: { passkey: true } },
        cookieOptions: {
          name: "fore-auth",
          httpOnly: true,
          secure: url.protocol === "https:",
          sameSite: "lax",
          path: "/",
          maxAge: 30 * 86400,
        },
        cookies: {
          getAll: () =>
            parseCookieHeader(request.headers.get("cookie") || "").map((c) => ({
              name: c.name,
              value: c.value || "",
            })),
          setAll: (values) => {
            changes.push(...values);
          },
        },
      } as any)
    : null;
  let checked: any = undefined;
  async function user() {
    if (checked !== undefined) return checked;
    if (!client) {
      checked = null;
      return checked;
    }
    const { data, error } = await client.auth.getUser();
    // Read the verified provider record, never a browser-supplied session/user object.
    checked = !error && data.user?.email_confirmed_at && data.user.email ? data.user : null;
    return checked;
  }
  async function sessionFingerprint() {
    if (!client) return "";
    try {
      const { data } = await client.auth.getSession();
      const token = data.session?.access_token || "";
      if (!token) return "";
      let stable = token;
      try {
        const payload = token.split(".")[1] || "";
        const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
        const decoded = JSON.parse(atob(normalized + "=".repeat((4 - normalized.length % 4) % 4)));
        stable = String(decoded.session_id || token);
      } catch {}
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable)));
      return [...digest].map((x) => x.toString(16).padStart(2, "0")).join("");
    } catch { return ""; }
  }
  async function securityEvent(userId:string,eventType:string,detail:any={}) {
    const eventId=`secevt_${crypto.randomUUID()}`,at=now();
    try {
      await env.DB.prepare("INSERT INTO account_security_events(id,user_id,event_type,actor_type,actor_user_id,session_fingerprint,ip_country,user_agent_summary,event_json,created_at) VALUES(?,?,?,'user',?,?,?,?,?,?)").bind(eventId,userId,eventType,userId,await sessionFingerprint(),(request.headers.get("cf-ipcountry")||"").slice(0,2),(request.headers.get("user-agent")||"").slice(0,240),JSON.stringify(detail||{}),at).run();
      const labels:Record<string,{title:string;body:string}>={
        login_succeeded:{title:"Sign-in to your Cove account",body:"A sign-in to your Cove account was recorded."},
        email_change_requested:{title:"Email change requested",body:"A change to your Cove account email was requested."},
        password_changed:{title:"Password changed",body:"Your Cove account password was changed and other sessions were signed out."},
        mfa_enrollment_started:{title:"Authenticator setup started",body:"Multi-factor authentication setup was started on your Cove account."},
        mfa_verified:{title:"Authenticator verified",body:"A multi-factor authenticator was verified on your Cove account."},
        mfa_factor_removed:{title:"Authenticator removed",body:"A multi-factor authentication factor was removed from your Cove account."},
        passkey_registered:{title:"Passkey added",body:"A new passkey was added to your Cove account."},
        passkey_deleted:{title:"Passkey removed",body:"A passkey was removed from your Cove account."},
        other_sessions_revoked:{title:"Other sessions signed out",body:"Other active Cove sessions were revoked."},
      },copy=labels[eventType]||{title:"Cove account security alert",body:"A security-related change was recorded on your Cove account."};
      await emitNotification(env.DB,{userId,eventType:"account_security_alert",dedupeKey:`security:${eventId}`,title:copy.title,body:copy.body,topic:"security",urgency:eventType==="login_succeeded"?"normal":"high",subjectType:"account_security_event",subjectId:eventId,actionUrl:"/account",payload:{securityEventType:eventType,...detail},forceChannels:eventType==="login_succeeded"?["in_app"]:["in_app","email"],allowedChannels:eventType==="login_succeeded"?["in_app","web_push","mobile_push"]:undefined});
      await assessAccountTakeoverRisk(env.DB as any,userId,eventType);
    } catch {}
  }
  async function bindIdentity(u: any) {
    let row = await env.DB.prepare("SELECT * FROM auth_accounts WHERE provider_id=?")
      .bind(u.id)
      .first<any>();
    if (!row) {
      const chosen = usernameSchema.safeParse(u.user_metadata?.username);
      const username = chosen.success ? chosen.data : null;
      const trustedId = request.headers.get("oai-authenticated-user-id"),
        trustedEmail = request.headers.get("oai-authenticated-user-email");
      // Preserve existing reading data only when both independently authenticated identities agree.
      const appId =
        trustedId && trustedEmail?.toLowerCase() === u.email.toLowerCase()
          ? trustedId
          : "sb:" + u.id;
      await env.DB.prepare(
        "INSERT OR IGNORE INTO auth_accounts(provider_id,app_id,email,username,created_at) VALUES(?,?,?,?,?)",
      )
        .bind(u.id, appId, u.email.toLowerCase(), null, now())
        .run();
      if (username)
        await env.DB.prepare(
          "UPDATE OR IGNORE auth_accounts SET username=? WHERE provider_id=? AND username IS NULL",
        )
          .bind(username, u.id)
          .run();
      row = await env.DB.prepare("SELECT * FROM auth_accounts WHERE provider_id=?")
        .bind(u.id)
        .first<any>();
    }
    await env.DB.prepare("UPDATE auth_accounts SET email=? WHERE provider_id=?")
      .bind(u.email.toLowerCase(), u.id)
      .run();
    let aal: "aal1" | "aal2" | null = null;
    try {
      const assurance = await client?.auth.mfa.getAuthenticatorAssuranceLevel();
      const level = assurance?.data?.currentLevel;
      aal = level === "aal2" ? "aal2" : level === "aal1" ? "aal1" : null;
    } catch {
      aal = null;
    }
    return {
      id: row.app_id,
      email: u.email,
      name: row.username || u.user_metadata?.full_name || "",
      registered: false,
      username: row.username || undefined,
      aal,
      authProvider: String(u.app_metadata?.provider || u.identities?.[0]?.provider || "supabase"),
      authSubject: String(u.id || ""),
    };
  }
  async function identify() {
    if (env.FORE_AUTH_MODE !== "supabase") return;
    let identity: CoveIdentity | null = null;
    if (client && request.headers.get("cookie")?.includes("fore-auth")) {
      const u = await user();
      if (u) {
        identity = await bindIdentity(u);
        const fp=await sessionFingerprint();
        if(fp){
          try {
            const blocked=await env.DB.prepare("SELECT id FROM account_sessions WHERE user_id=? AND provider_session_id_hash=? AND revoked_at IS NOT NULL").bind(identity.id,fp).first<any>();
            if(blocked){identity=null;}
            else {const at=now(),existing=await env.DB.prepare("SELECT id,last_seen_at FROM account_sessions WHERE user_id=? AND provider_session_id_hash=?").bind(identity.id,fp).first<any>();if(existing)await env.DB.prepare("UPDATE account_sessions SET last_seen_at=?,user_agent_summary=?,ip_country=? WHERE id=?").bind(at,(request.headers.get("user-agent")||"").slice(0,240),(request.headers.get("cf-ipcountry")||"").slice(0,2),existing.id).run();else await env.DB.prepare("INSERT INTO account_sessions(id,user_id,provider_session_id_hash,user_agent_summary,ip_country,created_at,last_seen_at) VALUES(?,?,?,?,?,?,?)").bind(`sess_${crypto.randomUUID()}`,identity.id,fp,(request.headers.get("user-agent")||"").slice(0,240),(request.headers.get("cf-ipcountry")||"").slice(0,2),at,at).run();identity.sessionFingerprint=fp;}
          } catch {}
        }
      }
    }
    identities.set(request, identity);
  }
  const decorate = (response: Response | null) => {
    if (!response) return response;
    if (changes.length) {
      response = new Response(response.body, response);
      for (const c of changes)
        response.headers.append(
          "Set-Cookie",
          serializeCookieHeader(c.name, c.value, {
            ...c.options,
            httpOnly: true,
            secure: url.protocol === "https:",
            sameSite: "lax",
            path: "/",
          }),
        );
      response.headers.set("Cache-Control", "private, no-store");
    }
    return response;
  };
  async function handle(path: string): Promise<Response | null> {
    if (!path.startsWith("/auth/")) return null;
    if (path === "/auth/options" && request.method === "GET")
      return json({
        available: configured,
        google: configured && env.FORE_GOOGLE_ENABLED === "true",
      });
    if (!client)
      throw new ApiError(503, "Account sign-in is being set up. Please try again later.");
    const origin = env.FORE_PUBLIC_URL ? new URL(env.FORE_PUBLIC_URL).origin : url.origin;
    const callback = origin + "/api/fore/auth/callback";
    const budget = async (name: string, n = 10) =>
      rateLimit(
        env,
        "auth:" + name + ":" + (request.headers.get("cf-connecting-ip") || "local"),
        n,
      );
    if (path === "/auth/security" && request.method === "GET") {
      const u=await user();if(!u)throw new ApiError(401,"Sign in to manage account security.");const assurance=await client.auth.mfa.getAuthenticatorAssuranceLevel();const factors=await client.auth.mfa.listFactors();let passkeys:any[]=[];try{const result=await (client.auth as any).passkey.list();if(!result?.error)passkeys=result?.data||[];}catch{}
      return json({email:u.email,provider:String(u.app_metadata?.provider||u.identities?.[0]?.provider||"email"),aal:{current:assurance.data?.currentLevel||null,next:assurance.data?.nextLevel||null},factors:factors.data||{all:[],totp:[],phone:[]},passkeys,passkeysExperimental:true});
    }
    if (path === "/auth/google" && request.method === "GET") {
      if (env.FORE_GOOGLE_ENABLED !== "true")
        throw new ApiError(503, "Google sign-in is being set up.");
      await budget("google", 20);
      const { data, error } = await client.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: callback,
          skipBrowserRedirect: true,
          queryParams: { prompt: "select_account" },
        },
      });
      if (error || !data.url) throw new ApiError(502, "Google sign-in could not be started.");
      return new Response(null, {
        status: 303,
        headers: { Location: data.url, "Cache-Control": "no-store" },
      });
    }
    if (path === "/auth/callback" && request.method === "GET") {
      const code = url.searchParams.get("code");
      if (!code)
        return new Response(null, {
          status: 303,
          headers: { Location: "/?auth=login&authError=link", "Cache-Control": "no-store" },
        });
      const { data, error } = await client.auth.exchangeCodeForSession(code);
      if (error || !data.user?.email_confirmed_at)
        return new Response(null, {
          status: 303,
          headers: { Location: "/?auth=login&authError=link", "Cache-Control": "no-store" },
        });
      await bindIdentity(data.user);
      return new Response(null, {
        status: 303,
        headers: {
          Location:
            url.searchParams.get("flow") === "recovery" ? "/?auth=new-password" : "/profile",
          "Cache-Control": "no-store",
        },
      });
    }
    if (request.method !== "POST") throw new ApiError(405, "This sign-in action requires POST.");
    if (path === "/auth/signup") {
      await budget("signup", 5);
      const input = z
        .object({ username: usernameSchema, email: emailSchema, password: passwordSchema })
        .parse(await readBody(request, 5000));
      await requireEmailConfirmation(env);
      if (
        await env.DB.prepare("SELECT 1 FROM auth_accounts WHERE username=?")
          .bind(input.username)
          .first()
      )
        throw new ApiError(409, "That username is already taken.");
      const { data, error } = await client.auth.signUp({
        email: input.email,
        password: input.password,
        options: { emailRedirectTo: callback, data: { username: input.username } },
      });
      if (error)
        throw new ApiError(
          error.status === 429 ? 429 : 400,
          error.code === "weak_password"
            ? "Choose a stronger password."
            : "We could not create the account. Check your details or try signing in.",
        );
      // A provider configured to auto-confirm email is not an acceptable verification workflow.
      if (data.session) {
        await client.auth.signOut({ scope: "local" });
        throw new ApiError(503, "Email verification must be enabled before registration can open.");
      }
      return json({
        verificationRequired: true,
        message:
          "Check your email to verify your account, then sign in. If you already have an account, you can sign in or reset your password.",
      });
    }
    if (path === "/auth/login") {
      await budget("login", 10);
      const input = z
        .object({ login: z.string().trim().min(1).max(254), password: z.string().min(1).max(128) })
        .parse(await readBody(request, 5000));
      let email = input.login.toLowerCase();
      if (!email.includes("@")) {
        const name = usernameSchema.safeParse(email);
        const row = name.success
          ? await env.DB.prepare("SELECT email FROM auth_accounts WHERE username=?")
              .bind(name.data)
              .first<any>()
          : null;
        email = row?.email || "invalid@invalid.example";
      }
      const { data, error } = await client.auth.signInWithPassword({
        email,
        password: input.password,
      });
      if (error || !data.user?.email_confirmed_at)
        throw new ApiError(
          401,
          "Sign-in failed. Check your username/email and password, and verify your email first.",
        );
      const bound=await bindIdentity(data.user);const assurance=await client.auth.mfa.getAuthenticatorAssuranceLevel();await securityEvent(bound.id,"login_succeeded",{provider:"password",nextLevel:assurance.data?.nextLevel||null});
      return json({ signedIn: true, mfaRequired: assurance.data?.nextLevel === "aal2" && assurance.data?.currentLevel !== "aal2" });
    }
    if (path === "/auth/verify") {
      await budget("verify", 8);
      const p = z
        .object({ email: emailSchema, code: z.string().regex(/^\d{6,10}$/) })
        .parse(await readBody(request, 2000));
      const { data, error } = await client.auth.verifyOtp({
        email: p.email,
        token: p.code,
        type: "signup",
      });
      if (error || !data.user?.email_confirmed_at)
        throw new ApiError(
          400,
          "That code is invalid or expired. Request another verification email.",
        );
      await bindIdentity(data.user);
      return json({ verified: true });
    }
    if (path === "/auth/resend" || path === "/auth/reset") {
      await budget("email", 3);
      const p = z.object({ email: emailSchema }).parse(await readBody(request, 2000));
      const result =
        path === "/auth/resend"
          ? await client.auth.resend({
              type: "signup",
              email: p.email,
              options: { emailRedirectTo: callback },
            })
          : await client.auth.resetPasswordForEmail(p.email, {
              redirectTo: callback + "?flow=recovery",
            });
      if (result.error && (result.error.status === 429 || Number(result.error.status) >= 500))
        throw new ApiError(
          result.error.status === 429 ? 429 : 503,
          "Email delivery is temporarily unavailable. Please try again later.",
        );
      return json({
        message:
          "If the address is eligible, an email will arrive shortly. Check your spam folder too.",
      });
    }
    if (path === "/auth/email") {
      const u=await user();if(!u)throw new ApiError(401,"Sign in first.");const input=z.object({email:emailSchema}).parse(await readBody(request,2000));const {error}=await (client.auth as any).updateUser({email:input.email},{emailRedirectTo:callback});if(error)throw new ApiError(400,"The email change could not be started.");const bound=await bindIdentity(u);await securityEvent(bound.id,"email_change_requested",{newEmail:input.email});return json({verificationRequired:true,message:"Confirm the change using the verification email sent by the identity provider."});
    }
    if (path === "/auth/change-password") {
      const u=await user();if(!u?.email)throw new ApiError(401,"Sign in first.");const input=z.object({currentPassword:z.string().min(1).max(128),newPassword:passwordSchema}).parse(await readBody(request,3000));const reauth=await client.auth.signInWithPassword({email:u.email,password:input.currentPassword});if(reauth.error)throw new ApiError(401,"Current password is incorrect.");const updated=await client.auth.updateUser({password:input.newPassword});if(updated.error)throw new ApiError(400,"The password could not be updated.");const bound=await bindIdentity(updated.data.user||u);await securityEvent(bound.id,"password_changed",{});await client.auth.signOut({scope:"global"});return json({updated:true,signedOut:true});
    }
    if (path === "/auth/mfa/enroll") {
      const u=await user();if(!u)throw new ApiError(401,"Sign in first.");const input=z.object({friendlyName:z.string().trim().min(1).max(80).default("Cove authenticator")}).parse(await readBody(request,2000));const result=await client.auth.mfa.enroll({factorType:"totp",friendlyName:input.friendlyName});if(result.error)throw new ApiError(400,result.error.message||"MFA enrollment failed.");const bound=await bindIdentity(u);await securityEvent(bound.id,"mfa_enrollment_started",{factorId:result.data.id});return json({id:result.data.id,type:result.data.type,totp:result.data.totp});
    }
    if (path === "/auth/mfa/verify") {
      const u=await user();if(!u)throw new ApiError(401,"Sign in first.");const input=z.object({factorId:z.string().min(1),code:z.string().regex(/^\d{6,10}$/)}).parse(await readBody(request,2000));const result=await (client.auth.mfa as any).challengeAndVerify({factorId:input.factorId,code:input.code});if(result.error)throw new ApiError(401,"The authentication code was invalid or expired.");const bound=await bindIdentity(u);await securityEvent(bound.id,"mfa_verified",{factorId:input.factorId});return json({verified:true});
    }
    if (path === "/auth/mfa/unenroll") {
      const u=await user();if(!u)throw new ApiError(401,"Sign in first.");const assurance=await client.auth.mfa.getAuthenticatorAssuranceLevel();if(assurance.data?.currentLevel!=="aal2")throw new ApiError(403,"Verify MFA before removing a factor.");const input=z.object({factorId:z.string().min(1)}).parse(await readBody(request,2000));const result=await client.auth.mfa.unenroll({factorId:input.factorId});if(result.error)throw new ApiError(400,"The MFA factor could not be removed.");const bound=await bindIdentity(u);await securityEvent(bound.id,"mfa_factor_removed",{factorId:input.factorId});return json({removed:true});
    }
    if (path === "/auth/passkey/registration/start") {const u=await user();if(!u)throw new ApiError(401,"Sign in first.");const result=await (client.auth as any).passkey.startRegistration();if(result.error)throw new ApiError(400,result.error.message||"Passkey enrollment could not start.");return json(result.data);}
    if (path === "/auth/passkey/registration/verify") {const u=await user();if(!u)throw new ApiError(401,"Sign in first.");const input=z.object({challengeId:z.string().min(1),credential:z.any()}).parse(await readBody(request,64000));const result=await (client.auth as any).passkey.verifyRegistration({challengeId:input.challengeId,credential:input.credential});if(result.error)throw new ApiError(400,result.error.message||"Passkey verification failed.");const bound=await bindIdentity(u);await securityEvent(bound.id,"passkey_registered",{passkeyId:result.data?.id||null});return json(result.data||{registered:true});}
    if (path === "/auth/passkey/authentication/start") {const result=await (client.auth as any).passkey.startAuthentication();if(result.error)throw new ApiError(400,result.error.message||"Passkey sign-in could not start.");return json(result.data);}
    if (path === "/auth/passkey/authentication/verify") {const input=z.object({challengeId:z.string().min(1),credential:z.any()}).parse(await readBody(request,64000));const result=await (client.auth as any).passkey.verifyAuthentication({challengeId:input.challengeId,credential:input.credential});if(result.error||!result.data?.user)throw new ApiError(401,"Passkey sign-in failed.");const bound=await bindIdentity(result.data.user);await securityEvent(bound.id,"login_succeeded",{provider:"passkey"});return json({signedIn:true});}
    if (path === "/auth/passkey/update") {const u=await user();if(!u)throw new ApiError(401,"Sign in first.");const input=z.object({passkeyId:z.string().min(1),friendlyName:z.string().trim().min(1).max(120)}).parse(await readBody(request,2000));const result=await (client.auth as any).passkey.update(input);if(result.error)throw new ApiError(400,"Passkey could not be renamed.");return json(result.data||{updated:true});}
    if (path === "/auth/passkey/delete") {const u=await user();if(!u)throw new ApiError(401,"Sign in first.");const assurance=await client.auth.mfa.getAuthenticatorAssuranceLevel();if(assurance.data?.nextLevel==="aal2"&&assurance.data?.currentLevel!=="aal2")throw new ApiError(403,"Verify MFA before deleting a passkey.");const input=z.object({passkeyId:z.string().min(1)}).parse(await readBody(request,2000));const result=await (client.auth as any).passkey.delete({passkeyId:input.passkeyId});if(result.error)throw new ApiError(400,"Passkey could not be deleted.");const bound=await bindIdentity(u);await securityEvent(bound.id,"passkey_deleted",{passkeyId:input.passkeyId});return json({deleted:true});}
    if (path === "/auth/sessions/signout-others") {const u=await user();if(!u)throw new ApiError(401,"Sign in first.");const current=await sessionFingerprint();const bound=await bindIdentity(u);const result=await client.auth.signOut({scope:"others"});if(result.error)throw new ApiError(502,"Other provider sessions could not be revoked.");await env.DB.prepare("UPDATE account_sessions SET revoked_at=COALESCE(revoked_at,?),revoked_reason='user_signout_others' WHERE user_id=? AND provider_session_id_hash<>? AND revoked_at IS NULL").bind(now(),bound.id,current).run();await securityEvent(bound.id,"other_sessions_revoked",{});return json({revoked:true});}
    if (path === "/auth/logout") {
      await client.auth.signOut({ scope: "local" });
      return json({ signedOut: true });
    }
    if (path === "/auth/password") {
      await budget("password", 5);
      if (!(await user()))
        throw new ApiError(401, "Open the password-reset link from your email first.");
      const input = z.object({ password: passwordSchema }).parse(await readBody(request, 2000));
      const { error } = await client.auth.updateUser({ password: input.password });
      if (error)
        throw new ApiError(
          400,
          "The password could not be updated. Try a different password or request a new reset link.",
        );
      await client.auth.signOut({ scope: "global" });
      return json({ updated: true });
    }
    if (path === "/auth/username") {
      const u = await user();
      if (!u) throw new ApiError(401, "Verify your email and sign in first.");
      const input = z.object({ username: usernameSchema }).parse(await readBody(request, 2000));
      await bindIdentity(u);
      const result = await env.DB.prepare(
        "UPDATE OR IGNORE auth_accounts SET username=? WHERE provider_id=? RETURNING username",
      )
        .bind(input.username, u.id)
        .first();
      if (!result) throw new ApiError(409, "That username is already taken.");
      return json({ username: input.username });
    }
    throw new ApiError(404, "Sign-in action not found.");
  }
  return { identify, handle, decorate };
}

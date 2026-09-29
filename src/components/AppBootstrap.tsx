import { useEffect } from "react";
import { getSupabaseClient } from "@/integrations/supabase/client";
import { applyPreferences, readPreferences } from "@/lib/preferences";
import { syncReadingData } from "@/lib/reading-data";

export function AppBootstrap() {
  useEffect(() => {
    applyPreferences(readPreferences());

    if ("serviceWorker" in navigator) {
      const register = () => navigator.serviceWorker.register("/sw.js").catch(() => undefined);
      if (document.readyState === "complete") void register();
      else window.addEventListener("load", register, { once: true });
    }

    const handleOnline = () => void syncReadingData();
    window.addEventListener("online", handleOnline);
    void syncReadingData();

    const client = getSupabaseClient();
    const subscription = client?.auth.onAuthStateChange(() => {
      window.setTimeout(() => void syncReadingData(), 0);
    }).data.subscription;

    return () => {
      window.removeEventListener("online", handleOnline);
      subscription?.unsubscribe();
    };
  }, []);

  return null;
}

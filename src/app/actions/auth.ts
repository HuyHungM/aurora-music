"use server";

import { signIn, signOut } from "@/lib/auth";
import { getAuthAvailability } from "@/lib/auth/availability";
import { getEnv } from "@/lib/config/env";

export async function signInWith(formData: FormData): Promise<void> {
  const provider = formData.get("provider");
  if (typeof provider !== "string") {
    return;
  }
  const availability = getAuthAvailability(getEnv());
  const supported =
    (provider === "google" && availability.google) ||
    (provider === "github" && availability.github);
  if (!supported) {
    return;
  }
  await signIn(provider);
}

export async function signOutUser(): Promise<void> {
  await signOut({ redirectTo: "/" });
}